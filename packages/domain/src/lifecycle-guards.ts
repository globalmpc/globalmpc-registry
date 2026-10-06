import type { AtLifecycleState } from "./machines.js";
import type { GateDecisionValue } from "./readiness.js";
import type { OfferingGateDecision, OfferingPreconditionKey } from "./offering-gate.js";

/**
 * Lifecycle transition guards — spec 04 §4.3 "Transition guards", invariant 7.
 *
 * The state machine says which moves exist. This file says **what must be true** before a
 * move is made. Until now a reason string was enough to take a project from `registered` to
 * `offering_open` — the state that invariant 7 forbids without a legal issuance status.
 *
 * Every row of the guard table falls into one of three kinds:
 *
 * 1. **Checkable with recorded data** — the offering preconditions (`project_facts`), a human
 *    `go` GateDecision, and new review activity after a suspension. These are evaluated.
 * 2. **Not recorded by this system** — Issuer offering status, settlement reconciliation,
 *    branch events, valuation requests, project votes with a threshold (OD-10), off-chain
 *    execution, legal approval of retirement. There is no table that holds them, so the move
 *    is refused and the condition is reported as `not_evaluable`. Refusing is the only safe
 *    answer: a guard that passes when it cannot see its input is not a guard.
 * 3. **Deliberately open** — entering `suspended`. Taking a project down is protective; a guard
 *    here would keep a problem project running while its paperwork is gathered.
 */

/** GateDecision `gate_id` that authorises offering activation. Stored with the decision. */
export const OFFERING_GATE_ID = "offering_activation";

/**
 * States that exist only after an offering has opened. Entering any of them without the
 * offering conditions would be offering activation by another name.
 */
export const OFFERING_FAMILY_STATES: readonly AtLifecycleState[] = [
  "offering_open",
  "offering_closed",
  "active",
  "branch_vote",
  "continuing",
  "divested",
];

export interface LifecycleCondition {
  readonly key: string;
  readonly label: string;
  readonly why: string;
  /**
   * `unmet` — recorded data says no. `not_evaluable` — nothing in this system records it, so
   * it cannot be met here yet.
   */
  readonly status: "unmet" | "not_evaluable";
  readonly owner?: string;
}

export interface LifecycleGuardFacts {
  /** `checkOfferingGate` over the project's recorded preconditions. */
  readonly offeringGate: OfferingGateDecision;
  /** The most recent human decision on `OFFERING_GATE_ID`, if any. */
  readonly latestOfferingDecision: GateDecisionValue | null;
  /**
   * Whether new evidence, review, readiness assessment, or gate decision was recorded after
   * the project was suspended. `null` when the suspension moment itself is unknown.
   */
  readonly reviewedSinceSuspension: boolean | null;
}

export type LifecycleGuardResult =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly code: "LIFECYCLE_GUARD_UNMET" | "LIFECYCLE_REGISTER_VIA_PUBLICATION";
      readonly conditions: readonly LifecycleCondition[];
      /** Offering preconditions marked confirmed without evidence. */
      readonly unsupported: readonly OfferingPreconditionKey[];
    };

const notRecorded = (key: string, label: string, why: string): LifecycleCondition => ({
  key,
  label,
  why,
  status: "not_evaluable",
});

const CLOSURE_CONDITION = notRecorded(
  "offchain_execution_or_obligation_plan",
  "Off-chain execution complete, or an obligation plan",
  "Closing while obligations are open leaves holders with no counterpart",
);

const BRANCH_CONDITIONS = [
  notRecorded(
    "contractual_branch_event",
    "Contractual branch event",
    "A branch vote starts only from an event the contract defines",
  ),
  notRecorded(
    "independent_valuation_request",
    "Independent valuation requested",
    "Voters decide on a valuation that did not come from the proposer",
  ),
];

const VOTE_CONDITION = notRecorded(
  "valid_project_vote",
  "Valid project vote meeting the threshold",
  "Quorum and threshold values are not decided yet, so no vote can be judged valid",
);

/**
 * Row conditions of §4.3 that this system does not record. Keyed by `from→to`.
 * Rows that are checkable (or deliberately open) are handled in code, not here.
 */
