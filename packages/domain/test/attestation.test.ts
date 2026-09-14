import { describe, expect, it } from "vitest";
import {
  canonicalAcceptanceBlockers,
  checkAttestationSignable,
  evaluateCredentialApplicability,
  type AttestationSignRequest,
} from "../src/attestation.js";

const SIGNABLE: AttestationSignRequest = {
  attestationType: "professional_signoff",
  claimScope: ["claim-001"],
  limitations: "이 검토는 자원량 추정에 한정되며 법적 권리 확인을 포함하지 않는다",
  conflictStatus: "none",
  credentialValidAtSigningTime: true,
  credentialScopeCoversClaims: true,
  hasActiveAssignment: true,
  schemaState: "active",
  signerSubmittedEvidence: false,
};

describe("AC-01 — limitations 없이 서명할 수 없다", () => {
  it("빈 문자열을 거절한다", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, limitations: "" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_LIMITATIONS_REQUIRED");
  });

  it("공백만 있는 문자열도 거절한다", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, limitations: "   \n\t " });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_LIMITATIONS_REQUIRED");
  });

  it("내용이 있으면 통과한다", () => {
    expect(checkAttestationSignable(SIGNABLE).allowed).toBe(true);
  });
});

describe("서명 전 검사", () => {
  it("claim scope가 비면 거절한다", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, claimScope: [] });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_EMPTY_CLAIM_SCOPE");
  });

  it("schema가 active가 아니면 거절한다", () => {
    for (const state of ["draft", "approved", "superseded", "retired"] as const) {
      const result = checkAttestationSignable({ ...SIGNABLE, schemaState: state });
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("ATTESTATION_SCHEMA_NOT_ACTIVE");
    }
  });

  it("assignment 없이 서명할 수 없다 — self-assignment 후 self-approval 차단", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, hasActiveAssignment: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_NO_ACTIVE_ASSIGNMENT");
  });

  it("서명 시점에 credential이 유효하지 않으면 거절한다", () => {
    const result = checkAttestationSignable({
      ...SIGNABLE,
      credentialValidAtSigningTime: false,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_CREDENTIAL_INVALID");
  });

  it("credential scope가 claim을 덮지 않으면 거절한다", () => {
    const result = checkAttestationSignable({
      ...SIGNABLE,
      credentialScopeCoversClaims: false,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_SCOPE_MISMATCH");
  });

  it("미해결 이해상충이 있으면 거절한다", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, conflictStatus: "unresolved" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_UNRESOLVED_CONFLICT");
  });

  it("공시·해결된 이해상충은 통과한다", () => {
    expect(
      checkAttestationSignable({ ...SIGNABLE, conflictStatus: "disclosed_resolved" }).allowed,
    ).toBe(true);
  });

  it("제출자 본인은 independent assurance를 할 수 없다", () => {
    const result = checkAttestationSignable({
      ...SIGNABLE,
      attestationType: "independent_assurance",
      signerSubmittedEvidence: true,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_SELF_ASSURANCE");
  });

  it("제출자 본인도 professional signoff는 할 수 있다 — 독립성 요구가 다르다", () => {
    expect(
      checkAttestationSignable({
        ...SIGNABLE,
        attestationType: "professional_signoff",
        signerSubmittedEvidence: true,
      }).allowed,
    ).toBe(true);
  });
});

describe("AC-12·AC-17 — credential 시점 평가", () => {
  it("서명 당시 유효하고 현재도 유효하면 그대로 적용된다", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: true,
      currentStatus: "valid",
    });
    expect(result).toEqual({
      pastSignatureRemainsValid: true,
      ongoingApplicability: "applicable",
      triggersDownstreamReassessment: false,
    });
  });

  it("서명 당시 유효했고 현재 만료면 과거는 보존하고 앞으로만 재평가한다", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: true,
      currentStatus: "expired",
    });
    expect(result.pastSignatureRemainsValid).toBe(true);
    expect(result.ongoingApplicability).toBe("needs_review");
    expect(result.triggersDownstreamReassessment).toBe(true);
  });

  it("철회된 credential은 과거 서명 사실을 남기되 앞으로의 근거가 되지 않는다", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: true,
      currentStatus: "revoked",
    });
    expect(result.pastSignatureRemainsValid).toBe(true);
    expect(result.ongoingApplicability).toBe("not_applicable");
  });

  it("서명 당시에도 유효하지 않았다면 과거 서명이 근거가 될 수 없다", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: false,
      currentStatus: "valid",
    });
    expect(result.pastSignatureRemainsValid).toBe(false);
    expect(result.ongoingApplicability).toBe("not_applicable");
  });

  it("상태를 알 수 없으면 재검토 대상이다 — 조용히 유효로 두지 않는다", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: true,
      currentStatus: "unknown",
    });
    expect(result.ongoingApplicability).toBe("needs_review");
    expect(result.triggersDownstreamReassessment).toBe(true);
  });
});

describe("AC-15·AC-16 — 네 가지 사실은 서로 다르다", () => {
  const ALL_TRUE = {
    signatureValid: true,
    authorityAccepted: true,
    credentialValid: true,
    assignedToThisCase: true,
    claimWithinAuthorityScope: true,
  };

  it("전부 충족되면 blocker가 없다", () => {
    expect(canonicalAcceptanceBlockers(ALL_TRUE)).toEqual([]);
  });

  it("AC-15: 서명이 유효해도 authority scope 밖이면 차단된다", () => {
    expect(
      canonicalAcceptanceBlockers({ ...ALL_TRUE, claimWithinAuthorityScope: false }),
    ).toEqual(["CLAIM_OUTSIDE_AUTHORITY_SCOPE"]);
  });

  it("AC-16: 서명이 유효해도 authority가 미수용이면 차단된다", () => {
    expect(canonicalAcceptanceBlockers({ ...ALL_TRUE, authorityAccepted: false })).toEqual([
      "AUTHORITY_NOT_ACCEPTED",
    ]);
  });

  it("credential이 유효해도 assignment가 없으면 차단된다", () => {
    expect(canonicalAcceptanceBlockers({ ...ALL_TRUE, assignedToThisCase: false })).toEqual([
      "NOT_ASSIGNED",
    ]);
  });

  it("여러 blocker를 모두 반환한다 — 하나만 고치면 되는 것처럼 보이면 안 된다", () => {
    expect(
      canonicalAcceptanceBlockers({
        signatureValid: false,
        authorityAccepted: false,
        credentialValid: false,
        assignedToThisCase: false,
        claimWithinAuthorityScope: false,
      }),
    ).toHaveLength(5);
  });
});
