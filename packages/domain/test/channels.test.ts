import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  checkChannelReady,
  checkSecondReview,
  classifyBulkExport,
  classifySignedDocument,
  detectSchemaDrift,
  requiresSecondReview,
} from "../src/channels.js";

/**
 * Evidence channel parity — AC-29.
 *
 * All four channels use the same result enum, but each must block different things. This file
 * checks that **a weak channel does not become an easy channel**.
 */
describe("schema drift", () => {
  it("catches a vanished field", () => {
    const drift = detectSchemaDrift(["licenseId", "holder", "expiresAt"], ["licenseId", "holder"]);
    expect(drift.drifted).toBe(true);
    // When an existing column vanishes, the parser can pass undefined along as empty.
    expect(drift.removed).toEqual(["expiresAt"]);
  });

  it("a new field is drift too", () => {
    const drift = detectSchemaDrift(["licenseId"], ["licenseId", "newColumn"]);
    expect(drift.drifted).toBe(true);
    expect(drift.added).toEqual(["newColumn"]);
  });

  it("says it did not compare when there is no declaration", () => {
    const drift = detectSchemaDrift([], ["a", "b"]);
    // The unknown is never read as a match.
    expect(drift.compared).toBe(false);
    expect(drift.drifted).toBe(false);
  });

  it("the same set in a different order is not drift", () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 1 }), (fields) => {
        const shuffled = [...fields].reverse();
        expect(detectSchemaDrift(fields, shuffled).drifted).toBe(false);
      }),
    );
  });
});

describe("bulk export", () => {
  it("drift is not confirmed", () => {
    const { result } = classifyBulkExport({
      declaredFields: ["licenseId", "expiresAt"],
      observedFields: ["licenseId"],
      recordFound: true,
    });
    // A value read from a file whose columns changed may point at something else.
    expect(result).toBe("schema_changed");
  });

  it("a person looks when nothing was compared", () => {
    const { result } = classifyBulkExport({
      declaredFields: [],
      observedFields: ["licenseId"],
      recordFound: true,
    });
    expect(result).toBe("manual_review_required");
  });

  it("a sound file without the record is no record", () => {
    const { result } = classifyBulkExport({
      declaredFields: ["licenseId"],
      observedFields: ["licenseId"],
      recordFound: false,
    });
    // A fact, not an outage.
    expect(result).toBe("source_returned_no_record");
  });
});

describe("signed document", () => {
  it("a failed signature verification is not confirmed", () => {
    expect(
      classifySignedDocument({ signatureValid: false, signerRecognized: true, recordFound: true }),
    ).toBe("signature_invalid");
  });

  it("distinguishes not verified from failed", () => {
    // Verification cannot be skipped by not registering a public key.
    expect(
      classifySignedDocument({ signatureValid: null, signerRecognized: true, recordFound: true }),
    ).toBe("manual_review_required");
  });

  it("rejects a valid signature from an unknown signer", () => {
    // A valid signature does not say who the signer is.
    expect(
      classifySignedDocument({ signatureValid: true, signerRecognized: false, recordFound: true }),
    ).toBe("signature_invalid");
  });

  it("confirms a valid signature from a known signer", () => {
    expect(
      classifySignedDocument({ signatureValid: true, signerRecognized: true, recordFound: true }),
    ).toBe("confirmed_from_source");
  });
});

describe("manual second review", () => {
  it("only manual checks require a second review", () => {
    expect(requiresSecondReview("manual_official_registry_confirmation")).toBe(true);
    expect(requiresSecondReview("authenticated_api")).toBe(false);
  });

  it("not confirmed without a second review", () => {
    const check = checkSecondReview({ firstConfirmedBy: "a", secondConfirmedBy: null });
    expect(check.ok).toBe(false);
  });

  it("the same person cannot check twice", () => {
    // The purpose is a different pair of eyes; allowing the same person leaves only the procedure.
    const check = checkSecondReview({ firstConfirmedBy: "a", secondConfirmedBy: "a" });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toContain("The first checker");
  });

  it("passes when another person confirms", () => {
    expect(checkSecondReview({ firstConfirmedBy: "a", secondConfirmedBy: "b" }).ok).toBe(true);
  });
});

describe("channel requirements", () => {
  it("requirements are not asked for a non-confirmation", () => {
    // Failures must be recorded as failures.
    const check = checkChannelReady({
      method: "manual_official_registry_confirmation",
      result: "source_unavailable",
    });
    expect(check.ok).toBe(true);
  });

  it("a signed document without signature evidence cannot be confirmed", () => {
    const check = checkChannelReady({
      method: "verifiable_signed_document",
      result: "confirmed_from_source",
      signatureValid: null,
    });
    expect(check.ok).toBe(false);
  });

  it("a bulk export without an observed schema cannot be confirmed", () => {
    const check = checkChannelReady({
      method: "official_bulk_export",
      result: "confirmed_from_source",
      observedFields: null,
    });
    expect(check.ok).toBe(false);
  });

  it("the API channel requires no channel evidence", () => {
    // For an API the status code signals failure. The adapter has already decided that.
    const check = checkChannelReady({
      method: "authenticated_api",
      result: "confirmed_from_source",
    });
    expect(check.ok).toBe(true);
  });
});
