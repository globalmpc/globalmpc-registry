import { describe, expect, it } from "vitest";
import {
  NEVER_PUBLIC_FIELDS,
  PUBLIC_FIELD_ALLOWLIST,
  checkPublishable,
  checkRestrictedAction,
  RESTRICTABLE_ACTION_TYPES,
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
  it("passes with only allowlisted fields", () => {
    expect(checkPublishable(PUBLISHABLE).allowed).toBe(true);
  });

  it("rejects fields outside the allowlist and returns which ones", () => {
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

  it("every never-public field is outside the allowlist", () => {
    for (const field of NEVER_PUBLIC_FIELDS) {
      expect(isPublicField(field)).toBe(false);
    }
  });

  it("rejects non-public sensitivity even with approval", () => {
    for (const sensitivity of ["restricted", "confidential", "pii", "whistleblower"] as const) {
      const result = checkPublishable({ ...PUBLISHABLE, sensitivity });
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("PUBLICATION_SENSITIVITY_TOO_HIGH");
    }
  });

  it("does not disclose without disclosure approval", () => {
    const result = checkPublishable({ ...PUBLISHABLE, disclosureApproved: false });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("PUBLICATION_APPROVAL_MISSING");
  });

  it("the allowlist has no raw-content or PII fields", () => {
    const allowlist = new Set<string>(PUBLIC_FIELD_ALLOWLIST);
    for (const forbidden of NEVER_PUBLIC_FIELDS) {
      expect(allowlist.has(forbidden)).toBe(false);
    }
  });
});

describe("AC-32 — blocks irreversible disclosure of natural-person identifiers", () => {
  it("allows when every safeguard is in place", () => {
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
    it(`blocks when ${key} is missing`, () => {
      const result = checkPublishable({
        ...PUBLISHABLE,
        containsPersonLevelIdentifier: true,
        personIdentifierSafeguards: { ...SAFEGUARDS_COMPLETE, [key]: false },
      });
      expect(result.allowed).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("PUBLICATION_PERSON_IDENTIFIER_GUARD");
    });
  }

  it("the pseudonymous handle is in the default allowlist", () => {
    expect(isPublicField("reviewerPseudonymousHandle")).toBe(true);
  });
});

describe("AC-13 — source license", () => {
  it("cannot publish as commercial grounds when commercial_reuse is unconfirmed", () => {
    const result = checkPublishable({
      ...PUBLISHABLE,
      commercialReuse: "unconfirmed",
      publishedAsCommercialBasis: true,
    });
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("PUBLICATION_SOURCE_LICENSE_UNCONFIRMED");
  });

  it("same for prohibited", () => {
    expect(
      checkPublishable({
        ...PUBLISHABLE,
        commercialReuse: "prohibited",
        publishedAsCommercialBasis: true,
      }).allowed,
    ).toBe(false);
  });

  it("reference and methodology use is possible even when unconfirmed", () => {
    expect(
      checkPublishable({
        ...PUBLISHABLE,
        commercialReuse: "unconfirmed",
        publishedAsCommercialBasis: false,
      }).allowed,
    ).toBe(true);
  });
});

describe("AC-30 — material-information blackout", () => {
  const active: DisclosureRestriction = {
    restrictionId: "restriction-001",
    subjectScope: ["asset-A"],
    restrictedActionTypes: ["transfer", "offering_subscribe"],
    state: "active",
  };

  it("an active restriction blocks designated actions and returns the restriction ID", () => {
    const result = checkRestrictedAction([active], "asset-A", "transfer");
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.restrictionId).toBe("restriction-001");
  });

  it("does not block a subject outside the scope", () => {
    expect(checkRestrictedAction([active], "asset-B", "transfer").blocked).toBe(false);
  });

  it("does not block an undesignated action", () => {
    expect(checkRestrictedAction([active], "asset-A", "view").blocked).toBe(false);
  });

  it("released, draft, and superseded restrictions do not block", () => {
    for (const state of ["draft", "released", "superseded"] as const) {
      expect(
        checkRestrictedAction([{ ...active, state }], "asset-A", "transfer").blocked,
      ).toBe(false);
    }
  });

  it("blocks if any one of several restrictions applies", () => {
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

describe("restrictable actions — 07 §7.14", () => {
  it("never lets a blackout block suspension", () => {
    // Taking a project down reduces risk; a blackout must not stand in its way.
    expect(RESTRICTABLE_ACTION_TYPES).not.toContain("project.lifecycle.suspended");
  });

  it("does not list asset-token actions that have no route (OD-07)", () => {
    for (const action of RESTRICTABLE_ACTION_TYPES) {
      expect(action).toMatch(/^(registry\.publish|project\.lifecycle\.)/);
    }
  });
});
