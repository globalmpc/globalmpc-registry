import { isEoaAnchorEligibleChainId } from "@mpc/domain";

/**
 * Anchor transaction state transitions — spec 06 §6.8, 08 §8.9.
 *
 * Computes only "observed facts → next state", with no IO. Mixing in RPC or DB makes hard-to-
 * reproduce cases such as reorgs untestable.
 *
 * Three core rules.
 *
 * 1. **`included` is not success.** Being in a block differs from being confirmed. Only after
 *    the confirmation depth is met does it become `confirmed`, and only then is the public
 *    proof included=true.
 * 2. **Transitions can go backward.** A reorg reverses confirmation. A forward-only state machine
 *    would leave a vanished block recorded as confirmed.
 * 3. **A revert is not retried.** What the contract rejected stays rejected on resend. It is
 *    distinct from submission failures such as insufficient gas or a nonce conflict.
 */

export type TransactionState =
  | "created"
  /** Only a Safe proposal exists. Nothing is on chain yet. */
  | "proposed"
  | "signed"
  | "submitted"
  | "included"
  | "confirmed"
  | "replaced"
  | "reverted"
  | "reorged"
  | "dropped"
  | "failed"
  | "reconciliation_required";

/** A fact observed on chain. Distinguishes "absent" from "failed". */
export type Observation =
  | { readonly kind: "pending" }
  /** A receipt exists. status decides success or failure. */
  | {
      readonly kind: "receipt";
      readonly status: "success" | "reverted";
      readonly blockNumber: number;
      readonly blockHash: string;
      /**
       * Gas actually burned and the gas price paid.
       *
       * Not optional — the daily cap (O1) sums their product to decide. If they could be
       * absent, a receipt would count as 0 and the cap would stay open forever.
       * A `reverted` receipt still burns gas, so both are taken regardless of status.
       */
      readonly gasUsed: bigint;
      readonly effectiveGasPrice: bigint;
      /**
       * L1 data fee (wei) charged on top of `gasUsed × effectiveGasPrice` — the receipt's `l1Fee`
       * on OP-stack chains such as opBNB, 0 elsewhere. It follows the L1 gas price, not the L2
       * one; left out, the daily cap would undercount every send by it.
       */
      readonly l1Fee: bigint;
      /**
       * `RootSubmitted` logs in this transaction with the address that emitted each, lowercase.
       *
       * A successful receipt alone does not say the root was stored: a Safe `execTransaction`
       * whose inner call failed succeeds anyway, emitting `ExecutionFailure`. Only this log,
       * emitted by the contract the transaction was recorded against, says it stored the batch.
       */
      readonly rootSubmissions: readonly {
        readonly contract: string;
        readonly batchId: string;
        readonly root: string;
      }[];
    }
  /** Submitted, but the node does not know the transaction — it may have left the mempool. */
  | { readonly kind: "unknown" };

export interface TrackInput {
  readonly state: TransactionState;
  readonly recordedBlockNumber: number | null;
  readonly recordedBlockHash: string | null;
  readonly observation: Observation;
  readonly headBlockNumber: number;
  readonly confirmationDepth: number;
  /**
   * The block the RPC reports for `ANCHOR_FINALITY_TAG` (`safe` or `finalized`); null when the
   * tag is `none`. A receipt's block must be at or below it, as well as `confirmationDepth` deep.
   */
  readonly finalizedBlockNumber: number | null;
  /** Time since submission (ms). Used to decide a mempool drop. */
  readonly elapsedSinceSubmitMs: number;
  readonly dropTimeoutMs: number;
}

export interface TrackResult {
  readonly nextState: TransactionState;
  readonly confirmations: number;
  readonly blockNumber: number | null;
  readonly blockHash: string | null;
  /** Whether the state went backward. Decides whether to record a reorg. */
  readonly reorged: boolean;
  readonly reason: string;
}

export function confirmationsOf(blockNumber: number, headBlockNumber: number): number {
  // The containing block counts as 1 confirmation. head == blockNumber gives 1.
  return Math.max(0, headBlockNumber - blockNumber + 1);
}

/**
 * Computes the next state from an observation.
 *
 * Transactions already in a terminal state (except `confirmed`) are left alone. `confirmed` can
 * be overturned by a reorg, so it stays under observation.
 */
