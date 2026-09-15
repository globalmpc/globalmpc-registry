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

describe("confirmations calculation", () => {
  it("is 1 when the block equals head", () => {
    expect(confirmationsOf(100, 100)).toBe(1);
  });

  it("is 0, not negative, when head lags", () => {
    // A node can briefly return a lagging response. Negative confirmations are meaningless.
    expect(confirmationsOf(105, 100)).toBe(0);
  });
});

describe("finality judgment", () => {
  it("is included when in a block but short of the required depth", () => {
    const result = track({ observation: receipt(100, BLOCK_A), headBlockNumber: 105 });
    expect(result.nextState).toBe("included");
    expect(result.confirmations).toBe(6);
  });

  it("is confirmed once the depth is reached", () => {
    const result = track({ observation: receipt(100, BLOCK_A), headBlockNumber: 111 });
    expect(result.nextState).toBe("confirmed");
    expect(result.confirmations).toBe(12);
  });

  it("does not treat included as success", () => {
    // 06 §6.8: block inclusion and finality are different facts. If the distinction collapses, the
    // public proof presents a state that can still disappear (included) as true.
    const result = track({ observation: receipt(100, BLOCK_A), headBlockNumber: 100 });
    expect(result.nextState).not.toBe("confirmed");
  });
});

describe("revert", () => {
  it("is reverted and not retried when the contract rejects", () => {
    const result = track({ observation: receipt(100, BLOCK_A, "reverted"), headBlockNumber: 130 });
    expect(result.nextState).toBe("reverted");
    expect(result.reason).toBe("execution_reverted");
  });

  it("reverted does not change on later observations", () => {
    const result = track({
      state: "reverted",
      observation: receipt(100, BLOCK_A),
      headBlockNumber: 200,
    });
    expect(result.nextState).toBe("reverted");
  });
});

describe("reorg", () => {
  it("records a reorg when the same transaction appears in a different block", () => {
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

  it("finality is revoked when depth is short after a reorg", () => {
    // Changing only the block while keeping finality leaves a "confirmed" mark with no basis.
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

  it("revokes finality when a confirmed transaction is back in the mempool", () => {
    // Its block was reorged out and the transaction waits to be mined again. Keeping
    // "confirmed" would show a proof as final while no block holds it.
    const result = track({
      state: "confirmed",
      recordedBlockNumber: 100,
      recordedBlockHash: BLOCK_A,
      observation: { kind: "pending" },
      headBlockNumber: 200,
    });
    expect(result.nextState).toBe("submitted");
    expect(result.reorged).toBe(true);
    expect(result.blockHash).toBeNull();
  });

  it("an included transaction back in the mempool also returns to submitted", () => {
    const result = track({
      state: "included",
      recordedBlockNumber: 100,
      recordedBlockHash: BLOCK_A,
      observation: { kind: "pending" },
      headBlockNumber: 101,
    });
    expect(result.nextState).toBe("submitted");
    expect(result.reorged).toBe(true);
  });

  it("does not auto-recover when a transaction seen as confirmed disappears", () => {
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

describe("mempool drop", () => {
  it("not being visible right after submission is not a failure", () => {
    const result = track({
      observation: { kind: "unknown" },
      elapsedSinceSubmitMs: 5_000,
    });
    expect(result.nextState).toBe("submitted");
  });

  it("marks dropped after the timeout", () => {
    const result = track({
      observation: { kind: "unknown" },
      elapsedSinceSubmitMs: 11 * 60 * 1000,
    });
    expect(result.nextState).toBe("dropped");
  });

  it("dropped is not resubmitted automatically", () => {
    // Submitting the same root twice makes the contract reject with BatchAlreadyExists, but gas is
    // still spent. A person decides on resubmission.
    const result = track({
      state: "dropped",
      observation: { kind: "pending" },
    });
    expect(result.nextState).toBe("dropped");
  });
});

describe("submission safety check (O1)", () => {
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

  it("submits via EOA on an allowed chain within the cap", () => {
    expect(checkSubmitAllowed(base)).toEqual({ allow: true, via: "eoa" });
  });

  it("does nothing on mainnet without a Safe", () => {
    // The Safe multisig holds the contract's ANCHOR_SUBMITTER_ROLE. If the worker could submit alone,
    // that design would be pointless.
    const result = checkSubmitAllowed({ ...base, chainId: 56 });
    expect(result.allow).toBe(false);
  });

  it("only creates a proposal on mainnet with a Safe", () => {
    // A proposal is not execution. People collect signatures and execute on the Safe side.
    const result = checkSubmitAllowed({
      ...base,
      chainId: 56,
      safeAddress: `0x${"ab".repeat(20)}`,
    });
    expect(result).toEqual({ allow: true, via: "safe_proposal" });
  });

  it("ignores the gas cap on the Safe path", () => {
    // Creating a proposal costs no gas. The Safe sets the fee at execution time.
    const result = checkSubmitAllowed({
      ...base,
      chainId: 56,
      safeAddress: `0x${"ab".repeat(20)}`,
      maxFeePerGas: 999_000_000_000n,
    });
    expect(result).toEqual({ allow: true, via: "safe_proposal" });
  });

  it("does not submit above the gas cap", () => {
    const result = checkSubmitAllowed({ ...base, maxFeePerGas: 500_000_000_000n });
    expect(result).toEqual({ allow: false, reason: "FEE_ABOVE_CAP" });
  });

  it("stops at the retry cap", () => {
    // Unlimited retries drain the gas wallet. That wallet is O1's loss cap.
    const result = checkSubmitAllowed({ ...base, attempts: 3 });
    expect(result).toEqual({ allow: false, reason: "MAX_ATTEMPTS_REACHED" });
  });

  it("submits when today's spend is below the cap", () => {
    const result = checkSubmitAllowed({ ...base, spentTodayWei: 999_999_999_999_999n });
    expect(result).toEqual({ allow: true, via: "eoa" });
  });

  it("does not submit once today's spend reaches the cap", () => {
    // O1's loss cap is this wallet. A per-tx gas cap alone does not bound the daily total — even
    // fees within the cap drain the wallet when repeated.
    const result = checkSubmitAllowed({ ...base, spentTodayWei: 1_000_000_000_000_000n });
    expect(result).toEqual({ allow: false, reason: "DAILY_SPEND_CAP_REACHED" });
  });

  it("blocks even when already over the cap", () => {
    const result = checkSubmitAllowed({ ...base, spentTodayWei: 5_000_000_000_000_000n });
    expect(result).toEqual({ allow: false, reason: "DAILY_SPEND_CAP_REACHED" });
  });

  it("the daily cap is judged before the gas cap", () => {
    // When both apply, the recorded reason must be the loss cap. Unlike FEE_ABOVE_CAP, which clears
    // when fees drop, the daily cap clears only when the date changes.
    const result = checkSubmitAllowed({
      ...base,
      maxFeePerGas: 500_000_000_000n,
      spentTodayWei: 1_000_000_000_000_000n,
    });
    expect(result).toEqual({ allow: false, reason: "DAILY_SPEND_CAP_REACHED" });
  });

  it("ignores the daily cap on the Safe path", () => {
    // A proposal spends no gas from our wallet. The Safe owner executes it.
    const result = checkSubmitAllowed({
      ...base,
      chainId: 56,
      safeAddress: `0x${"ab".repeat(20)}`,
      spentTodayWei: 5_000_000_000_000_000n,
    });
    expect(result).toEqual({ allow: true, via: "safe_proposal" });
  });
});
