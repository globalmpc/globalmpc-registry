import { describe, expect, it } from "vitest";
import {
  ALL_MACHINES,
  SUSPENDABLE_STATES,
  atLifecycleMachine,
  attestationMachine,
  CHAIN_TX_STATES,
  chainTransactionMachine,
  disclosureRestrictionMachine,
  proposalMachine,
  resumeFromSuspension,
  verificationCaseMachine,
  type AtLifecycleState,
} from "../src/machines.js";
import {
  InvalidTransitionError,
  assertTransition,
  canTransition,
  validateMachine,
  type StateMachine,
} from "../src/state-machine.js";

describe("consistency of every state machine", () => {
  // The 13 machines each have a different state union. The exhaustive check must treat them as
  // string machines, so they are widened once here.
  const machines: StateMachine<string>[] = ALL_MACHINES.map(
    (machine) => machine as unknown as StateMachine<string>,
  );

  for (const machine of machines) {
    it(`${machine.name}: transition table matches states`, () => {
      expect(() => validateMachine(machine)).not.toThrow();
    });

    it(`${machine.name}: no state unreachable from initial`, () => {
      const reachable = new Set<string>([machine.initial]);
      const queue: string[] = [machine.initial];
      while (queue.length > 0) {
        const current = queue.shift()!;
        for (const next of machine.transitions[current] ?? []) {
          if (!reachable.has(next)) {
            reachable.add(next);
            queue.push(next);
          }
        }
      }
      const unreachable = machine.states.filter((state) => !reachable.has(state));
      expect(unreachable).toEqual([]);
    });
  }
});

describe("AT lifecycle — spec 04 §4.3", () => {
  it("normal path", () => {
    const path: AtLifecycleState[] = [
      "draft",
      "registered",
      "offering_open",
      "offering_closed",
      "active",
      "branch_vote",
      "divested",
      "closure",
      "retired",
    ];
    for (let i = 0; i < path.length - 1; i += 1) {
      expect(canTransition(atLifecycleMachine, path[i]!, path[i + 1]!)).toBe(true);
    }
  });

  it("cannot skip from draft to offering_open", () => {
    expect(canTransition(atLifecycleMachine, "draft", "offering_open")).toBe(false);
  });

  it("cannot skip from registered to active — the offering stage cannot be bypassed", () => {
    expect(canTransition(atLifecycleMachine, "registered", "active")).toBe(false);
  });

  it("retired is terminal", () => {
    expect(atLifecycleMachine.transitions.retired).toEqual([]);
  });

  it("draft cannot be suspended — there is nothing to suspend", () => {
    expect(canTransition(atLifecycleMachine, "draft", "suspended")).toBe(false);
  });

  it("every suspendable state can move to suspended", () => {
    for (const state of SUSPENDABLE_STATES) {
      expect(canTransition(atLifecycleMachine, state, "suspended")).toBe(true);
    }
  });

  it("assertTransition throws on a forbidden transition", () => {
    expect(() => assertTransition(atLifecycleMachine, "draft", "active")).toThrowError(
      InvalidTransitionError,
    );
  });
});

describe("resume from suspension — prior state or closure only", () => {
  it("resumes to the prior state", () => {
    expect(resumeFromSuspension("active", "active")).toBe(true);
  });

  it("can move to closure", () => {
    expect(resumeFromSuspension("active", "closure")).toBe(true);
  });

  it("cannot resume to another state — suspension must not launder state", () => {
    expect(resumeFromSuspension("registered", "active")).toBe(false);
    expect(resumeFromSuspension("offering_open", "offering_closed")).toBe(false);
  });
});

describe("Verification Case — immutability after signing", () => {
  it("cannot return from signed to in_review", () => {
    expect(canTransition(verificationCaseMachine, "signed", "in_review")).toBe(false);
  });

  it("cannot move from signed to changes_requested", () => {
    expect(canTransition(verificationCaseMachine, "signed", "changes_requested")).toBe(false);
  });

  it("correction only by revoke or supersede", () => {
    expect(canTransition(verificationCaseMachine, "signed", "revoked")).toBe(true);
    expect(canTransition(verificationCaseMachine, "signed", "superseded")).toBe(true);
  });

  it("changes_requested ↔ in_review round-trips only before signing", () => {
    expect(canTransition(verificationCaseMachine, "in_review", "changes_requested")).toBe(true);
    expect(canTransition(verificationCaseMachine, "changes_requested", "in_review")).toBe(true);
  });

  it("cannot skip assigned and go to in_review", () => {
    expect(canTransition(verificationCaseMachine, "draft", "in_review")).toBe(false);
  });
});

describe("Proposal — no cancellation after the vote is final", () => {
  it("no cancelled after voting", () => {
    expect(canTransition(proposalMachine, "voting", "cancelled")).toBe(false);
    expect(canTransition(proposalMachine, "succeeded", "cancelled")).toBe(false);
  });

  it("can be cancelled before voting", () => {
    expect(canTransition(proposalMachine, "draft", "cancelled")).toBe(true);
    expect(canTransition(proposalMachine, "announced", "cancelled")).toBe(true);
  });

  it("AC-06 — on-chain success is not completed off-chain execution", () => {
    // succeeded cannot go straight to executed. It passes through timelock, record, execution_pending.
    expect(canTransition(proposalMachine, "succeeded", "executed")).toBe(false);
    expect(canTransition(proposalMachine, "execution_pending", "executed")).toBe(true);
    expect(canTransition(proposalMachine, "execution_pending", "failed")).toBe(true);
    expect(canTransition(proposalMachine, "execution_pending", "disputed")).toBe(true);
  });

  it("cannot skip the timelock", () => {
    expect(canTransition(proposalMachine, "succeeded", "recorded")).toBe(false);
  });
});

