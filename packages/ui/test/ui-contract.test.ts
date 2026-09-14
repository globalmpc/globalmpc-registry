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

describe("status display mapping completeness", () => {
  it("every enum has a display definition", () => {
    expect(() => assertDisplayCoverage()).not.toThrow();
  });

  it("all 12 source results are mapped", () => {
    expect(Object.keys(SOURCE_RESULT_DISPLAY).sort()).toEqual([...SOURCE_RESULTS].sort());
  });

  it("all 5 grades are mapped", () => {
    expect(Object.keys(GRADE_DISPLAY).sort()).toEqual([...GRADES].sort());
  });

  it("all 4 readiness statuses are mapped", () => {
    expect(Object.keys(READINESS_DISPLAY).sort()).toEqual([...READINESS_STATUSES].sort());
  });
});

describe("§11.8 — status is never conveyed by color alone", () => {
  it("every display has an icon and a label", () => {
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

  it("uses tokens only, never literal color values", () => {
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

  it("never uses --gold for status — it is reserved for numeric emphasis", () => {
    const all = [
      ...Object.values(SOURCE_RESULT_DISPLAY),
      ...Object.values(GRADE_DISPLAY),
      ...Object.values(READINESS_DISPLAY),
    ];
    expect(all.some((display) => display.token === "--gold")).toBe(false);
  });
});

describe("AC-18 — no record and unavailable are distinguishable on screen", () => {
  const noRecord = SOURCE_RESULT_DISPLAY.source_returned_no_record;
  const unavailable = SOURCE_RESULT_DISPLAY.source_unavailable;
  const notApplicable = SOURCE_RESULT_DISPLAY.not_applicable;

  it("labels differ", () => {
    expect(new Set([noRecord.labelKo, unavailable.labelKo, notApplicable.labelKo]).size).toBe(3);
  });

  it("next actions differ", () => {
    expect(
      new Set([noRecord.nextActionKo, unavailable.nextActionKo, notApplicable.nextActionKo]).size,
    ).toBe(3);
  });

  it("the icon or the token differs", () => {
    expect(
      noRecord.token !== unavailable.token || noRecord.icon !== unavailable.icon,
    ).toBe(true);
  });
});

describe("§11.4 — each status defines its prohibited interpretation", () => {
  it("every grade has a prohibited interpretation", () => {
    for (const grade of GRADES) {
      expect(GRADE_DISPLAY[grade].notMeaningKo.length).toBeGreaterThan(0);
    }
  });

  it("every readiness status has a prohibited interpretation", () => {
    for (const status of READINESS_STATUSES) {
      expect(READINESS_DISPLAY[status].notMeaningKo.length).toBeGreaterThan(0);
    }
  });

  it("not_evaluable states that it is not a pass", () => {
    expect(READINESS_DISPLAY.not_evaluable.notMeaningKo).toContain("차단");
  });

  it("ok states that it is not automatic approval", () => {
    expect(READINESS_DISPLAY.ok.notMeaningKo).toContain("자동");
  });

  it("verified states that it is not a guarantee", () => {
    expect(GRADE_DISPLAY.verified.notMeaningKo).toContain("보장");
  });
});

/**
 * OD-30 — the screen shows English.
 *
 * The Korean copy stays as the spec original, but an empty English string leaves the screen blank.
 * Blocks adding an entry with only the Korean filled in.
 */
describe("OD-30 — English copy is not empty", () => {
  const displays = [
    ...Object.values(SOURCE_RESULT_DISPLAY),
    ...Object.values(GRADE_DISPLAY),
    ...Object.values(READINESS_DISPLAY),
  ];

  it("every entry has an English label and next action", () => {
    for (const display of displays) {
      expect(display.labelEn.length).toBeGreaterThan(0);
      expect(display.nextActionEn.length).toBeGreaterThan(0);
    }
  });

  it("grade and readiness prohibited interpretations have English", () => {
    for (const display of [
      ...Object.values(GRADE_DISPLAY),
      ...Object.values(READINESS_DISPLAY),
    ]) {
      expect(display.notMeaningEn.length).toBeGreaterThan(0);
    }
  });

  it("the 12 source results have distinct English labels", () => {
    const labels = Object.values(SOURCE_RESULT_DISPLAY).map((display) => display.labelEn);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("AC-31 — R-04 prohibited-language lint", () => {
  it("catches guaranteed-return wording", () => {
    const findings = lintProhibitedLanguage("이 상품은 확정이득을 제공합니다");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.phrase).toBe("확정이득");
    expect(findings[0]!.replacement).toContain("조건부");
  });

  it("catches English wording too", () => {
    const findings = lintProhibitedLanguage("Offering a guaranteed return of 12%");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    expect(lintProhibitedLanguage("GUARANTEED RETURN")).toHaveLength(1);
  });

  it("catches overstated government approval", () => {
    expect(lintProhibitedLanguage("정부 승인을 받은 프로젝트")).toHaveLength(1);
    expect(lintProhibitedLanguage("This project is government verified")).toHaveLength(1);
  });

  it("catches overstated chain integrity", () => {
    expect(lintProhibitedLanguage("on-chain truth for every record").length).toBeGreaterThan(0);
    expect(lintProhibitedLanguage("블록체인이 진위를 보증합니다").length).toBeGreaterThan(0);
  });

  it("catches automatic-approval wording", () => {
    expect(lintProhibitedLanguage("모든 요건이 ok면 자동 승인됩니다").length).toBeGreaterThan(0);
  });

  it("catches investment-solicitation wording", () => {
    expect(lintProhibitedLanguage("투자 추천 종목")).toHaveLength(1);
  });

  it("reports every occurrence", () => {
    expect(lintProhibitedLanguage("확정이득. 다시 확정이득.")).toHaveLength(2);
  });

  it("returns position and context — it must be findable straight from the CI log", () => {
    const findings = lintProhibitedLanguage("서두 문장입니다. 확정이득 보장. 끝.");
    expect(findings[0]!.index).toBeGreaterThan(0);
    expect(findings[0]!.context).toContain("확정이득");
  });

  it("acceptable copy passes", () => {
    expect(
      lintProhibitedLanguage(
        "이 결과는 문서 내용의 사실성·법률 효력·투자 적합성을 보증하지 않습니다.",
      ),
    ).toEqual([]);
  });

  it("every prohibited term has a replacement — a bare ban breeds workaround phrasing", () => {
    for (const entry of PROHIBITED_PHRASES) {
      expect(entry.replacement.length).toBeGreaterThan(0);
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("required boundary copy contains no prohibited term", () => {
    for (const copy of Object.values(REQUIRED_BOUNDARY_COPY)) {
      expect(lintProhibitedLanguage(copy.ko)).toEqual([]);
      expect(lintProhibitedLanguage(copy.en)).toEqual([]);
    }
  });

  it("the Compliance Policy Engine display name matches the rule (§11.13)", () => {
    expect(REQUIRED_BOUNDARY_COPY.policyEngineName.ko).toBe("데이터·증빙 준비도 평가");
  });
});

describe("AC-26 — three-depth consistency", () => {
  const view: RecordView = {
    shared: {
      recordId: "verification-001",
      version: "3",
      status: "published",
      asOf: "2026-08-01T00:00:00Z",
      limitations: ["Legal title confirmation is outside the scope of this review"],
      authorityScope: ["mining_license_registration"],
    },
    explanation: {
      proves: ["Corporate registration status in the jurisdiction"],
      doesNotProve: ["Mining right completeness", "Economic viability", "Investment suitability"],
      freshnessExplanation: "12 days since the reference date",
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

  it("all three depths show the same shared facts", () => {
    expect(sharedFactsConsistent(view)).toBe(true);
  });

  it("basic also has limitations and authority scope — they cannot be collapsed", () => {
    const basic = project(view, "basic");
    expect(basic.limitations).toEqual(view.shared.limitations);
    expect(basic.authorityScope).toEqual(view.shared.authorityScope);
  });

  it("basic has no hash, signature, or merkle path", () => {
    const basic = project(view, "basic") as Record<string, unknown>;
    expect(basic["rawHashReference"]).toBeUndefined();
    expect(basic["signature"]).toBeUndefined();
    expect(basic["merklePath"]).toBeUndefined();
  });

  it("explanation states what is not proven", () => {
    const explanation = project(view, "explanation") as Record<string, unknown>;
    expect(explanation["doesNotProve"]).toEqual(view.explanation.doesNotProve);
    expect(explanation["rawHashReference"]).toBeUndefined();
  });

  it("only expert has receipt, schema, and proof details", () => {
    const expert = project(view, "expert") as Record<string, unknown>;
    expect(expert["rawHashReference"]).toBe(view.expert.rawHashReference);
    expect(expert["merklePath"]).toEqual(view.expert.merklePath);
    expect(expert["adapterVersion"]).toBe("1.2.0");
  });

  it("detects a mismatch when status differs across depths", () => {
    const broken = {
      ...view,
      // Simulates the Expert layer overwriting a shared key.
      expert: { ...view.expert, status: "draft" } as never,
    };
    expect(sharedFactsConsistent(broken)).toBe(false);
  });
});
