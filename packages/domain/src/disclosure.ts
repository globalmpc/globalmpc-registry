/**
 * Public projection boundary and material-information blackout — spec 05 §5.7·§5.9 / 07 §7.14 /
 * 13 AC-22·AC-30·AC-32.
 *
 * Disclosure cannot be undone. An anchored leaf cannot be deleted, and a natural-person
 * identifier, once public, cannot be undone even by crypto-shredding (05 §5.9). So this
 * module rejects by default and permits only through an allowlist.
 */

export const SENSITIVITY_LEVELS = [
  "public",
  "restricted",
  "confidential",
  "pii",
  "whistleblower",
] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** Fields that may be included in the public projection (05 §5.7 "inclusion candidates"). */
export const PUBLIC_FIELD_ALLOWLIST = [
  "stableId",
  "projectKey",
  "projectName",
  "hostCountry",
  "mineral",
  "status",
  "version",
  "asOf",
  "sourceAge",
  "staleStatus",
  "claimSummary",
  "evidenceLedger",
  "grade",
  "limitations",
  "verificationScope",
  "authorityType",
  "authorityScope",
  "authorityJurisdiction",
  "collectionMethod",
  "reviewerOrganization",
  "reviewerCredentialType",
  "reviewerCredentialScope",
  "reviewerCredentialIssuer",
  "reviewerCredentialValidity",
  "reviewerPseudonymousHandle",
  "decisionAuthority",
  "decisionType",
  "decisionDate",
  "anchorTransaction",
  "anchorRoot",
  "inclusionProof",
  "supersededBy",
  "revokedAt",
  "disputeStatus",
  "legalEffect",
  "disclaimerCodes",
  "externalRegulatedServiceStatus",
] as const;
export type PublicField = (typeof PUBLIC_FIELD_ALLOWLIST)[number];

/**
 * What no approval can put into the public projection (05 §5.7 "exclusions").
 * Anything outside the allowlist is rejected anyway; this list is an explicit record against false positives.
 */
export const NEVER_PUBLIC_FIELDS = [
  "rawSourceResponse",
  "contractBody",
  "preciseGeologicalCoordinates",
  "personalIdentifier",
  "whistleblowerIdentity",
  "kycData",
  "naturalPersonBeneficialOwner",
  "privateNegotiation",
  "tradeSecret",
  "internalNotes",
  "apiCredential",
  "secretReference",
] as const;

export function isPublicField(field: string): field is PublicField {
  return (PUBLIC_FIELD_ALLOWLIST as readonly string[]).includes(field);
}

export type PublicationDenyReason =
  | "PUBLICATION_FIELD_NOT_ALLOWLISTED"
  | "PUBLICATION_SENSITIVITY_TOO_HIGH"
  | "PUBLICATION_PERSON_IDENTIFIER_GUARD"
  | "PUBLICATION_SOURCE_LICENSE_UNCONFIRMED"
  | "PUBLICATION_APPROVAL_MISSING";

export interface PublicationGuardInput {
  readonly fields: readonly string[];
  readonly sensitivity: Sensitivity;
  readonly disclosureApproved: boolean;
  /**
   * Does it include person-level identifiers such as a natural person's name or registration number?
   * The default is a pseudonymous handle (05 §5.9).
   */
  readonly containsPersonLevelIdentifier: boolean;
  readonly personIdentifierSafeguards: {
    readonly lawfulBasisRecorded: boolean;
    readonly explicitPublicationApproval: boolean;
    readonly purposeRecorded: boolean;
    readonly retentionRecorded: boolean;
    readonly irreversibilityAcknowledged: boolean;
  };
  /** `terms/license.commercial_reuse` — AC-13. */
  readonly commercialReuse: "confirmed" | "unconfirmed" | "prohibited";
  /** Is it being published as grounds for a commercial offering? */
  readonly publishedAsCommercialBasis: boolean;
}

