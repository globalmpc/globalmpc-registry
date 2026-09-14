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
      expect(display.label.length).toBeGreaterThan(0);
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
    expect(new Set([noRecord.label, unavailable.label, notApplicable.label]).size).toBe(3);
  });

  it("next actions differ", () => {
    expect(
      new Set([noRecord.nextAction, unavailable.nextAction, notApplicable.nextAction]).size,
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
      expect(GRADE_DISPLAY[grade].notMeaning.length).toBeGreaterThan(0);
    }
  });

  it("every readiness status has a prohibited interpretation", () => {
    for (const status of READINESS_STATUSES) {
      expect(READINESS_DISPLAY[status].notMeaning.length).toBeGreaterThan(0);
    }
  });

  it("not_evaluable states that it is not a pass", () => {
    expect(READINESS_DISPLAY.not_evaluable.notMeaning).toContain("blocks go");
  });

  it("ok states that it is not automatic approval", () => {
    expect(READINESS_DISPLAY.ok.notMeaning).toContain("automatically");
  });

  it("verified states that it is not a guarantee", () => {
    expect(GRADE_DISPLAY.verified.notMeaning).toContain("does not warrant");
  });
});

/**
 * Display copy is never empty.
 *
 * An empty string leaves the screen blank. Blocks adding an entry with an empty field.
 */
describe("display copy is not empty", () => {
  const displays = [
    ...Object.values(SOURCE_RESULT_DISPLAY),
    ...Object.values(GRADE_DISPLAY),
    ...Object.values(READINESS_DISPLAY),
  ];

  it("every entry has a label and next action", () => {
    for (const display of displays) {
      expect(display.label.length).toBeGreaterThan(0);
      expect(display.nextAction.length).toBeGreaterThan(0);
    }
  });

  it("grade and readiness prohibited interpretations are not empty", () => {
    for (const display of [
      ...Object.values(GRADE_DISPLAY),
      ...Object.values(READINESS_DISPLAY),
    ]) {
      expect(display.notMeaning.length).toBeGreaterThan(0);
    }
  });

  it("the 12 source results have distinct labels", () => {
    const labels = Object.values(SOURCE_RESULT_DISPLAY).map((display) => display.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe("AC-31 — R-04 prohibited-language lint", () => {
  it("catches guaranteed-return wording", () => {
    const findings = lintProhibitedLanguage("This product offers a guaranteed yield");
    expect(findings).toHaveLength(1);
    expect(findings[0]!.phrase).toBe("guaranteed yield");
    expect(findings[0]!.replacement).toContain("conditional");
  });

  it("catches a phrase mid-sentence", () => {
    const findings = lintProhibitedLanguage("Offering a guaranteed return of 12%");
    expect(findings.length).toBeGreaterThan(0);
  });

  it("is case-insensitive", () => {
    expect(lintProhibitedLanguage("GUARANTEED RETURN")).toHaveLength(1);
  });

  it("catches overstated government approval", () => {
    expect(lintProhibitedLanguage("Government integration complete for this project")).toHaveLength(1);
    expect(lintProhibitedLanguage("This project is government verified")).toHaveLength(1);
  });

  it("catches overstated chain integrity", () => {
    expect(lintProhibitedLanguage("on-chain truth for every record").length).toBeGreaterThan(0);
    expect(lintProhibitedLanguage("The blockchain guarantees accuracy of every record").length).toBeGreaterThan(0);
  });

  it("catches automatic-approval wording", () => {
    expect(lintProhibitedLanguage("If every requirement is ok, automatic legal approval follows").length).toBeGreaterThan(0);
  });

  it("catches investment-solicitation wording", () => {
    expect(lintProhibitedLanguage("Our investment recommendation list")).toHaveLength(1);
  });

  it("reports every occurrence", () => {
    expect(lintProhibitedLanguage("guaranteed yield. Again, guaranteed yield.")).toHaveLength(2);
  });

  it("returns position and context — it must be findable straight from the CI log", () => {
    const findings = lintProhibitedLanguage("An opening sentence. A guaranteed yield. The end.");
    expect(findings[0]!.index).toBeGreaterThan(0);
    expect(findings[0]!.context).toContain("guaranteed yield");
  });

  it("acceptable copy passes", () => {
    expect(
      lintProhibitedLanguage(
        "This result does not prove factual truth, legal effect, or investment suitability.",
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
      expect(lintProhibitedLanguage(copy)).toEqual([]);
    }
  });

  it("the Compliance Policy Engine display name matches the rule (§11.13)", () => {
    expect(REQUIRED_BOUNDARY_COPY.policyEngineName).toBe("Data and evidence readiness assessment");
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
