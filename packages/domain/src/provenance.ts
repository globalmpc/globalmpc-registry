/**
 * The three provenance axes and the summary grade — spec 05 §5.3.
 *
 * The three axes are orthogonal. Never collapse them into a single stored `verified=true`.
 */

/** P1 official registry / regulatory disclosure → P5 unverified secondary citation. */
export const EVIDENCE_TIERS = ["P1", "P2", "P3", "P4", "P5"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/**
 * artifact kind — each kind has its own immutable ID/version and is linked by lineage edges.
 * A semantic kind is never changed or overwritten (invariant 17).
 */
export const ARTIFACT_KINDS = [
  "raw_source",
  "extracted_artifact",
  "normalized_observation",
  "interpretation",
  "public_projection",
] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const VERIFICATION_STATES = [
  "unreviewed",
  "machine_checked",
  "analyst_checked",
  "independently_assured",
  "rejected",
] as const;
export type VerificationState = (typeof VERIFICATION_STATES)[number];

export const ATTESTATION_TYPES = [
  "professional_signoff",
  "laboratory_accreditation",
  "independent_assurance",
  "legal_notarization",
  "cryptographic_attestation",
] as const;
export type AttestationType = (typeof ATTESTATION_TYPES)[number];

export const GRADES = [
  "rejected",
  "unverified",
  "self_reported",
  "partially_verified",
  "verified",
] as const;
export type Grade = (typeof GRADES)[number];

/**
 * Grade precedence — lower is worse.
 * spec 05 §5.3: `rejected > unverified > self_reported > partially_verified > verified`
 * (Here `>` means "is adopted with higher priority"; the net effect is picking the minimum.)
 */
const GRADE_RANK: Readonly<Record<Grade, number>> = {
  rejected: 0,
  unverified: 1,
  self_reported: 2,
  partially_verified: 3,
  verified: 4,
};

const STATE_RANK: Readonly<Record<VerificationState, number>> = {
  rejected: -1,
  unreviewed: 0,
  machine_checked: 1,
  analyst_checked: 2,
  independently_assured: 3,
};

export interface ClaimGradeInput {
  readonly verificationState: VerificationState;
  /** null when there is no evidence at all. */
  readonly evidenceTier: EvidenceTier | null;
  readonly attestationTypes: readonly AttestationType[];
  readonly unresolvedConflictCount: number;
  /** Forged, unsuitable, revoked, or excluded by rule. */
  readonly excludedByRule: boolean;
}

/**
 * Per-claim summary grade.
 *
 * Must be deterministic — the same input always yields the same grade. Uses no current time,
 * randomness, or external lookup (AC-11).
 */
export function computeClaimGrade(input: ClaimGradeInput): Grade {
  if (input.excludedByRule || input.verificationState === "rejected") {
    return "rejected";
  }

  if (input.evidenceTier === null || input.verificationState === "unreviewed") {
    return "unverified";
  }

  const stateRank = STATE_RANK[input.verificationState];
  const tier = input.evidenceTier;
  const attestations = new Set(input.attestationTypes);

  const isIndependentlyAssured = stateRank >= STATE_RANK.independently_assured;
  const hasProfessionalSignoff = attestations.has("professional_signoff");
  const hasIndependentAssurance = attestations.has("independent_assurance");
  const tierIsP1OrP2 = tier === "P1" || tier === "P2";
  const tierIsP1ToP3 = tierIsP1OrP2 || tier === "P3";

  if (
    isIndependentlyAssured &&
    hasProfessionalSignoff &&
    hasIndependentAssurance &&
    tierIsP1OrP2 &&
    input.unresolvedConflictCount === 0
  ) {
    return "verified";
  }

  if (stateRank >= STATE_RANK.analyst_checked && tierIsP1ToP3) {
    return "partially_verified";
  }

  if (stateRank <= STATE_RANK.machine_checked) {
    return "self_reported";
  }

  // analyst_checked or higher but tier is P4/P5 — reviewed, yet the evidence tier is low.
  return "self_reported";
}

/**
 * Weakest link — uses the lowest grade among the asset's required claims (§5.3).
 *
 * An empty set is `unverified`. "No required claims" is not a good state but one with no
 * basis for judgment.
 */
export function weakestGrade(grades: readonly Grade[]): Grade {
  if (grades.length === 0) return "unverified";
  return grades.reduce((worst, current) =>
    GRADE_RANK[current] < GRADE_RANK[worst] ? current : worst,
  );
}

export function gradeAtLeast(grade: Grade, minimum: Grade): boolean {
  return GRADE_RANK[grade] >= GRADE_RANK[minimum];
}

export function compareGrade(a: Grade, b: Grade): number {
  return GRADE_RANK[a] - GRADE_RANK[b];
}
