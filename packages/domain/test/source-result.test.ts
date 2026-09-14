import { describe, expect, it } from "vitest";
import {
  SOURCE_RESULTS,
  SOURCE_RESULT_BEHAVIOUR,
  isSourceResult,
} from "../src/source-result.js";

describe("canonical source result enum — 13 §13.13", () => {
  it("정확히 12개다", () => {
    expect(SOURCE_RESULTS).toHaveLength(12);
  });

  it("중복이 없다", () => {
    expect(new Set(SOURCE_RESULTS).size).toBe(SOURCE_RESULTS.length);
  });

  it("모든 result에 동작 정의가 있다", () => {
    for (const result of SOURCE_RESULTS) {
      expect(SOURCE_RESULT_BEHAVIOUR[result]).toBeDefined();
      expect(SOURCE_RESULT_BEHAVIOUR[result].nextAction).toBeTruthy();
    }
  });

  it("동작 정의에 enum 밖 키가 없다", () => {
    expect(Object.keys(SOURCE_RESULT_BEHAVIOUR).sort()).toEqual([...SOURCE_RESULTS].sort());
  });

  it("별칭을 인식하지 않는다", () => {
    expect(isSourceResult("no_record")).toBe(false);
    expect(isSourceResult("unavailable")).toBe(false);
    expect(isSourceResult("error")).toBe(false);
    expect(isSourceResult("ok")).toBe(false);
  });
});

describe("AC-18 — no record / unavailable / not applicable은 서로 다르다", () => {
  const noRecord = SOURCE_RESULT_BEHAVIOUR.source_returned_no_record;
  const unavailable = SOURCE_RESULT_BEHAVIOUR.source_unavailable;
  const notApplicable = SOURCE_RESULT_BEHAVIOUR.not_applicable;

  it("재시도 가능성이 다르다", () => {
    // 출처가 정상 응답하며 "없다"고 했으면 재시도해도 같다.
    expect(noRecord.retryable).toBe(false);
    // 출처가 응답하지 못한 것은 재시도 대상이다.
    expect(unavailable.retryable).toBe(true);
    expect(notApplicable.retryable).toBe(false);
  });

  it("다음 행동이 다르다", () => {
    const actions = new Set([
      noRecord.nextAction,
      unavailable.nextAction,
      notApplicable.nextAction,
    ]);
    expect(actions.size).toBe(3);
  });

  it("connection 상태에 미치는 영향이 다르다", () => {
    expect(noRecord.degradesConnection).toBe(false);
    expect(unavailable.degradesConnection).toBe(true);
    expect(notApplicable.degradesConnection).toBe(false);
  });
});

describe("불변조건 15 — API success ≠ canonical claim acceptance", () => {
  it("confirmed_from_source만 canonical acceptance 후보가 된다", () => {
    const permitted = SOURCE_RESULTS.filter(
      (result) => SOURCE_RESULT_BEHAVIOUR[result].permitsCanonicalAcceptance,
    );
    expect(permitted).toEqual(["confirmed_from_source"]);
  });

  it("confirmed_from_source도 그 자체로 acceptance는 아니다 — limitation 확인이 다음 행동이다", () => {
    expect(SOURCE_RESULT_BEHAVIOUR.confirmed_from_source.nextAction).toBe("view_limitations");
  });
});

describe("AC-19 — schema drift는 silent normalization을 만들지 않는다", () => {
  it("schema_changed는 재시도 대상이 아니라 reconciliation 대상이다", () => {
    const behaviour = SOURCE_RESULT_BEHAVIOUR.schema_changed;
    expect(behaviour.retryable).toBe(false);
    expect(behaviour.permitsCanonicalAcceptance).toBe(false);
    expect(behaviour.degradesConnection).toBe(true);
    expect(behaviour.nextAction).toBe("await_reconciliation");
  });
});

describe("보안 관련 result", () => {
  it("signature_invalid는 격리·보안 검토로 간다", () => {
    expect(SOURCE_RESULT_BEHAVIOUR.signature_invalid.nextAction).toBe(
      "quarantine_security_review",
    );
    expect(SOURCE_RESULT_BEHAVIOUR.signature_invalid.retryable).toBe(false);
  });

  it("legal_interpretation_required는 법무로 escalate한다", () => {
    expect(SOURCE_RESULT_BEHAVIOUR.legal_interpretation_required.nextAction).toBe(
      "escalate_to_legal",
    );
  });
});
