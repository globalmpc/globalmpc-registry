import { z } from "zod";
import { ATTESTATION_TYPES, GRADES } from "@mpc/domain";
import type { Predicate } from "./predicate.js";

/**
 * Readiness rule schema — resolves OD-15.
 *
 * Pins the requirement fields of spec 05 §5.4 as an executable schema.
 * A Rule Set change creates a new projection instead of overwriting existing Assessments.
 * Whether it applies retroactively is stated in `retroactive` (D-34).
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
      value: z.string().regex(/^-?(0|[1-9][0-9]*)$/, "must be an integer decimal string"),
    }),
    z.object({
      op: z.literal("lte"),
      path: z.string().min(1),
      value: z.string().regex(/^-?(0|[1-9][0-9]*)$/, "must be an integer decimal string"),
    }),
  ]),
) as z.ZodType<Predicate>;

export const requirementSchema = z.object({
  requirementId: z.string().min(1),
  /** Requirement name shown to users. Owned by the rule so the UI does not hardcode copy. */
  label: z.string().min(1),
  /** Condition under which this requirement applies. When false, it is excluded from evaluation. */
  appliesWhen: predicateSchema,
  requiredClaimTypes: z.array(z.string().min(1)),
  minimumGrade: z.enum(GRADES),
  /**
   * Maximum allowed evidence age in days. null means freshness is not required.
   * Actual values vary by source and claim type and are settled in OD-16.
   */
  freshnessThresholdDays: z
    .string()
    .regex(/^(0|[1-9][0-9]*)$/)
    .nullable(),
  requiredAttestations: z.array(z.enum(ATTESTATION_TYPES)),
  blockingConflictTypes: z.array(z.string().min(1)),
  /** Condition with no evaluation basis at all — not_evaluable, not gap. */
  notEvaluableWhen: predicateSchema,
  /** Condition that allows progress but needs monitoring. */
  watchWhen: predicateSchema.nullable(),
});

export type Requirement = z.infer<typeof requirementSchema>;

export const ruleSetSchema = z
  .object({
    ruleSetId: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, "must be semver"),
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "ISO 8601 UTC"),
    supersededBy: z.string().nullable(),
    jurisdictionProfile: z.string().min(1),
    gateId: z.string().min(1),
    /** Whether it applies retroactively to existing issuances (D-34). Default is non-retroactive. */
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
          message: `duplicate requirementId: ${requirement.requirementId}`,
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