describe("Attestation — stale can be undone but revoke cannot", () => {
  it("stale_candidate can return to active after re-review", () => {
    expect(canTransition(attestationMachine, "stale_candidate", "active")).toBe(true);
  });

  it("revoked is terminal", () => {
    expect(attestationMachine.transitions.revoked).toEqual([]);
  });

  it("a signed attestation can be superseded by a correction — nothing activates it first", () => {
    expect(canTransition(attestationMachine, "signed", "superseded")).toBe(true);
  });

  it("superseded is terminal", () => {
    expect(attestationMachine.transitions.superseded).toEqual([]);
  });

  it("cannot go from draft straight to active — signing cannot be skipped", () => {
    expect(canTransition(attestationMachine, "draft", "active")).toBe(false);
  });
});

describe("Chain transaction — included is not success", () => {
  it("nothing reaches confirmed without a mined, hashed state", () => {
    // Confirmation needs depth and finality on a receipt (anchor-state); the table only allows the
    // states that hold a hash to get there.
    const toConfirmed = CHAIN_TX_STATES.filter((from) =>
      canTransition(chainTransactionMachine, from, "confirmed"),
    );
    expect(toConfirmed.sort()).toEqual(["included", "submitted"]);
  });

  it("a Safe proposal is not a submission: it confirms only after execution is tracked", () => {
    expect(canTransition(chainTransactionMachine, "proposed", "confirmed")).toBe(false);
    expect(canTransition(chainTransactionMachine, "proposed", "submitted")).toBe(true);
  });

  it("confirmed can be reorged too", () => {
    expect(canTransition(chainTransactionMachine, "confirmed", "reorged")).toBe(true);
  });

  it("reorg goes to resubmission or reconciliation", () => {
    expect(canTransition(chainTransactionMachine, "reorged", "submitted")).toBe(true);
    expect(canTransition(chainTransactionMachine, "reorged", "reconciliation_required")).toBe(
      true,
    );
  });

  // Every move the anchor worker and the API resubmission route write (anchor-submitter.ts,
  // anchor-state.ts trackTransaction, routes/registry.ts). The table is documentation; this list
  // keeps it from drifting from the code again.
  it.each([
    ["created", "submitted", "EOA send, or an earlier attempt's hash recovered from chain"],
    ["created", "proposed", "Safe proposal uploaded"],
    ["created", "failed", "no batch, or the attempt cap"],
    ["created", "reconciliation_required", "on chain with another root or an unfound transaction"],
    ["proposed", "submitted", "executed on the Safe"],
    ["proposed", "failed", "rejected or replaced on the Safe"],
    ["submitted", "included", "mined, short of depth or finality"],
    ["submitted", "confirmed", "first observation already deep and final"],
    ["submitted", "reverted", "receipt reverted"],
    ["submitted", "dropped", "unknown past the drop timeout"],
    ["submitted", "failed", "no hash recorded"],
    ["submitted", "reconciliation_required", "receipt_without_root_submitted"],
    ["included", "confirmed", "depth and finality met"],
    ["included", "submitted", "back in the mempool, or following another transaction"],
    ["included", "reverted", "receipt reverted"],
    ["included", "reconciliation_required", "block disappeared, or no RootSubmitted"],
    ["confirmed", "included", "re-observed short of depth or finality"],
    ["confirmed", "submitted", "back in the mempool, or following during the reorg watch"],
    ["confirmed", "reverted", "re-mined and reverted"],
    ["confirmed", "reconciliation_required", "block disappeared, or no RootSubmitted"],
    ["reverted", "created", "resubmitted by a person"],
    ["dropped", "created", "resubmitted by a person"],
    ["failed", "created", "resubmitted by a person"],
    ["reconciliation_required", "created", "resubmitted by a person"],
  ] as const)("%s → %s (%s)", (from, to, _why) => {
    expect(canTransition(chainTransactionMachine, from, to)).toBe(true);
  });

  it("has every state of chain.transaction_state, including proposed", () => {
    expect(CHAIN_TX_STATES).toContain("proposed");
    expect(CHAIN_TX_STATES).toHaveLength(12);
  });
});

describe("disclosure restriction — 07 §7.14", () => {
  it("a released or superseded restriction is final", () => {
    expect(disclosureRestrictionMachine.transitions.released).toEqual([]);
    expect(disclosureRestrictionMachine.transitions.superseded).toEqual([]);
  });

  it("only an active restriction can be released", () => {
    expect(canTransition(disclosureRestrictionMachine, "draft", "released")).toBe(false);
    expect(canTransition(disclosureRestrictionMachine, "active", "released")).toBe(true);
  });
});
