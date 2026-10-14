import { describe, expect, it } from "vitest";
import {
  canChangeCredentialStatus,
  canonicalAcceptanceBlockers,
  evaluateAuthorityBasis,
  type AuthorityFacts,
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
  independenceReviewed: true,
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

describe("02 §2.4 — an assignment whose independence was not reviewed cannot be signed on", () => {
  it("rejects when independence was not reviewed", () => {
    const result = checkAttestationSignable({ ...SIGNABLE, independenceReviewed: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("ATTESTATION_INDEPENDENCE_NOT_REVIEWED");
  });
});

describe("AC-15·AC-16 — authority basis", () => {
  const ISSUER: AuthorityFacts = {
    state: "accepted",
    validFrom: "2020-01-01",
    validUntil: null,
    recognizedScope: ["mining_right_registration", "resource_estimate"],
  };
  const BASE = {
    issuer: ISSUER,
    sourceAuthorities: [],
    claimTypes: ["mining_right_registration"],
    credentialScope: ["mining_right_registration"],
    asOf: "2026-09-23",
  };

  it("accepts an accepted issuer recognized for every claim type", () => {
    const basis = evaluateAuthorityBasis(BASE);
    expect(basis.authorityAccepted).toBe(true);
    expect(basis.claimWithinAuthorityScope).toBe(true);
    expect(basis.credentialScopeCoversClaims).toBe(true);
  });

  it("AC-16: a proposed, suspended or expired issuer is not accepted", () => {
    for (const state of ["proposed", "under_review", "suspended", "expired", "revoked", "superseded"] as const) {
      expect(evaluateAuthorityBasis({ ...BASE, issuer: { ...ISSUER, state } }).authorityAccepted).toBe(false);
    }
  });

  it("AC-16: an accepted issuer outside its validity period is not accepted", () => {
    const lapsed = evaluateAuthorityBasis({ ...BASE, issuer: { ...ISSUER, validUntil: "2025-12-31" } });
    expect(lapsed.authorityAccepted).toBe(false);
  });

  it("AC-16: a suspended source authority blocks the basis even with an accepted issuer", () => {
    const basis = evaluateAuthorityBasis({
      ...BASE,
      sourceAuthorities: [{ ...ISSUER, state: "suspended" }],
    });
    expect(basis.authorityAccepted).toBe(false);
  });

  it("a credential with no linked issuer is neither accepted nor in scope", () => {
    const basis = evaluateAuthorityBasis({ ...BASE, issuer: null });
    expect(basis.authorityAccepted).toBe(false);
    expect(basis.claimWithinAuthorityScope).toBe(false);
  });

  it("AC-15: a claim type outside the issuer's recognized scope is reported", () => {
    const basis = evaluateAuthorityBasis({
      ...BASE,
      claimTypes: ["mining_right_registration", "environmental_permit"],
      credentialScope: ["mining_right_registration", "environmental_permit"],
    });
    expect(basis.claimWithinAuthorityScope).toBe(false);
    expect(basis.outsideAuthorityScope).toEqual(["environmental_permit"]);
  });

  it("credential scope must cover every claim type — non-empty is not enough", () => {
    const basis = evaluateAuthorityBasis({ ...BASE, credentialScope: ["resource_estimate"] });
    expect(basis.credentialScopeCoversClaims).toBe(false);
    expect(basis.outsideCredentialScope).toEqual(["mining_right_registration"]);
  });

  it("feeds canonicalAcceptanceBlockers", () => {
    const basis = evaluateAuthorityBasis({ ...BASE, issuer: { ...ISSUER, state: "suspended" } });
    expect(
      canonicalAcceptanceBlockers({
        signatureValid: true,
        authorityAccepted: basis.authorityAccepted,
        credentialValid: true,
        assignedToThisCase: true,
        claimWithinAuthorityScope: basis.claimWithinAuthorityScope,
      }),
    ).toEqual(["AUTHORITY_NOT_ACCEPTED"]);
  });
});

describe("credential status transitions", () => {
  it("revoked is terminal", () => {
    for (const to of ["valid", "expired", "suspended", "unknown"] as const) {
      expect(canChangeCredentialStatus("revoked", to)).toBe(false);
    }
  });

  it("a suspension can be lifted, an expiry cannot be undone", () => {
    expect(canChangeCredentialStatus("suspended", "valid")).toBe(true);
    expect(canChangeCredentialStatus("expired", "valid")).toBe(false);
    expect(canChangeCredentialStatus("expired", "revoked")).toBe(true);
  });

  it("a status cannot change to itself", () => {
    expect(canChangeCredentialStatus("valid", "valid")).toBe(false);
  });
});
