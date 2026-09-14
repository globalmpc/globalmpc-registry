import { describe, expect, it } from "vitest";
import {
  checkSubmitAllowed,
  confirmationsOf,
  trackTransaction,
  type Observation,
  type TrackInput,
} from "../src/anchor-state.js";

const BLOCK_A = `0x${"a1".repeat(32)}`;
const BLOCK_B = `0x${"b2".repeat(32)}`;

function track(overrides: Partial<TrackInput> = {}) {
  const base: TrackInput = {
    state: "submitted",
    recordedBlockNumber: null,
    recordedBlockHash: null,
    observation: { kind: "pending" },
    headBlockNumber: 100,
    confirmationDepth: 12,
    elapsedSinceSubmitMs: 0,
    dropTimeoutMs: 10 * 60 * 1000,
  };
  return trackTransaction({ ...base, ...overrides });
}

const receipt = (
  blockNumber: number,
  blockHash: string,
  status: "success" | "reverted" = "success",
): Observation => ({
  kind: "receipt",
  status,
  blockNumber,
  blockHash,
  gasUsed: 100_000n,
  effectiveGasPrice: 1_000_000_000n,
});

describe("confirmations 계산", () => {
  it("head와 같은 블록이면 1이다", () => {
    expect(confirmationsOf(100, 100)).toBe(1);
  });

  it("head가 뒤처지면 음수가 아니라 0이다", () => {
    // 노드가 잠시 뒤처진 응답을 줄 수 있다. 음수 confirmation은 의미가 없다.
    expect(confirmationsOf(105, 100)).toBe(0);
  });
});

describe("확정 판정", () => {
  it("블록에 들어가도 깊이를 못 채우면 included다", () => {
    const result = track({ observation: receipt(100, BLOCK_A), headBlockNumber: 105 });
    expect(result.nextState).toBe("included");
    expect(result.confirmations).toBe(6);
  });

  it("깊이를 채우면 confirmed다", () => {
    const result = track({ observation: receipt(100, BLOCK_A), headBlockNumber: 111 });
    expect(result.nextState).toBe("confirmed");
    expect(result.confirmations).toBe(12);
  });

  it("included를 성공으로 취급하지 않는다", () => {
    // 06 §6.8: 블록 포함과 확정은 다른 사실이다. 이 구분이 무너지면 공개 증명의
    // included가 사라질 수 있는 상태를 참으로 보여준다.
    const result = track({ observation: receipt(100, BLOCK_A), headBlockNumber: 100 });
    expect(result.nextState).not.toBe("confirmed");
  });
});

describe("revert", () => {
  it("컨트랙트가 거절하면 reverted이고 재시도 대상이 아니다", () => {
    const result = track({ observation: receipt(100, BLOCK_A, "reverted"), headBlockNumber: 130 });
    expect(result.nextState).toBe("reverted");
    expect(result.reason).toBe("execution_reverted");
  });

  it("reverted는 이후 관측으로 바뀌지 않는다", () => {
    const result = track({
      state: "reverted",
      observation: receipt(100, BLOCK_A),
      headBlockNumber: 200,
    });
    expect(result.nextState).toBe("reverted");
  });
});

describe("reorg", () => {
  it("같은 트랜잭션이 다른 블록에서 보이면 reorg로 기록한다", () => {
    const result = track({
      state: "confirmed",
      recordedBlockNumber: 100,
      recordedBlockHash: BLOCK_A,
      observation: receipt(101, BLOCK_B),
      headBlockNumber: 200,
    });
    expect(result.reorged).toBe(true);
    expect(result.blockHash).toBe(BLOCK_B);
  });

  it("reorg 후 깊이를 못 채우면 확정이 취소된다", () => {
    // 확정을 유지한 채 블록만 바꾸면 "확정됐다"는 표시가 근거 없이 남는다.
    const result = track({
      state: "confirmed",
      recordedBlockNumber: 100,
      recordedBlockHash: BLOCK_A,
      observation: receipt(150, BLOCK_B),
      headBlockNumber: 152,
    });
    expect(result.nextState).toBe("included");
    expect(result.reorged).toBe(true);
  });

  it("확정으로 봤던 트랜잭션이 사라지면 자동 복구하지 않는다", () => {
    const result = track({
      state: "confirmed",
      recordedBlockNumber: 100,
      recordedBlockHash: BLOCK_A,
      observation: { kind: "unknown" },
      headBlockNumber: 200,
    });
    expect(result.nextState).toBe("reconciliation_required");
    expect(result.reorged).toBe(true);
  });
});

describe("mempool 이탈", () => {
  it("제출 직후 안 보이는 것은 실패가 아니다", () => {
    const result = track({
      observation: { kind: "unknown" },
      elapsedSinceSubmitMs: 5_000,
    });
    expect(result.nextState).toBe("submitted");
  });

  it("타임아웃을 넘으면 dropped로 표시한다", () => {
    const result = track({
      observation: { kind: "unknown" },
      elapsedSinceSubmitMs: 11 * 60 * 1000,
    });
    expect(result.nextState).toBe("dropped");
  });

  it("dropped는 자동 재제출되지 않는다", () => {
    // 같은 root를 두 번 올리면 컨트랙트가 BatchAlreadyExists로 거절하지만,
    // 가스는 소모된다. 재제출 판단은 사람이 한다.
    const result = track({
      state: "dropped",
      observation: { kind: "pending" },
    });
    expect(result.nextState).toBe("dropped");
  });
});

