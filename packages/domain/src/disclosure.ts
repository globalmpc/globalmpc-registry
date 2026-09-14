/**
 * 공개 projection 경계와 중대정보 blackout — spec 05 §5.7·§5.9 / 07 §7.14 /
 * 13 AC-22·AC-30·AC-32.
 *
 * 공개는 되돌릴 수 없다. anchor된 leaf는 삭제할 수 없고, 한 번 공개된 자연인
 * 식별자는 crypto-shredding으로도 되돌릴 수 없다(05 §5.9). 그래서 이 모듈의
 * 기본값은 전부 거절이고, 허용은 allowlist로만 이루어진다.
 */

export const SENSITIVITY_LEVELS = [
  "public",
  "restricted",
  "confidential",
  "pii",
  "whistleblower",
] as const;
export type Sensitivity = (typeof SENSITIVITY_LEVELS)[number];

/** public projection에 포함 가능한 필드(05 §5.7 "포함 후보"). */
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
 * 어떤 승인으로도 public projection에 넣을 수 없는 것(05 §5.7 "제외").
 * allowlist에 없는 것은 전부 거절되지만, 이 목록은 오탐을 막기 위한 명시적 기록이다.
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
   * 자연인 이름·등록번호 등 person-level 식별자를 포함하는가.
   * 기본은 pseudonymous handle이다(05 §5.9).
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
  /** 상업적 offering 근거로 publish하려는가. */
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
 * 중대정보 blackout — 07 §7.14, AC-30.
 *
 * active restriction 동안 지정된 action은 UI뿐 아니라 API와 contract adapter에서도
 * 같은 restriction ID로 거절된다. 버튼을 숨기는 것은 통제가 아니다.
 */
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
