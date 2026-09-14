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
  limitations: "This review is limited to resource estimation and does not include legal title verification",
  conflictStatus: "none",
  credentialValidAtSigningTime: true,
  credentialScopeCoversClaims: true,
  hasActiveAssignment: true,
  schemaState: "active",
  signerSubmittedEvidence: false,
};

describe("AC-01 — cannot sign without limitations", () => {
  it("rejects an empty string", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, limitations: "" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_LIMITATIONS_REQUIRED");
  });

  it("rejects a whitespace-only string", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, limitations: "   \n\t " });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_LIMITATIONS_REQUIRED");
  });

  it("passes when content is present", () => {
    expect(checkAttestationSignable(SIGNABLE).allowed).toBe(true);
  });
});

describe("pre-signature checks", () => {
  it("rejects an empty claim scope", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, claimScope: [] });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_EMPTY_CLAIM_SCOPE");
  });

  it("rejects a schema that is not active", () => {
    for (const state of ["draft", "approved", "superseded", "retired"] as const) {
      const result = checkAttestationSignable({ ...SIGNABLE, schemaState: state });
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("ATTESTATION_SCHEMA_NOT_ACTIVE");
    }
  });

  it("cannot sign without an assignment — blocks self-assignment then self-approval", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, hasActiveAssignment: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_NO_ACTIVE_ASSIGNMENT");
  });

  it("rejects a credential that is not valid at signing time", () => {
    const result = checkAttestationSignable({
      ...SIGNABLE,
      credentialValidAtSigningTime: false,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_CREDENTIAL_INVALID");
  });

  it("rejects when the credential scope does not cover the claim", () => {
    const result = checkAttestationSignable({
      ...SIGNABLE,
      credentialScopeCoversClaims: false,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_SCOPE_MISMATCH");
  });

  it("rejects an unresolved conflict of interest", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, conflictStatus: "unresolved" });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_UNRESOLVED_CONFLICT");
  });

  it("passes a disclosed or resolved conflict of interest", () => {
    expect(
      checkAttestationSignable({ ...SIGNABLE, conflictStatus: "disclosed_resolved" }).allowed,
    ).toBe(true);
  });

  it("the submitter cannot give independent assurance", () => {
    const result = checkAttestationSignable({
      ...SIGNABLE,
      attestationType: "independent_assurance",
      signerSubmittedEvidence: true,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_SELF_ASSURANCE");
  });

  it("the submitter can still give a professional signoff — independence requirements differ", () => {
    expect(
      checkAttestationSignable({
        ...SIGNABLE,
        attestationType: "professional_signoff",
        signerSubmittedEvidence: true,
      }).allowed,
    ).toBe(true);
  });
});

describe("AC-12·AC-17 — point-in-time credential evaluation", () => {
  it("valid at signing and still valid applies as is", () => {
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

  it("valid at signing and now expired preserves the past and re-evaluates only going forward", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: true,
      currentStatus: "expired",
    });
    expect(result.pastSignatureRemainsValid).toBe(true);
    expect(result.ongoingApplicability).toBe("needs_review");
    expect(result.triggersDownstreamReassessment).toBe(true);
  });

  it("a revoked credential keeps the past signature but is no longer evidence going forward", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: true,
      currentStatus: "revoked",
    });
    expect(result.pastSignatureRemainsValid).toBe(true);
    expect(result.ongoingApplicability).toBe("not_applicable");
  });

  it("if it was not valid even at signing, the past signature cannot be evidence", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: false,
      currentStatus: "valid",
    });
    expect(result.pastSignatureRemainsValid).toBe(false);
    expect(result.ongoingApplicability).toBe("not_applicable");
  });

  it("an unknown state is up for re-review — not silently left valid", () => {
    const result = evaluateCredentialApplicability({
      validAtAttestationTime: true,
      currentStatus: "unknown",
    });
    expect(result.ongoingApplicability).toBe("needs_review");
    expect(result.triggersDownstreamReassessment).toBe(true);
  });
});

describe("AC-15·AC-16 — the four facts are distinct", () => {
  const ALL_TRUE = {
    signatureValid: true,
    authorityAccepted: true,
    credentialValid: true,
    assignedToThisCase: true,
    claimWithinAuthorityScope: true,
  };

  it("no blocker when everything is met", () => {
    expect(canonicalAcceptanceBlockers(ALL_TRUE)).toEqual([]);
  });

  it("AC-15: blocked outside the authority scope even with a valid signature", () => {
    expect(
      canonicalAcceptanceBlockers({ ...ALL_TRUE, claimWithinAuthorityScope: false }),
    ).toEqual(["CLAIM_OUTSIDE_AUTHORITY_SCOPE"]);
  });

  it("AC-16: blocked when the authority has not accepted, even with a valid signature", () => {
    expect(canonicalAcceptanceBlockers({ ...ALL_TRUE, authorityAccepted: false })).toEqual([
      "AUTHORITY_NOT_ACCEPTED",
    ]);
  });

  it("blocked without an assignment even with a valid credential", () => {
    expect(canonicalAcceptanceBlockers({ ...ALL_TRUE, assignedToThisCase: false })).toEqual([
      "NOT_ASSIGNED",
    ]);
  });

  it("returns every blocker — it must not look like fixing one is enough", () => {
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