describe("제출 안전 점검 (O1)", () => {
  const base = {
    chainId: 31337,
    maxFeePerGas: 1_000_000_000n,
    feeCapWei: 100_000_000_000n,
    attempts: 0,
    maxAttempts: 3,
    eoaAllowedChainIds: [31337, 97],
    safeAddress: null,
    dailySpendCapWei: 1_000_000_000_000_000n,
    spentTodayWei: 0n,
  };

  it("허용된 체인에서 상한 안이면 EOA로 제출한다", () => {
    expect(checkSubmitAllowed(base)).toEqual({ allow: true, via: "eoa" });
  });

  it("mainnet에서 Safe가 없으면 아무것도 하지 않는다", () => {
    // 컨트랙트의 ANCHOR_SUBMITTER_ROLE은 Safe multisig가 보유한다. worker가
    // 단독으로 올릴 수 있으면 그 설계가 무의미해진다.
    const result = checkSubmitAllowed({ ...base, chainId: 56 });
    expect(result.allow).toBe(false);
  });

  it("mainnet에서 Safe가 있으면 제안만 만든다", () => {
    // 제안은 실행이 아니다. 서명 수집과 실행은 Safe 쪽에서 사람이 한다.
    const result = checkSubmitAllowed({
      ...base,
      chainId: 56,
      safeAddress: `0x${"ab".repeat(20)}`,
    });
    expect(result).toEqual({ allow: true, via: "safe_proposal" });
  });

  it("Safe 경로에서는 가스 상한을 보지 않는다", () => {
    // 제안을 만드는 데는 가스가 들지 않는다. 실행 시점의 요금은 Safe가 정한다.
    const result = checkSubmitAllowed({
      ...base,
      chainId: 56,
      safeAddress: `0x${"ab".repeat(20)}`,
      maxFeePerGas: 999_000_000_000n,
    });
    expect(result).toEqual({ allow: true, via: "safe_proposal" });
  });

  it("가스 상한을 넘으면 제출하지 않는다", () => {
    const result = checkSubmitAllowed({ ...base, maxFeePerGas: 500_000_000_000n });
    expect(result).toEqual({ allow: false, reason: "FEE_ABOVE_CAP" });
  });

  it("재시도 상한에 닿으면 멈춘다", () => {
    // 무한 재시도는 가스 지갑을 비운다. O1의 손실 상한이 이 지갑이다.
    const result = checkSubmitAllowed({ ...base, attempts: 3 });
    expect(result).toEqual({ allow: false, reason: "MAX_ATTEMPTS_REACHED" });
  });

  it("오늘 쓴 금액이 상한 미만이면 제출한다", () => {
    const result = checkSubmitAllowed({ ...base, spentTodayWei: 999_999_999_999_999n });
    expect(result).toEqual({ allow: true, via: "eoa" });
  });

  it("오늘 쓴 금액이 상한에 닿으면 제출하지 않는다", () => {
    // O1의 손실 상한은 이 지갑이다. per-tx 가스 상한만으로는 하루 총량이 묶이지
    // 않는다 — 상한 안의 요금이라도 반복하면 지갑이 빈다.
    const result = checkSubmitAllowed({ ...base, spentTodayWei: 1_000_000_000_000_000n });
    expect(result).toEqual({ allow: false, reason: "DAILY_SPEND_CAP_REACHED" });
  });

  it("상한을 이미 넘어선 상태에서도 막는다", () => {
    const result = checkSubmitAllowed({ ...base, spentTodayWei: 5_000_000_000_000_000n });
    expect(result).toEqual({ allow: false, reason: "DAILY_SPEND_CAP_REACHED" });
  });

  it("일일 상한이 가스 상한보다 먼저 판정된다", () => {
    // 둘 다 걸릴 때 남는 이유는 손실 상한 쪽이어야 한다. 요금이 내려가면 풀리는
    // FEE_ABOVE_CAP과 달리 일일 상한은 날짜가 바뀌어야 풀린다.
    const result = checkSubmitAllowed({
      ...base,
      maxFeePerGas: 500_000_000_000n,
      spentTodayWei: 1_000_000_000_000_000n,
    });
    expect(result).toEqual({ allow: false, reason: "DAILY_SPEND_CAP_REACHED" });
  });

  it("Safe 경로에서는 일일 상한을 보지 않는다", () => {
    // 제안은 우리 지갑의 가스를 쓰지 않는다. 실행하는 것은 Safe owner다.
    const result = checkSubmitAllowed({
      ...base,
      chainId: 56,
      safeAddress: `0x${"ab".repeat(20)}`,
      spentTodayWei: 5_000_000_000_000_000n,
    });
    expect(result).toEqual({ allow: true, via: "safe_proposal" });
  });
});
