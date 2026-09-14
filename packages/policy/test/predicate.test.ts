import { describe, expect, it } from "vitest";
import {
  PredicateError,
  collectPredicatePaths,
  evaluatePredicate,
  type Facts,
} from "../src/predicate.js";
import { safeParseRuleSet } from "../src/rule-schema.js";
import rulesFixture from "./fixtures/registry-gate.rules.json" with { type: "json" };

const FACTS: Facts = {
  stage: "exploration",
  minerals: ["copper", "gold"],
  ageDays: "180",
  emptyList: [],
};

describe("evaluatePredicate", () => {
  it("always / never", () => {
    expect(evaluatePredicate({ op: "always" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "never" }, FACTS)).toBe(false);
  });

  it("eq compares scalars", () => {
    expect(evaluatePredicate({ op: "eq", path: "stage", value: "exploration" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "eq", path: "stage", value: "production" }, FACTS)).toBe(false);
  });

  it("eq checks membership for arrays", () => {
    expect(evaluatePredicate({ op: "eq", path: "minerals", value: "gold" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "eq", path: "minerals", value: "silver" }, FACTS)).toBe(false);
  });

  it("a missing path is false — never silently true", () => {
    expect(evaluatePredicate({ op: "eq", path: "missing", value: "x" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "exists", path: "missing" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "gte", path: "missing", value: "0" }, FACTS)).toBe(false);
  });

  it("an empty array does not satisfy exists", () => {
    expect(evaluatePredicate({ op: "exists", path: "emptyList" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "exists", path: "minerals" }, FACTS)).toBe(true);
  });

  it("in checks for intersection", () => {
    expect(
      evaluatePredicate({ op: "in", path: "minerals", values: ["silver", "gold"] }, FACTS),
    ).toBe(true);
    expect(evaluatePredicate({ op: "in", path: "minerals", values: ["silver"] }, FACTS)).toBe(
      false,
    );
    expect(
      evaluatePredicate({ op: "in", path: "stage", values: ["exploration", "production"] }, FACTS),
    ).toBe(true);
  });

  it("gte / lte compare integers", () => {
    expect(evaluatePredicate({ op: "gte", path: "ageDays", value: "180" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "gte", path: "ageDays", value: "181" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "lte", path: "ageDays", value: "180" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "lte", path: "ageDays", value: "179" }, FACTS)).toBe(false);
  });

  it("compares large integers exactly — no double-precision loss", () => {
    const big: Facts = { supply: "10000000000000000000000000000" };
    expect(
      evaluatePredicate(
        { op: "gte", path: "supply", value: "10000000000000000000000000000" },
        big,
      ),
    ).toBe(true);
    expect(
      evaluatePredicate(
        { op: "gte", path: "supply", value: "10000000000000000000000000001" },
        big,
      ),
    ).toBe(false);
  });

  it("rejects comparison of non-integer values", () => {
    expect(() =>
      evaluatePredicate({ op: "gte", path: "stage", value: "0" }, FACTS),
    ).toThrowError(PredicateError);
  });

  it("rejects scalar comparison of an array", () => {
    expect(() =>
      evaluatePredicate({ op: "gte", path: "minerals", value: "0" }, FACTS),
    ).toThrowError(/is an array/);
  });

  it("and / or / not", () => {
    expect(
      evaluatePredicate(
        {
          op: "and",
          operands: [
            { op: "eq", path: "stage", value: "exploration" },
            { op: "exists", path: "minerals" },
          ],
        },
        FACTS,
      ),
    ).toBe(true);

    expect(
      evaluatePredicate(
        {
          op: "or",
          operands: [
            { op: "eq", path: "stage", value: "production" },
            { op: "eq", path: "stage", value: "exploration" },
          ],
        },
        FACTS,
      ),
    ).toBe(true);

    expect(evaluatePredicate({ op: "not", operand: { op: "always" } }, FACTS)).toBe(false);
  });
});

describe("collectPredicatePaths", () => {
  it("collects every path in a nested predicate", () => {
    const paths = collectPredicatePaths({
      op: "and",
      operands: [
        { op: "eq", path: "a", value: "1" },
        { op: "not", operand: { op: "exists", path: "b" } },
        { op: "or", operands: [{ op: "gte", path: "c", value: "0" }] },
      ],
    });
    expect([...paths].sort()).toEqual(["a", "b", "c"]);
  });
});

describe("rule schema validation", () => {
  it("the example rule set passes the schema", () => {
    const result = safeParseRuleSet(rulesFixture);
    expect(result.success).toBe(true);
  });

  it("rejects a non-semver version", () => {
    const result = safeParseRuleSet({ ...rulesFixture, version: "1.0" });
    expect(result.success).toBe(false);
  });

  it("rejects a rule set with no requirements", () => {
    const result = safeParseRuleSet({ ...rulesFixture, requirements: [] });
    expect(result.success).toBe(false);
  });

  it("rejects duplicate requirementIds", () => {
    const duplicated = {
      ...rulesFixture,
      requirements: [rulesFixture.requirements[0], rulesFixture.requirements[0]],
    };
    const result = safeParseRuleSet(duplicated);
    expect(result.success).toBe(false);
  });

  it("rejects an unknown predicate operator", () => {
    const bad = {
      ...rulesFixture,
      requirements: [
        {
          ...rulesFixture.requirements[0],
          appliesWhen: { op: "regex", path: "x", value: ".*" },
        },
      ],
    };
    expect(safeParseRuleSet(bad).success).toBe(false);
  });

  it("rejects a non-integer freshness threshold", () => {
    const bad = {
      ...rulesFixture,
      requirements: [{ ...rulesFixture.requirements[0], freshnessThresholdDays: "30.5" }],
    };
    expect(safeParseRuleSet(bad).success).toBe(false);
  });

  it("rejects an unknown attestation type", () => {
    const bad = {
      ...rulesFixture,
      requirements: [
        { ...rulesFixture.requirements[0], requiredAttestations: ["ai_review"] },
      ],
    };
    expect(safeParseRuleSet(bad).success).toBe(false);
  });
});
