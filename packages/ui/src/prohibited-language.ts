/**
 * R-04 prohibited-language lint — spec 11 §11.13 / 13 AC-31.
 *
 * **`PROHIBITED_PHRASES` below is the canonical list of R-04 prohibited terms**.
 *
 * 11 §11.13 once named `paper/GLOSSARY.md` as canonical. That file is outside this repository
 * (OD-37), and meanwhile this list grew independently without reading it — so the check did not
 * follow changes to the canonical source. A canonical source that nothing reads is not canonical,
 * so it moved here, where the check actually reads it. 11 §11.13 points to this file.
 *
 * Scope: UI copy, API messages, notifications, and exports. Any violation fails the build/content
 * release.
 *
 * Why this is not a style preference: MPC describes pre-issuance financial products. A wrong
 * sentence is not a bad sentence but a compliance problem (`design-system/docs/voice.md`).
 *
 * When the list changes, `scripts/lint-ui-copy.ts` checks against it on the next CI run.
 * There is no separate copy to keep in sync.
 */

export interface ProhibitedPhrase {
  readonly phrase: string;
  readonly reason: string;
  /** Wording to use instead. Banning without an alternative breeds workaround phrasing. */
  readonly replacement: string;
}

export const PROHIBITED_PHRASES: readonly ProhibitedPhrase[] = [
  // --- Guaranteed or fixed return wording (GLOSSARY R-04) -----------------
  {
    phrase: "guaranteed return",
    reason: "R-04 guaranteed return",
    replacement: "conditional distribution priority",
  },
  {
    phrase: "guaranteed yield",
    reason: "R-04 guaranteed return",
    replacement: "conditional distribution priority",
  },
  {
    phrase: "fixed return",
    reason: "R-04 fixed-return wording",
    replacement: "distribution priority in a conditional, uncertain liquidity event",
  },
  {
    phrase: "fixed yield",
    reason: "R-04 fixed-yield wording",
    replacement: "conditional distribution priority",
  },
  {
    phrase: "principal guarantee",
    reason: "R-04 principal-guarantee wording",
    replacement: "the possibility of loss together with the distribution priority",
  },
  {
    phrase: "principal guaranteed",
    reason: "R-04 principal-guarantee wording",
    replacement: "the possibility of loss together with the distribution priority",
  },

  // --- Overstated government or authority approval ------------------------
  {
    phrase: "government verified",
    reason: "government verification overclaim",
    replacement: "matched against an official source within its authority scope",
  },
  {
    phrase: "government approved",
    reason: "claims approval outside authority scope (11 §11.12)",
    replacement: "a lookup result that states the authority's scope and as-of date",
  },
  {
    phrase: "government approval",
    reason: "claims approval outside authority scope (11 §11.12)",
    replacement: "a lookup result that states the authority's scope and as-of date",
  },
  {
    phrase: "officially certified",
    reason: "implies MPC issues certifications (11 §11.12)",
    replacement: "the confirmed source and the review scope",
  },
  {
    phrase: "official certification",
    reason: "implies MPC issues certifications (11 §11.12)",
    replacement: "the confirmed source and the review scope",
  },
  {
    phrase: "government integration complete",
    reason: "presents an unconfirmed authority integration as complete (OD-42)",
    replacement: "the actual source status: planned / access_confirmed / tested / active",
  },

  // --- Overstated chain or integrity claims --------------------------------
  {
    phrase: "on-chain truth",
    reason: "presents an inclusion proof as factual truth (AC-23)",
    replacement: "on-chain inclusion of this published version",
  },
  {
    phrase: "blockchain guarantees accuracy",
    reason: "presents an integrity proof as a guarantee of accuracy",
    replacement: "the proof confirms inclusion and integrity, not factual accuracy",
  },
  {
    phrase: "blockchain guarantees authenticity",
    reason: "presents an integrity proof as a guarantee of authenticity",
    replacement: "confirms inclusion and integrity only; does not guarantee factual accuracy",
  },
  {
    phrase: "tamper-proof fact",
    reason: "conflates integrity with factual truth",
    replacement: "a record that can be checked for changes",
  },

  // --- Overstated automatic approval or legal effect ------------------------
  {
    phrase: "automatic legal approval",
    reason: "presents readiness as legal approval (AC-33)",
    replacement: "data readiness only; legal issuance is a separate decision",
  },
  {
    phrase: "automatically approved",
    reason: "presents readiness ok as approval (AC-03)",
    replacement: "a separate human gate decision is required",
  },
  {
    phrase: "verified and safe",
    reason: "presents verification as a guarantee (R-04)",
    replacement: "the review scope shown together with its limitations",
  },

  // --- Investment solicitation --------------------------------------------
  {
    phrase: "investment recommendation",
    reason: "MPC does not provide investment advice",
    replacement: "institutional review brief",
  },
  {
    phrase: "subscribe now",
    reason: "solicits subscription at the pre-issuance stage (OD-07)",
    replacement: "the current stage and the remaining gates",
  },
];

export interface LintFinding {
  readonly phrase: string;
  readonly reason: string;
  readonly replacement: string;
  readonly index: number;
  readonly context: string;
}

/**
 * Checks text.
 *
 * Case-insensitive; returns positions in the original text — fixes are fast when the CI log
 * shows exactly where to edit.
 */
export function lintProhibitedLanguage(text: string): LintFinding[] {
  const haystack = text.toLowerCase();
  const findings: LintFinding[] = [];

  for (const entry of PROHIBITED_PHRASES) {
    const needle = entry.phrase.toLowerCase();
    let index = haystack.indexOf(needle);
    while (index !== -1) {
      findings.push({
        phrase: entry.phrase,
        reason: entry.reason,
        replacement: entry.replacement,
        index,
        context: text.slice(Math.max(0, index - 30), index + needle.length + 30),
      });
      index = haystack.indexOf(needle, index + needle.length);
    }
  }

  return findings.sort((a, b) => a.index - b.index);
}

/**
 * Required boundary copy.
 *
 * Removing prohibited terms is not enough. Copy that prevents misreading **must be present**
 * (11 §11.6: place it near the related result instead of hiding it in a single footer).
 */
export const REQUIRED_BOUNDARY_COPY = {
  proofResult: "This result does not prove factual truth, legal effect, or investment suitability.",
  readiness: "Readiness is not a decision.",
  sourceStatus: "API success is not verification.",
  verification: "Verification is not a guarantee.",
  policyEngineName: "Data and evidence readiness assessment",
} as const;
