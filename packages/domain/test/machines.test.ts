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

describe("모든 상태기계의 정합성", () => {
  // 12개 기계는 각자 다른 상태 유니온을 갖는다. 전수 검사에서는 문자열 기계로
  // 다뤄야 하므로 여기서 한 번만 넓힌다.
  const machines: StateMachine<string>[] = ALL_MACHINES.map(
    (machine) => machine as unknown as StateMachine<string>,
  );

  for (const machine of machines) {
    it(`${machine.name}: 전이표와 states가 일치한다`, () => {
      expect(() => validateMachine(machine)).not.toThrow();
    });

    it(`${machine.name}: initial에서 도달 불가능한 상태가 없다`, () => {
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
  it("정상 경로", () => {
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

  it("draft에서 offering_open으로 건너뛸 수 없다", () => {
    expect(canTransition(atLifecycleMachine, "draft", "offering_open")).toBe(false);
  });

  it("registered에서 active로 건너뛸 수 없다 — offering 단계를 우회할 수 없다", () => {
    expect(canTransition(atLifecycleMachine, "registered", "active")).toBe(false);
  });

  it("retired는 terminal이다", () => {
    expect(atLifecycleMachine.transitions.retired).toEqual([]);
  });

  it("draft는 suspend할 수 없다 — 정지할 대상이 없다", () => {
    expect(canTransition(atLifecycleMachine, "draft", "suspended")).toBe(false);
  });

  it("suspendable 상태는 모두 suspended로 갈 수 있다", () => {
    for (const state of SUSPENDABLE_STATES) {
      expect(canTransition(atLifecycleMachine, state, "suspended")).toBe(true);
    }
  });

  it("assertTransition은 금지 전이에서 예외를 던진다", () => {
    expect(() => assertTransition(atLifecycleMachine, "draft", "active")).toThrowError(
      InvalidTransitionError,
    );
  });
});

describe("suspension 복귀 — 이전 상태 또는 closure만", () => {
  it("이전 상태로 복귀한다", () => {
    expect(resumeFromSuspension("active", "active")).toBe(true);
  });

  it("closure로 갈 수 있다", () => {
    expect(resumeFromSuspension("active", "closure")).toBe(true);
  });

  it("다른 상태로는 복귀할 수 없다 — suspension이 상태 세탁 수단이 되면 안 된다", () => {
    expect(resumeFromSuspension("registered", "active")).toBe(false);
    expect(resumeFromSuspension("offering_open", "offering_closed")).toBe(false);
  });
});

describe("Verification Case — 서명 이후 immutability", () => {
  it("signed에서 in_review로 돌아갈 수 없다", () => {
    expect(canTransition(verificationCaseMachine, "signed", "in_review")).toBe(false);
  });

  it("signed에서 changes_requested로 갈 수 없다", () => {
    expect(canTransition(verificationCaseMachine, "signed", "changes_requested")).toBe(false);
  });

  it("정정은 revoke 또는 supersede로만 한다", () => {
    expect(canTransition(verificationCaseMachine, "signed", "revoked")).toBe(true);
    expect(canTransition(verificationCaseMachine, "signed", "superseded")).toBe(true);
  });

  it("changes_requested ↔ in_review는 서명 전에만 왕복 가능하다", () => {
    expect(canTransition(verificationCaseMachine, "in_review", "changes_requested")).toBe(true);
    expect(canTransition(verificationCaseMachine, "changes_requested", "in_review")).toBe(true);
  });

  it("assigned를 건너뛰고 in_review로 갈 수 없다", () => {
    expect(canTransition(verificationCaseMachine, "draft", "in_review")).toBe(false);
  });
});

describe("Proposal — 투표 확정 후 취소 불가", () => {
  it("voting 이후 cancelled가 없다", () => {
    expect(canTransition(proposalMachine, "voting", "cancelled")).toBe(false);
    expect(canTransition(proposalMachine, "succeeded", "cancelled")).toBe(false);
  });

  it("voting 전에는 취소할 수 있다", () => {
    expect(canTransition(proposalMachine, "draft", "cancelled")).toBe(true);
    expect(canTransition(proposalMachine, "announced", "cancelled")).toBe(true);
  });

  it("AC-06 — 온체인 성공이 오프체인 집행 완료가 아니다", () => {
    // succeeded → 바로 executed로 갈 수 없다. timelock·record·execution_pending을 거친다.
    expect(canTransition(proposalMachine, "succeeded", "executed")).toBe(false);
    expect(canTransition(proposalMachine, "execution_pending", "executed")).toBe(true);
    expect(canTransition(proposalMachine, "execution_pending", "failed")).toBe(true);
    expect(canTransition(proposalMachine, "execution_pending", "disputed")).toBe(true);
  });

  it("timelock을 건너뛸 수 없다", () => {
    expect(canTransition(proposalMachine, "succeeded", "recorded")).toBe(false);
  });
});

describe("Attestation — stale은 되돌릴 수 있지만 revoke는 아니다", () => {
  it("stale_candidate에서 재검토 후 active로 복귀할 수 있다", () => {
    expect(canTransition(attestationMachine, "stale_candidate", "active")).toBe(true);
  });

  it("revoked는 terminal이다", () => {
    expect(attestationMachine.transitions.revoked).toEqual([]);
  });

  it("superseded는 terminal이다", () => {
    expect(attestationMachine.transitions.superseded).toEqual([]);
  });

  it("draft에서 active로 바로 갈 수 없다 — 서명을 건너뛸 수 없다", () => {
    expect(canTransition(attestationMachine, "draft", "active")).toBe(false);
  });
});

describe("Chain transaction — included는 성공이 아니다", () => {
  it("submitted에서 confirmed로 건너뛸 수 없다", () => {
    expect(canTransition(chainTransactionMachine, "submitted", "confirmed")).toBe(false);
  });

  it("included에서 confirmation depth 충족 후 confirmed가 된다", () => {
    expect(canTransition(chainTransactionMachine, "included", "confirmed")).toBe(true);
  });

  it("confirmed도 reorg될 수 있다", () => {
    expect(canTransition(chainTransactionMachine, "confirmed", "reorged")).toBe(true);
  });

  it("reorg는 재제출 또는 reconciliation으로 간다", () => {
    expect(canTransition(chainTransactionMachine, "reorged", "submitted")).toBe(true);
    expect(canTransition(chainTransactionMachine, "reorged", "reconciliation_required")).toBe(
      true,
    );
  });
});