export function trackTransaction(input: TrackInput): TrackResult {
  const keep = (reason: string): TrackResult => ({
    nextState: input.state,
    confirmations: 0,
    blockNumber: input.recordedBlockNumber,
    blockHash: input.recordedBlockHash,
    reorged: false,
    reason,
  });

  if (
    input.state === "reverted" ||
    input.state === "replaced" ||
    input.state === "dropped" ||
    input.state === "failed"
  ) {
    return keep("terminal");
  }

  if (input.observation.kind === "receipt") {
    const { status, blockNumber, blockHash } = input.observation;

    if (status === "reverted") {
      // The contract rejected it. Resending the same payload gives the same result.
      return {
        nextState: "reverted",
        confirmations: 0,
        blockNumber,
        blockHash,
        reorged: false,
        reason: "execution_reverted",
      };
    }

    // If the same transaction shows up in a different block, the previously seen block is gone.
    const reorged =
      input.recordedBlockHash !== null && input.recordedBlockHash !== blockHash;

    const confirmations = confirmationsOf(blockNumber, input.headBlockNumber);
    const deepEnough = confirmations >= input.confirmationDepth;
    // Depth alone is a block count, and block counts differ in time: 12 blocks are 3 s on opBNB.
    // The node's safe or finalized head is the chain's own statement that the block stays.
    const final = input.finalizedBlockNumber === null || blockNumber <= input.finalizedBlockNumber;
    const confirmed = deepEnough && final;

    return {
      // Recompute the state even on re-confirmation after a reorg. Below the confirmation depth
      // or above the finalized head it returns to included — never keep confirmed while only
      // swapping the block.
      nextState: confirmed ? "confirmed" : "included",
      confirmations,
      blockNumber,
      blockHash,
      reorged,
      reason: reorged
        ? "reorg_reobserved"
        : confirmed
          ? "confirmed"
          : deepEnough
            ? "awaiting_finality"
            : "included",
    };
  }

  if (input.observation.kind === "unknown") {
    // What was seen as confirmed is gone. Reconciliation is required; no automatic rollback.
    if (input.state === "confirmed" || input.state === "included") {
      return {
        nextState: "reconciliation_required",
        confirmations: 0,
        blockNumber: null,
        blockHash: null,
        reorged: true,
        reason: "observed_block_disappeared",
      };
    }

    if (input.elapsedSinceSubmitMs >= input.dropTimeoutMs) {
      // Treat it as dropped from the mempool. A human decides on resubmission — automatic
      // resubmission risks anchoring the same root twice.
      return {
        nextState: "dropped",
        confirmations: 0,
        blockNumber: null,
        blockHash: null,
        reorged: false,
        reason: "not_found_after_timeout",
      };
    }

    return keep("not_found_yet");
  }

  // pending: the node knows the transaction but no block holds it.
  if (input.state === "confirmed" || input.state === "included") {
    // Its block was reorged out and it waits in the mempool to be mined again. Finality is
    // revoked and the reorg recorded; once mined again it climbs back through included.
    return {
      nextState: "submitted",
      confirmations: 0,
      blockNumber: null,
      blockHash: null,
      reorged: true,
      reason: "returned_to_mempool",
    };
  }

  return keep("pending");
}

/**
 * Pre-submission safety check.
 *
 * O1: the only thing this worker can lose is gas from the anchor signer wallet. With caps fixed
 * in code, a gas spike or endless retries cannot drain the wallet.
 *
 * **The three caps guard against different things.**
 *
 * - `feeCapWei` — gas price of **one** transaction. Do not submit during a spike.
 * - `maxAttempts` — retries for **one batch**. Never resubmit the same root endlessly.
 * - `dailySpendCapWei` — **daily total**. Even with both above honored, a steady stream of
 *   distinct batches drains the wallet. The loss cap O1 requires is this third one.
 */
