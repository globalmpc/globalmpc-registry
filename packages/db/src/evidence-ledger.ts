import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { canonicalBytes, keccak256, type CanonicalValue } from "@mpc/canonical";
import { weakestGrade, type Grade, type ReadinessStatus } from "@mpc/domain";
import { evaluateAssessment, safeParseRuleSet, type RequirementFacts } from "@mpc/policy";

export type LedgerItemStatus = "missing" | "unreviewed" | "reviewed" | "needs_re_review" | "conflicting" | "rejected" | "not_applicable";
export interface LedgerReview {
  reviewerHandle:string; credentialType:string; attestationType:string; signedAt:string; limitations:string;
}
export interface LedgerItem {
  claimType: string; catalogVersion: number; displayName: string; status: LedgerItemStatus;
  grade: Grade | null; reviewScope: string[]; reviews: LedgerReview[]; claimIds: string[]; attestationIds: string[]; reasons: string[]; limitations: string[];
}
export interface LedgerStage {
  gateId: string; policySetId: string; ruleSetVersion: string; status: ReadinessStatus; missing: string[]; reviewedItems:string; requiredItems:string;
}
export interface LedgerSnapshot {
  id: string | null; projectId: string; evaluatedAt: string; inputSnapshotHash: string;
  evaluatorVersion: "1"; inputBasis: Record<string, unknown>; items: LedgerItem[]; stages: LedgerStage[]; currentStage: string | null; limitations: string[];
}
export interface LedgerClaim {
  id: string; claim_type: string; catalog_entry_id: string; catalog_version: number;
  grade: Grade; as_of: Date | null; value_text: string; stale: boolean; has_evidence: boolean;
  conflict_ids: string[]; conflict_types: string[]; upload_ids: string[]; signal_ids: string[]; excluded_by_rule: boolean;
}
export interface LedgerAttestation {
  id: string; claim_scope: string[]; attestation_type: string; state: string; limitations: string;
  valid: boolean; credential_id: string; valid_until: Date | null;
  reviewer_subject_id?:string; credential_type?:string; signed_at?:Date;
}
export const LEDGER_LIMITATIONS = [
  "Computed evidence coverage is not a legal, investment, or operating approval.",
  "Manual project confirmations and publication permissions remain separate.",
];
export const STAGE_GATE_ORDER = ["stage.exploration", "stage.resource_defined", "stage.feasibility", "stage.permitted", "stage.production"] as const;

/** Conflict and invalid evidence outrank old passing grades. Empty evidence never earns a review. */
export function deriveLedgerItemStatus(
  claims: readonly LedgerClaim[], attestations: readonly LedgerAttestation[], explicitlyNotApplicable = false,
): { status: LedgerItemStatus; reasons: string[]; attestationIds: string[]; limitations: string[] } {
  const relevant = attestations.filter((a) => a.claim_scope.some((id) => claims.some((c) => c.id === id)));
  const valid = relevant.filter((a) => a.valid);
  const base = { attestationIds: relevant.filter((a) => a.state !== "superseded").map((a) => a.id).sort(), limitations: valid.map((a) => a.limitations) };
  if (claims.some((c) => c.conflict_ids.length > 0) || relevant.some((a) => a.state === "disputed")) {
    return { ...base, status: "conflicting", reasons: ["UNRESOLVED_CONFLICT"] };
  }
  if (claims.some((c) => c.stale) || relevant.some((a) => !a.valid && a.state !== "superseded")) {
    return { ...base, status: "needs_re_review", reasons: ["EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT"] };
  }
  if (claims.some((c) => c.grade === "rejected" || c.excluded_by_rule)) {
    return { ...base, status: "rejected", reasons: ["REJECTED_OR_EXCLUDED_EVIDENCE"] };
  }
  if (explicitlyNotApplicable) return { ...base, status: "not_applicable", reasons: ["RECORDED_NOT_APPLICABLE"] };
  if (claims.length === 0) return { ...base, status: "missing", reasons: ["NO_CATALOG_CLAIM"] };
  if (claims.every((c) => c.has_evidence && valid.some((a) => a.claim_scope.includes(c.id)))) {
    return { ...base, status: "reviewed", reasons: ["CURRENT_SCOPED_REVIEW"] };
  }
  return { ...base, status: "unreviewed", reasons: ["CURRENT_SCOPED_REVIEW_REQUIRED"] };
}

