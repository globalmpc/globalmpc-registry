import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { normalizeEmail, ROLE_MINIMUM_ASSURANCE, satisfiesAssurance } from "@mpc/api-contract";
import type { AssuranceLevel } from "@mpc/api-contract";
import { ROLE_DEPLOY_BOUND } from "./audit.js";

/**
 * Operational bootstrap — inserts the first person into a deployed system.
 *
 * Migrations create only the schema. Without a tenant, organization, person and role on top,
 * nobody can sign in, and nobody could invite the first person: invitations are an admin action.
 *
 * `apps/web/e2e/seed.ts` cannot substitute. It drops and recreates the schema, and the private
 * keys of the accounts it seeds sit in the repository — seeding them at a deployed address lets
 * anyone who knows the keys log in as operator.
 *
 * This function **deletes nothing.** Re-running with the same input leaves existing rows as is
 * and fills only what is missing. It must be safe for the deploy pipeline to call every time.
 *
 * Called with an RLS-bypassing connection (superuser). What it creates is the tenant itself,
 * so a tenant context cannot be established first.
 *
 * **Email only** (account authentication WP2, WP7). The person signs in by emailed code, then
 * enrols a second factor. Bootstrap binds no wallet: a wallet is a signing key the holder binds
 * from Settings by proof of possession (WP5), and a key attached here would be one nobody proved
 * holding. An address already on another tenant's person stops the run: moving an address is the
 * two-person email change, not something a deploy pipeline does.
 *
 * **First-enrolment window** (WP3, migration 0118). A person may enrol a first passkey or TOTP
 * from an email-code session only within 24 hours of creation or of an approved reset. A first
 * operator who missed those 24 hours has no second admin to approve a reset, so a run for an
 * existing person who holds **no** passkey or TOTP opens a fresh 24-hour window (recorded as a
 * `bootstrap` reset row and audited as `deploy_bound`). Once the person holds a factor, a run
 * opens nothing and changes no factor; from then on only the two-person admin reset does.
 *
 * **Never undoes a two-person decision** (the deploy runs this on every release). For a person who
 * already exists it stops the run, writing nothing, when:
 *
 * - the person is **suspended** — reinstatement is the two-person decision of 0127, and a deploy
 *   must neither give them a role nor open an enrolment window (their factors were revoked, so the
 *   window function alone would open one);
 * - the person's binding of this role was **revoked** (a two-person revocation, or a break-glass
 *   access quarantine) and none is live — re-granting it on every deploy would quietly reverse
 *   that decision. An admin grants it again through the API if it should come back.
 *
 * And it **creates only the first holder of the role**: a new binding is created only when the
 * tenant has never had anyone hold the role (revoked bindings count) and the address is not one
 * a completed email change moved away from. Otherwise a deploy still naming an operator's old
 * address would hand the role to whoever reads that mailbox, including an existing account
 * (`refuseNewHolder`).
 *
 * **Legacy operator cutover requires a stable subject ID.** With `subjectId`, a deployment
 * operator may initialize the first email on an existing legacy person. The person must already
 * hold the configured role and assurance, have an operator-bound wallet in their history, and
 * have no account-authentication or recovery history. Nothing grants a role, changes assurance,
 * revives a signing key/session, or changes an existing email. The initialization and its audit
 * are atomic. Repeating the same ID and address reports the existing window without renewing it.
 *
 * All of these stop the run rather than skip: the deploy configuration still names this person as the
 * operator, and a run that "succeeds" without the role would hide that until someone needs it.
 * Removing `BOOTSTRAP_EMAIL` from the environment is how a deploy stops bootstrapping.
 */

export class BootstrapError extends Error {
  readonly code = "BOOTSTRAP_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BootstrapError";
  }
}

export interface BootstrapInput {
  /** Tenant identifier. Reused if it already exists. */
  readonly tenantSlug: string;
  readonly tenantName: string;
  /** Organization legal name. Reused if the same name exists in the same tenant. */
  readonly organizationName: string;
  /** ISO3 jurisdiction code. */
  readonly jurisdiction: string;
  readonly subjectName: string;
  /** Explicit legacy operator identity; initializes only its first email, never grants a role. */
  readonly subjectId?: string;
  /** The person's sign-in address. Normalized (trimmed, lower-cased). Required. */
  readonly email: string;
  readonly role: string;
  readonly assuranceLevel: AssuranceLevel;
}

