import type postgres from "postgres";
import {
  canonicalAcceptanceBlockers,
  evaluateAuthorityBasis,
  reviewIndependence,
  type AcceptanceBlocker,
  type AuthorityBasis,
  type AuthorityFacts,
  type AuthorityState,
  type CredentialCurrentStatus,
  type IndependenceReview,
} from "@mpc/domain";

/**
 * What an assignment or an attestation stands on — spec 02 §2.4·§2.9, 13 AC-15·AC-16·AC-17.
 *
 * The facts are read here, once, and judged by the domain. Assignment, drafting and signature
 * submission all ask the same questions; if each route wrote its own queries, "accepted issuer"
 * or "the reviewer's organization" would come to mean different things in different places.
 */

type Tx = postgres.TransactionSql;

interface AuthorityRow {
  state: AuthorityState;
  valid_from: string;
  valid_until: string | null;
  recognized_scope: string[];
}

function toAuthorityFacts(row: AuthorityRow): AuthorityFacts {
  return {
    state: row.state,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    recognizedScope: row.recognized_scope,
  };
}

export interface CredentialFacts {
  readonly id: string;
  readonly subjectId: string;
  readonly organizationId: string | null;
  readonly currentStatus: CredentialCurrentStatus;
  readonly credentialScope: readonly string[];
  readonly issuerAuthorityId: string | null;
}

export async function loadCredential(tx: Tx, credentialId: string): Promise<CredentialFacts | null> {
  const [row] = await tx<
    {
      id: string;
      subject_id: string;
      organization_id: string | null;
      current_status: CredentialCurrentStatus;
      credential_scope: string[];
      issuer_authority_id: string | null;
    }[]
  >`
    SELECT id, subject_id, organization_id, current_status, credential_scope, issuer_authority_id
    FROM core.credentials WHERE id = ${credentialId}
  `;
  if (!row) return null;
  return {
    id: row.id,
    subjectId: row.subject_id,
    organizationId: row.organization_id,
    currentStatus: row.current_status,
    credentialScope: row.credential_scope,
    issuerAuthorityId: row.issuer_authority_id,
  };
}

/** Today in UTC as `YYYY-MM-DD`, the grain authority validity periods are recorded in. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The authority basis for reviewing these claims with this credential — AC-15·AC-16.
 *
 * The issuer is the authority linked to the credential. Source authorities are those behind the
 * receipts the claims were recorded from; a claim entered by hand has none, and its basis rests
 * on the issuer alone.
 */
export async function loadAuthorityBasis(
  tx: Tx,
  credential: CredentialFacts,
  claimIds: readonly string[],
): Promise<AuthorityBasis> {
  const [issuer] = credential.issuerAuthorityId
    ? await tx<AuthorityRow[]>`
        SELECT state, to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
               to_char(valid_until, 'YYYY-MM-DD') AS valid_until, recognized_scope
        FROM core.authorities WHERE id = ${credential.issuerAuthorityId}
      `
    : [];

  const claims = await tx<{ claim_type: string }[]>`
    SELECT claim_type FROM core.claims WHERE id = ANY(${claimIds as string[]}::uuid[])
  `;

  const sources = await tx<AuthorityRow[]>`
    SELECT DISTINCT au.id, au.state, to_char(au.valid_from, 'YYYY-MM-DD') AS valid_from,
           to_char(au.valid_until, 'YYYY-MM-DD') AS valid_until, au.recognized_scope
    FROM core.claims c
    JOIN core.source_receipts r ON r.id = c.source_receipt_id
    JOIN core.authorities au ON au.id = r.authority_id
    WHERE c.id = ANY(${claimIds as string[]}::uuid[])
  `;

  return evaluateAuthorityBasis({
    issuer: issuer ? toAuthorityFacts(issuer) : null,
    sourceAuthorities: sources.map(toAuthorityFacts),
    claimTypes: claims.map((claim) => claim.claim_type),
    credentialScope: credential.credentialScope,
    asOf: today(),
  });
}

/**
 * Everything that stops a credential from being a basis, as one list.
 *
 * `canonicalAcceptanceBlockers` covers the five facts of invariants 13·14; a credential whose
 * scope does not cover the claims is a sixth, reported alongside so the caller sees every reason
 * at once instead of fixing them one refusal at a time.
 */
export type BasisBlocker = AcceptanceBlocker | "CREDENTIAL_SCOPE_MISMATCH";

export function basisBlockers(input: {
  readonly basis: AuthorityBasis;
  readonly credentialStatus: CredentialCurrentStatus;
  readonly signatureValid: boolean;
  readonly assignedToThisCase: boolean;
}): BasisBlocker[] {
  const blockers: BasisBlocker[] = canonicalAcceptanceBlockers({
    signatureValid: input.signatureValid,
    authorityAccepted: input.basis.authorityAccepted,
    credentialValid: input.credentialStatus === "valid",
    assignedToThisCase: input.assignedToThisCase,
    claimWithinAuthorityScope: input.basis.claimWithinAuthorityScope,
  });
  if (!input.basis.credentialScopeCoversClaims) blockers.push("CREDENTIAL_SCOPE_MISMATCH");
  return blockers;
}

/**
 * Who submitted the evidence behind these claims — 02 §2.4 rule 1.
 *
 * Three records name a submitter: the claim itself, a manual source confirmation, and an upload
 * promoted to an artifact from the same receipt. A claim with no recorded submitter (created
 * before submitters were recorded) makes the set incomplete, and the caller must not treat an
 * incomplete set as "nobody".
 */
