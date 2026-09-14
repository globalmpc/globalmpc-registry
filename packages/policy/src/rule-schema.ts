import { z } from "zod";
import { ATTESTATION_TYPES, GRADES } from "@mpc/domain";
import type { Predicate } from "./predicate.js";

/**
 * Readiness rule schema — OD-15 해소.
 *
 * spec 05 §5.4의 requirement 필드를 실행 가능한 스키마로 고정한다.
 * Rule Set 변경은 기존 Assessment를 덮어쓰지 않고 새 projection을 만든다.
 * 소급 여부는 `retroactive`에 명시한다(D-34).
 */

const predicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.discriminatedUnion("op", [
    z.object({ op: z.literal("always") }),
    z.object({ op: z.literal("never") }),
    z.object({ op: z.literal("and"), operands: z.array(predicateSchema).min(1) }),
    z.object({ op: z.literal("or"), operands: z.array(predicateSchema).min(1) }),
    z.object({ op: z.literal("not"), operand: predicateSchema }),
    z.object({ op: z.literal("eq"), path: z.string().min(1), value: z.string() }),
    z.object({ op: z.literal("in"), path: z.string().min(1), values: z.array(z.string()).min(1) }),
    z.object({ op: z.literal("exists"), path: z.string().min(1) }),
    z.object({
      op: z.literal("gte"),
      path: z.string().min(1),
      value: z.string().regex(/^-?(0|[1-9][0-9]*)$/, "정수 decimal string이어야 한다"),
    }),
    z.object({
      op: z.literal("lte"),
      path: z.string().min(1),
      value: z.string().regex(/^-?(0|[1-9][0-9]*)$/, "정수 decimal string이어야 한다"),
    }),
  ]),
) as z.ZodType<Predicate>;

export const requirementSchema = z.object({
  requirementId: z.string().min(1),
  /** 사용자에게 보여줄 요구 이름. UI가 문구를 하드코딩하지 않게 규칙이 소유한다. */
  label: z.string().min(1),
  /** 이 requirement가 적용되는 조건. false면 평가 대상에서 제외된다. */
  appliesWhen: predicateSchema,
  requiredClaimTypes: z.array(z.string().min(1)),
  minimumGrade: z.enum(GRADES),
  /**
   * 근거의 최대 허용 경과일. null이면 freshness를 요구하지 않는다.
   * 실제 값은 source·claim type별로 다르며 OD-16에서 확정한다.
   */
  freshnessThresholdDays: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .nullable(),
  requiredAttestations: z.array(z.enum(ATTESTATION_TYPES)),
  blockingConflictTypes: z.array(z.string().min(1)),
  /** 판단 기준 자체가 없는 조건 — gap이 아니라 not_evaluable이다. */
  notEvaluableWhen: predicateSchema,
  /** 진행 가능하지만 monitoring이 필요한 조건. */
  watchWhen: predicateSchema.nullable(),
});

export type Requirement = z.infer<typeof requirementSchema>;

export const ruleSetSchema = z
  .object({
    ruleSetId: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "semver여야 한다"),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "ISO 8601 UTC"),
    supersededBy: z.string().nullable(),
    jurisdictionProfile: z.string().min(1),
    gateId: z.string().min(1),
    /** 기존 발행분에 소급 적용하는가(D-34). 기본은 비소급이다. */
    retroactive: z.boolean(),
    requirements: z.array(requirementSchema).min(1),
  })
  .superRefine((ruleSet, ctx) => {
    const seen = new Set<string>();
    for (const [index, requirement] of ruleSet.requirements.entries()) {
      if (seen.has(requirement.requirementId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["requirements", index, "requirementId"],
          message: `requirementId가 중복된다: ${requirement.requirementId}`,
        });
      }
      seen.add(requirement.requirementId);
    }
  });

export type RuleSet = z.infer<typeof ruleSetSchema>;

export function parseRuleSet(input: unknown): RuleSet {
  return ruleSetSchema.parse(input);
}

export function safeParseRuleSet(input: unknown): z.SafeParseReturnType<unknown, RuleSet> {
  return ruleSetSchema.safeParse(input);
}
