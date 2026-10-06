import {
  GRADES,
  READINESS_STATUSES,
  SOURCE_RESULTS,
  type Grade,
  type ReadinessStatus,
  type SourceResult,
} from "@mpc/domain";

/**
 * Status → display mapping.
 *
 * spec 11 §11.4, §11.8, §11.11 / ADR-T11.
 *
 * This file is two rules.
 *
 * 1. **Never convey status by color alone** (§11.8). Every entry has a label and icon alongside
 *    its token. Status must stay readable with color-vision deficiency, grayscale printing, and
 *    low contrast.
 * 2. **Never hardcode copy in components** (§7.3). The API supplies a status and the UI looks it
 *    up in this table, so the 12 source results are not phrased differently per screen.
 *
 * Each entry has exactly one label, one next action and, where defined, one prohibited
 * interpretation.
 */

/** @mpc/design token names. No literal color values. */
export type DesignToken =
  | "--positive"
  | "--alert"
  | "--destructive"
  | "--muted-foreground"
  | "--copper"
  | "--gold";

export interface StatusDisplay {
  readonly token: DesignToken;
  /** Marker that conveys status independently of color. */
  readonly icon: "check" | "clock" | "cross" | "dash" | "question" | "warning";
  readonly label: string;
  /** The next action the user can take on screen. */
  readonly nextAction: string;
}

/** grade and readiness also carry "what this status does not mean" (§11.6). */
export interface NotMeaning {
  readonly notMeaning: string;
}

/**
 * The 12 source results — exactly as in the §11.11 table.
 *
 * The point of this table is that `source_returned_no_record` (no record) and `source_unavailable`
 * (cannot check) have different colors, icons, copy, and next actions. Showing both as the same
 * "error" makes users keep retrying a record that does not exist.
 */
export const SOURCE_RESULT_DISPLAY: Readonly<Record<SourceResult, StatusDisplay>> = {
  confirmed_from_source: {
    token: "--positive",
    icon: "check",
    label: "Matched against official source",
    nextAction: "Review the scope and limitations of this check",
  },
  source_returned_no_record: {
    token: "--muted-foreground",
    icon: "dash",
    label: "No record found for this query",
    nextAction: "Check the query terms, or request a manual review",
  },
  not_applicable: {
    token: "--muted-foreground",
    icon: "dash",
    label: "Not applicable to this project",
    nextAction: "See why this requirement does not apply",
  },
  access_not_authorized: {
    token: "--alert",
    icon: "warning",
    label: "Access not authorized",
    nextAction: "Check the administrator or authority process",
  },
  source_unavailable: {
    token: "--alert",
    icon: "clock",
    label: "Source currently unavailable",
    nextAction: "See the retry time and the last successful check",
  },
  authentication_failed: {
    token: "--alert",
    icon: "warning",
    label: "Connection authentication failed",
    nextAction: "Ask a Connection Admin to act",
  },
  signature_invalid: {
    token: "--destructive",
    icon: "cross",
    label: "Source signature could not be verified",
    nextAction: "Check the quarantine state and start a security review",
  },
  schema_changed: {
    token: "--alert",
    icon: "warning",
    label: "Ingestion paused — source schema changed",
    nextAction: "Wait for reconciliation to complete",
  },
  stale: {
    token: "--alert",
    icon: "clock",
    label: "Stale — refresh required",
    nextAction: "Request a refresh",
  },
  conflicting: {
    token: "--alert",
    icon: "warning",
    label: "Sources conflict",
    nextAction: "Compare the sources, then request an expert review",
  },
  manual_review_required: {
    token: "--alert",
    icon: "question",
    label: "Manual review required",
    nextAction: "Submit an official document, or request a review",
  },
  legal_interpretation_required: {
    token: "--alert",
    icon: "question",
    label: "Legal interpretation required",
    nextAction: "Refer this to the legal owner",
  },
};

/**
 * grade — §11.4 status language.
 *
 * The "prohibited interpretation" next to each label is placed nearby as a disclaimer (§11.6).
 */
export const GRADE_DISPLAY: Readonly<Record<Grade, StatusDisplay & NotMeaning>> = {
  verified: {
    token: "--positive",
    icon: "check",
    label: "Independent review requirements met",
    nextAction: "Review the scope and limitations",
    notMeaning: "This does not warrant the facts or any return",
  },
  partially_verified: {
    token: "--alert",
    icon: "warning",
    label: "Partially reviewed",
    nextAction: "See which requirements are unmet",
    notMeaning: "This does not mean the quality is high",
  },
  self_reported: {
    token: "--alert",
    icon: "question",
    label: "Self-reported, not independently checked",
    nextAction: "Request a review",
    notMeaning: "This does not mean verification is complete",
  },
  unverified: {
    token: "--muted-foreground",
    icon: "dash",
    label: "Unreviewed or insufficient basis",
    nextAction: "Submit supporting evidence",
    notMeaning: "This does not assert that the claim is false",
  },
  rejected: {
    token: "--destructive",
    icon: "cross",
    label: "Excluded by rule",
    nextAction: "See why it was excluded",
    notMeaning: "This is not a judgement on the whole project",
  },
};

/**
 * readiness — §11.4.
 *
 * `gap` and `not_evaluable` both block go but have different causes. They are distinguished by
 * text, not color (ADR-T11).
 */
export const READINESS_DISPLAY: Readonly<Record<ReadinessStatus, StatusDisplay & NotMeaning>> = {
  ok: {
    token: "--positive",
    icon: "check",
    label: "Data requirement met",
    nextAction: "Check the next requirement",
    notMeaning: "The next stage is not approved automatically by this",
  },
  watch: {
    token: "--alert",
    icon: "warning",
    label: "Proceed with monitoring",
    nextAction: "Check the monitoring conditions and the reason",
    notMeaning: "This does not mean there is no problem",
  },
  gap: {
    token: "--destructive",
    icon: "cross",
    label: "Required basis missing",
    nextAction: "Submit the missing basis",
    notMeaning: "This is not a finding that the company is unqualified",
  },
  not_evaluable: {
    token: "--muted-foreground",
    icon: "question",
    label: "No basis to evaluate",
    nextAction: "Check which rule and source apply",
    notMeaning: "This is not a pass. Like gap, it blocks go",
  },
};

/** Catches missing mappings at both compile time and test time. */
export function assertDisplayCoverage(): void {
  for (const result of SOURCE_RESULTS) {
    if (!SOURCE_RESULT_DISPLAY[result]) throw new Error(`missing source result display: ${result}`);
  }
  for (const grade of GRADES) {
    if (!GRADE_DISPLAY[grade]) throw new Error(`missing grade display: ${grade}`);
  }
  for (const status of READINESS_STATUSES) {
    if (!READINESS_DISPLAY[status]) throw new Error(`missing readiness display: ${status}`);
  }
}
