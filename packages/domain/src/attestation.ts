import type { AttestationType } from "./provenance.js";

/**
 * Verification Attestation pre-signature checks — spec 04 §4.2 / 13 AC-01·AC-17.
 *
 * This module only decides "may this be signed". Signing itself uses the user's key; the
 * server never holds a private key or signs on anyone's behalf (07 §7.2, 02 §2.8).
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
   * Scope and limitations of the review. Empty strings are not allowed (05 §5.3, AC-01).
   *
   * "No limitations" is a review result that does not exist. No professional review vouches for
   * facts outside its scope.
   */
  readonly limitations: string;
  readonly conflictStatus: ConflictStatus;
  readonly credentialValidAtSigningTime: boolean;
  readonly credentialScopeCoversClaims: boolean;
  readonly hasActiveAssignment: boolean;
  readonly schemaState: "draft" | "approved" | "active" | "superseded" | "retired";
  /**
   * Is the signer the submitter of this evidence?
   * The submitter cannot give `independent_assurance` (02 §2.4 rule 1).
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
 * Point-in-time credential evaluation — AC-12·AC-17.
 *
 * If a credential valid at signing time is now expired or revoked, **the past signature is
 * preserved as is** and only future applicability is re-evaluated. Retroactively voiding the past
 * would make the basis of decisions made at that time unreproducible.
 */
export type CredentialCurrentStatus = "valid" | "expired" | "revoked" | "suspended" | "unknown";

export type OngoingApplicability = "applicable" | "needs_review" | "not_applicable";

export interface CredentialApplicability {
  /** Validity at signing time. Does not change with the current state. */
  readonly pastSignatureRemainsValid: boolean;
  readonly ongoingApplicability: OngoingApplicability;
  /** Is downstream grade/readiness re-evaluation needed? */
  readonly triggersDownstreamReassessment: boolean;
}

export function evaluateCredentialApplicability(input: {
  readonly validAtAttestationTime: boolean;
  readonly currentStatus: CredentialCurrentStatus;
}): CredentialApplicability {
  if (!input.validAtAttestationTime) {
    // If it was not valid even at signing time, that signature could never be evidence.
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
      // Revocation means the issuer voided the credential itself. The past signature remains,
      // but it cannot serve as evidence going forward.
      return {
        pastSignatureRemainsValid: true,
        ongoingApplicability: "not_applicable",
        triggersDownstreamReassessment: true,
      };
  }
}

/**
 * Signature validity and authority acceptance are distinct states — invariants 13·14, AC-15·AC-16.
 *
 * This function exists to block attempts to collapse the four into one boolean.
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

/** Returns every blocker to check before accepting as a canonical claim. */
export function canonicalAcceptanceBlockers(facts: AcceptanceFacts): AcceptanceBlocker[] {
  const blockers: AcceptanceBlocker[] = [];
  if (!facts.signatureValid) blockers.push("SIGNATURE_INVALID");
  if (!facts.authorityAccepted) blockers.push("AUTHORITY_NOT_ACCEPTED");
  if (!facts.credentialValid) blockers.push("CREDENTIAL_INVALID");
  if (!facts.assignedToThisCase) blockers.push("NOT_ASSIGNED");
  if (!facts.claimWithinAuthorityScope) blockers.push("CLAIM_OUTSIDE_AUTHORITY_SCOPE");
  return blockers;
}
