"use client";

import {
  GRADE_DISPLAY,
  READINESS_DISPLAY,
  SOURCE_RESULT_DISPLAY,
  type StatusDisplay,
} from "@mpc/ui";
import type { Grade, ReadinessStatus, SourceResult } from "@mpc/domain";

/**
 * 상태 배지.
 *
 * 라벨·아이콘·색을 `@mpc/ui`의 매핑에서 가져온다. 컴포넌트가 문구를
 * 하드코딩하지 않는 것이 핵심이다 — 12개 source result가 화면마다 다르게
 * 번역되면 사용자는 같은 상태를 다른 상태로 읽는다(§7.3).
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
      {/* 색만으로 구분하지 않는다(§11.8). 글리프는 장식이므로 읽히지 않게 한다. */}
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
 * lifecycle 상태는 아직 @mpc/ui 매핑 대상이 아니다(R2에서 추가).
 * 임시로 중립 표기하되 색만으로 의미를 전달하지 않는 규칙은 지킨다.
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
