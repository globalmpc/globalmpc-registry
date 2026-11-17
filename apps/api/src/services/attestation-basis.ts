import type postgres from "postgres";
import { canonicalBytes, keccak256 } from "@mpc/canonical";
import type { EvidenceSnapshot } from "./evidence-snapshot.js";
import { unprocessable } from "../errors.js";
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

interface ContributorScope {
  readonly claimIds: readonly string[];
  readonly projectId: string | null;
  readonly frozen: EvidenceSnapshot["manifest"] | null;
  readonly legacyCase: boolean;
  readonly createdAt: Date | null;
}

async function contributorScope(tx: Tx, claimIds: readonly string[], caseId: string | null): Promise<ContributorScope | null> {
  if (!caseId) return { claimIds, projectId: null, frozen: null, legacyCase: false, createdAt: null };
  const [row] = await tx<{
    project_id: string; evidence_snapshot_hash: string; evidence_snapshot: EvidenceSnapshot["manifest"] | null; created_at: Date;
  }[]>`SELECT project_id,evidence_snapshot_hash,evidence_snapshot,created_at FROM core.verification_cases WHERE id=${caseId}`;
  if (!row) return null;
  const frozen = row.evidence_snapshot;
  if (frozen) {
    if (frozen.claimIds.length === 0 || keccak256(canonicalBytes(frozen)) !== row.evidence_snapshot_hash) return null;
    return { claimIds: frozen.claimIds, projectId: row.project_id, frozen, legacyCase: false, createdAt: row.created_at };
  }
  // A subset attestation still signs the complete case hash. Historical cases restore their
  // assigned claim scope from the append-only links rather than trusting that subset.
  const claims = await tx<{ claim_id: string }[]>`SELECT claim_id FROM core.verification_case_claims WHERE case_id=${caseId}`;
  if (claims.length === 0) return null;
  return { claimIds: claims.map(c => c.claim_id), projectId: row.project_id, frozen: null, legacyCase: true, createdAt: row.created_at };
}

/**
 * Who submitted the evidence behind these claims — 02 §2.4 rule 1.
 *
 * Contributors include claim authors, effective receipt confirmers, and uploaders of the
 * active artifacts/direct documents in the signed snapshot. A claim with no recorded submitter (created
 * before submitters were recorded) makes the set incomplete, and the caller must not treat an
 * incomplete set as "nobody".
 */
