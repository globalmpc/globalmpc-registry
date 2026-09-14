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
 * The Korean copy is kept because it is the original text of the spec §11.11 table. **The screen
 * shows English** (OD-30) — edit both strings of an entry together in one place so the two
 * languages never assert different facts.
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
  readonly labelKo: string;
  readonly labelEn: string;
  /** The next action the user can take on screen. */
  readonly nextActionKo: string;
  readonly nextActionEn: string;
}

/** grade and readiness also carry "what this status does not mean" (§11.6). */
export interface NotMeaning {
  readonly notMeaningKo: string;
  readonly notMeaningEn: string;
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
    labelKo: "공식 출처 조회 결과와 대조됨",
    labelEn: "Matched against official source",
    nextActionKo: "확인 범위와 한계 보기",
    nextActionEn: "Review the scope and limitations of this check",
  },
  source_returned_no_record: {
    token: "--muted-foreground",
    icon: "dash",
    labelKo: "해당 조건으로 기록을 찾지 못함",
    labelEn: "No record found for this query",
    nextActionKo: "조회 조건 확인 또는 수동 검토 요청",
    nextActionEn: "Check the query terms, or request a manual review",
  },
  not_applicable: {
    token: "--muted-foreground",
    icon: "dash",
    labelKo: "이 항목은 적용 대상이 아님",
    labelEn: "Not applicable to this project",
    nextActionKo: "적용 근거 보기",
    nextActionEn: "See why this requirement does not apply",
  },
  access_not_authorized: {
    token: "--alert",
    icon: "warning",
    labelKo: "현재 접근 권한 없음",
    labelEn: "Access not authorized",
    nextActionKo: "관리자·기관 절차 확인",
    nextActionEn: "Check the administrator or authority process",
  },
  source_unavailable: {
    token: "--alert",
    icon: "clock",
    labelKo: "현재 출처 확인 불가",
    labelEn: "Source currently unavailable",
    nextActionKo: "재시도 시각과 마지막 성공 기록 보기",
    nextActionEn: "See the retry time and the last successful check",
  },
  authentication_failed: {
    token: "--alert",
    icon: "warning",
    labelKo: "연결 인증 문제",
    labelEn: "Connection authentication failed",
    nextActionKo: "Connection Admin 조치 요청",
    nextActionEn: "Ask a Connection Admin to act",
  },
  signature_invalid: {
    token: "--destructive",
    icon: "cross",
    labelKo: "출처 서명을 확인할 수 없음",
    labelEn: "Source signature could not be verified",
    nextActionKo: "격리 상태 확인과 보안 검토",
    nextActionEn: "Check the quarantine state and start a security review",
  },
  schema_changed: {
    token: "--alert",
    icon: "warning",
    labelKo: "출처 형식 변경으로 확인 중단",
    labelEn: "Ingestion paused — source schema changed",
    nextActionKo: "reconciliation 완료 대기",
    nextActionEn: "Wait for reconciliation to complete",
  },
  stale: {
    token: "--alert",
    icon: "clock",
    labelKo: "오래된 정보, 다시 확인 필요",
    labelEn: "Stale — refresh required",
    nextActionKo: "갱신 요청",
    nextActionEn: "Request a refresh",
  },
  conflicting: {
    token: "--alert",
    icon: "warning",
    labelKo: "출처 간 정보 충돌",
    labelEn: "Sources conflict",
    nextActionKo: "비교 후 전문 검토 요청",
    nextActionEn: "Compare the sources, then request an expert review",
  },
  manual_review_required: {
    token: "--alert",
    icon: "question",
    labelKo: "담당자 확인 필요",
    labelEn: "Manual review required",
    nextActionKo: "공식 문서 제출 또는 검토 요청",
    nextActionEn: "Submit an official document, or request a review",
  },
  legal_interpretation_required: {
    token: "--alert",
    icon: "question",
    labelKo: "법률 해석 필요",
    labelEn: "Legal interpretation required",
    nextActionKo: "법무 책임자에게 전달",
    nextActionEn: "Refer this to the legal owner",
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
    labelKo: "독립 검토 요건 충족",
    labelEn: "Independent review requirements met",
    nextActionKo: "검토 범위와 한계 보기",
    nextActionEn: "Review the scope and limitations",
    notMeaningKo: "사실 또는 수익의 보장을 뜻하지 않는다",
    notMeaningEn: "This does not warrant the facts or any return",
  },
  partially_verified: {
    token: "--alert",
    icon: "warning",
    labelKo: "일부 검토 요건 충족",
    labelEn: "Partially reviewed",
    nextActionKo: "부족한 요건 보기",
    nextActionEn: "See which requirements are unmet",
    notMeaningKo: "품질이 우수하다는 뜻이 아니다",
    notMeaningEn: "This does not mean the quality is high",
  },
  self_reported: {
    token: "--alert",
    icon: "question",
    labelKo: "제3자 확인 없는 제출 정보",
    labelEn: "Self-reported, not independently checked",
    nextActionKo: "검토 요청",
    nextActionEn: "Request a review",
    notMeaningKo: "검증이 완료됐다는 뜻이 아니다",
    notMeaningEn: "This does not mean verification is complete",
  },
  unverified: {
    token: "--muted-foreground",
    icon: "dash",
    labelKo: "검토 전 또는 근거 부족",
    labelEn: "Unreviewed or insufficient basis",
    nextActionKo: "근거 자료 제출",
    nextActionEn: "Submit supporting evidence",
    notMeaningKo: "허위라고 단정하는 것이 아니다",
    notMeaningEn: "This does not assert that the claim is false",
  },
  rejected: {
    token: "--destructive",
    icon: "cross",
    labelKo: "규칙상 사용 차단",
    labelEn: "Excluded by rule",
    nextActionKo: "차단 사유 보기",
    nextActionEn: "See why it was excluded",
    notMeaningKo: "프로젝트 전체가 부정하다는 뜻이 아니다",
    notMeaningEn: "This is not a judgement on the whole project",
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
    labelKo: "해당 데이터 요건 충족",
    labelEn: "Data requirement met",
    nextActionKo: "다음 요건 확인",
    nextActionEn: "Check the next requirement",
    notMeaningKo: "다음 단계가 자동 승인된다는 뜻이 아니다",
    notMeaningEn: "The next stage is not approved automatically by this",
  },
  watch: {
    token: "--alert",
    icon: "warning",
    labelKo: "조건부 주의",
    labelEn: "Proceed with monitoring",
    nextActionKo: "관찰 조건과 사유 확인",
    nextActionEn: "Check the monitoring conditions and the reason",
    notMeaningKo: "문제가 없다는 뜻이 아니다",
    notMeaningEn: "This does not mean there is no problem",
  },
  gap: {
    token: "--destructive",
    icon: "cross",
    labelKo: "필수 근거 미충족",
    labelEn: "Required basis missing",
    nextActionKo: "부족한 근거 제출",
    nextActionEn: "Submit the missing basis",
    notMeaningKo: "회사 자체가 부적격이라는 뜻이 아니다",
    notMeaningEn: "This is not a finding that the company is unqualified",
  },
  not_evaluable: {
    token: "--muted-foreground",
    icon: "question",
    labelKo: "판단 기준이 없어 평가할 수 없음",
    labelEn: "No basis to evaluate",
    nextActionKo: "적용 기준·원천 확인",
    nextActionEn: "Check which rule and source apply",
    notMeaningKo: "통과했다는 뜻이 아니다. gap과 동일하게 go를 차단한다",
    notMeaningEn: "This is not a pass. Like gap, it blocks go",
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