export type PublicationCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: PublicationDenyReason;
      readonly offendingFields: readonly string[];
    };

export function checkPublishable(input: PublicationGuardInput): PublicationCheck {
  if (!input.disclosureApproved) {
    return {
      allowed: false,
      reason: "PUBLICATION_APPROVAL_MISSING",
      offendingFields: [],
    };
  }

  if (input.sensitivity !== "public") {
    return {
      allowed: false,
      reason: "PUBLICATION_SENSITIVITY_TOO_HIGH",
      offendingFields: [],
    };
  }

  const notAllowlisted = input.fields.filter((field) => !isPublicField(field));
  if (notAllowlisted.length > 0) {
    return {
      allowed: false,
      reason: "PUBLICATION_FIELD_NOT_ALLOWLISTED",
      offendingFields: notAllowlisted,
    };
  }

  if (input.containsPersonLevelIdentifier) {
    const safeguards = input.personIdentifierSafeguards;
    const complete =
      safeguards.lawfulBasisRecorded &&
      safeguards.explicitPublicationApproval &&
      safeguards.purposeRecorded &&
      safeguards.retentionRecorded &&
      safeguards.irreversibilityAcknowledged;
    if (!complete) {
      return {
        allowed: false,
        reason: "PUBLICATION_PERSON_IDENTIFIER_GUARD",
        offendingFields: [],
      };
    }
  }

  if (input.publishedAsCommercialBasis && input.commercialReuse !== "confirmed") {
    return {
      allowed: false,
      reason: "PUBLICATION_SOURCE_LICENSE_UNCONFIRMED",
      offendingFields: [],
    };
  }

  return { allowed: true };
}

/**
 * Material-information blackout — 07 §7.14, AC-30.
 *
 * During an active restriction, designated actions are rejected with the same restriction ID not
 * only in the UI but also in the API and the contract adapter. Hiding a button is not a control.
 */
/**
 * Actions a restriction may name — the closed list of blackout-checked actions in R0–R5.
 *
 * A restriction naming an action with no check behind it would read as a control that does not
 * exist, so creation rejects anything outside this list. Asset-token actions (transfer,
 * subscription, redemption) are not here: those paths are not built (OD-07, R6), and listing them
 * would promise a block on a route that returns 404 anyway.
 *
 * Suspension is deliberately absent. It reduces risk, and a blackout must never stand in the way
 * of taking a project down.
 */
export const RESTRICTABLE_ACTION_TYPES = [
  "registry.publish",
  "project.lifecycle.offering_open",
  "project.lifecycle.offering_closed",
  "project.lifecycle.active",
  "project.lifecycle.branch_vote",
  "project.lifecycle.continuing",
  "project.lifecycle.divested",
  "project.lifecycle.closure",
  "project.lifecycle.retired",
] as const;

export type RestrictableActionType = (typeof RESTRICTABLE_ACTION_TYPES)[number];

export function isRestrictableAction(value: string): value is RestrictableActionType {
  return (RESTRICTABLE_ACTION_TYPES as readonly string[]).includes(value);
}

export interface DisclosureRestriction {
  readonly restrictionId: string;
  readonly subjectScope: readonly string[];
  readonly restrictedActionTypes: readonly string[];
  readonly state: "draft" | "active" | "released" | "superseded";
}

export type RestrictionCheck =
  | { readonly blocked: false }
  | { readonly blocked: true; readonly restrictionId: string };

export function checkRestrictedAction(
  restrictions: readonly DisclosureRestriction[],
  subjectId: string,
  actionType: string,
): RestrictionCheck {
  for (const restriction of restrictions) {
    if (restriction.state !== "active") continue;
    if (!restriction.subjectScope.includes(subjectId)) continue;
    if (!restriction.restrictedActionTypes.includes(actionType)) continue;
    return { blocked: true, restrictionId: restriction.restrictionId };
  }
  return { blocked: false };
}