const UNRECORDED_ROW_CONDITIONS: Readonly<Record<string, readonly LifecycleCondition[]>> = {
  "offering_open→offering_closed": [
    notRecorded(
      "issuer_offering_status",
      "Issuer offering status and per-function ERSP status",
      "Only the issuer and the licensed service providers know whether the offering ended",
    ),
    notRecorded(
      "deadline_or_cap_rule",
      "Offering deadline or cap rule reached",
      "Closing before the rule is met changes the terms investors relied on",
    ),
  ],
  "offering_closed→active": [
    notRecorded(
      "settlement_reconciliation",
      "Settlement and registry reconciliation",
      "An unreconciled offering can show holdings that settlement does not support",
    ),
  ],
  "active→branch_vote": BRANCH_CONDITIONS,
  "continuing→branch_vote": BRANCH_CONDITIONS,
  "branch_vote→continuing": [VOTE_CONDITION],
  "branch_vote→divested": [VOTE_CONDITION],
  "continuing→active": [
    notRecorded(
      "financing_condition_record",
      "Financing or contract condition recorded",
      "Continuing without a recorded condition leaves the next decision without a basis",
    ),
  ],
  "divested→closure": [CLOSURE_CONDITION],
  "active→closure": [CLOSURE_CONDITION],
  "closure→retired": [
    notRecorded(
      "obligations_resolved",
      "No unresolved obligations",
      "A retired project cannot be pursued for what it still owes",
    ),
    notRecorded(
      "retirement_legal_approval",
      "Legal approval of retirement",
      "Retirement ends the legal vehicle, which only a legal decision can do",
    ),
  ],
};

/**
 * Invariant 7 — no offering-family state without legal issuance and the other preconditions,
 * and AC-03 — no forward move without a human `go`, even when every condition is met.
 */
function offeringConditions(facts: LifecycleGuardFacts): LifecycleCondition[] {
  const conditions: LifecycleCondition[] = facts.offeringGate.activatable
    ? []
    : facts.offeringGate.missing.map((missing) => ({
        key: missing.key,
        label: missing.label,
        why: missing.why,
        owner: missing.owner,
        status: "unmet" as const,
      }));

  // Marked confirmed without evidence. `checkOfferingGate` refuses these even when nothing is
  // missing, so the guard must too — otherwise an empty `missing` list would read as "all met".
  if (!facts.offeringGate.activatable && facts.offeringGate.unsupported.length > 0) {
    conditions.push({
      key: "offering_precondition_evidence",
      label: "Evidence for every confirmed offering precondition",
      why: `Confirmed without evidence: ${facts.offeringGate.unsupported.join(", ")}`,
      status: "unmet",
    });
  }

  if (facts.latestOfferingDecision !== "go") {
    conditions.push({
      key: "offering_gate_go_decision",
      label: "Human go decision on the offering gate",
      why:
        facts.latestOfferingDecision === null
          ? "Conditions being met is not approval; a person must decide go (AC-03)"
          : `The latest offering gate decision is ${facts.latestOfferingDecision}, not go`,
      owner: "Gate approver",
      status: "unmet",
    });
  }

  return conditions;
}

function unsupportedOf(facts: LifecycleGuardFacts): readonly OfferingPreconditionKey[] {
  return facts.offeringGate.activatable ? [] : facts.offeringGate.unsupported;
}

/**
 * Whether `from → to` may be applied. Call it only after the state machine and the
 * reinstatement-target rule have accepted the move.
 */
export function checkLifecycleGuard(
  from: AtLifecycleState,
  to: AtLifecycleState,
  facts: LifecycleGuardFacts,
): LifecycleGuardResult {
  if (to === "suspended") return { allowed: true };

  // `registered` means "a Project Registry record exists" (11 §11.4). Publication checks the
  // minimum fields and the responsible party; a reason string here checks neither.
  if (from === "draft" && to === "registered") {
    return {
      allowed: false,
      code: "LIFECYCLE_REGISTER_VIA_PUBLICATION",
      conditions: [
        {
          key: "project_registry_entry",
          label: "Published Project Registry entry",
          why: "A project becomes registered by publishing its Registry entry, which checks the minimum fields and the responsible party",
          status: "unmet",
        },
      ],
      unsupported: [],
    };
  }

  const conditions: LifecycleCondition[] = [];

  if (from === "suspended") {
    // Closing a suspended project is winding down, not laundering (§4.3).
    if (to === "closure") return { allowed: true };

    if (facts.reviewedSinceSuspension !== true) {
      conditions.push({
        key: "review_since_suspension",
        label: "New evidence, review, readiness assessment, or decision since suspension",
        why:
          facts.reviewedSinceSuspension === null
            ? "No suspension record exists, so nothing can be shown to be newer than it"
            : "Reinstating on the same record that led to suspension undoes the control",
        status: "unmet",
      });
    }
  } else {
    conditions.push(...(UNRECORDED_ROW_CONDITIONS[`${from}→${to}`] ?? []));
  }

  if (OFFERING_FAMILY_STATES.includes(to)) {
    conditions.push(...offeringConditions(facts));
  }

  if (conditions.length === 0) return { allowed: true };
  return {
    allowed: false,
    code: "LIFECYCLE_GUARD_UNMET",
    conditions,
    // Offering-gate data the system does not hold yet; reported only where the offering guard runs.
    unsupported: OFFERING_FAMILY_STATES.includes(to) ? unsupportedOf(facts) : [],
  };
}
