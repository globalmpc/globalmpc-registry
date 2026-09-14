/**
 * Provenance 3축과 요약 grade — spec 05 §5.3.
 *
 * 세 축은 직교한다. 하나의 `verified=true`로 축약해 저장하지 않는다.
 */

/** P1 공식 등록부·규제 공시 → P5 미확인 2차 인용. */
export const EVIDENCE_TIERS = ["P1", "P2", "P3", "P4", "P5"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

/**
 * artifact kind — 각 kind는 별도 immutable ID/version이며 lineage edge로 연결한다.
 * semantic kind를 바꾸거나 덮어쓰지 않는다(불변조건 17).
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
 * grade 우선순위 — 낮을수록 나쁘다.
 * spec 05 §5.3: `rejected > unverified > self_reported > partially_verified > verified`
 * (여기서 `>`는 "더 우선해서 채택된다"는 뜻이고, 결과적으로 최저값을 고른다.)
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
  /** 근거가 아예 없으면 null. */
  readonly evidenceTier: EvidenceTier | null;
  readonly attestationTypes: readonly AttestationType[];
  readonly unresolvedConflictCount: number;
  /** 위조·부적합·철회·규칙상 배제. */
  readonly excludedByRule: boolean;
}

/**
 * claim 단위 요약 grade.
 *
 * 결정적이어야 한다 — 같은 입력은 항상 같은 grade를 만든다. 현재 시각·난수·외부
 * 조회를 사용하지 않는다(AC-11).
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

  // analyst_checked 이상이지만 tier가 P4/P5인 경우 — 검토는 있었으나 근거 등급이 낮다.
  return "self_reported";
}

/**
 * weakest link — asset의 필수 claim 중 최저 grade를 사용한다(§5.3).
 *
 * 빈 집합은 `unverified`다. "필수 claim이 없다"는 좋은 상태가 아니라
 * 판단 근거가 없는 상태다.
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
