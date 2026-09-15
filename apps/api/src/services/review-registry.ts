import type postgres from "postgres";
import { ATTESTATION_TYPES, type AttestationType } from "@mpc/domain";
import { safeParseRuleSet, type RuleSet } from "@mpc/policy";

/**
 * The three review registries — credentials, attestation schemas, compliance policy sets.
 *
 * **One validation and one write path for both callers.** The API approval route
 * (`routes/review-registry.ts`) and the bootstrap CLI (`bootstrap-registry.ts`) both validate
 * with the functions here and both insert through the `materialize*` functions here. If the two
 * paths wrote their own INSERTs, a column one path fills and the other leaves to a default would
 * make signing and readiness treat "the same" row differently depending on who created it.
 *
 * Validation returns a result instead of throwing: the route turns a failure into a 422, the
 * CLI into its own error, and neither has to guess which exceptions are expected.
 */

type Tx = postgres.TransactionSql;

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };

function valid<T>(value: T): Validated<T> {
  return { ok: true, value };
}

function invalid<T>(code: string, message: string, details?: Record<string, unknown>): Validated<T> {
  return details ? { ok: false, code, message, details } : { ok: false, code, message };
}

function parseDate(value: string): Date | null {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// --- credential -------------------------------------------------------------

export interface CredentialFields {
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

export interface ValidCredential {
  readonly issuerReference: string;
  readonly credentialType: string;
  readonly credentialScope: readonly string[];
  readonly jurisdiction: readonly string[];
  readonly issuedAt: Date;
  readonly expiresAt: Date | null;
}

const CREDENTIAL_INVALID = "CREDENTIAL_INVALID";

export function validateCredential(input: CredentialFields, now: Date): Validated<ValidCredential> {
  if (input.credentialScope.length === 0) {
    return invalid(
      CREDENTIAL_INVALID,
      "credentialScope is empty. Signing with an unscoped credential is rejected (02 §2.5)",
    );
  }
  if (input.issuerReference.trim() === "" || input.credentialType.trim() === "") {
    return invalid(CREDENTIAL_INVALID, "issuerReference and credentialType are required");
  }

  const issuedAt = parseDate(input.issuedAt);
  if (!issuedAt) return invalid(CREDENTIAL_INVALID, `Cannot parse issuedAt — ${input.issuedAt}`);

  const fields = {
    issuerReference: input.issuerReference,
    credentialType: input.credentialType,
    credentialScope: [...input.credentialScope],
    jurisdiction: [...input.jurisdiction],
    issuedAt,
  };
  if (input.expiresAt === null) return valid({ ...fields, expiresAt: null });

  const expiresAt = parseDate(input.expiresAt);
  if (!expiresAt) return invalid(CREDENTIAL_INVALID, `Cannot parse expiresAt — ${input.expiresAt}`);

  // Do not insert an already-expired credential as `valid`. The signing-time check would pass,
  // and a false status would remain in the attestation's credential snapshot (AC-12·AC-17).
  if (expiresAt.getTime() <= now.getTime()) {
    return invalid(
      CREDENTIAL_INVALID,
      `expiresAt is in the past — ${input.expiresAt}. Expired credentials are not registered as valid`,
    );
  }
  return valid({ ...fields, expiresAt });
}

/**
 * The organization a credential is attached to.
 *
 * Taken from the holder's earliest-granted active role binding. LIMIT 1 without ordering returns
 * a different organization each time for people bound to several — if the credential's
 * organization changes per run, the basis for independence judgments shifts.
 */
export async function holderOrganization(
  tx: Tx,
  tenantId: string,
  subjectId: string,
): Promise<string | null> {
  const [binding] = await tx<{ organization_id: string | null }[]>`
    SELECT organization_id FROM core.role_bindings
    WHERE tenant_id = ${tenantId} AND subject_id = ${subjectId} AND revoked_at IS NULL
    ORDER BY granted_at, id
    LIMIT 1
  `;
  return binding?.organization_id ?? null;
}

/** A holder's credential with this issuer reference. Holder + reference is the credential's identity. */
export async function findCredential(
  tx: Tx,
  tenantId: string,
  subjectId: string,
  issuerReference: string,
): Promise<{ readonly id: string; readonly currentStatus: string } | null> {
  const [row] = await tx<{ id: string; current_status: string }[]>`
    SELECT id, current_status FROM core.credentials
    WHERE tenant_id = ${tenantId} AND subject_id = ${subjectId}
      AND issuer_reference = ${issuerReference}
    ORDER BY created_at, id
    LIMIT 1
  `;
  return row ? { id: row.id, currentStatus: row.current_status } : null;
}

export interface CredentialRow {
  readonly id: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly organizationId: string | null;
  readonly credential: ValidCredential;
}

/** Always `valid` — an expired or unscoped credential never gets this far. */
export async function materializeCredential(tx: Tx, row: CredentialRow): Promise<void> {
  const { credential } = row;
  await tx`
    INSERT INTO core.credentials (
      id, tenant_id, subject_id, organization_id, issuer_reference,
      credential_type, credential_scope, jurisdiction, issued_at, expires_at,
      current_status
    ) VALUES (
      ${row.id}, ${row.tenantId}, ${row.subjectId}, ${row.organizationId},
      ${credential.issuerReference}, ${credential.credentialType},
      ${credential.credentialScope as string[]}, ${credential.jurisdiction as string[]},
      ${credential.issuedAt}, ${credential.expiresAt}, 'valid'
    )
  `;
}

// --- attestation schema -----------------------------------------------------

export interface AttestationSchemaFields {
  readonly schemaKey: string;
  readonly schemaVersion: string;
  readonly attestationType: string;
  readonly requiredEvidence: readonly string[];
  readonly acceptedAuthorityTypes: readonly string[];
  /** Limitations every attestation made with this schema must disclose. */
  readonly mandatoryLimitations: readonly string[];
  readonly jurisdictionProfile: string;
}

export interface ValidAttestationSchema extends AttestationSchemaFields {
  readonly attestationType: AttestationType;
}

const SCHEMA_INVALID = "ATTESTATION_SCHEMA_INVALID";

function isAttestationType(value: string): value is AttestationType {
  return (ATTESTATION_TYPES as readonly string[]).includes(value);
}

export function validateAttestationSchema(
  input: AttestationSchemaFields,
): Validated<ValidAttestationSchema> {
  if (input.mandatoryLimitations.length === 0) {
    return invalid(
      SCHEMA_INVALID,
      "mandatoryLimitations is empty. Review schemas without limitations are not created (AC-01)",
    );
  }
  if (
    input.schemaKey.trim() === "" ||
    input.schemaVersion.trim() === "" ||
    input.jurisdictionProfile.trim() === ""
  ) {
    return invalid(SCHEMA_INVALID, "schemaKey, schemaVersion and jurisdictionProfile are required");
  }
  const attestationType = input.attestationType;
  if (!isAttestationType(attestationType)) {
    return invalid(SCHEMA_INVALID, `Unknown attestationType — ${attestationType}`, {
      allowed: ATTESTATION_TYPES,
    });
  }
  return valid({
    schemaKey: input.schemaKey,
    schemaVersion: input.schemaVersion,
    attestationType,
    requiredEvidence: [...input.requiredEvidence],
    acceptedAuthorityTypes: [...input.acceptedAuthorityTypes],
    mandatoryLimitations: [...input.mandatoryLimitations],
    jurisdictionProfile: input.jurisdictionProfile,
  });
}

export async function findAttestationSchema(
  tx: Tx,
  tenantId: string,
  schemaKey: string,
  schemaVersion: string,
): Promise<{ readonly id: string; readonly state: string } | null> {
  const [row] = await tx<{ id: string; state: string }[]>`
    SELECT id, state FROM core.attestation_schemas
    WHERE tenant_id = ${tenantId} AND schema_key = ${schemaKey}
      AND schema_version = ${schemaVersion}
  `;
  return row ?? null;
}

/** `draft` cannot be signed with; `active` can. Only the bootstrap CLI writes `draft`. */
export type AttestationSchemaState = "draft" | "active";

export async function materializeAttestationSchema(
  tx: Tx,
  row: {
    readonly id: string;
    readonly tenantId: string;
    readonly schema: ValidAttestationSchema;
    readonly state: AttestationSchemaState;
  },
): Promise<void> {
  const { schema } = row;
  await tx`
    INSERT INTO core.attestation_schemas (
      id, tenant_id, schema_key, schema_version, attestation_type,
      required_evidence, accepted_authority_types, mandatory_limitations,
      jurisdiction_profile, state
    ) VALUES (
      ${row.id}, ${row.tenantId}, ${schema.schemaKey}, ${schema.schemaVersion},
      ${schema.attestationType}::core.attestation_type,
      ${schema.requiredEvidence as string[]}, ${schema.acceptedAuthorityTypes as string[]},
      ${schema.mandatoryLimitations as string[]}, ${schema.jurisdictionProfile}, ${row.state}
    )
  `;
}

// --- compliance policy set --------------------------------------------------

/**
 * Rules being data means they are validated (OD-15). Inserting without parsing breaks only at
 * evaluation time, when the problem shows up only as an error on the gate screen.
 */
export function validatePolicySet(definition: unknown): Validated<RuleSet> {
  const parsed = safeParseRuleSet(definition);
  if (!parsed.success) {
    return invalid(
      "POLICY_SET_INVALID",
      `Rule set failed schema validation — ${parsed.error.message}`,
      { issues: parsed.error.issues },
    );
  }
  return valid(parsed.data);
}

export async function findPolicySet(
  tx: Tx,
  tenantId: string,
  ruleSetId: string,
  version: string,
): Promise<{ readonly id: string; readonly state: string } | null> {
  const [row] = await tx<{ id: string; state: string }[]>`
    SELECT id, state FROM core.compliance_policy_sets
    WHERE tenant_id = ${tenantId} AND rule_set_id = ${ruleSetId}
      AND rule_set_version = ${version}
  `;
  return row ?? null;
}

/** `draft` does not run evaluation; `effective` does. Only the bootstrap CLI writes `draft`. */
export type PolicySetState = "draft" | "effective";

/**
 * Row columns come from the parsed rule set; `definition` is stored as submitted, the same bytes
 * the bootstrap CLI stored before this function existed.
 */
export async function materializePolicySet(
  tx: Tx,
  row: {
    readonly id: string;
    readonly tenantId: string;
    readonly ruleSet: RuleSet;
    readonly definition: unknown;
    readonly state: PolicySetState;
  },
): Promise<void> {
  const { ruleSet } = row;
  await tx`
    INSERT INTO core.compliance_policy_sets (
      id, tenant_id, rule_set_id, rule_set_version, gate_id,
      jurisdiction_profile, effective_from, retroactive, definition, state
    ) VALUES (
      ${row.id}, ${row.tenantId}, ${ruleSet.ruleSetId}, ${ruleSet.version}, ${ruleSet.gateId},
      ${ruleSet.jurisdictionProfile}, ${new Date(ruleSet.effectiveFrom)},
      ${ruleSet.retroactive}, ${tx.json(row.definition as never)}, ${row.state}
    )
  `;
}
