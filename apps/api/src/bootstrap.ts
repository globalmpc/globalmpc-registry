import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ROLE_MINIMUM_ASSURANCE, satisfiesAssurance } from "@mpc/api-contract";
import type { AssuranceLevel } from "@mpc/api-contract";

/**
 * Operational bootstrap — inserts the first person into a deployed system.
 *
 * Migrations create only the schema. Without a tenant, organization, subject, wallet, and role
 * on top, SIWE login works but grants no role. The screens load, but nothing can be done.
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
  readonly walletAddress: string;
  /** 56 (BSC mainnet) or 97 (BSC testnet). */
  readonly chainId: number;
  readonly role: string;
  readonly assuranceLevel: AssuranceLevel;
}

export interface BootstrapResult {
  readonly tenantId: string;
  readonly organizationId: string;
  readonly subjectId: string;
  /** Whether this call created the wallet and subject. False if they already existed. */
  readonly created: boolean;
  /** Whether this call created the role assignment. */
  readonly roleGranted: boolean;
}

const ASSURANCE_LEVELS: readonly AssuranceLevel[] = [
  "wallet_only",
  "identity_bound",
  "high_assurance",
];

const WALLET_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * Validates all input first.
 *
 * If it fails after half the data is in the DB, the next run cannot tell what to fix.
 * Assurance in particular is not enforced by the DB — a low value still inserts the row, every
 * request gets 403, and the screen shows no reason. So it is blocked here.
 */
function validate(input: BootstrapInput): { walletAddress: string } {
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

  const walletAddress = input.walletAddress.toLowerCase();
  if (!WALLET_PATTERN.test(walletAddress)) {
    throw new BootstrapError(`walletAddress is malformed — ${input.walletAddress}`);
  }

  // The API accepts only 56 and 97. A wallet bound to another chain cannot log in.
  if (input.chainId !== 56 && input.chainId !== 97) {
    throw new BootstrapError("chainId must be 56 (BSC mainnet) or 97 (BSC testnet)");
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

  return { walletAddress };
}

export async function bootstrapOperator(
  sql: postgres.Sql,
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const { walletAddress } = validate(input);

  return sql.begin(async (tx) => {
    // Check the wallet first. If it is already bound to another tenant, stop before creating the
    // tenant — rejecting after creation leaves an unused tenant behind.
    const existingWallet = await tx<
      { tenant_id: string; subject_id: string | null; disabled_at: Date | null }[]
    >`
      SELECT tenant_id, subject_id, disabled_at
      FROM core.wallet_identities
      WHERE wallet_address = ${walletAddress} AND chain_id = ${input.chainId}
    `;

    const tenantId = await upsertTenant(tx, input);

    const wallet = existingWallet[0];
    if (wallet && wallet.tenant_id !== tenantId) {
      throw new BootstrapError(
        `This wallet is already bound to another tenant (${wallet.tenant_id}). One key cannot hold authority in two tenants`,
      );
    }
    if (wallet && wallet.disabled_at !== null) {
      throw new BootstrapError(
        "This wallet is inactive. Key rotation goes through the recovery procedure, not bootstrap (AC-27)",
      );
    }

    const organizationId = await upsertOrganization(tx, tenantId, input);

    let subjectId = wallet?.subject_id ?? null;
    const created = subjectId === null;

    if (subjectId === null) {
      subjectId = randomUUID();
      await tx`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name)
        VALUES (${subjectId}, ${tenantId}, 'person', ${input.subjectName})
      `;
      await tx`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
        ) VALUES (
          ${randomUUID()}, ${tenantId}, ${subjectId}, ${walletAddress},
          ${input.chainId}, ${input.assuranceLevel}, now()
        )
      `;
    }

    const roleGranted = await grantRole(tx, {
      tenantId,
      subjectId,
      organizationId,
      role: input.role,
    });

    return { tenantId, organizationId, subjectId, created, roleGranted };
  });
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
  args: { tenantId: string; subjectId: string; organizationId: string; role: string },
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

  await tx`
    INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
    VALUES (${randomUUID()}, ${args.tenantId}, ${args.subjectId}, ${args.organizationId}, ${args.role})
  `;
  return true;
}