export async function loadEvidenceSubmitters(
  tx: Tx,
  claimIds: readonly string[],
  snapshotCaseId: string | null = null,
  liveProjectId: string | null = null,
): Promise<{ readonly submitterIds: readonly string[]; readonly allKnown: boolean }> {
  const scope = await contributorScope(tx, claimIds, snapshotCaseId);
  if (!scope) return { submitterIds: [], allKnown: false };
  const { claimIds: scopedIds, projectId, frozen, legacyCase, createdAt } = scope;
  const [row] = await tx<{ submitters: string[] | null; unknown_count: string }[]>`
    WITH scoped AS (
      SELECT id, tenant_id, project_id, submitted_by, source_receipt_id, document_upload_ids FROM core.claims
      WHERE id = ANY(${scopedIds as string[]}::uuid[])
        AND (${projectId}::uuid IS NULL OR project_id=${projectId})
    ),
    projects AS (
      SELECT DISTINCT tenant_id,project_id FROM scoped
      UNION SELECT tenant_id,id FROM core.projects WHERE id=${liveProjectId}
    ),
    receipts AS (SELECT DISTINCT tenant_id,source_receipt_id FROM scoped WHERE source_receipt_id IS NOT NULL),
    scoped_artifacts AS (
      SELECT a.* FROM core.artifacts a
      WHERE EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id=a.tenant_id AND p.project_id=a.project_id)
        AND (${!legacyCase} OR a.created_at <= ${createdAt})
        AND (CASE WHEN ${!!frozen} THEN a.id=ANY(${frozen?.artifactIds ?? []}::uuid[])
          ELSE a.revoked_at IS NULL OR EXISTS (
            SELECT 1 FROM receipts r WHERE r.tenant_id=a.tenant_id AND r.source_receipt_id=a.source_receipt_id
          ) OR (${legacyCase} AND EXISTS (
            SELECT 1 FROM core.verification_cases c WHERE c.id=${snapshotCaseId} AND a.revoked_at >= c.created_at
          )) END)
    ),
    receipt_ids AS (
      SELECT r.id FROM core.source_receipts r
      WHERE CASE WHEN ${!!frozen} THEN r.id=ANY(${frozen?.receiptIds ?? []}::uuid[])
        ELSE (${legacyCase} AND EXISTS (
          SELECT 1 FROM projects p WHERE p.tenant_id=r.tenant_id AND p.project_id=r.project_id
        )) OR EXISTS (SELECT 1 FROM receipts x WHERE x.tenant_id=r.tenant_id AND x.source_receipt_id=r.id)
          OR EXISTS (SELECT 1 FROM scoped_artifacts a WHERE a.tenant_id=r.tenant_id AND a.source_receipt_id=r.id)
        END AND (${!legacyCase} OR r.created_at <= ${createdAt})
    ),
    contributing_receipts AS (
      SELECT r.* FROM receipt_ids ids JOIN core.source_receipts r ON r.id=ids.id
    ),
    uploads AS (
      SELECT u.id,u.uploaded_by FROM core.object_uploads u
      JOIN scoped_artifacts a ON a.tenant_id=u.tenant_id AND a.project_id=u.project_id AND a.id=u.promoted_artifact_id
      UNION
      SELECT u.id,u.uploaded_by FROM scoped s
      CROSS JOIN LATERAL unnest(s.document_upload_ids) document(id)
      LEFT JOIN core.object_uploads u
        ON u.tenant_id=s.tenant_id AND u.project_id=s.project_id AND u.id=document.id
      UNION
      SELECT u.id,u.uploaded_by FROM contributing_receipts r
      LEFT JOIN core.object_uploads u ON u.tenant_id=r.tenant_id
        AND u.id::text=r.channel_evidence ->> 'documentUploadId'
        AND (r.project_id IS NULL OR r.project_id=u.project_id)
        AND EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id=u.tenant_id AND p.project_id=u.project_id)
      WHERE r.channel_evidence ? 'documentUploadId'
        OR r.collection_method IN ('verifiable_signed_document','official_bulk_export')
    ),
    named AS (
      SELECT submitted_by AS subject_id FROM scoped
      UNION SELECT r.first_confirmed_by FROM contributing_receipts r
      UNION SELECT r.second_confirmed_by FROM contributing_receipts r
      UNION SELECT uploaded_by FROM uploads
    )
    SELECT
      (SELECT array_agg(DISTINCT subject_id::text) FROM named WHERE subject_id IS NOT NULL) AS submitters,
      ((${new Set(scopedIds).size} - (SELECT count(*) FROM scoped)) +
       (SELECT count(*) FROM scoped WHERE submitted_by IS NULL) +
       (CASE WHEN ${!!frozen} THEN ${frozen?.artifactIds.length ?? 0}-(SELECT count(*) FROM scoped_artifacts) ELSE 0 END) +
       (CASE WHEN ${!!frozen} THEN ${frozen?.receiptIds.length ?? 0}-(SELECT count(*) FROM contributing_receipts) ELSE 0 END) +
       (SELECT count(*) FROM uploads WHERE uploaded_by IS NULL) +
       (SELECT count(*) FROM scoped_artifacts a WHERE a.kind='raw_source' AND a.source_receipt_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM core.object_uploads u WHERE u.tenant_id=a.tenant_id
           AND u.project_id=a.project_id AND u.promoted_artifact_id=a.id)) +
       (SELECT count(*) FROM contributing_receipts WHERE collection_method='manual_official_registry_confirmation'
         AND (first_confirmed_by IS NULL OR (result='confirmed_from_source' AND second_confirmed_by IS NULL)
           OR first_confirmed_by=second_confirmed_by)))::text AS unknown_count
  `;
  return {
    submitterIds: row?.submitters ?? [],
    allKnown: Number(row?.unknown_count ?? "1") === 0,
  };
}

/**
 * Organizations a reviewer acts for — current credentials, the selected credential and active role
 * binding's. Rule 2 must see all of them: a reviewer bound to the operator through any role is
 * not independent of it.
 */
export async function loadReviewerOrganizations(
  tx: Tx,
  reviewerSubjectId: string,
  credential?: CredentialFacts,
): Promise<string[]> {
  const bindings = await tx<{ organization_id: string }[]>`
    SELECT DISTINCT organization_id FROM core.role_bindings
    WHERE subject_id = ${reviewerSubjectId} AND revoked_at IS NULL AND organization_id IS NOT NULL
    UNION
    SELECT organization_id FROM core.credentials
    WHERE subject_id=${reviewerSubjectId} AND organization_id IS NOT NULL
      AND current_status='valid' AND revoked_at IS NULL AND issued_at <= now()
      AND (expires_at IS NULL OR expires_at > now())
  `;
  const ids = new Set(bindings.map((binding) => binding.organization_id));
  if (credential?.organizationId) ids.add(credential.organizationId);
  return [...ids].sort();
}