export interface BootstrapResult {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly subjectId: string;
  /** Whether this call created the subject. False if it already existed. */
  readonly created: boolean;
  /** Whether this call gave the subject its email address. */
  readonly emailBound: boolean;
  /** Whether this call created the role assignment. */
  readonly roleGranted: boolean;
  /**
   * Until when the person may enrol a first passkey or TOTP from an email-code session, or null
   * when they already hold a factor or an explicit-ID rerun has no active window.
   */
  readonly enrolmentWindowUntil: Date | null;
  /** Whether this call opened that window (an existing person past 24 h with no factor). */
  readonly enrolmentWindowOpened: boolean;
}

const ASSURANCE_LEVELS: readonly AssuranceLevel[] = [
  "wallet_only",
  "identity_bound",
  "high_assurance",
];

/**
 * Validates all input first.
 *
 * If it fails after half the data is in the DB, the next run cannot tell what to fix.
 * Assurance in particular is not enforced by the DB — a low value still inserts the row, every
 * request gets 403, and the screen shows no reason. So it is blocked here.
 */
function validate(input: BootstrapInput): { email: string } {
  if (input.tenantSlug.trim() === "") {
    throw new BootstrapError("tenantSlug is empty");
  }
  if (input.tenantName.trim() === "" || input.organizationName.trim() === "") {
    throw new BootstrapError("tenantName and organizationName are required");
  }
  if (input.subjectName.trim() === "") {
    throw new BootstrapError("subjectName is required");
  }
  if (!/^[A-Z]{3}$/.test(input.jurisdiction)) {
    throw new BootstrapError(`jurisdiction must be 3 uppercase ISO3 letters — ${input.jurisdiction}`);
  }

  if (!input.email?.trim()) {
    throw new BootstrapError("email is required — the person signs in with an emailed code");
  }
  if (input.subjectId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.subjectId)) {
    throw new BootstrapError("subjectId must be a UUID");
  }
  const email = normalizeEmail(input.email);
  if (email === null) {
    // The value is not echoed: it is personal data, and this message lands in deploy logs.
    throw new BootstrapError("email is not one email address");
  }

  const required = ROLE_MINIMUM_ASSURANCE[input.role];
  if (required === undefined) {
    const known = Object.keys(ROLE_MINIMUM_ASSURANCE).sort().join(", ");
    throw new BootstrapError(`Unknown role — ${input.role}. Allowed values: ${known}`);
  }

  if (!ASSURANCE_LEVELS.includes(input.assuranceLevel)) {
    throw new BootstrapError(`Unknown assuranceLevel — ${input.assuranceLevel}`);
  }

  if (!satisfiesAssurance(input.assuranceLevel, required)) {
    throw new BootstrapError(
      `${input.role} requires at least ${required} — given ${input.assuranceLevel}`,
    );
  }

  return { email };
}

export async function bootstrapOperator(
  sql: postgres.Sql,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const { email } = validate(input);

  return sql.begin(async (tx) => {
    if (input.subjectId !== undefined) return initializeLegacyOperator(tx, input, email);
    // Check the address first. If it already belongs to another tenant, stop before creating the
    // tenant — rejecting after creation leaves an unused tenant behind.
    // Locked, so a suspension decided while this runs waits for it (or this waits for that).
    const existingEmail = await tx<{ id: string; tenant_id: string; suspended: boolean; assurance_level: AssuranceLevel }[]>`
      SELECT id, tenant_id, suspended_at IS NOT NULL AS suspended, assurance_level
      FROM core.subjects WHERE email = ${email}
      FOR UPDATE
    `;

    const tenantId = await upsertTenant(tx, input);
    // Serialize first-holder decisions across bootstrap runs without conflicting with the
    // KEY SHARE locks ordinary tenant-owned inserts take for their foreign keys.
    await tx`SELECT id FROM core.tenants WHERE id = ${tenantId} FOR NO KEY UPDATE`;

    const byEmail = existingEmail[0];
    if (byEmail && byEmail.tenant_id !== tenantId) {
      throw new BootstrapError(
        "This email address already belongs to a person in another tenant. One address signs in to one account",
      );
    }

    if (byEmail?.suspended) {
      throw new BootstrapError(
        "This person is suspended. Bootstrap neither grants a role nor opens an enrolment window for a suspended person — " +
          "reinstatement is a two-person decision. Remove BOOTSTRAP_EMAIL from the deploy, or reinstate the person first",
      );
    }

    // Creation input never upgrades an existing identity's assurance. Otherwise bootstrap can
    // claim the operator is ready even though every protected admin request will reject them.
    if (byEmail && !satisfiesAssurance(byEmail.assurance_level, ROLE_MINIMUM_ASSURANCE[input.role]!)) {
      throw new BootstrapError("The existing person's stored assurance is insufficient; bootstrap never upgrades it");
    }

    const organizationId = await upsertOrganization(tx, tenantId, input);

    let subjectId = byEmail?.id ?? null;
    const created = subjectId === null;
    let emailBound = false;

    if (subjectId === null) {
      subjectId = randomUUID();
      await tx`
        INSERT INTO core.subjects (
          id, tenant_id, kind, display_name, assurance_level, email, organization_id
        ) VALUES (
          ${subjectId}, ${tenantId}, 'person', ${input.subjectName}, ${input.assuranceLevel},
          ${email}, ${organizationId}
        )
      `;
      emailBound = true;
    }

    const roleGranted = await grantRole(tx, {
      tenantId,
      subjectId,
      organizationId,
      role: input.role,
      email,
    });

    const window = await openEnrolmentWindow(tx, tenantId, subjectId);

    return { tenantId, organizationId, subjectId, created, emailBound, roleGranted, ...window };
  });
}