/** Count logical required types once, across all active pinned evidence versions. */
export function stageEvidenceCoverage(
  requirements:readonly {requirementId:string;requiredClaimTypes:readonly string[]}[],
  results:readonly {requirementId:string;applicable:boolean}[],
  items:readonly LedgerItem[],
):{reviewedItems:string;requiredItems:string}{
  const applicableIds=new Set(results.filter(result=>result.applicable).map(result=>result.requirementId));
  const types=[...new Set(requirements.filter(requirement=>applicableIds.has(requirement.requirementId))
    .flatMap(requirement=>[...requirement.requiredClaimTypes]))];
  let required=0,reviewed=0;
  for(const type of types){
    const candidates=items.filter(item=>item.claimType===type);
    const pinned=candidates.filter(item=>item.claimIds.length>0);
    const relevant=(pinned.length>0?pinned:candidates).filter(item=>item.status!=='not_applicable');
    if(candidates.length>0 && relevant.length===0)continue;
    required++;
    if(relevant.length>0 && relevant.every(item=>item.status==='reviewed'))reviewed++;
  }
  return{reviewedItems:String(reviewed),requiredItems:String(required)};
}

/** Excluded items cannot supply evidence; conflict policy uses recorded types, not configured blockers. */
export function ledgerRequirementEvidence(
  requiredClaimTypes: readonly string[], claims: readonly LedgerClaim[],
  attestations: readonly LedgerAttestation[], items: readonly LedgerItem[], evaluatedAt: Date,
): Omit<RequirementFacts, 'context'> {
  const included = claims.filter(c => !items.some(item => item.status === 'not_applicable'
    && item.claimType === c.claim_type && item.catalogVersion === c.catalog_version));
  const relevant = included.filter(c => requiredClaimTypes.includes(c.claim_type));
  // Claim as-of values are calendar dates. A future UTC day is invalid evidence,
  // including for policies with no freshness threshold; it must never become a negative age.
  const evaluatedDay = Math.floor(evaluatedAt.getTime() / 86400000);
  const futureDated = (c: LedgerClaim) => c.as_of !== null
    && Math.floor(c.as_of.getTime() / 86400000) > evaluatedDay;
  const covered = attestations.filter(a => a.valid && a.claim_scope.some(id => relevant.some(c => c.id === id)));
  const staleEvidence = [...new Set(relevant.filter(c => c.stale || c.excluded_by_rule || c.grade === 'rejected'
    || futureDated(c)
    || !c.has_evidence || !covered.some(a => a.claim_scope.includes(c.id))
    || attestations.some(a => a.claim_scope.includes(c.id) && !a.valid && a.state !== 'superseded'))
    .map(c => c.claim_type))];
  return {
    presentClaimTypes: [...new Set(included.filter(c => c.has_evidence && !c.excluded_by_rule).map(c => c.claim_type))],
    grade: relevant.length > 0 ? weakestGrade(relevant.map(c => c.grade)) : null,
    presentAttestations: [...new Set(covered.map(a => a.attestation_type))] as RequirementFacts['presentAttestations'],
    evidenceAgeDays: relevant.length === 0 || relevant.some(c => c.as_of === null || futureDated(c)) ? null
      : String(Math.max(...relevant.map(c => evaluatedDay - Math.floor(c.as_of!.getTime() / 86400000)))),
    unresolvedConflictTypes: [...new Set(relevant.flatMap(c => c.conflict_types))].sort(),
    staleEvidence,
  };
}

