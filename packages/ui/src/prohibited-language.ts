/**
 * R-04 금지어 lint — spec 11 §11.13 / 13 AC-31.
 *
 * **아래 `PROHIBITED_PHRASES`가 R-04 금지어의 정본이다**.
 *
 * 11 §11.13은 한때 `paper/GLOSSARY.md`를 정본으로 지목했다. 그 파일은 OD-37로
 * 이 저장소 밖에 있고, 그동안 이 목록은 그것을 읽지 않은 채 독립적으로 자랐다 —
 * 즉 정본이 바뀌어도 검사는 따라가지 않았다. 읽히지 않는 정본은 정본이 아니므로
 * 검사가 실제로 읽는 이곳으로 옮겼다. 11 §11.13이 이 파일을 가리킨다.
 *
 * 적용 범위는 UI copy·API message·notification·export다. 언어는 영어 하나이고
 * 번역본을 두지 않는다(OD-30) — 한국어 항목이 남아 있는 것은 그 표현이 화면이
 * 아니라 소스·문서에 섞여 들어오는 것을 막기 위해서다. 위반이 있으면
 * build/content release를 실패시킨다.
 *
 * 이 규칙이 문체 취향이 아닌 이유: MPC는 발행 전 단계의 금융 상품을 서술한다.
 * 잘못된 문장은 나쁜 문장이 아니라 컴플라이언스 문제가 된다
 * (`design-system/docs/voice.md`).
 *
 * 목록을 고치면 `scripts/lint-ui-copy.ts`가 다음 CI에서 그것으로 검사한다.
 * 별도로 동기화할 사본은 없다.
 */

export interface ProhibitedPhrase {
  readonly phrase: string;
  readonly reason: string;
  /** 대신 쓸 표현. 금지만 하고 대안을 안 주면 우회 표현이 생긴다. */
  readonly replacement: string;
}

export const PROHIBITED_PHRASES: readonly ProhibitedPhrase[] = [
  // --- 수익 보장·확정 표현 (GLOSSARY R-04) --------------------------------
  {
    phrase: "확정이득",
    reason: "R-04 수익 확정 표현",
    replacement: "조건부·불확정 유동성 이벤트에서의 우선 분배 순위",
  },
  {
    phrase: "보장 수익",
    reason: "R-04 수익 보장 표현",
    replacement: "조건부 분배 구조",
  },
  {
    phrase: "확정 수익률",
    reason: "R-04 수익률 확정 표현",
    replacement: "조건부 분배 순위",
  },
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
    phrase: "원금 보장",
    reason: "R-04 원금 보장 표현",
    replacement: "손실 가능성과 분배 순위를 함께 설명",
  },

  // --- 정부·기관 승인 과장 ------------------------------------------------
  {
    phrase: "정부 승인",
    reason: "authority scope 밖 승인 주장 (11 §11.12)",
    replacement: "해당 기관의 authority scope와 기준일을 명시한 조회 결과",
  },
  {
    phrase: "government verified",
    reason: "government verification overclaim",
    replacement: "matched against an official source within its authority scope",
  },
  {
    phrase: "government integration complete",
    reason: "미확인 기관 연동을 완료로 표현 (OD-42)",
    replacement: "source status: planned / access_confirmed / tested / active 중 실제 상태",
  },
  {
    phrase: "공식 인증",
    reason: "MPC가 인증을 발급한다는 오해 (11 §11.12)",
    replacement: "확인된 출처와 검토 범위",
  },

  // --- 체인·무결성 과장 ---------------------------------------------------
  {
    phrase: "on-chain truth",
    reason: "inclusion proof를 사실성으로 표현 (AC-23)",
    replacement: "on-chain inclusion of this published version",
  },
  {
    phrase: "blockchain guarantees accuracy",
    reason: "무결성 증명을 정확성 보증으로 표현",
    replacement: "the proof confirms inclusion and integrity, not factual accuracy",
  },
  {
    phrase: "블록체인이 진위를 보증",
    reason: "무결성 증명을 진위 보증으로 표현",
    replacement: "포함 여부와 무결성만 확인하며 사실성은 보증하지 않음",
  },
  {
    phrase: "위변조 불가능한 사실",
    reason: "무결성과 사실성을 혼동",
    replacement: "변경되지 않았음을 확인할 수 있는 기록",
  },

  // --- 자동 승인·법률 효력 과장 -------------------------------------------
  {
    phrase: "automatic legal approval",
    reason: "readiness를 법적 승인으로 표현 (AC-33)",
    replacement: "data readiness only; legal issuance is a separate decision",
  },
  {
    phrase: "자동 승인",
    reason: "readiness ok를 승인으로 표현 (AC-03)",
    replacement: "사람의 gate decision이 별도로 필요함",
  },
  {
    phrase: "검증 완료로 안전",
    reason: "verification을 보증으로 표현 (R-04)",
    replacement: "검토 범위와 한계를 함께 표시",
  },

  // --- 투자 권유 ----------------------------------------------------------
  {
    phrase: "투자 추천",
    reason: "MPC는 투자자문을 하지 않는다 (D-50, R-03)",
    replacement: "기관 검토 브리프",
  },
  {
    phrase: "investment recommendation",
    reason: "MPC does not provide investment advice",
    replacement: "institutional review brief",
  },
  {
    phrase: "지금 청약",
    reason: "발행 전 단계에서 청약 권유 표현 (OD-07)",
    replacement: "현재 단계와 남은 gate 표시",
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
 * 텍스트를 검사한다.
 *
 * 대소문자를 무시하고 원문 위치를 반환한다 — CI 로그에서 어디를 고쳐야 하는지
 * 바로 보여야 수정이 빠르다.
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
 * 필수 경계 문구.
 *
 * 금지어를 없애는 것만으로는 부족하다. 오해를 막는 문구가 **있어야** 한다
 * (11 §11.6: 문구를 footer 한 곳에 숨기지 않고 관련 결과 가까이에 배치한다).
 */
export const REQUIRED_BOUNDARY_COPY = {
  proofResult: {
    ko: "이 결과는 문서 내용의 사실성·법률 효력·투자 적합성을 보증하지 않습니다.",
    en: "This result does not prove factual truth, legal effect, or investment suitability.",
  },
  readiness: {
    ko: "준비도 평가는 데이터 요건 충족 여부이며 사람의 결정을 대신하지 않습니다.",
    en: "Readiness is not a decision.",
  },
  sourceStatus: {
    ko: "출처 조회 성공이 곧 검증은 아닙니다.",
    en: "API success is not verification.",
  },
  verification: {
    ko: "검토 결과에는 범위와 한계가 있으며 보증이 아닙니다.",
    en: "Verification is not a guarantee.",
  },
  policyEngineName: {
    ko: "데이터·증빙 준비도 평가",
    en: "Data and evidence readiness assessment",
  },
} as const;