/**
 * A migration operator explicitly selects the stable legacy person. A mailbox cannot establish
 * that identity. This exception attaches the first account address; it never creates authority
 * or reopens recovery for somebody who already used account authentication.
 */
async function initializeLegacyOperator(
  tx: postgres.TransactionSql,
  input: BootstrapInput,
  email: string,
): Promise<BootstrapResult> {
  const [subject] = await tx<{
    id: string; tenant_id: string; email: string | null; kind: string;
    assurance_level: AssuranceLevel; suspended_at: Date | null; version: number;
  }[]>`
    SELECT s.id, s.tenant_id, s.email, s.kind, s.assurance_level, s.suspended_at, s.version
    FROM core.subjects s JOIN core.tenants t ON t.id = s.tenant_id
    WHERE s.id = ${input.subjectId!} AND t.slug = ${input.tenantSlug}
    FOR UPDATE OF s
  `;
  if (!subject || subject.kind !== "person") {
    throw new BootstrapError("subjectId must identify an existing person in the configured tenant");
  }
  await tx`SELECT id FROM core.tenants WHERE id = ${subject.tenant_id} FOR NO KEY UPDATE`;
  if (subject.suspended_at !== null) throw new BootstrapError("This person is suspended");
  if (!satisfiesAssurance(subject.assurance_level, ROLE_MINIMUM_ASSURANCE[input.role]!)) {
    throw new BootstrapError("The existing person's stored assurance is insufficient; bootstrap never upgrades it");
  }
  const [binding] = await tx<{ organization_id: string }[]>`
    SELECT b.organization_id FROM core.role_bindings b
    JOIN core.organizations o ON o.tenant_id = b.tenant_id AND o.id = b.organization_id
    WHERE b.tenant_id = ${subject.tenant_id} AND b.subject_id = ${subject.id}
      AND b.role = ${input.role} AND b.revoked_at IS NULL AND o.legal_name = ${input.organizationName}
    LIMIT 1
  `;
  if (!binding) {
    throw new BootstrapError("The existing person must already hold the configured active role in the configured organization; bootstrap never grants it in subjectId mode");
  }
  if (subject.email !== null && subject.email !== email) {
    throw new BootstrapError("This person already has a different email; use the two-person email change");
  }
  const emailBound = subject.email === null;
  if (emailBound) {
    const [history] = await tx`
      SELECT 1 WHERE
        EXISTS (SELECT 1 FROM core.sessions WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id} AND first_factor <> 'siwe_legacy')
        OR EXISTS (SELECT 1 FROM core.external_identities WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id})
        OR EXISTS (SELECT 1 FROM core.webauthn_credentials WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id})
        OR EXISTS (SELECT 1 FROM core.totp_authenticators WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id})
        OR EXISTS (SELECT 1 FROM core.recovery_codes WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id})
        OR EXISTS (SELECT 1 FROM core.mfa_reset_requests WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id})
        OR EXISTS (SELECT 1 FROM core.email_change_requests WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id})
        OR EXISTS (SELECT 1 FROM audit.events WHERE tenant_id = ${subject.tenant_id} AND resource_id = ${subject.id} AND command = 'bootstrap.legacy_email.initialized')
    `;
    if (history) throw new BootstrapError("This person has account or recovery history; legacy email initialization is not account recovery");
    const [legacy] = await tx`
      SELECT 1 FROM core.wallet_identities
      WHERE tenant_id = ${subject.tenant_id} AND subject_id = ${subject.id} AND bound_via = 'operator'
      LIMIT 1
    `;
    if (!legacy) throw new BootstrapError("This person has no historical operator-bound wallet; subjectId mode is only for legacy cutover");
    const [occupied] = await tx`SELECT 1 FROM core.subjects WHERE email = ${email} AND id <> ${subject.id}`;
    if (occupied) throw new BootstrapError("This email already belongs to another account");
    const [moved] = await tx`
      SELECT 1 FROM core.email_change_requests
      WHERE tenant_id = ${subject.tenant_id} AND state = 'completed' AND previous_email = ${email}
      LIMIT 1
    `;
    if (moved) throw new BootstrapError("This address was moved off a person by a completed email change");
    await tx`UPDATE core.subjects SET email = ${email}, version = version + 1 WHERE id = ${subject.id}`;
    await tx`
      INSERT INTO audit.events (
        tenant_id, actor_subject_id, actor_wallet, effective_role, command,
        resource_type, resource_id, before_version, after_version, reason, correlation_id
      ) VALUES (
        ${subject.tenant_id}, NULL, NULL, ${ROLE_DEPLOY_BOUND}, 'bootstrap.legacy_email.initialized',
        'subject', ${subject.id}, ${subject.version}, ${subject.version + 1},
        'Explicit legacy operator email initialization', ${randomUUID()}
      )
    `;
  }
  let window: { enrolmentWindowUntil: Date | null; enrolmentWindowOpened: boolean };
  if (emailBound) {
    window = await openEnrolmentWindow(tx, subject.tenant_id, subject.id);
  } else {
    // An explicit cutover rerun reports only an existing window; it is not MFA recovery.
    await tx`SELECT set_config('app.current_tenant', ${subject.tenant_id}, true)`;
    const [existing] = await tx<{ until: Date | null }[]>`
      WITH barrier AS (
        SELECT GREATEST(
          (SELECT max(r.decided_at) FROM core.subject_suspensions r
           WHERE r.subject_id = ${subject.id} AND r.action = 'suspend' AND r.state = 'approved'),
          (SELECT max(c.completed_at) FROM core.email_change_requests c
           WHERE c.subject_id = ${subject.id} AND c.state = 'completed')
        ) AS at
      )
      SELECT CASE WHEN core.mfa_has_passkey(s.id) OR core.mfa_has_totp(s.id)
        THEN NULL ELSE (
          SELECT max(deadline) FROM (
            SELECT s.created_at + interval '24 hours' AS deadline
            WHERE core.mfa_creation_window_open(s.id)
            UNION ALL
            SELECT r.enrolment_window_until FROM core.mfa_reset_requests r, barrier b
            WHERE r.tenant_id = s.tenant_id AND r.subject_id = s.id AND r.state = 'approved'
              AND r.closed_reason IS NULL AND (b.at IS NULL OR r.decided_at > b.at)
              AND core.mfa_reset_window_open(s.id)
            UNION ALL
            SELECT r.enrolment_window_until FROM core.subject_suspensions r, barrier b
            WHERE r.tenant_id = s.tenant_id AND r.subject_id = s.id
              AND r.action = 'reinstate' AND r.state = 'approved'
              AND (b.at IS NULL OR r.decided_at > b.at) AND core.mfa_reset_window_open(s.id)
          ) deadlines WHERE deadline > now()
        ) END AS until
      FROM core.subjects s WHERE s.id = ${subject.id} AND s.tenant_id = ${subject.tenant_id}
    `;
    window = { enrolmentWindowUntil: existing!.until, enrolmentWindowOpened: false };
  }
  return {
    tenantId: subject.tenant_id, organizationId: binding.organization_id, subjectId: subject.id,
    created: false, emailBound, roleGranted: false, ...window,
  };
}

