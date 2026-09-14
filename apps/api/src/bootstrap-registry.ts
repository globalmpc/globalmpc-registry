import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { parseRuleSet } from "@mpc/policy";
import { ROLE_DEPLOY_BOUND } from "./audit.js";

/**
 * Inserts the three things needed to start review into a deployed system.
 *
 * When `bootstrap.ts` inserts people, login and project registration work. It stops there —
 * review assignment requires the reviewer's **credential** and an **attestation schema**, and
 * readiness evaluation requires a **policy rule set**. The only path creating the three was the
 * E2E seed, which drops the schema and so cannot be used in deployment.
 *
 * **This is not an API.** 02 §2.8 defines credential verification and schema/policy approval
 * as work for separate roles, and those screens and routes do not exist yet. This is a path
 * operators run directly in the deployment environment, and it does not hide that gap by
 * **recording in audit who was stated to have approved**.
 *
 * Rules:
 *
 * - Deletes or overwrites nothing. If it already exists it is left as is with `created: false`.
 * - Without an approver it goes in as `draft`. A draft schema cannot be signed, and a
 *   draft policy set does not run evaluation — that is the exact marker of "not yet
 *   approved".
 * - Expired credentials are not inserted as `valid`. Doing so would pass the signing-time
 *   check and embed a false status in the attestation.
 *
 * Called with an RLS-bypassing connection (superuser).
 */

export class BootstrapRegistryError extends Error {
  readonly code = "BOOTSTRAP_REGISTRY_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "BootstrapRegistryError";
  }
}

interface AuditInput {
  readonly tenantId: string;
  readonly command: string;
  readonly resourceType: string;
  readonly resourceId: string;
  readonly reason: string | null;
  readonly detail: Record<string, unknown>;
}

/**
 * Audit record for a mutation without a human session.
 *
 * `actor_subject_id` and `actor_wallet` are left empty. What ran this path is an operator with
 * access to the deployment environment, whom the app does not identify — rather than invent an
 * identity, it records that there is none. The `command` prefix `bootstrap.` marks that fact.
 *
 * `effective_role` is not `mpc_operator` for the same reason. No authorization decision was
 * made, so writing a role name there would make the record lie.
 */
async function recordBootstrapAudit(
  tx: postgres.TransactionSql,
  entry: AuditInput,
): Promise<void> {
  await tx`
    INSERT INTO audit.events (
      tenant_id, actor_subject_id, actor_wallet, effective_role,
      command, resource_type, resource_id, reason, correlation_id, detail
    ) VALUES (
      ${entry.tenantId}, NULL, NULL, ${ROLE_DEPLOY_BOUND},
      ${entry.command}, ${entry.resourceType}, ${entry.resourceId},
      ${entry.reason}, ${randomUUID()}, ${tx.json(entry.detail as never)}
    )
  `;
}

async function requireTenant(tx: postgres.TransactionSql, slug: string): Promise<string> {
  const [tenant] = await tx<{ id: string }[]>`
    SELECT id FROM core.tenants WHERE slug = ${slug}
  `;
  if (!tenant) {
    throw new BootstrapRegistryError(
      `Tenant not found — ${slug}. Insert people first (\`pnpm --filter @mpc/api bootstrap\`)`,
    );
  }
  return tenant.id;
}

// --- credential -------------------------------------------------------------

export interface CredentialInput {
  readonly tenantSlug: string;
  /** Wallet of the credential holder. Must already be in via `bootstrap`. */
  readonly walletAddress: string;
  /** Issuing body and credential number. Must be strings a human can cross-check. */
  readonly issuerReference: string;
  /** `competent_person`·`laboratory`·`legal_practitioner`, etc. */
  readonly credentialType: string;
  /** Claim types this credential covers. Empty blocks signing. */
  readonly credentialScope: readonly string[];
  readonly jurisdiction: readonly string[];
  readonly issuedAt: string;
  /** Absent means a credential without expiry. If present it must be in the future. */
  readonly expiresAt: string | null;
}

export interface BootstrapRegistryResult {
  readonly id: string;
  readonly created: boolean;
  readonly state: string;
}