/** Unknown organization cannot establish independence. All review boundaries share this rule. */
export function reviewerOrganizationsIndependent(organizations: readonly string[], operatorId: string): boolean {
  return organizations.length > 0 && !organizations.includes(operatorId);
}

/** Evidence is frozen; organizational affiliation remains live through signing. */
export async function assertReviewerOrganizationIndependence(
  tx: Tx, subjectId: string, credentialId: string, projectId: string,
): Promise<void> {
  const credential = await loadCredential(tx, credentialId);
  const organizations = credential ? await loadReviewerOrganizations(tx, subjectId, credential) : [];
  const [project] = await tx<{ owner_organization_id: string }[]>`
    SELECT owner_organization_id FROM core.projects WHERE id=${projectId}
  `;
  if (!credential || !project || !reviewerOrganizationsIndependent(organizations,project.owner_organization_id)) {
    throw unprocessable("ATTESTATION_OPERATOR_NOT_INDEPENDENT", "The reviewer must remain independent of the project's operating organization");
  }
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
    readonly caseId: string;
    readonly claimIds: readonly string[];
    readonly reviewerSubjectId: string;
    readonly assignerSubjectId: string | null;
    readonly credential: CredentialFacts;
  },
): Promise<IndependenceResult> {
  const submitters = await loadEvidenceSubmitters(tx, input.claimIds, input.caseId);
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

/** The tenant/schema-key activation clock is captured under the configuration barrier. */
export async function loadSchemaActivationEpoch(tx: Tx, schemaId: string): Promise<string> {
  const [row]=await tx<{epoch:string}[]>`SELECT COALESCE(clock.epoch,0)::text AS epoch
    FROM core.attestation_schemas s LEFT JOIN core.schema_activation_clocks clock
      ON clock.tenant_id=s.tenant_id AND clock.schema_key=s.schema_key WHERE s.id=${schemaId}`;
  if (!row) throw new Error("Attestation schema not found");
  return row.epoch;
}

/** A dismissed objection cannot renew a professional review whose live basis has changed. */
export async function attestationRestorationBlockers(tx: Tx, attestationId: string): Promise<string[]> {
  const [row] = await tx<{
    case_id:string; project_id:string; schema_id:string; credential_id:string; subject_id:string;
    claim_scope:string[]; method_version:string; policy_version:string; owner_organization_id:string;
    credential_current:boolean; schema_current:boolean; assignment_current:boolean; review_current:boolean;
  }[]>`SELECT a.case_id,vc.project_id,a.schema_id,a.credential_id,asg.subject_id,a.claim_scope,
      a.method_version,a.policy_version,p.owner_organization_id,
      (c.current_status='valid' AND c.revoked_at IS NULL AND c.issued_at<=now()
        AND (c.expires_at IS NULL OR c.expires_at>now())) AS credential_current,
      (s.state='active' AND a.schema_activation_epoch IS NOT NULL
        AND a.schema_activation_epoch=COALESCE((SELECT clock.epoch FROM core.schema_activation_clocks clock
          WHERE clock.tenant_id=s.tenant_id AND clock.schema_key=s.schema_key),0)) AS schema_current,
      (asg.case_id=a.case_id AND asg.revoked_at IS NULL AND asg.independence_reviewed
        AND asg.conflict_status<>'unresolved') AS assignment_current,
      (a.valid_until IS NULL OR a.valid_until>now()) AS review_current
    FROM core.verification_attestations a JOIN core.verification_cases vc ON vc.id=a.case_id
    JOIN core.projects p ON p.id=vc.project_id JOIN core.assignments asg ON asg.id=a.assignment_id
    JOIN core.credentials c ON c.id=a.credential_id JOIN core.attestation_schemas s ON s.id=a.schema_id
    WHERE a.id=${attestationId}`;
  if (!row) return ["REVIEW_BASIS_MISSING"];
  const blockers:string[]=[];
  if (!row.credential_current) blockers.push("CREDENTIAL_NOT_CURRENT");
  if (!row.schema_current) blockers.push("SCHEMA_NOT_CURRENT");
  if (!row.assignment_current) blockers.push("ASSIGNMENT_NOT_CURRENT");
  if (!row.review_current) blockers.push("REVIEW_EXPIRED");
  const credential=await loadCredential(tx,row.credential_id);
  if (!credential) return [...blockers,"CREDENTIAL_MISSING"];
  blockers.push(...basisBlockers({basis:await loadAuthorityBasis(tx,credential,row.claim_scope),
    credentialStatus:credential.currentStatus,signatureValid:true,assignedToThisCase:row.assignment_current}));
  if (!reviewerOrganizationsIndependent(await loadReviewerOrganizations(tx,row.subject_id,credential),row.owner_organization_id)) blockers.push("SIGNER_ORGANIZATION_NOT_INDEPENDENT");
  const contributors=await loadEvidenceSubmitters(tx,[],row.case_id);
  if (!contributors.allKnown || contributors.submitterIds.includes(row.subject_id)) blockers.push("SIGNER_EVIDENCE_NOT_INDEPENDENT");
  const scope=await contributorScope(tx,[],row.case_id);
  if (!scope) return [...blockers,"EVIDENCE_SCOPE_MISSING"];
  const [health]=await tx<{invalid:boolean}[]>`
    WITH claims AS (SELECT * FROM core.claims WHERE id=ANY(${scope.claimIds as string[]}::uuid[]) AND project_id=${row.project_id}),
    artifacts AS (SELECT * FROM core.artifacts a WHERE a.project_id=${row.project_id}
      AND CASE WHEN ${!!scope.frozen} THEN a.id=ANY(${scope.frozen?.artifactIds ?? []}::uuid[])
        ELSE a.created_at<=${scope.createdAt} AND (a.revoked_at IS NULL OR a.revoked_at>=${scope.createdAt}) END),
    receipts AS (SELECT * FROM core.source_receipts r WHERE
      CASE WHEN ${!!scope.frozen} THEN r.id=ANY(${scope.frozen?.receiptIds ?? []}::uuid[])
      ELSE r.id IN (SELECT source_receipt_id FROM claims UNION SELECT source_receipt_id FROM artifacts) END),
    uploads AS (SELECT u.* FROM core.object_uploads u WHERE u.project_id=${row.project_id} AND
      (u.id IN (SELECT unnest(document_upload_ids) FROM claims)
       OR u.promoted_artifact_id IN (SELECT id FROM artifacts)
       OR u.id::text IN (SELECT channel_evidence ->> 'documentUploadId' FROM receipts)))
    SELECT (${scope.claimIds.length}<>(SELECT count(*) FROM claims)
      OR (${!!scope.frozen} AND ${scope.frozen?.artifactIds.length ?? 0}<>(SELECT count(*) FROM artifacts))
      OR (${!!scope.frozen} AND ${scope.frozen?.receiptIds.length ?? 0}<>(SELECT count(*) FROM receipts))
      OR EXISTS(SELECT 1 FROM claims WHERE superseded_by_claim_id IS NOT NULL OR verification_state='rejected'
        OR (stale_since IS NOT NULL AND stale_since<=now()))
      OR EXISTS(SELECT 1 FROM artifacts WHERE revoked_at IS NOT NULL OR superseded_by IS NOT NULL
        OR lifecycle_state IN ('rejected','revoked','superseded'))
      OR EXISTS(SELECT 1 FROM uploads u WHERE u.revoked_at IS NOT NULL OR u.state NOT IN ('scanned_clean','promoted')
        OR u.valid_until < (now() AT TIME ZONE 'UTC')::date
        OR core.document_successor(u.id) IS NOT NULL
        OR EXISTS(SELECT 1 FROM core.document_impacts impact WHERE impact.upload_id=u.id AND impact.resolution='open')
        OR EXISTS(SELECT 1 FROM core.object_uploads upstream
          CROSS JOIN LATERAL core.document_impact_targets(upstream.id) targets
          WHERE upstream.tenant_id=u.tenant_id AND upstream.project_id=u.project_id AND targets.upload_id=u.id
            AND (upstream.revoked_at IS NOT NULL OR upstream.valid_until < (now() AT TIME ZONE 'UTC')::date
              OR core.document_successor(upstream.id) IS NOT NULL)))
      OR EXISTS(SELECT 1 FROM receipts WHERE result<>'confirmed_from_source')) AS invalid`;
  if (!health || health.invalid) blockers.push("EVIDENCE_NOT_CURRENT");
  const versions=await versionsInForce(tx,row.schema_id,row.project_id);
  if (versions.methodVersion!==row.method_version || versions.policyVersion!==row.policy_version) blockers.push("REVIEW_VERSIONS_CHANGED");
  return [...new Set(blockers)];
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
  projectId?: string,
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
      AND core.project_definition_applies(project_id,${projectId ?? null})
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