/**
 * Bootstrap creates the **first** holder of the role, never a later one — see the header.
 *
 * A person is found by address only. Once the operator's address moved (the two-person email
 * change), a deploy still naming the old address would find nobody and create a new person
 * there, or find a different existing account, with the role and an open first-enrolment window:
 * whoever reads the old mailbox would
 * become an operator. So a new binding is created only in a tenant that has never had anyone
 * hold `role` (a revoked binding counts), and never on an address a completed email change in
 * the tenant moved away from. Both stop the run; the transaction writes nothing.
 */
async function refuseNewHolder(
  tx: postgres.TransactionSql,
  tenantId: string,
  email: string,
  role: string,
): Promise<void> {
  const [moved] = await tx`
    SELECT 1 FROM core.email_change_requests
    WHERE tenant_id = ${tenantId} AND state = 'completed' AND previous_email = ${email}
    LIMIT 1
  `;
  if (moved) {
    throw new BootstrapError(
      "This address was moved off a person in this tenant by a completed email change. Bootstrap does not create " +
        "a new role binding on it — the old mailbox would become the operator. Remove BOOTSTRAP_EMAIL from the deploy, " +
        "or set it to the person's current address",
    );
  }
  const [held] = await tx`
    SELECT 1 FROM core.role_bindings WHERE tenant_id = ${tenantId} AND role = ${role} LIMIT 1
  `;
  if (held) {
    throw new BootstrapError(
      `This tenant already has (or had) a ${role}, and none has this address. Bootstrap creates only the first one — ` +
        "later people are invited by an admin. Remove BOOTSTRAP_EMAIL from the deploy, or set it to the address of the person who holds it",
    );
  }
}