export async function bootstrapCredential(
  sql: postgres.Sql,
  input: CredentialInput,
): Promise<BootstrapRegistryResult> {
  const wallet = input.walletAddress.toLowerCase();

  if (input.credentialScope.length === 0) {
    throw new BootstrapRegistryError(
      "credentialScope is empty. Signing with an unscoped credential is rejected (02 §2.5)",
    );
  }
  if (input.issuerReference.trim() === "" || input.credentialType.trim() === "") {
    throw new BootstrapRegistryError("issuerReference and credentialType are required");
  }

  const issuedAt = new Date(input.issuedAt);
  if (Number.isNaN(issuedAt.getTime())) {
    throw new BootstrapRegistryError(`Cannot parse issuedAt — ${input.issuedAt}`);
  }

  let expiresAt: Date | null = null;
  if (input.expiresAt !== null) {
    expiresAt = new Date(input.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new BootstrapRegistryError(`Cannot parse expiresAt — ${input.expiresAt}`);
    }
    // Do not insert an already-expired credential as `valid`. The signing-time check would pass,
    // and a false status would remain in the attestation's credential snapshot (AC-12·AC-17).
    if (expiresAt.getTime() <= Date.now()) {
      throw new BootstrapRegistryError(
        `expiresAt is in the past — ${input.expiresAt}. Expired credentials are not registered as valid`,
      );
    }
  }

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    // The organization comes from the earliest-created role binding. LIMIT 1 without ordering
    // returns a different organization each time for people bound to several — if the credential's
    // organization changes per run, the basis for independence judgments shifts.
    const [identity] = await tx<{ subject_id: string | null; organization_id: string | null }[]>`
      SELECT w.subject_id, rb.organization_id
      FROM core.wallet_identities w
      LEFT JOIN core.role_bindings rb
        ON rb.subject_id = w.subject_id AND rb.revoked_at IS NULL
      WHERE w.wallet_address = ${wallet} AND w.tenant_id = ${tenantId}
        AND w.disabled_at IS NULL
      ORDER BY rb.granted_at NULLS LAST, rb.id
      LIMIT 1
    `;

    if (!identity?.subject_id) {
      throw new BootstrapRegistryError(
        `Wallet ${wallet} is not in this tenant. Insert people first`,
      );
    }

    const existing = await tx<{ id: string; current_status: string }[]>`
      SELECT id, current_status FROM core.credentials
      WHERE tenant_id = ${tenantId} AND subject_id = ${identity.subject_id}
        AND issuer_reference = ${input.issuerReference}
    `;
    const found = existing[0];
    if (found) return { id: found.id, created: false, state: found.current_status };

    const id = randomUUID();
    await tx`
      INSERT INTO core.credentials (
        id, tenant_id, subject_id, organization_id, issuer_reference,
        credential_type, credential_scope, jurisdiction, issued_at, expires_at,
        current_status
      ) VALUES (
        ${id}, ${tenantId}, ${identity.subject_id}, ${identity.organization_id},
        ${input.issuerReference}, ${input.credentialType},
        ${input.credentialScope as string[]}, ${input.jurisdiction as string[]},
        ${issuedAt}, ${expiresAt}, 'valid'
      )
    `;

    await recordBootstrapAudit(tx, {
      tenantId,
      command: "bootstrap.credential.created",
      resourceType: "credential",
      resourceId: id,
      reason: null,
      detail: {
        issuerReference: input.issuerReference,
        credentialType: input.credentialType,
        scope: input.credentialScope,
      },
    });

    return { id, created: true, state: "valid" };
  });
}

// --- attestation schema -----------------------------------------------------

export interface AttestationSchemaInput {
  readonly tenantSlug: string;
  readonly schemaKey: string;
  readonly schemaVersion: string;
  readonly attestationType: string;
  readonly requiredEvidence: readonly string[];
  readonly acceptedAuthorityTypes: readonly string[];
  /** Limitations every attestation made with this schema must disclose. */
  readonly mandatoryLimitations: readonly string[];
  readonly jurisdictionProfile: string;
  /**
   * The person stated to have approved.
   *
   * Absent means `draft` — signing is rejected in that state. Present means `active`, and the
   * name is recorded in audit. It is **a statement by the operator**, not a fact the app
   * verified, and is recorded as such (a limitation until the 02 §2.8 approval path exists).
   */
  readonly approvedBy: string | null;
}