export async function loadEvidenceSubmitters(
  tx: Tx,
  claimIds: readonly string[],
): Promise<{ readonly submitterIds: readonly string[]; readonly allKnown: boolean }> {
  const [row] = await tx<{ submitters: string[] | null; unknown_count: string }[]>`
    WITH scoped AS (
      SELECT id, submitted_by, source_receipt_id FROM core.claims
      WHERE id = ANY(${claimIds as string[]}::uuid[])
    ),
    named AS (
      SELECT submitted_by AS subject_id FROM scoped
      UNION
      SELECT r.first_confirmed_by FROM scoped s JOIN core.source_receipts r ON r.id = s.source_receipt_id
      UNION
      SELECT r.second_confirmed_by FROM scoped s JOIN core.source_receipts r ON r.id = s.source_receipt_id
      UNION
      SELECT u.uploaded_by
      FROM scoped s
      JOIN core.artifacts a ON a.source_receipt_id = s.source_receipt_id
      JOIN core.object_uploads u ON u.promoted_artifact_id = a.id
    )
    SELECT
      (SELECT array_agg(DISTINCT subject_id::text) FROM named WHERE subject_id IS NOT NULL) AS submitters,
      (SELECT count(*)::text FROM scoped WHERE submitted_by IS NULL) AS unknown_count
  `;
  return {
    submitterIds: row?.submitters ?? [],
    allKnown: Number(row?.unknown_count ?? "1") === 0,
  };
}

/**
 * Organizations a reviewer acts for — the credential's organization and every active role
 * binding's. Rule 2 must see all of them: a reviewer bound to the operator through any role is
 * not independent of it.
 */
async function loadReviewerOrganizations(
  tx: Tx,
  reviewerSubjectId: string,
  credential: CredentialFacts,
): Promise<string[]> {
  const bindings = await tx<{ organization_id: string }[]>`
    SELECT DISTINCT organization_id FROM core.role_bindings
    WHERE subject_id = ${reviewerSubjectId} AND revoked_at IS NULL AND organization_id IS NOT NULL
  `;
  const ids = new Set(bindings.map((binding) => binding.organization_id));
  if (credential.organizationId) ids.add(credential.organizationId);
  return [...ids].sort();
}

export interface IndependenceResult {
  readonly review: IndependenceReview;
  /** Stored on the assignment so the judgment can be reproduced (REQ-DAPP-018). */
  readonly basis: Record<string, unknown>;
}

export async function reviewAssignmentIndependence(
  tx: Tx,
  input: {
    readonly projectId: string;
    readonly claimIds: readonly string[];
    readonly reviewerSubjectId: string;
    readonly assignerSubjectId: string | null;
    readonly credential: CredentialFacts;
  },
): Promise<IndependenceResult> {
  const submitters = await loadEvidenceSubmitters(tx, input.claimIds);
  const reviewerOrganizationIds = await loadReviewerOrganizations(
    tx,
    input.reviewerSubjectId,
    input.credential,
  );
  const [project] = await tx<{ owner_organization_id: string }[]>`
    SELECT owner_organization_id FROM core.projects WHERE id = ${input.projectId}
  `;
  const operatorOrganizationIds = project ? [project.owner_organization_id] : [];

  const review = reviewIndependence({
    reviewerSubjectId: input.reviewerSubjectId,
    assignerSubjectId: input.assignerSubjectId,
    evidenceSubmitterIds: submitters.submitterIds,
    allSubmittersKnown: submitters.allKnown,
    reviewerOrganizationIds,
    operatorOrganizationIds,
  });

  return {
    review,
    basis: {
      rules: ["02 §2.4 rule 1", "02 §2.4 rule 2", "02 §2.8 self-assignment"],
      evidenceSubmitterIds: [...submitters.submitterIds].sort(),
      allSubmittersKnown: submitters.allKnown,
      reviewerOrganizationIds,
      operatorOrganizationIds,
      violations: review.violations,
      gaps: review.gaps,
    },
  };
}

/**
 * The attestation schema and policy versions in force when an attestation is made — 04 §4.2,
 * REQ-DAPP-037·046.
 *
 * `method_version` is the schema the review follows (`schemaKey@schemaVersion`).
 * `policy_version` lists the compliance policy sets effective for the schema's jurisdiction
 * profile at that moment. When none is effective it says so — recording a placeholder version
 * would claim a policy that did not exist.
 */
export const NO_EFFECTIVE_POLICY = "none_effective";

export async function versionsInForce(
  tx: Tx,
  schemaId: string,
): Promise<{ readonly methodVersion: string; readonly policyVersion: string }> {
  const [schema] = await tx<
    { schema_key: string; schema_version: string; jurisdiction_profile: string }[]
  >`
    SELECT schema_key, schema_version, jurisdiction_profile
    FROM core.attestation_schemas WHERE id = ${schemaId}
  `;
  if (!schema) throw new Error(`attestation schema ${schemaId} not found`);

  const policies = await tx<{ rule_set_id: string; rule_set_version: string }[]>`
    SELECT rule_set_id, rule_set_version FROM core.compliance_policy_sets
    WHERE state = 'effective' AND effective_from <= now()
      AND jurisdiction_profile = ${schema.jurisdiction_profile}
    ORDER BY rule_set_id, rule_set_version
  `;

  return {
    methodVersion: `${schema.schema_key}@${schema.schema_version}`,
    policyVersion:
      policies.length === 0
        ? NO_EFFECTIVE_POLICY
        : policies.map((policy) => `${policy.rule_set_id}@${policy.rule_set_version}`).join(","),
  };
}
