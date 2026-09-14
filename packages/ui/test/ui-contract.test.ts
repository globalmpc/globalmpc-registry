import { describe, expect, it } from "vitest";
import { GRADES, READINESS_STATUSES, SOURCE_RESULTS } from "@mpc/domain";
import {
  GRADE_DISPLAY,
  READINESS_DISPLAY,
  SOURCE_RESULT_DISPLAY,
  assertDisplayCoverage,
} from "../src/status-display.js";
import {
  PROHIBITED_PHRASES,
  REQUIRED_BOUNDARY_COPY,
  lintProhibitedLanguage,
} from "../src/prohibited-language.js";
import { project, sharedFactsConsistent, type RecordView } from "../src/record-depth.js";

describe("상태 표시 매핑 완전성", () => {
  it("모든 enum이 표시 정의를 갖는다", () => {
    expect(() => assertDisplayCoverage()).not.toThrow();
  });

  it("12개 source result 전부 매핑된다", () => {
    expect(Object.keys(SOURCE_RESULT_DISPLAY).sort()).toEqual([...SOURCE_RESULTS].sort());
  });

  it("5개 grade 전부 매핑된다", () => {
    expect(Object.keys(GRADE_DISPLAY).sort()).toEqual([...GRADES].sort());
  });

  it("4개 readiness 전부 매핑된다", () => {
    expect(Object.keys(READINESS_DISPLAY).sort()).toEqual([...READINESS_STATUSES].sort());
  });
});