export async function bootstrapAttestationSchema(
  sql: postgres.Sql,
  input: AttestationSchemaInput,
): Promise<BootstrapRegistryResult> {
  if (input.mandatoryLimitations.length === 0) {
    throw new BootstrapRegistryError(
      "mandatoryLimitations is empty. Review schemas without limitations are not created (AC-01)",
    );
  }

  const state = input.approvedBy === null ? "draft" : "active";

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    const existing = await tx<{ id: string; state: string }[]>`
      SELECT id, state FROM core.attestation_schemas
      WHERE tenant_id = ${tenantId} AND schema_key = ${input.schemaKey}
        AND schema_version = ${input.schemaVersion}
    `;
    const found = existing[0];
    if (found) {
      // Registration and approval must be splittable into two steps (02 §2.8). Without a path to
      // approve a draft later, the only option is one person doing everything at once.
      if (found.state === "draft" && input.approvedBy !== null) {
        await tx`
          UPDATE core.attestation_schemas SET state = 'active' WHERE id = ${found.id}
        `;
        await recordBootstrapAudit(tx, {
          tenantId,
          command: "bootstrap.attestation_schema.approved",
          resourceType: "attestation_schema",
          resourceId: found.id,
          reason: input.approvedBy,
          detail: { schemaKey: input.schemaKey, approvalIsOperatorStatement: true },
        });
        return { id: found.id, created: false, state: "active" };
      }
      return { id: found.id, created: false, state: found.state };
    }

    const id = randomUUID();
    await tx`
      INSERT INTO core.attestation_schemas (
        id, tenant_id, schema_key, schema_version, attestation_type,
        required_evidence, accepted_authority_types, mandatory_limitations,
        jurisdiction_profile, state
      ) VALUES (
        ${id}, ${tenantId}, ${input.schemaKey}, ${input.schemaVersion},
        ${input.attestationType}::core.attestation_type,
        ${input.requiredEvidence as string[]}, ${input.acceptedAuthorityTypes as string[]},
        ${input.mandatoryLimitations as string[]}, ${input.jurisdictionProfile}, ${state}
      )
    `;

    await recordBootstrapAudit(tx, {
      tenantId,
      command: "bootstrap.attestation_schema.created",
      resourceType: "attestation_schema",
      resourceId: id,
      reason: input.approvedBy,
      detail: {
        schemaKey: input.schemaKey,
        schemaVersion: input.schemaVersion,
        state,
        approvalIsOperatorStatement: input.approvedBy !== null,
      },
    });

    return { id, created: true, state };
  });
}

// --- compliance policy set --------------------------------------------------

export interface PolicySetInput {
  readonly tenantSlug: string;
  /** Rule set from `packages/policy`. Parsed and rejected here. */
  readonly definition: unknown;
  /** Same meaning as for the attestation schema. Absent means `draft`. */
  readonly approvedBy: string | null;
}

export async function bootstrapPolicySet(
  sql: postgres.Sql,
  input: PolicySetInput,
): Promise<BootstrapRegistryResult> {
  // Rules being data means they are validated (OD-15). Inserting without parsing breaks only at
  // evaluation time, when the problem shows up only as an error on the gate screen.
  let ruleSet;
  try {
    ruleSet = parseRuleSet(input.definition);
  } catch (error) {
    throw new BootstrapRegistryError(
      `Rule set failed schema validation — ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const state = input.approvedBy === null ? "draft" : "effective";

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    const existing = await tx<{ id: string; state: string }[]>`
      SELECT id, state FROM core.compliance_policy_sets
      WHERE tenant_id = ${tenantId} AND rule_set_id = ${ruleSet.ruleSetId}
        AND rule_set_version = ${ruleSet.version}
    `;
    const found = existing[0];
    if (found) {
      // Same as schema — inserting and approving must be separable.
      if (found.state === "draft" && input.approvedBy !== null) {
        await tx`
          UPDATE core.compliance_policy_sets SET state = 'effective' WHERE id = ${found.id}
        `;
        await recordBootstrapAudit(tx, {
          tenantId,
          command: "bootstrap.policy_set.approved",
          resourceType: "compliance_policy_set",
          resourceId: found.id,
          reason: input.approvedBy,
          detail: { ruleSetId: ruleSet.ruleSetId, approvalIsOperatorStatement: true },
        });
        return { id: found.id, created: false, state: "effective" };
      }
      return { id: found.id, created: false, state: found.state };
    }

    const id = randomUUID();
    await tx`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, retroactive, definition, state
      ) VALUES (
        ${id}, ${tenantId}, ${ruleSet.ruleSetId}, ${ruleSet.version}, ${ruleSet.gateId},
        ${ruleSet.jurisdictionProfile}, ${new Date(ruleSet.effectiveFrom)},
        ${ruleSet.retroactive}, ${tx.json(input.definition as never)}, ${state}
      )
    `;

    await recordBootstrapAudit(tx, {
      tenantId,
      command: "bootstrap.policy_set.created",
      resourceType: "compliance_policy_set",
      resourceId: id,
      reason: input.approvedBy,
      detail: {
        ruleSetId: ruleSet.ruleSetId,
        version: ruleSet.version,
        gateId: ruleSet.gateId,
        requirementCount: ruleSet.requirements.length,
        state,
        approvalIsOperatorStatement: input.approvedBy !== null,
      },
    });

    return { id, created: true, state };
  });
}
