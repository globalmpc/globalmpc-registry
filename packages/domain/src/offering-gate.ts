/**
 * Asset/Offering activation gate — OD-07, spec 12 §R6.
 *
 * **No trading functionality is implemented.** Nor is it hidden behind a feature flag —
 * an unapproved regulated feature behind a flag still creates code, security, and operational
 * liability and the risk of accidental activation (OD-07).
 *
 * What lives here is **code that decides "why not yet"**. Keeping the preconditions as a list
 * makes three things possible.
 *
 * 1. The UI shows the remaining conditions instead of an empty slot.
 * 2. Progress toward meeting the conditions can be tracked.
 * 3. When implementation starts becomes a determination, not a judgment call.
 *
 * Verbs like `buy`, `subscribe`, `transfer`, `custody` appear neither in this file nor anywhere else.
 */

/**
 * R6 preconditions.
 *
 * Missing any one means no activation. **There is no partial activation** — "remittance first"
 * is, from a regulatory standpoint, the same as opening everything.
 */
export const OFFERING_PRECONDITIONS = [
  {
    key: "issuer_identified",
    label: "Per-project issuer confirmed",
    why: "Without a settled issuer, no one can tell who is responsible for what",
    owner: "Issuer · Legal",
  },
  {
    key: "host_country_spv",
    label: "Local SPV incorporation confirmed",
    why: "Without an entity to hold the asset, where the rights reside is undefined",
    owner: "Issuer · Legal",
  },
  {
    key: "jurisdiction_determined",
    label: "Applicable jurisdiction confirmed",
    why: "Each jurisdiction requires different licenses and disclosure obligations",
    owner: "Legal",
  },
  {
    key: "ersp_engaged",
    label: "Per-function ERSP contracts",
    why: "Investor verification, custody, and transfer records are performed by licensed external entities (OD-25·OD-27)",
    owner: "Issuer · Legal",
  },
  {
    key: "legal_issuance_decision",
    label: "Legal issuance decision",
    why: "Data readiness or a governance pass does not substitute for issuance approval",
    owner: "Issuer · Legal",
  },
  {
    key: "security_audit",
    label: "Security audit complete",
    why: "Once a fund-movement path exists, the loss cap exceeds gas costs (O1)",
    owner: "Security",
  },
  {
    key: "separate_implementation_plan",
    label: "Separate implementation plan approved",
    why: "Designing only after confirming the real ERSP APIs and legal requirements avoids waste (OD-07)",
    owner: "Product owner · CTO",
  },
] as const;

export type OfferingPreconditionKey = (typeof OFFERING_PRECONDITIONS)[number]["key"];

export interface PreconditionStatus {
  readonly key: OfferingPreconditionKey;
  /** Whether it is met. Anything unconfirmed is not met. */
  readonly satisfied: boolean;
  /** What it was confirmed with. Required when met. */
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
      /** Items marked as met without evidence. This itself is a problem. */
      readonly unsupported: readonly OfferingPreconditionKey[];
    }
  | { readonly activatable: true };

/**
 * Whether activation is possible.
 *
 * **`activatable: true` does not mean the feature exists.** It only means every condition is
 * met; implementation follows under a separate plan. Even when this returns true, the code
 * still has no trading path.
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

  // Marked as met but lacking evidence. More dangerous than a missing item — it makes people
  // believe it was confirmed.
  const unsupported = statuses
    .filter((status) => status.satisfied && !status.evidenceRef)
    .map((status) => status.key);

  if (missing.length === 0 && unsupported.length === 0) {
    return { activatable: true };
  }

  return { activatable: false, missing, unsupported };
}

/**
 * What the UI must show — 11 §11.3.
 *
 * No empty space or disabled button in place of a trading CTA. A disabled button reads as
 * "coming soon", and empty space reads as "something should be here".
 * Show the remaining conditions and their owners instead.
 */
export const OFFERING_ABSENCE_COPY = {
  ko: "이 프로젝트에는 자산·청약 기능이 없습니다. 기능을 만들지 않았고 숨겨 두지도 않았습니다.",
  en: "This project has no asset or offering functionality. It is not built and not hidden behind a flag.",
} as const;

export const OFFERING_NOT_MEANING = {
  ko: "데이터 준비도 충족·거버넌스 통과·검토 서명은 발행 승인이 아닙니다.",
  en: "Data readiness, governance approval, and verification signatures are not issuance approval.",
} as const;
