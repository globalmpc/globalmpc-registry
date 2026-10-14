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
  | "ATTESTATION_SELF_ASSURANCE"
  | "ATTESTATION_INDEPENDENCE_NOT_REVIEWED";

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
  /**
   * Did the server evaluate 02 §2.4 rules 1·2 for this assignment and find nothing it could not
   * evaluate? An assignment whose independence could not be judged is not a basis for signing —
   * "not checked" must not read as "independent".
   */
  readonly independenceReviewed: boolean;
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
  if (!request.independenceReviewed) {
    return { allowed: false, reason: "ATTESTATION_INDEPENDENCE_NOT_REVIEWED" };
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

/**
 * The authority facts behind `authorityAccepted` and `claimWithinAuthorityScope` — AC-15·AC-16.
 *
 * `canonicalAcceptanceBlockers` takes booleans; this is where they come from, so that every
 * caller derives them the same way instead of each route deciding what "accepted" means.
 */
export type AuthorityState =
  | "proposed"
  | "under_review"
  | "accepted"
  | "suspended"
  | "expired"
  | "revoked"
  | "superseded";

export interface AuthorityFacts {
  readonly state: AuthorityState;
  /** ISO date (YYYY-MM-DD). */
  readonly validFrom: string;
  readonly validUntil: string | null;
  readonly recognizedScope: readonly string[];
}

export interface AuthorityBasisInput {
  /**
   * The authority that issued the reviewer's credential. `null` when the credential is not
   * linked to one — an issuer nobody can look up is not an accepted issuer.
   */
  readonly issuer: AuthorityFacts | null;
  /** Authorities behind the source receipts the reviewed claims rest on (AC-16 "source"). */
  readonly sourceAuthorities: readonly AuthorityFacts[];
  /** Claim types under review. */
  readonly claimTypes: readonly string[];
  readonly credentialScope: readonly string[];
  /** ISO date (YYYY-MM-DD) the basis is judged on. */
  readonly asOf: string;
}

export interface AuthorityBasis {
  readonly authorityAccepted: boolean;
  readonly claimWithinAuthorityScope: boolean;
  readonly credentialScopeCoversClaims: boolean;
  /** Claim types the issuer is not recognized for. Shown so the reviewer knows what to fix. */
  readonly outsideAuthorityScope: readonly string[];
  /** Claim types the credential does not cover. */
  readonly outsideCredentialScope: readonly string[];
}

/** Accepted, and inside its validity period on `asOf`. An expired period is not acceptance. */
export function isAuthorityInForce(authority: AuthorityFacts, asOf: string): boolean {
  if (authority.state !== "accepted") return false;
  if (authority.validFrom > asOf) return false;
  return authority.validUntil === null || authority.validUntil >= asOf;
}

export function evaluateAuthorityBasis(input: AuthorityBasisInput): AuthorityBasis {
  const claimTypes = [...new Set(input.claimTypes)].sort();
  const outsideCredentialScope = claimTypes.filter(
    (type) => !input.credentialScope.includes(type),
  );
  // Without an issuer, every claim type is outside its recognized scope — nothing vouches for it.
  const outsideAuthorityScope = input.issuer
    ? claimTypes.filter((type) => !input.issuer!.recognizedScope.includes(type))
    : claimTypes;

  const issuerInForce = input.issuer !== null && isAuthorityInForce(input.issuer, input.asOf);
  const sourcesInForce = input.sourceAuthorities.every((source) =>
    isAuthorityInForce(source, input.asOf),
  );

  return {
    authorityAccepted: issuerInForce && sourcesInForce,
    // An empty claim set covers nothing; the empty-scope check reports it separately.
    claimWithinAuthorityScope: claimTypes.length > 0 && outsideAuthorityScope.length === 0,
    credentialScopeCoversClaims: claimTypes.length > 0 && outsideCredentialScope.length === 0,
    outsideAuthorityScope,
    outsideCredentialScope,
  };
}

/**
 * Credential status changes — 02 §2.6·§2.8, REQ-DAPP-042·044.
 *
 * `revoked` is terminal: the issuer voided the credential, and bringing it back would rewrite
 * that fact. `suspended` can be lifted. `expired` can still be revoked (an issuer may void an
 * expired credential) but not revived — a renewed credential is a new registration.
 */
export const CREDENTIAL_STATUS_TRANSITIONS: Readonly<
  Record<CredentialCurrentStatus, readonly CredentialCurrentStatus[]>
> = {
  valid: ["expired", "revoked", "suspended"],
  suspended: ["valid", "expired", "revoked"],
  expired: ["revoked"],
  unknown: ["valid", "expired", "revoked", "suspended"],
  revoked: [],
};

export function canChangeCredentialStatus(
  from: CredentialCurrentStatus,
  to: CredentialCurrentStatus,
): boolean {
  return CREDENTIAL_STATUS_TRANSITIONS[from].includes(to);
}