/** Only registered effective stage rules are evaluated. No rules means unknown, never a default stage. */
export async function computeEvidenceLedger(
  tx: postgres.TransactionSql, tenantId: string, projectId: string, evaluatedAt: Date,
): Promise<LedgerSnapshot | null> {
  const [project] = await tx<{ reference_status: string; host_country_iso3: string }[]>`
    SELECT reference_status, host_country_iso3 FROM core.projects
    WHERE tenant_id = ${tenantId} AND id = ${projectId}
  `;
  if (!project) return null;
  const catalog = await tx<{ id: string; claim_type: string; catalog_version: number; display_name: string }[]>`
    SELECT ct.id, ct.claim_type, ct.catalog_version, ct.display_name
    FROM core.claim_types ct WHERE ct.tenant_id = ${tenantId} AND ct.effective_from <= ${evaluatedAt}
      AND (ct.catalog_version = (SELECT max(latest.catalog_version) FROM core.claim_types latest
        WHERE latest.tenant_id=ct.tenant_id AND latest.claim_type=ct.claim_type AND latest.effective_from <= ${evaluatedAt})
      OR EXISTS (SELECT 1 FROM core.claims c WHERE c.project_id=${projectId} AND c.catalog_entry_id=ct.id AND c.superseded_by_claim_id IS NULL))
    ORDER BY ct.claim_type, ct.catalog_version
  `;
  const claims = await tx<LedgerClaim[]>`SELECT * FROM core.ledger_claim_health(${projectId}, ${evaluatedAt})`;
  const attestations = await tx<LedgerAttestation[]>`
    SELECT a.id, a.claim_scope, a.attestation_type, a.state, a.limitations, a.credential_id, a.valid_until,
      cr.subject_id AS reviewer_subject_id,cr.credential_type,a.signed_at,
      (a.state IN ('signed','active') AND a.signature <> '' AND a.signed_at <= ${evaluatedAt}
       AND (a.valid_until IS NULL OR a.valid_until > ${evaluatedAt})
       AND cr.current_status = 'valid' AND cr.revoked_at IS NULL
       AND (cr.expires_at IS NULL OR cr.expires_at > ${evaluatedAt})
       AND sch.state IN ('active','approved')) AS valid
    FROM core.verification_attestations a
    JOIN core.verification_cases vc ON vc.id = a.case_id AND vc.tenant_id = a.tenant_id
    JOIN core.credentials cr ON cr.id = a.credential_id AND cr.tenant_id = a.tenant_id
    JOIN core.attestation_schemas sch ON sch.id = a.schema_id AND sch.tenant_id = a.tenant_id
    WHERE vc.project_id = ${projectId} AND a.tenant_id = ${tenantId}
      AND a.state <> 'draft'
    ORDER BY a.id
  `;
  const manual = await tx<{ id: string; fact_key: string; status: string; version: number }[]>`
    SELECT DISTINCT ON (fact_key) id, fact_key, status, version FROM core.project_fact_versions
    WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
    ORDER BY fact_key, version DESC
  `;
  const items = catalog.map((definition): LedgerItem => {
    const relevant = claims.filter((c) => c.catalog_entry_id === definition.id);
    const result = deriveLedgerItemStatus(relevant, attestations,
      manual.some((f) => f.fact_key === definition.claim_type && f.status === 'not_applicable'));
    return { claimType: definition.claim_type, catalogVersion: definition.catalog_version,
      displayName: definition.display_name,
      grade: relevant.length > 0 ? weakestGrade(relevant.map((c) => c.grade)) : null,
      reviewScope: [...new Set(relevant.filter(c => attestations.some(a => a.valid && a.claim_scope.includes(c.id))).map(c => c.claim_type))].sort(),
      reviews:attestations.filter(a => a.valid && a.claim_scope.some(id => relevant.some(c=>c.id===id))).map(a=>({
        reviewerHandle:keccak256(canonicalBytes({tenantId,subjectId:a.reviewer_subject_id ?? ''})),
        credentialType:a.credential_type ?? 'unknown',attestationType:a.attestation_type,
        signedAt:a.signed_at!.toISOString(),limitations:a.limitations,
      })),
      claimIds: relevant.map((c) => c.id).sort(), ...result };
  });
  // A policy must be effective, time-valid, and approved through the registry. Bootstrap rules
  // predate proposals and remain usable only when explicitly effective in their own tenant.
  const policies = await tx<{ id: string; gate_id: string; definition: unknown; jurisdiction_profile: string }[]>`
    SELECT DISTINCT ON (p.gate_id) p.id, p.gate_id, p.definition, p.jurisdiction_profile
    FROM core.compliance_policy_sets p
    WHERE p.tenant_id = ${tenantId} AND p.state = 'effective'
      AND p.effective_from <= ${evaluatedAt} AND p.superseded_by IS NULL
      AND p.gate_id = ANY(${[...STAGE_GATE_ORDER]}::text[])
      AND p.jurisdiction_profile = ${project.host_country_iso3}
    ORDER BY p.gate_id, p.effective_from DESC, p.created_at DESC, p.id
  `;
  const profile = await tx<{ state: string; environmental_requirement_basis: string | null; profile_version: number }[]>`
    SELECT state, environmental_requirement_basis, profile_version FROM core.jurisdiction_profiles
    WHERE tenant_id = ${tenantId} AND jurisdiction = ${project.host_country_iso3} AND effective_from <= ${evaluatedAt}
    ORDER BY profile_version DESC LIMIT 1
  `;
  const input = {
    evaluatorVersion: "1", projectId,
    catalog, claims: claims.map((c) => ({ ...c, as_of: c.as_of?.toISOString() ?? null })),
    attestations: attestations.map((a) => ({ ...a, signed_at:a.signed_at?.toISOString() ?? null, valid_until: a.valid_until?.toISOString() ?? null })),
    manual, policies, profile, referenceStatus: project.reference_status,
  };
  const inputBasis = JSON.parse(JSON.stringify(input, (_key, value: unknown) => typeof value === "number" ? String(value) : value)) as Record<string, unknown>;
  const inputSnapshotHash = ledgerInputHash(inputBasis, evaluatedAt.toISOString());
  const applicableStageRequirements: {policySetId: string; requirementId: string}[] = [];
  const stages: LedgerStage[] = [];
  for (const gateId of STAGE_GATE_ORDER) {
    const policy = policies.find((p) => p.gate_id === gateId);
    if (!policy) continue;
    const parsed = safeParseRuleSet(policy.definition);
    if (!parsed.success || parsed.data.gateId !== gateId) continue;
    const rule = parsed.data;
    const requirementFacts: Record<string, RequirementFacts> = {};
    for (const requirement of rule.requirements) {
      const p = profile[0];
      requirementFacts[requirement.requirementId] = {
        ...ledgerRequirementEvidence(requirement.requiredClaimTypes, claims, attestations, items, evaluatedAt),
        context: {
          referenceStatus: project.reference_status,
          projectReferenceStatus: project.reference_status,
          jurisdictionProfileState: p?.state,
          environmentalRequirementBasis: p?.environmental_requirement_basis ?? undefined,
          openFindingCount: String(claims.reduce((n,c) => n + c.conflict_ids.length, 0)),
        },
      };
    }
    const assessment = evaluateAssessment(rule, { subjectId: projectId, gateId, inputSnapshotHash,
      evaluatedAsOf: evaluatedAt.toISOString(), requirementFacts });
    applicableStageRequirements.push(...assessment.requirementResults.filter(r => r.applicable)
      .map(r => ({policySetId: policy.id, requirementId: r.requirementId})));
    // An applicability-only success with no evidence is not proof of reaching a stage.
    const hasApplicable = assessment.requirementResults.some((r) => r.applicable);
    const status = hasApplicable ? assessment.status : 'not_evaluable';
    stages.push({ gateId, policySetId: policy.id, ruleSetVersion: rule.version, status,
      ...stageEvidenceCoverage(rule.requirements,assessment.requirementResults,items),
      missing: [...new Set(assessment.requirementResults.flatMap((r) => r.missing))].sort() });
  }
  // Keep applicability private, but bind it to the input commitment for safe live warnings.
  inputBasis['applicableStageRequirements'] = applicableStageRequirements;
  return { id: null, projectId, evaluatedAt: evaluatedAt.toISOString(), evaluatorVersion: '1',
    inputSnapshotHash: ledgerInputHash(inputBasis, evaluatedAt.toISOString()), inputBasis, items, stages, currentStage: stages.filter((s) => s.status === 'ok').at(-1)?.gateId ?? null,
    limitations: [...LEDGER_LIMITATIONS, ...(stages.length === 0 ? ['No effective stage rules are available; stage is unknown.'] : [])] };
}

