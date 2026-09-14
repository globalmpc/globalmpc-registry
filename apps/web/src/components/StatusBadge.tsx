"use client";

import {
  GRADE_DISPLAY,
  READINESS_DISPLAY,
  SOURCE_RESULT_DISPLAY,
  type StatusDisplay,
} from "@mpc/ui";
import type { Grade, ReadinessStatus, SourceResult } from "@mpc/domain";

/**
 * Status badge.
 *
 * Label, icon, and color come from the `@mpc/ui` mapping. The key point is that the component
 * does not hardcode copy — if the 12 source results are rendered differently
 * per screen, users read the same status as different statuses (§7.3).
 */

const GLYPH: Record<StatusDisplay["icon"], string> = {
  check: "✓",
  clock: "◷",
  cross: "✕",
  dash: "–",
  question: "?",
  warning: "!",
};

function Badge({ display, title }: { display: StatusDisplay; title?: string }) {
  return (
    <span className="badge" style={{ color: `var(${display.token})` }} title={title}>
      {/* Never distinguish by color alone (§11.8). The glyph is decorative, so it is hidden from screen readers. */}
      <span className="glyph" aria-hidden="true">
        {GLYPH[display.icon]}
      </span>
      {display.labelEn}
    </span>
  );
}

export function ReadinessBadge({ status }: { status: ReadinessStatus }) {
  const display = READINESS_DISPLAY[status];
  return <Badge display={display} title={display.notMeaningEn} />;
}

export function GradeBadge({ grade }: { grade: Grade }) {
  const display = GRADE_DISPLAY[grade];
  return <Badge display={display} title={display.notMeaningEn} />;
}

export function SourceResultBadge({ result }: { result: SourceResult }) {
  const display = SOURCE_RESULT_DISPLAY[result];
  return <Badge display={display} title={display.nextActionEn} />;
}

/**
 * Lifecycle status is not yet covered by the @mpc/ui mapping (added in R2).
 * It is shown neutrally for now, still keeping the rule that color alone carries no meaning.
 */
export function LifecycleBadge({ state }: { state: string }) {
  return (
    <span className="badge" style={{ color: "var(--muted-foreground)" }}>
      <span className="glyph" aria-hidden="true">
        ●
      </span>
      {state}
    </span>
  );
}