describe("§11.8 — 색만으로 상태를 표현하지 않는다", () => {
  it("모든 표시가 아이콘과 라벨을 갖는다", () => {
    const all = [
      ...Object.values(SOURCE_RESULT_DISPLAY),
      ...Object.values(GRADE_DISPLAY),
      ...Object.values(READINESS_DISPLAY),
    ];
    for (const display of all) {
      expect(display.icon).toBeTruthy();
      expect(display.labelKo.length).toBeGreaterThan(0);
      expect(display.labelEn.length).toBeGreaterThan(0);
    }
  });

  it("리터럴 색상값 대신 토큰만 쓴다", () => {
    const all = [
      ...Object.values(SOURCE_RESULT_DISPLAY),
      ...Object.values(GRADE_DISPLAY),
      ...Object.values(READINESS_DISPLAY),
    ];
    for (const display of all) {
      expect(display.token.startsWith("--")).toBe(true);
      expect(display.token).not.toMatch(/#[0-9a-f]{3,8}/i);
    }
  });

  it("--gold를 상태 표현에 쓰지 않는다 — 수치 강조 전용이다", () => {
    const all = [
      ...Object.values(SOURCE_RESULT_DISPLAY),
      ...Object.values(GRADE_DISPLAY),
      ...Object.values(READINESS_DISPLAY),
    ];
    expect(all.some((display) => display.token === "--gold")).toBe(false);
  });
});

describe("AC-18 — no record와 unavailable이 화면에서 구분된다", () => {
  const noRecord = SOURCE_RESULT_DISPLAY.source_returned_no_record;
  const unavailable = SOURCE_RESULT_DISPLAY.source_unavailable;
  const notApplicable = SOURCE_RESULT_DISPLAY.not_applicable;

  it("라벨이 다르다", () => {
    expect(new Set([noRecord.labelKo, unavailable.labelKo, notApplicable.labelKo]).size).toBe(3);
  });

  it("다음 행동이 다르다", () => {
    expect(
      new Set([noRecord.nextActionKo, unavailable.nextActionKo, notApplicable.nextActionKo]).size,
    ).toBe(3);
  });

  it("아이콘이나 토큰 중 하나 이상이 다르다", () => {
    expect(
      noRecord.token !== unavailable.token || noRecord.icon !== unavailable.icon,
    ).toBe(true);
  });
});

describe("§11.4 — 상태의 금지 해석이 함께 정의된다", () => {
  it("모든 grade에 금지 해석이 있다", () => {
    for (const grade of GRADES) {
      expect(GRADE_DISPLAY[grade].notMeaningKo.length).toBeGreaterThan(0);
    }
  });

  it("모든 readiness에 금지 해석이 있다", () => {
    for (const status of READINESS_STATUSES) {
      expect(READINESS_DISPLAY[status].notMeaningKo.length).toBeGreaterThan(0);
    }
  });

  it("not_evaluable이 통과가 아님을 명시한다", () => {
    expect(READINESS_DISPLAY.not_evaluable.notMeaningKo).toContain("차단");
  });

  it("ok가 자동 승인이 아님을 명시한다", () => {
    expect(READINESS_DISPLAY.ok.notMeaningKo).toContain("자동");
  });

  it("verified가 보장이 아님을 명시한다", () => {
    expect(GRADE_DISPLAY.verified.notMeaningKo).toContain("보장");
  });
});

/**
 * OD-30 — 화면에 나가는 것은 영문이다.
 *
 * 국문 문구는 spec 원문으로 남지만, 영문이 비면 화면이 빈다. 국문만 채운 채로
 * 항목을 추가할 수 없게 막는다.
 */
describe("OD-30 — 영문 문구가 비어 있지 않다", () => {
  const displays = [
    ...Object.values(SOURCE_RESULT_DISPLAY),
    ...Object.values(GRADE_DISPLAY),
    ...Object.values(READINESS_DISPLAY),
  ];

  it("모든 항목이 영문 라벨과 다음 행동을 갖는다", () => {
    for (const display of displays) {
      expect(display.labelEn.length).toBeGreaterThan(0);
      expect(display.nextActionEn.length).toBeGreaterThan(0);
    }
  });

  it("grade·readiness의 금지 해석에 영문이 있다", () => {
    for (const display of [
      ...Object.values(GRADE_DISPLAY),
      ...Object.values(READINESS_DISPLAY),
    ]) {
      expect(display.notMeaningEn.length).toBeGreaterThan(0);
    }
  });

  it("12개 source result의 영문 라벨이 서로 다르다", () => {
    const labels = Object.values(SOURCE_RESULT_DISPLAY).map((display) => display.labelEn);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("AC-31 — R-04 금지어 lint", () => {
  it("수익 보장 표현을 잡는다", () => {
    const findings = lintProhibitedLanguage("이 상품은 확정이득을 제공합니다");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.phrase).toBe("확정이득");
    expect(findings[0]!.replacement).toContain("조건부");
  });

  it("영문 표현도 잡는다", () => {
    const findings = lintProhibitedLanguage("Offering a guaranteed return of 12%");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("대소문자를 무시한다", () => {
    expect(lintProhibitedLanguage("GUARANTEED RETURN")).toHaveLength(1);
  });

  it("정부 승인 과장을 잡는다", () => {
    expect(lintProhibitedLanguage("정부 승인을 받은 프로젝트")).toHaveLength(1);
    expect(lintProhibitedLanguage("This project is government verified")).toHaveLength(1);
  });

  it("체인 무결성 과장을 잡는다", () => {
    expect(lintProhibitedLanguage("on-chain truth for every record").length).toBeGreaterThan(0);
    expect(lintProhibitedLanguage("블록체인이 진위를 보증합니다").length).toBeGreaterThan(0);
  });

  it("자동 승인 표현을 잡는다", () => {
    expect(lintProhibitedLanguage("모든 요건이 ok면 자동 승인됩니다").length).toBeGreaterThan(0);
  });

  it("투자 권유 표현을 잡는다", () => {
    expect(lintProhibitedLanguage("투자 추천 종목")).toHaveLength(1);
  });

  it("여러 번 나오면 모두 보고한다", () => {
    expect(lintProhibitedLanguage("확정이득. 다시 확정이득.")).toHaveLength(2);
  });

  it("위치와 문맥을 반환한다 — CI 로그에서 바로 찾을 수 있어야 한다", () => {
    const findings = lintProhibitedLanguage("서두 문장입니다. 확정이득 보장. 끝.");
    expect(findings[0]!.index).toBeGreaterThan(0);
    expect(findings[0]!.context).toContain("확정이득");
  });

  it("정상 문구는 통과한다", () => {
    expect(
      lintProhibitedLanguage(
        "이 결과는 문서 내용의 사실성·법률 효력·투자 적합성을 보증하지 않습니다.",
      ),
    ).toEqual([]);
  });

  it("모든 금지어에 대체 표현이 있다 — 금지만 하면 우회 표현이 생긴다", () => {
    for (const entry of PROHIBITED_PHRASES) {
      expect(entry.replacement.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("필수 경계 문구 자체는 금지어를 포함하지 않는다", () => {
    for (const copy of Object.values(REQUIRED_BOUNDARY_COPY)) {
      expect(lintProhibitedLanguage(copy.ko)).toEqual([]);
      expect(lintProhibitedLanguage(copy.en)).toEqual([]);
    }
  });

  it("Compliance Policy Engine의 사용자 표시명이 규정대로다 (§11.13)", () => {
    expect(REQUIRED_BOUNDARY_COPY.policyEngineName.ko).toBe("데이터·증빙 준비도 평가");
  });
});

describe("AC-26 — 3깊이 일관성", () => {
  const view: RecordView = {
    shared: {
      recordId: "verification-001",
      version: "3",
      status: "published",
      asOf: "2026-08-01T00:00:00Z",
      limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
      authorityScope: ["mining_license_registration"],
    },
    explanation: {
      proves: ["해당 관할의 법인 등록 상태"],
      doesNotProve: ["광업권 완전성", "경제성", "투자 적합성"],
      freshnessExplanation: "기준일로부터 12일 경과",
    },
    expert: {
      authorityId: "authority-mn-001",
      queryOrDocumentReference: "REG-2026-0801-XYZ",
      receivedAt: "2026-08-01T03:12:00Z",
      rawHashReference: "0x" + "ab".repeat(32),
      sourceSchemaVersion: "2024-01",
      adapterVersion: "1.2.0",
      signature: "0xsig",
      attestationVersion: "2",
      policyVersion: "mn-core-1.0.0",
      merklePath: ["0x" + "cd".repeat(32)],
      transactionHash: "0x" + "ef".repeat(32),
    },
  };

  it("세 깊이가 같은 shared facts를 보여준다", () => {
    expect(sharedFactsConsistent(view)).toBe(true);
  });

  it("basic에도 limitations와 authority scope가 있다 — 접을 수 없다", () => {
    const basic = project(view, "basic");
    expect(basic.limitations).toEqual(view.shared.limitations);
    expect(basic.authorityScope).toEqual(view.shared.authorityScope);
  });

  it("basic에는 hash·signature·merkle path가 없다", () => {
    const basic = project(view, "basic") as Record<string, unknown>;
    expect(basic["rawHashReference"]).toBeUndefined();
    expect(basic["signature"]).toBeUndefined();
    expect(basic["merklePath"]).toBeUndefined();
  });

  it("explanation에는 무엇을 증명하지 않는지가 있다", () => {
    const explanation = project(view, "explanation") as Record<string, unknown>;
    expect(explanation["doesNotProve"]).toEqual(view.explanation.doesNotProve);
    expect(explanation["rawHashReference"]).toBeUndefined();
  });

  it("expert에만 receipt·schema·proof 상세가 있다", () => {
    const expert = project(view, "expert") as Record<string, unknown>;
    expect(expert["rawHashReference"]).toBe(view.expert.rawHashReference);
    expect(expert["merklePath"]).toEqual(view.expert.merklePath);
    expect(expert["adapterVersion"]).toBe("1.2.0");
  });

  it("status가 깊이마다 다르면 불일치를 잡는다", () => {
    const broken = {
      ...view,
      // Expert 레이어가 shared 키를 덮어쓰는 경우를 시뮬레이션한다.
      expert: { ...view.expert, status: "draft" } as never,
    };
    expect(sharedFactsConsistent(broken)).toBe(false);
  });
});
