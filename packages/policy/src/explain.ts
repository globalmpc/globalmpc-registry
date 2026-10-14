import type { RequirementResult } from "./engine.js";

/**
 * Why a requirement is where it is, and what would move it — AC-34.
 *
 * A blocked go that only lists indexes leaves the approver asking "what is missing and who
 * fills it". This turns a result into three answers: the cause, the evidence it needs, and
 * the next action.
 *
 * Derived from `reasonCode` and `missing` alone, so it is as deterministic as the result and is
 * not stored — the canonical result hash covers the result, and this adds no input to it.
 */
export interface RequirementExplanation {
  readonly cause: string;
  /** What has to exist before the requirement can pass. Empty when nothing is needed. */
  readonly neededEvidence: readonly string[];
  /** The next step. `null` when nothing is needed. */
  readonly nextAction: string | null;
}

function strip(prefix: string, values: readonly string[]): string[] {
  return values.filter((value) => value.startsWith(prefix)).map((value) => value.slice(prefix.length));
}

export function explainRequirementResult(result: RequirementResult): RequirementExplanation {
  switch (result.reasonCode) {
    case "REQUIREMENT_SATISFIED":
      return { cause: "The requirement is met", neededEvidence: [], nextAction: null };

    case "REQUIREMENT_NOT_APPLICABLE":
      return {
        cause: "The requirement does not apply to this project",
        neededEvidence: [],
        nextAction: null,
      };

    case "MISSING_REQUIRED_CLAIM_TYPE":
      return {
        cause: `Required claims are missing: ${result.missing.join(", ")}`,
        neededEvidence: [...result.missing],
        nextAction: "Record the missing claims against a source receipt, then recompute readiness",
      };

    case "GRADE_BELOW_MINIMUM":
      return {
        cause: `The weakest claim this requirement uses is below grade ${result.missing.join(", ")}`,
        neededEvidence: result.missing.map((grade) => `claims graded at least ${grade}`),
        nextAction:
          "Raise the weakest claim through source confirmation or review, or resolve what lowered it",
      };

    case "MISSING_REQUIRED_ATTESTATION":
      return {
        cause: `Required attestations are missing or no longer valid: ${result.missing.join(", ")}`,
        neededEvidence: [...result.missing],
        nextAction: "Assign a qualified reviewer and have the attestation signed over these claims",
      };

    case "EVIDENCE_STALE": {
      const stale = strip("stale:", result.missing);
      if (stale.length > 0) {
        return {
          cause: `Evidence under these claims has gone stale: ${stale.join(", ")}`,
          neededEvidence: stale.map((claimType) => `current evidence for ${claimType}`),
          nextAction:
            "Collect a new source receipt for these claims and have them reviewed again",
        };
      }
      const maxAge = strip("max_age_days:", result.missing);
      return {
        cause: `Evidence is older than the rule allows (${maxAge.join(", ")} days)`,
        neededEvidence: maxAge.map((days) => `evidence dated within ${days} days`),
        nextAction: "Collect a newer source receipt within the rule's age limit",
      };
    }

    case "BLOCKING_CONFLICT":
      return {
        cause: `Unresolved conflicts block this requirement: ${result.missing.join(", ")}`,
        neededEvidence: result.missing.map((conflict) => `resolution of ${conflict}`),
        nextAction: "Resolve the conflicting claims with evidence, then recompute readiness",
      };

    case "NO_EVALUATION_BASIS": {
      const facts = strip("fact:", result.missing);
      if (facts.length > 0) {
        return {
          cause: `No recorded basis to judge this requirement: ${facts.join(", ")}`,
          neededEvidence: facts,
          nextAction:
            "Record these facts for the project or its jurisdiction profile, then recompute readiness — no default is assumed",
        };
      }
      return {
        cause: "The age of the evidence is unknown, so freshness cannot be judged",
        neededEvidence: ["as-of date on the claims this requirement uses"],
        nextAction: "Record the as-of date of the evidence on each claim, then recompute readiness",
      };
    }

    case "FACTS_NOT_SUPPLIED":
      return {
        cause: "The assessment received no facts for this requirement",
        neededEvidence: ["requirement facts"],
        nextAction: "Recompute readiness; if it repeats, the input collection needs fixing",
      };

    case "WATCH_CONDITION_MET":
      return {
        cause: "The requirement is met but a watch condition holds",
        neededEvidence: [],
        nextAction: "Going ahead needs a rationale and at least one condition to monitor",
      };
  }
}
