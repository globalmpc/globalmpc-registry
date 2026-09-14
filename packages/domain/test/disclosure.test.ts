import { describe, expect, it } from "vitest";
import {
  NEVER_PUBLIC_FIELDS,
  PUBLIC_FIELD_ALLOWLIST,
  checkPublishable,
  checkRestrictedAction,
  isPublicField,
  type DisclosureRestriction,
  type PublicationGuardInput,
} from "../src/disclosure.js";

const SAFEGUARDS_COMPLETE = {
  lawfulBasisRecorded: true,
  explicitPublicationApproval: true,
  purposeRecorded: true,
  retentionRecorded: true,
  irreversibilityAcknowledged: true,
};

const PUBLISHABLE: PublicationGuardInput = {
  fields: ["projectKey", "hostCountry", "status", "asOf", "limitations", "grade"],
  sensitivity: "public",
  disclosureApproved: true,
  containsPersonLevelIdentifier: false,
  personIdentifierSafeguards: SAFEGUARDS_COMPLETE,
  commercialReuse: "confirmed",
  publishedAsCommercialBasis: false,
};

describe("AC-22 — public projection allowlist", () => {
  it("allowlist 필드만 있으면 통과한다", () => {
    expect(checkPublishable(PUBLISHABLE).allowed).toBe(true);
  });

  it("allowlist에 없는 필드를 거절하고 어떤 필드인지 반환한다", () => {
    const result = checkPublishable({
      ...PUBLISHABLE,
      fields: [...PUBLISHABLE.fields, "rawSourceResponse", "internalNotes"],
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe("PUBLICATION_FIELD_NOT_ALLOWLISTED");
      expect(result.offendingFields).toEqual(["rawSourceResponse", "internalNotes"]);
    }
  });

  it("절대 공개 불가 필드는 전부 allowlist 밖이다", () => {
    for (const field of NEVER_PUBLIC_FIELDS) {
      expect(isPublicField(field)).toBe(false);
    }
  });

  it("public이 아닌 민감도는 승인이 있어도 거절한다", () => {
    for (const sensitivity of ["restricted", "confidential", "pii", "whistleblower"] as const) {
      const result = checkPublishable({ ...PUBLISHABLE, sensitivity });
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("PUBLICATION_SENSITIVITY_TOO_HIGH");
    }
  });

  it("disclosure 승인 없이는 공개하지 않는다", () => {
    const result = checkPublishable({ ...PUBLISHABLE, disclosureApproved: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("PUBLICATION_APPROVAL_MISSING");
  });

  it("allowlist에 원문·PII 성격의 필드가 없다", () => {
    const allowlist = new Set<string>(PUBLIC_FIELD_ALLOWLIST);
    for (const forbidden of NEVER_PUBLIC_FIELDS) {
      expect(allowlist.has(forbidden)).toBe(false);
    }
  });
});

describe("AC-32 — 자연인 식별자의 비가역 공개 차단", () => {
  it("safeguard가 전부 갖춰지면 허용한다", () => {
    expect(
      checkPublishable({
        ...PUBLISHABLE,
        containsPersonLevelIdentifier: true,
        personIdentifierSafeguards: SAFEGUARDS_COMPLETE,
      }).allowed,
    ).toBe(true);
  });

  const safeguardKeys = [
    "lawfulBasisRecorded",
    "explicitPublicationApproval",
    "purposeRecorded",
    "retentionRecorded",
    "irreversibilityAcknowledged",
  ] as const;

  for (const key of safeguardKeys) {
    it(`${key}가 없으면 차단한다`, () => {
      const result = checkPublishable({
        ...PUBLISHABLE,
        containsPersonLevelIdentifier: true,
        personIdentifierSafeguards: { ...SAFEGUARDS_COMPLETE, [key]: false },
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("PUBLICATION_PERSON_IDENTIFIER_GUARD");
    });
  }

  it("pseudonymous handle은 기본 allowlist에 있다", () => {
    expect(isPublicField("reviewerPseudonymousHandle")).toBe(true);
  });
});

describe("AC-13 — source license", () => {
  it("commercial_reuse가 unconfirmed면 상업적 근거로 publish할 수 없다", () => {
    const result = checkPublishable({
      ...PUBLISHABLE,
      commercialReuse: "unconfirmed",
      publishedAsCommercialBasis: true,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("PUBLICATION_SOURCE_LICENSE_UNCONFIRMED");
  });

  it("prohibited도 마찬가지다", () => {
    expect(
      checkPublishable({
        ...PUBLISHABLE,
        commercialReuse: "prohibited",
        publishedAsCommercialBasis: true,
      }).allowed,
    ).toBe(false);
  });

  it("Reference·methodology 용도는 unconfirmed여도 가능하다", () => {
    expect(
      checkPublishable({
        ...PUBLISHABLE,
        commercialReuse: "unconfirmed",
        publishedAsCommercialBasis: false,
      }).allowed,
    ).toBe(true);
  });
});

describe("AC-30 — 중대정보 blackout", () => {
  const active: DisclosureRestriction = {
    restrictionId: "restriction-001",
    subjectScope: ["asset-A"],
    restrictedActionTypes: ["transfer", "offering_subscribe"],
    state: "active",
  };

  it("active restriction은 지정된 action을 차단하고 restriction ID를 반환한다", () => {
    const result = checkRestrictedAction([active], "asset-A", "transfer");
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.restrictionId).toBe("restriction-001");
  });

  it("scope 밖 subject는 차단하지 않는다", () => {
    expect(checkRestrictedAction([active], "asset-B", "transfer").blocked).toBe(false);
  });

  it("지정되지 않은 action은 차단하지 않는다", () => {
    expect(checkRestrictedAction([active], "asset-A", "view").blocked).toBe(false);
  });

  it("released·draft·superseded restriction은 차단하지 않는다", () => {
    for (const state of ["draft", "released", "superseded"] as const) {
      expect(
        checkRestrictedAction([{ ...active, state }], "asset-A", "transfer").blocked,
      ).toBe(false);
    }
  });

  it("여러 restriction 중 하나라도 걸리면 차단한다", () => {
    const other: DisclosureRestriction = {
      restrictionId: "restriction-002",
      subjectScope: ["asset-A"],
      restrictedActionTypes: ["vote"],
      state: "active",
    };
    const result = checkRestrictedAction([active, other], "asset-A", "vote");
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.restrictionId).toBe("restriction-002");
  });
});