/** Recomputable commitment to the fixed clock and complete normalized evaluation input. */
export function ledgerInputHash(inputBasis: Record<string, unknown>, evaluatedAt: string): string {
  return keccak256(canonicalBytes(JSON.parse(JSON.stringify({inputBasis,evaluatedAt}))));
}

export function publicLedgerProjection(snapshot: LedgerSnapshot & { id: string }) {
  return {
    snapshotId: snapshot.id, evaluatedAt: snapshot.evaluatedAt, inputSnapshotHash: snapshot.inputSnapshotHash,
    items: snapshot.items.map(({claimIds: _claims, attestationIds: _attestations, catalogVersion, ...item}) => ({...item,catalogVersion:String(catalogVersion)})),
    stages: snapshot.stages.map(({policySetId: _id, ...stage}) => stage),
    currentStage: snapshot.currentStage, limitations: snapshot.limitations,
  };
}
/** Publication freshness comparison excludes the clock and provenance hashes, not outcomes. */
export function evidenceLedgerSemantic(snapshot: LedgerSnapshot) {
  const { id: _id, evaluatedAt: _time, inputSnapshotHash: _hash, ...semantic } = snapshot;
  return JSON.parse(JSON.stringify(semantic, (_key, value: unknown) => typeof value === "number" ? String(value) : value)) as CanonicalValue;
}
export async function persistEvidenceLedger(tx: postgres.TransactionSql, tenantId: string, snapshot: LedgerSnapshot): Promise<LedgerSnapshot & { id: string }> {
  const id = randomUUID();
  const stored = { ...snapshot, id };
  await tx`INSERT INTO core.evidence_ledger_snapshots (id,tenant_id,project_id,evaluated_at,input_snapshot_hash,snapshot)
    VALUES (${id},${tenantId},${snapshot.projectId},${snapshot.evaluatedAt},${snapshot.inputSnapshotHash},${tx.json(stored as never)})`;
  return stored;
}
export async function loadEvidenceLedgerSnapshot(tx: postgres.TransactionSql, tenantId: string, projectId: string, id: string): Promise<(LedgerSnapshot & {id:string}) | null> {
  const [row] = await tx<{snapshot: LedgerSnapshot & {id:string}}[]>`SELECT snapshot FROM core.evidence_ledger_snapshots
    WHERE tenant_id=${tenantId} AND project_id=${projectId} AND id=${id}`;
  return row?.snapshot ?? null;
}