/**
 * Opens (or reports) the person's first-enrolment window — see the header. The database decides:
 * `core.open_bootstrap_enrolment_window` refuses once a factor exists, and is not granted to the
 * application role, so only this migration-connection run can call it.
 */
async function openEnrolmentWindow(
  tx: postgres.TransactionSql,
  tenantId: string,
  subjectId: string,
): Promise<{ enrolmentWindowUntil: Date | null; enrolmentWindowOpened: boolean }> {
  const [row] = await tx<{ opened: boolean; reset_id: string | null; window_until: Date | null }[]>`
    SELECT * FROM core.open_bootstrap_enrolment_window(${subjectId})
  `;
  if (row!.opened) {
    await tx`
      INSERT INTO audit.events (
        tenant_id, actor_subject_id, actor_wallet, effective_role,
        command, resource_type, resource_id, reason, correlation_id, detail
      ) VALUES (
        ${tenantId}, NULL, NULL, ${ROLE_DEPLOY_BOUND},
        'bootstrap.mfa_enrolment_window.opened', 'mfa_reset_request', ${row!.reset_id},
        'Bootstrap re-run for a person with no second factor', ${randomUUID()},
        ${tx.json({ subjectId, windowUntil: row!.window_until!.toISOString() })}
      )
    `;
  }
  return { enrolmentWindowUntil: row!.window_until, enrolmentWindowOpened: row!.opened };
}

async function upsertTenant(tx: postgres.TransactionSql, input: BootstrapInput): Promise<string> {
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM core.tenants WHERE slug = ${input.tenantSlug}
  `;
  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await tx`
    INSERT INTO core.tenants (id, slug, display_name)
    VALUES (${id}, ${input.tenantSlug}, ${input.tenantName})
  `;
  return id;
}

async function upsertOrganization(
  tx: postgres.TransactionSql,
  tenantId: string,
  input: BootstrapInput,
): Promise<string> {
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM core.organizations
    WHERE tenant_id = ${tenantId} AND legal_name = ${input.organizationName}
  `;
  if (existing[0]) return existing[0].id;

  const id = randomUUID();
  await tx`
    INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
    VALUES (${id}, ${tenantId}, ${input.organizationName}, ${input.jurisdiction})
  `;
  return id;
}

async function grantRole(
  tx: postgres.TransactionSql,
  args: { tenantId: string; subjectId: string; organizationId: string; role: string; email: string },
): Promise<boolean> {
  const existing = await tx<{ id: string }[]>`
    SELECT id FROM core.role_bindings
    WHERE tenant_id = ${args.tenantId}
      AND subject_id = ${args.subjectId}
      AND organization_id = ${args.organizationId}
      AND role = ${args.role}
      AND revoked_at IS NULL
  `;
  if (existing[0]) return false;

  // In any organization: a new organization name in the input must not route around it.
  const [revoked] = await tx<{ count: number }[]>`
    SELECT count(*)::int AS count FROM core.role_bindings
    WHERE tenant_id = ${args.tenantId}
      AND subject_id = ${args.subjectId}
      AND role = ${args.role}
      AND revoked_at IS NOT NULL
  `;
  if (revoked!.count > 0) {
    throw new BootstrapError(
      `This person's ${args.role} binding was revoked. Bootstrap does not grant it again — an admin does, through the API. ` +
        "Remove BOOTSTRAP_EMAIL from the deploy, or have the role granted first",
    );
  }

  // Existing mailbox ownership is not evidence that this is the original role holder.
  // Apply the historical safeguards to every new grant, including an existing account.
  await refuseNewHolder(tx, args.tenantId, args.email, args.role);

  await tx`
    INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
    VALUES (${randomUUID()}, ${args.tenantId}, ${args.subjectId}, ${args.organizationId}, ${args.role})
  `;
  return true;
}
