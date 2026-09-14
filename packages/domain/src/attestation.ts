import type { AttestationType } from "./provenance.js";

/**
 * Verification Attestation 서명 전 검사 — spec 04 §4.2 / 13 AC-01·AC-17.
 *
 * 이 모듈은 "서명해도 되는가"만 판정한다. 서명 자체는 사용자의 key로 이루어지며
 * 서버는 private key를 보관하거나 대리 서명하지 않는다(07 §7.2, 02 §2.8).
 */

export type ConflictStatus = "none" | "disclosed_resolved" | "unresolved";

export type AttestationDenyReason =
  | "ATTESTATION_LIMITATIONS_REQUIRED"
  | "ATTESTATION_UNRESOLVED_CONFLICT"
  | "ATTESTATION_NO_ACTIVE_ASSIGNMENT"
  | "ATTESTATION_CREDENTIAL_INVALID"
  | "ATTESTATION_SCOPE_MISMATCH"
  | "ATTESTATION_SCHEMA_NOT_ACTIVE"
  | "ATTESTATION_EMPTY_CLAIM_SCOPE"
  | "ATTESTATION_SELF_ASSURANCE";

export interface AttestationSignRequest {
  readonly attestationType: AttestationType;
  readonly claimScope: readonly string[];
  /**
   * 검토의 범위와 한계. 빈 문자열을 허용하지 않는다(05 §5.3, AC-01).
   *
   * "한계 없음"은 존재하지 않는 검토 결과다. 모든 전문 검토는 범위 밖 사실을
   * 보증하지 않는다.
   */
  readonly limitations: string;
  readonly conflictStatus: ConflictStatus;
  readonly credentialValidAtSigningTime: boolean;
  readonly credentialScopeCoversClaims: boolean;
  readonly hasActiveAssignment: boolean;
  readonly schemaState: "draft" | "approved" | "active" | "superseded" | "retired";
  /**
   * 서명자가 이 evidence의 제출자인가.
   * `independent_assurance`는 제출자 본인이 할 수 없다(02 §2.4 규칙 1).
   */
  readonly signerSubmittedEvidence: boolean;
}

export type AttestationSignCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: AttestationDenyReason };

export function checkAttestationSignable(
  request: AttestationSignRequest,
): AttestationSignCheck {
  if (request.limitations.trim().length === 0) {
    return { allowed: false, reason: "ATTESTATION_LIMITATIONS_REQUIRED" };
  }
  if (request.claimScope.length === 0) {
    return { allowed: false, reason: "ATTESTATION_EMPTY_CLAIM_SCOPE" };
  }
  if (request.schemaState !== "active") {
    return { allowed: false, reason: "ATTESTATION_SCHEMA_NOT_ACTIVE" };
  }
  if (!request.hasActiveAssignment) {
    return { allowed: false, reason: "ATTESTATION_NO_ACTIVE_ASSIGNMENT" };
  }
  if (!request.credentialValidAtSigningTime) {
    return { allowed: false, reason: "ATTESTATION_CREDENTIAL_INVALID" };
  }
  if (!request.credentialScopeCoversClaims) {
    return { allowed: false, reason: "ATTESTATION_SCOPE_MISMATCH" };
  }
  if (request.conflictStatus === "unresolved") {
    return { allowed: false, reason: "ATTESTATION_UNRESOLVED_CONFLICT" };
  }
  if (request.attestationType === "independent_assurance" && request.signerSubmittedEvidence) {
    return { allowed: false, reason: "ATTESTATION_SELF_ASSURANCE" };
  }
  return { allowed: true };
}

/**
 * credential 시점 평가 — AC-12·AC-17.
 *
 * 서명 당시 유효했던 credential이 현재 만료·철회됐다면 **과거 서명 사실은 그대로
 * 보존**하고 앞으로의 적용 가능성만 재평가한다. 과거를 소급해 무효로 만들면
 * 그때 내려진 결정의 근거를 재현할 수 없다.
 */
export type CredentialCurrentStatus = "valid" | "expired" | "revoked" | "suspended" | "unknown";

export type OngoingApplicability = "applicable" | "needs_review" | "not_applicable";

export interface CredentialApplicability {
  /** 서명 시점의 유효성. 현재 상태로 바뀌지 않는다. */
  readonly pastSignatureRemainsValid: boolean;
  readonly ongoingApplicability: OngoingApplicability;
  /** 하류 grade·readiness 재평가가 필요한가. */
  readonly triggersDownstreamReassessment: boolean;
}

export function evaluateCredentialApplicability(input: {
  readonly validAtAttestationTime: boolean;
  readonly currentStatus: CredentialCurrentStatus;
}): CredentialApplicability {
  if (!input.validAtAttestationTime) {
    // 서명 당시에도 유효하지 않았다면 그 서명은 애초에 근거가 될 수 없다.
    return {
      pastSignatureRemainsValid: false,
      ongoingApplicability: "not_applicable",
      triggersDownstreamReassessment: true,
    };
  }

  switch (input.currentStatus) {
    case "valid":
      return {
        pastSignatureRemainsValid: true,
        ongoingApplicability: "applicable",
        triggersDownstreamReassessment: false,
      };
    case "expired":
    case "suspended":
    case "unknown":
      return {
        pastSignatureRemainsValid: true,
        ongoingApplicability: "needs_review",
        triggersDownstreamReassessment: true,
      };
    case "revoked":
      // 철회는 issuer가 자격 자체를 무효로 만든 것이다. 과거 서명 사실은 남지만
      // 앞으로의 근거로 쓸 수 없다.
      return {
        pastSignatureRemainsValid: true,
        ongoingApplicability: "not_applicable",
        triggersDownstreamReassessment: true,
      };
  }
}

/**
 * 서명 유효성과 authority 수용은 다른 상태다 — 불변조건 13·14, AC-15·AC-16.
 *
 * 이 함수가 존재하는 이유는 네 가지를 한 boolean으로 합치려는 시도를 막기 위해서다.
 */
export interface AcceptanceFacts {
  readonly signatureValid: boolean;
  readonly authorityAccepted: boolean;
  readonly credentialValid: boolean;
  readonly assignedToThisCase: boolean;
  readonly claimWithinAuthorityScope: boolean;
}

export type AcceptanceBlocker =
  | "SIGNATURE_INVALID"
  | "AUTHORITY_NOT_ACCEPTED"
  | "CREDENTIAL_INVALID"
  | "NOT_ASSIGNED"
  | "CLAIM_OUTSIDE_AUTHORITY_SCOPE";

/** canonical claim으로 받아들이기 전 확인할 blocker 전체를 반환한다. */
export function canonicalAcceptanceBlockers(facts: AcceptanceFacts): AcceptanceBlocker[] {
  const blockers: AcceptanceBlocker[] = [];
  if (!facts.signatureValid) blockers.push("SIGNATURE_INVALID");
  if (!facts.authorityAccepted) blockers.push("AUTHORITY_NOT_ACCEPTED");
  if (!facts.credentialValid) blockers.push("CREDENTIAL_INVALID");
  if (!facts.assignedToThisCase) blockers.push("NOT_ASSIGNED");
  if (!facts.claimWithinAuthorityScope) blockers.push("CLAIM_OUTSIDE_AUTHORITY_SCOPE");
  return blockers;
}
