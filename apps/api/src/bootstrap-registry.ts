import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { ROLE_DEPLOY_BOUND } from "./audit.js";
import {
  findAttestationSchema,
  findCredential,
  findPolicySet,
  holderOrganization,
  materializeAttestationSchema,
  materializeCredential,
  materializePolicySet,
  validateAttestationSchema,
  validateCredential,
  validatePolicySet,
  type CredentialFields,
} from "./services/review-registry.js";

/**
 * Inserts the three things needed to start review into a deployed system.
 *
 * When `bootstrap.ts` inserts people, login and project registration work. It stops there —
 * review assignment requires the reviewer's **credential** and an **attestation schema**, and
 * readiness evaluation requires a **policy rule set**.
 *
 * **This is the seed path, not the approval path.** 02 §2.8 separates proposal from approval;
 * that separation lives in the review-registry API (`routes/review-registry.ts`), where the
 * proposer and the approver are different identified people. This CLI exists for a fresh
 * environment where nobody can approve yet, and it does not hide that: it records in audit **who
 * was stated to have approved**, as a statement.
 *
 * Both paths validate and write through `services/review-registry.ts`, so a row seeded here and
 * a row approved through the API are the same row.
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

export interface CredentialInput extends CredentialFields {
  readonly tenantSlug: string;
  /** Wallet of the credential holder. Must already be in via `bootstrap`. */
  readonly walletAddress: string;
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

  const checked = validateCredential(input, new Date());
  if (!checked.ok) throw new BootstrapRegistryError(checked.message);

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    const [identity] = await tx<{ subject_id: string | null }[]>`
      SELECT subject_id FROM core.wallet_identities
      WHERE wallet_address = ${wallet} AND tenant_id = ${tenantId}
        AND disabled_at IS NULL
      ORDER BY created_at
      LIMIT 1
    `;
    if (!identity?.subject_id) {
      throw new BootstrapRegistryError(
        `Wallet ${wallet} is not in this tenant. Insert people first`,
      );
    }

    const found = await findCredential(tx, tenantId, identity.subject_id, input.issuerReference);
    if (found) return { id: found.id, created: false, state: found.currentStatus };

    const id = randomUUID();
    await materializeCredential(tx, {
      id,
      tenantId,
      subjectId: identity.subject_id,
      organizationId: await holderOrganization(tx, tenantId, identity.subject_id),
      credential: checked.value,
    });

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
   * verified, and is recorded as such. The verified path is the review-registry API.
   */
  readonly approvedBy: string | null;
}

export async function bootstrapAttestationSchema(
  sql: postgres.Sql,
  input: AttestationSchemaInput,
): Promise<BootstrapRegistryResult> {
  const checked = validateAttestationSchema(input);
  if (!checked.ok) throw new BootstrapRegistryError(checked.message);

  const state = input.approvedBy === null ? "draft" : "active";

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    const found = await findAttestationSchema(tx, tenantId, input.schemaKey, input.schemaVersion);
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
    await materializeAttestationSchema(tx, { id, tenantId, schema: checked.value, state });

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
  const checked = validatePolicySet(input.definition);
  if (!checked.ok) throw new BootstrapRegistryError(checked.message);
  const ruleSet = checked.value;

  const state = input.approvedBy === null ? "draft" : "effective";

  return sql.begin(async (tx) => {
    const tenantId = await requireTenant(tx, input.tenantSlug);

    const found = await findPolicySet(tx, tenantId, ruleSet.ruleSetId, ruleSet.version);
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
    await materializePolicySet(tx, { id, tenantId, ruleSet, definition: input.definition, state });

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
