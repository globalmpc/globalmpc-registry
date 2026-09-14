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
 * Scope: UI copy, API messages, notifications, and exports. The only language is English, with no
 * translations (OD-30) — the Korean entries remain to keep those expressions from creeping into
 * source and documents rather than screens. Any violation fails the build/content release.
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
    phrase: "확정이득",
    reason: "R-04 fixed-return wording",
    replacement: "조건부·불확정 유동성 이벤트에서의 우선 분배 순위",
  },
  {
    phrase: "보장 수익",
    reason: "R-04 guaranteed-return wording",
    replacement: "조건부 분배 구조",
  },
  {
    phrase: "확정 수익률",
    reason: "R-04 fixed-yield wording",
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
    reason: "R-04 principal-guarantee wording",
    replacement: "손실 가능성과 분배 순위를 함께 설명",
  },

  // --- Overstated government or authority approval ------------------------
  {
    phrase: "정부 승인",
    reason: "claims approval outside authority scope (11 §11.12)",
    replacement: "해당 기관의 authority scope와 기준일을 명시한 조회 결과",
  },
  {
    phrase: "government verified",
    reason: "government verification overclaim",
    replacement: "matched against an official source within its authority scope",
  },
  {
    phrase: "government integration complete",
    reason: "presents an unconfirmed authority integration as complete (OD-42)",
    replacement: "the actual source status: planned / access_confirmed / tested / active",
  },
  {
    phrase: "공식 인증",
    reason: "implies MPC issues certifications (11 §11.12)",
    replacement: "확인된 출처와 검토 범위",
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
    phrase: "블록체인이 진위를 보증",
    reason: "presents an integrity proof as a guarantee of authenticity",
    replacement: "포함 여부와 무결성만 확인하며 사실성은 보증하지 않음",
  },
  {
    phrase: "위변조 불가능한 사실",
    reason: "conflates integrity with factual truth",
    replacement: "변경되지 않았음을 확인할 수 있는 기록",
  },

  // --- Overstated automatic approval or legal effect ------------------------
  {
    phrase: "automatic legal approval",
    reason: "presents readiness as legal approval (AC-33)",
    replacement: "data readiness only; legal issuance is a separate decision",
  },
  {
    phrase: "자동 승인",
    reason: "presents readiness ok as approval (AC-03)",
    replacement: "사람의 gate decision이 별도로 필요함",
  },
  {
    phrase: "검증 완료로 안전",
    reason: "presents verification as a guarantee (R-04)",
    replacement: "검토 범위와 한계를 함께 표시",
  },

  // --- Investment solicitation --------------------------------------------
  {
    phrase: "투자 추천",
    reason: "MPC does not provide investment advice (D-50, R-03)",
    replacement: "기관 검토 브리프",
  },
  {
    phrase: "investment recommendation",
    reason: "MPC does not provide investment advice",
    replacement: "institutional review brief",
  },
  {
    phrase: "지금 청약",
    reason: "solicits subscription at the pre-issuance stage (OD-07)",
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
