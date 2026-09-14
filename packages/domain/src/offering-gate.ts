/**
 * Asset/Offering activation gate — OD-07, spec 12 §R6.
 *
 * **거래 기능을 구현하지 않는다.** feature flag 뒤에 숨겨 두지도 않는다 —
 * 미승인 규제 기능은 flag 뒤에 있어도 코드·보안·운영 책임과 오활성화 위험을
 * 만든다(OD-07).
 *
 * 여기 있는 것은 **"왜 아직 안 되는가"를 판정하는 코드**다. 선행조건을 목록으로
 * 두면 세 가지가 가능해진다.
 *
 * 1. 화면이 빈 자리 대신 남은 조건을 보여준다.
 * 2. 조건이 충족되는 것을 추적할 수 있다.
 * 3. 구현 착수 시점이 판단이 아니라 판정이 된다.
 *
 * `buy`·`subscribe`·`transfer`·`custody` 같은 동사는 이 파일에도, 어디에도 없다.
 */

/**
 * R6 선행조건.
 *
 * 하나라도 빠지면 활성화하지 않는다. **부분 활성화가 없다** — "송금만 먼저"는
 * 규제 관점에서 전체를 연 것과 같다.
 */
export const OFFERING_PRECONDITIONS = [
  {
    key: "issuer_identified",
    label: "프로젝트별 Issuer 확정",
    why: "발행 주체가 정해지지 않으면 누가 무엇에 책임지는지 알 수 없다",
    owner: "Issuer·법무",
  },
  {
    key: "host_country_spv",
    label: "소재국 SPV 설립 확인",
    why: "자산이 귀속될 법인이 없으면 권리가 어디에 있는지 정의되지 않는다",
    owner: "Issuer·법무",
  },
  {
    key: "jurisdiction_determined",
    label: "적용 관할 확정",
    why: "관할마다 요구되는 인가와 공시 의무가 다르다",
    owner: "법무",
  },
  {
    key: "ersp_engaged",
    label: "기능별 ERSP 계약",
    why: "투자자 확인·자금 보관·이전 기록은 인가받은 외부 법인이 수행한다(OD-25·OD-27)",
    owner: "Issuer·법무",
  },
  {
    key: "legal_issuance_decision",
    label: "법적 발행 결정",
    why: "데이터 준비도나 거버넌스 통과가 발행 승인을 대신하지 않는다",
    owner: "Issuer·법무",
  },
  {
    key: "security_audit",
    label: "보안 감사 완료",
    why: "자금 이동 경로가 생기면 손실 상한이 가스비를 넘어선다(O1)",
    owner: "보안",
  },
  {
    key: "separate_implementation_plan",
    label: "별도 구현 계획 승인",
    why: "실제 ERSP API와 법률 요구를 확인한 뒤 설계해야 낭비가 없다(OD-07)",
    owner: "제품책임자·CTO",
  },
] as const;

export type OfferingPreconditionKey = (typeof OFFERING_PRECONDITIONS)[number]["key"];

export interface PreconditionStatus {
  readonly key: OfferingPreconditionKey;
  /** 충족 여부. 확인되지 않은 것은 충족이 아니다. */
  readonly satisfied: boolean;
  /** 무엇으로 확인했는가. 충족이라면 반드시 있어야 한다. */
  readonly evidenceRef: string | null;
}

export type OfferingGateDecision =
  | {
      readonly activatable: false;
      readonly missing: readonly {
        readonly key: OfferingPreconditionKey;
        readonly label: string;
        readonly why: string;
        readonly owner: string;
      }[];
      /** 근거 없이 충족으로 표시된 항목. 이것 자체가 문제다. */
      readonly unsupported: readonly OfferingPreconditionKey[];
    }
  | { readonly activatable: true };

/**
 * 활성화 가능 여부.
 *
 * **`activatable: true`가 곧 기능이 있다는 뜻은 아니다.** 조건이 다 찼다는
 * 판정일 뿐이고, 구현은 그 뒤에 별도 계획으로 한다. 이 함수가 true를 반환해도
 * 코드에는 여전히 거래 경로가 없다.
 */
export function checkOfferingGate(
  statuses: readonly PreconditionStatus[],
): OfferingGateDecision {
  const byKey = new Map(statuses.map((status) => [status.key, status]));

  const missing = OFFERING_PRECONDITIONS.filter(
    (precondition) => byKey.get(precondition.key)?.satisfied !== true,
  ).map((precondition) => ({
    key: precondition.key,
    label: precondition.label,
    why: precondition.why,
    owner: precondition.owner,
  }));

  // 충족이라고 표시했는데 근거가 없는 것. 빠진 것보다 위험하다 — 확인됐다고
  // 믿게 만든다.
  const unsupported = statuses
    .filter((status) => status.satisfied && !status.evidenceRef)
    .map((status) => status.key);

  if (missing.length === 0 && unsupported.length === 0) {
    return { activatable: true };
  }

  return { activatable: false, missing, unsupported };
}

/**
 * 화면이 보여야 하는 것 — 11 §11.3.
 *
 * 거래 CTA 자리에 빈 공간이나 비활성 버튼을 두지 않는다. 비활성 버튼은
 * "곧 생긴다"로 읽히고, 빈 공간은 "여기 뭔가 있어야 하는데"로 읽힌다.
 * 대신 남은 조건과 그 담당을 보여준다.
 */
export const OFFERING_ABSENCE_COPY = {
  ko: "이 프로젝트에는 자산·청약 기능이 없습니다. 기능을 만들지 않았고 숨겨 두지도 않았습니다.",
  en: "This project has no asset or offering functionality. It is not built and not hidden behind a flag.",
} as const;

export const OFFERING_NOT_MEANING = {
  ko: "데이터 준비도 충족·거버넌스 통과·검토 서명은 발행 승인이 아닙니다.",
  en: "Data readiness, governance approval, and verification signatures are not issuance approval.",
} as const;
