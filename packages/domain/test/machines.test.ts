import { describe, expect, it } from "vitest";
import {
  ALL_MACHINES,
  SUSPENDABLE_STATES,
  atLifecycleMachine,
  attestationMachine,
  chainTransactionMachine,
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
  // The 12 machines each have a different state union. The exhaustive check must treat them as
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

  it("superseded is terminal", () => {
    expect(attestationMachine.transitions.superseded).toEqual([]);
  });

  it("cannot go from draft straight to active — signing cannot be skipped", () => {
    expect(canTransition(attestationMachine, "draft", "active")).toBe(false);
  });
});

describe("Chain transaction — included is not success", () => {
  it("cannot skip from submitted to confirmed", () => {
    expect(canTransition(chainTransactionMachine, "submitted", "confirmed")).toBe(false);
  });

  it("included becomes confirmed after confirmation depth is met", () => {
    expect(canTransition(chainTransactionMachine, "included", "confirmed")).toBe(true);
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
});
