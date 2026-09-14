import { describe, expect, it } from "vitest";
import {
  SOURCE_RESULTS,
  SOURCE_RESULT_BEHAVIOUR,
  isSourceResult,
} from "../src/source-result.js";

describe("canonical source result enum — 13 §13.13", () => {
  it("exactly 12", () => {
    expect(SOURCE_RESULTS).toHaveLength(12);
  });

  it("no duplicates", () => {
    expect(new Set(SOURCE_RESULTS).size).toBe(SOURCE_RESULTS.length);
  });

  it("every result has a behavior definition", () => {
    for (const result of SOURCE_RESULTS) {
      expect(SOURCE_RESULT_BEHAVIOUR[result]).toBeDefined();
      expect(SOURCE_RESULT_BEHAVIOUR[result].nextAction).toBeTruthy();
    }
  });

  it("behavior definitions have no keys outside the enum", () => {
    expect(Object.keys(SOURCE_RESULT_BEHAVIOUR).sort()).toEqual([...SOURCE_RESULTS].sort());
  });

  it("does not recognize aliases", () => {
    expect(isSourceResult("no_record")).toBe(false);
    expect(isSourceResult("unavailable")).toBe(false);
    expect(isSourceResult("error")).toBe(false);
    expect(isSourceResult("ok")).toBe(false);
  });
});

describe("AC-18 — no record / unavailable / not applicable are distinct", () => {
  const noRecord = SOURCE_RESULT_BEHAVIOUR.source_returned_no_record;
  const unavailable = SOURCE_RESULT_BEHAVIOUR.source_unavailable;
  const notApplicable = SOURCE_RESULT_BEHAVIOUR.not_applicable;

  it("retryability differs", () => {
    // If the source answered normally and said "none", a retry yields the same.
    expect(noRecord.retryable).toBe(false);
    // A source that could not answer is a retry target.
    expect(unavailable.retryable).toBe(true);
    expect(notApplicable.retryable).toBe(false);
  });

  it("the next action differs", () => {
    const actions = new Set([
      noRecord.nextAction,
      unavailable.nextAction,
      notApplicable.nextAction,
    ]);
    expect(actions.size).toBe(3);
  });

  it("the effect on connection state differs", () => {
    expect(noRecord.degradesConnection).toBe(false);
    expect(unavailable.degradesConnection).toBe(true);
    expect(notApplicable.degradesConnection).toBe(false);
  });
});

describe("invariant 15 — API success ≠ canonical claim acceptance", () => {
  it("only confirmed_from_source is a canonical acceptance candidate", () => {
    const permitted = SOURCE_RESULTS.filter(
      (result) => SOURCE_RESULT_BEHAVIOUR[result].permitsCanonicalAcceptance,
    );
    expect(permitted).toEqual(["confirmed_from_source"]);
  });

  it("confirmed_from_source is not acceptance by itself — checking limitations is the next action", () => {
    expect(SOURCE_RESULT_BEHAVIOUR.confirmed_from_source.nextAction).toBe("view_limitations");
  });
});

describe("AC-19 — schema drift creates no silent normalization", () => {
  it("schema_changed is a reconciliation target, not a retry target", () => {
    const behaviour = SOURCE_RESULT_BEHAVIOUR.schema_changed;
    expect(behaviour.retryable).toBe(false);
    expect(behaviour.permitsCanonicalAcceptance).toBe(false);
    expect(behaviour.degradesConnection).toBe(true);
    expect(behaviour.nextAction).toBe("await_reconciliation");
  });
});

describe("security-related results", () => {
  it("signature_invalid goes to quarantine and security review", () => {
    expect(SOURCE_RESULT_BEHAVIOUR.signature_invalid.nextAction).toBe(
      "quarantine_security_review",
    );
    expect(SOURCE_RESULT_BEHAVIOUR.signature_invalid.retryable).toBe(false);
  });

  it("legal_interpretation_required escalates to legal", () => {
    expect(SOURCE_RESULT_BEHAVIOUR.legal_interpretation_required.nextAction).toBe(
      "escalate_to_legal",
    );
  });
});
