import type { Facts } from "@mpc/policy";

/**
 * Where the rule set's context facts come from — REQ-DAPP-047, REQ-DAPP-055, AC-25.
 *
 * The assessment context used to be constants: one project stage, one reporting standard, one
 * country's environmental law, an `approved` profile, no offering and no expiring rights. Every
 * project in every jurisdiction was assessed as if those were facts about it.
 *
 * Each fact now has a source, and a fact with no recorded value is `undefined`. The engine
 * turns a requirement that reads an undefined fact into `not_evaluable` — there is no default.
 *
 * | fact                          | source                                                   |
 * |-------------------------------|----------------------------------------------------------|
 * | projectStage                  | claim `project_stage`                                    |
 * | offeringIntent                | claim `offering_intent` (`true`/`false`)                 |
 * | rightsExpiryWithin12Months    | claim `mining_right_expiry` (a date) against the as-of   |
 * | acceptedReportingStandard     | jurisdiction profile — no store yet (OD-46 is proposed)  |
 * | environmentalRequirementBasis | jurisdiction profile in effect (`core.jurisdiction_profiles`) |
 * | jurisdictionProfileState      | jurisdiction profile in effect (`core.jurisdiction_profiles`) |
 *
 * Project facts come from claims because a claim already carries what a context fact needs:
 * a source receipt, a grade, an as-of date and stale propagation. A separate table would be a
 * second place to type a value without evidence.
 */

export const CONTEXT_CLAIM_TYPES = {
  projectStage: "project_stage",
  offeringIntent: "offering_intent",
  miningRightExpiry: "mining_right_expiry",
} as const;

export interface ContextClaim {
  readonly claim_type: string;
  readonly value_text: string;
  readonly grade: string;
  readonly excluded_by_rule: boolean;
  /** Stale at the evaluation time. */
  readonly stale: boolean;
}

/**
 * The single value the project's usable claims of this type agree on.
 *
 * Unusable: rejected, excluded by rule, or stale — evidence that has moved is not a basis.
 * Two usable claims with different values are a conflict, not a choice, so the fact is absent
 * until someone resolves it.
 */
function agreedValue(claims: readonly ContextClaim[], claimType: string): string | undefined {
  const values = new Set(
    claims
      .filter(
        (claim) =>
          claim.claim_type === claimType &&
          claim.grade !== "rejected" &&
          !claim.excluded_by_rule &&
          !claim.stale,
      )
      .map((claim) => claim.value_text.trim())
      .filter((value) => value !== ""),
  );
  return values.size === 1 ? [...values][0] : undefined;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `expiry` falls on or before the same calendar day twelve months after `asOf`. */
function withinTwelveMonths(expiry: string, asOf: Date): string | undefined {
  const match = ISO_DATE.exec(expiry);
  if (!match) return undefined;
  const expiryDay = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Reject dates that roll over (2026-02-30), which Date.UTC would silently accept.
  if (new Date(expiryDay).toISOString().slice(0, 10) !== expiry) return undefined;
  const horizon = Date.UTC(asOf.getUTCFullYear() + 1, asOf.getUTCMonth(), asOf.getUTCDate());
  return expiryDay <= horizon ? "true" : "false";
}

export function deriveProjectContext(claims: readonly ContextClaim[], asOf: Date): Facts {
  const stage = agreedValue(claims, CONTEXT_CLAIM_TYPES.projectStage);
  const intent = agreedValue(claims, CONTEXT_CLAIM_TYPES.offeringIntent);
  const expiry = agreedValue(claims, CONTEXT_CLAIM_TYPES.miningRightExpiry);

  return {
    projectStage: stage,
    offeringIntent: intent === "true" || intent === "false" ? intent : undefined,
    rightsExpiryWithin12Months: expiry === undefined ? undefined : withinTwelveMonths(expiry, asOf),
  };
}

/** The jurisdiction profile version in effect at evaluation time (`core.jurisdiction_profiles`). */
export interface JurisdictionProfileRow {
  readonly state: string;
  readonly environmental_requirement_basis: string | null;
}

/**
 * Jurisdiction profile facts.
 *
 * Read from the reviewed profile in effect at evaluation time (OD-43). With no profile, its state
 * and environmental basis are unrecorded and the requirements that read them are `not_evaluable`.
 * The profile does not record a reporting standard (OD-46 is proposed), so that stays unrecorded:
 * guessing one is what this replaces.
 */
export function deriveJurisdictionContext(profile?: JurisdictionProfileRow): Facts {
  return {
    acceptedReportingStandard: undefined,
    environmentalRequirementBasis: profile?.environmental_requirement_basis ?? undefined,
    jurisdictionProfileState: profile?.state,
  };
}