export interface SubmitGuardInput {
  readonly chainId: number;
  readonly maxFeePerGas: bigint;
  readonly feeCapWei: bigint;
  readonly attempts: number;
  readonly maxAttempts: number;
  /** Chains that allow solo EOA submission. Elsewhere the Safe multisig submits. */
  readonly eoaAllowedChainIds: readonly number[];
  /** Safe multisig address. Receives proposals on chains where EOA submission is blocked. */
  readonly safeAddress: string | null;
  /** Total gas (wei) that may be burned per day. Set by the operator; no default. */
  readonly dailySpendCapWei: bigint;
  /** Gas (wei) already burned today (UTC). Counts only transactions with a receipt. */
  readonly spentTodayWei: bigint;
  /**
   * The most that sent transactions without a receipt can still burn (wei). Their gas is
   * committed but not yet in the ledger; leaving it out lets every worker spend the same headroom.
   */
  readonly inFlightMaxWei: bigint;
  /** Gas limit every send carries. With the fee ceiling it bounds what this send can burn. */
  readonly gasLimit: bigint;
  /**
   * Reserved L1 data fee for this send (wei): the oracle's quote with a margin on OP-stack
   * chains, 0 elsewhere. Charged on top of gas, so gas limit × fee alone does not bound the send.
   */
  readonly l1FeeBoundWei: bigint;
}

/**
 * Submission mode.
 *
 * - `eoa` — the worker signs and sends directly. Local chain, or the opBNB testnet when opted in;
 *   never mainnet (`ANCHOR_EOA_CHAIN_IDS`).
 * - `safe_proposal` — creates a proposal only; does not execute. Humans collect signatures and
 *   execute in Safe. **A created proposal is not a submission.**
 * - `blocked` — neither is possible.
 */
export type SubmitGuard =
  | { readonly allow: true; readonly via: "eoa" }
  | { readonly allow: true; readonly via: "safe_proposal" }
  | { readonly allow: false; readonly reason: string };

/**
 * Whether the worker may sign alone on this chain.
 *
 * Eligibility is checked here again, not only at startup: the mainnet rule outranks whatever list
 * reaches this point, so a config path that skipped validation still cannot open it. The startup
 * log uses the same rule, so the mode it reports is the one the guard applies.
 */
export function eoaSubmissionAllowed(chainId: number, eoaAllowedChainIds: readonly number[]): boolean {
  return isEoaAnchorEligibleChainId(chainId) && eoaAllowedChainIds.includes(chainId);
}

export function checkSubmitAllowed(input: SubmitGuardInput): SubmitGuard {
  if (!eoaSubmissionAllowed(input.chainId, input.eoaAllowedChainIds)) {
    // The Safe multisig holds the contract's ANCHOR_SUBMITTER_ROLE. Direct EOA submission is
    // for the local chain and opted-in testnets only, and must never open in prod.
    //
    // With a Safe address configured, create a proposal. Without one nothing can be done, and
    // that fact is not left silent.
    if (input.safeAddress) {
      return { allow: true, via: "safe_proposal" };
    }
    return {
      allow: false,
      reason: `EOA_SUBMISSION_NOT_ALLOWED_ON_CHAIN_${input.chainId}`,
    };
  }

  // Check the daily cap before the fee cap. When both trip, the recorded reason must be the
  // loss cap — FEE_ABOVE_CAP clears when fees drop, but the daily cap does not. If the last
  // reason the operator sees is the milder one, it reads as "just wait for fees".
  //
  // The cap holds only if the check counts what can still be burned, not just what has been:
  // spent today + the most in-flight sends can burn + the most this send can burn (gas and, on
  // OP-stack chains, the reserved L1 data fee). Checking spend
  // alone let a send go out one wei under the cap and burn a full transaction past it.
  //
  // This send is projected at no more than the fee cap. Above it nothing is sent anyway, and the
  // daily reason should mean "no budget left at any allowed price", not "fees spiked".
  const feeCeiling =
    input.maxFeePerGas < input.feeCapWei ? input.maxFeePerGas : input.feeCapWei;
  const projectedWei =
    input.spentTodayWei + input.inFlightMaxWei + input.gasLimit * feeCeiling + input.l1FeeBoundWei;
  if (projectedWei > input.dailySpendCapWei) {
    return { allow: false, reason: "DAILY_SPEND_CAP_REACHED" };
  }

  if (input.maxFeePerGas > input.feeCapWei) {
    return { allow: false, reason: "FEE_ABOVE_CAP" };
  }

  if (input.attempts >= input.maxAttempts) {
    return { allow: false, reason: "MAX_ATTEMPTS_REACHED" };
  }

  return { allow: true, via: "eoa" };
}
