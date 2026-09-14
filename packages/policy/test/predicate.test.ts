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

  it("eq는 스칼라를 비교한다", () => {
    expect(evaluatePredicate({ op: "eq", path: "stage", value: "exploration" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "eq", path: "stage", value: "production" }, FACTS)).toBe(false);
  });

  it("eq는 배열이면 포함 여부를 본다", () => {
    expect(evaluatePredicate({ op: "eq", path: "minerals", value: "gold" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "eq", path: "minerals", value: "silver" }, FACTS)).toBe(false);
  });

  it("없는 경로는 false다 — 조용히 true가 되지 않는다", () => {
    expect(evaluatePredicate({ op: "eq", path: "missing", value: "x" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "exists", path: "missing" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "gte", path: "missing", value: "0" }, FACTS)).toBe(false);
  });

  it("빈 배열은 exists가 아니다", () => {
    expect(evaluatePredicate({ op: "exists", path: "emptyList" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "exists", path: "minerals" }, FACTS)).toBe(true);
  });

  it("in은 교집합을 본다", () => {
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

  it("gte / lte는 정수 비교다", () => {
    expect(evaluatePredicate({ op: "gte", path: "ageDays", value: "180" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "gte", path: "ageDays", value: "181" }, FACTS)).toBe(false);
    expect(evaluatePredicate({ op: "lte", path: "ageDays", value: "180" }, FACTS)).toBe(true);
    expect(evaluatePredicate({ op: "lte", path: "ageDays", value: "179" }, FACTS)).toBe(false);
  });

  it("큰 정수도 정확히 비교한다 — 배정밀도로 깨지지 않는다", () => {
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

  it("정수가 아닌 값을 비교하면 거절한다", () => {
    expect(() =>
      evaluatePredicate({ op: "gte", path: "stage", value: "0" }, FACTS),
    ).toThrowError(PredicateError);
  });

  it("배열을 스칼라로 비교하면 거절한다", () => {
    expect(() =>
      evaluatePredicate({ op: "gte", path: "minerals", value: "0" }, FACTS),
    ).toThrowError(/배열이다/);
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
  it("중첩 predicate의 모든 경로를 모은다", () => {
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

describe("rule schema 검증", () => {
  it("예시 rule set이 스키마를 통과한다", () => {
    const result = safeParseRuleSet(rulesFixture);
    expect(result.success).toBe(true);
  });

  it("semver가 아닌 version을 거절한다", () => {
    const result = safeParseRuleSet({ ...rulesFixture, version: "1.0" });
    expect(result.success).toBe(false);
  });

  it("requirement가 없는 rule set을 거절한다", () => {
    const result = safeParseRuleSet({ ...rulesFixture, requirements: [] });
    expect(result.success).toBe(false);
  });

  it("requirementId 중복을 거절한다", () => {
    const duplicated = {
      ...rulesFixture,
      requirements: [rulesFixture.requirements[0], rulesFixture.requirements[0]],
    };
    const result = safeParseRuleSet(duplicated);
    expect(result.success).toBe(false);
  });

  it("알 수 없는 predicate 연산자를 거절한다", () => {
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

  it("정수가 아닌 freshness threshold를 거절한다", () => {
    const bad = {
      ...rulesFixture,
      requirements: [{ ...rulesFixture.requirements[0], freshnessThresholdDays: "30.5" }],
    };
    expect(safeParseRuleSet(bad).success).toBe(false);
  });

  it("알 수 없는 attestation type을 거절한다", () => {
    const bad = {
      ...rulesFixture,
      requirements: [
        { ...rulesFixture.requirements[0], requiredAttestations: ["ai_review"] },
      ],
    };
    expect(safeParseRuleSet(bad).success).toBe(false);
  });
});
