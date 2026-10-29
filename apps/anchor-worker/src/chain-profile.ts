import {
  BSC_MAINNET_CHAIN_ID,
  LOCAL_CHAIN_ID,
  OPBNB_TESTNET_CHAIN_ID,
  type SupportedChainId,
} from "@mpc/domain";

/**
 * What the anchor worker must know about each supported chain beyond its id.
 *
 * Kept as one table keyed by every supported chain, so adding a chain to `SUPPORTED_CHAIN_IDS`
 * fails to compile until someone decides these values for it. A missing entry would otherwise
 * fall back to whatever the code assumed for the chains it was written against.
 */

/**
 * Block tag a receipt's block must be at or below before it is `confirmed`.
 *
 * - `safe` — the node's safe head. On opBNB the block's batch is on BSC; on BSC it is fast-
 *   finality justified.
 * - `finalized` — the node's finalized head. Slower; no weaker anywhere.
 * - `none` — only `ANCHOR_CONFIRMATIONS` counts.
 */
export type FinalityTag = "safe" | "finalized" | "none";

export const FINALITY_TAGS: readonly FinalityTag[] = ["safe", "finalized", "none"];

export function isFinalityTag(value: unknown): value is FinalityTag {
  return typeof value === "string" && (FINALITY_TAGS as readonly string[]).includes(value);
}

interface ChainProfile {
  /** Default `ANCHOR_FINALITY_TAG`. */
  readonly finalityTag: FinalityTag;
  /**
   * Whether a transaction also pays an L1 data fee, charged outside `gasUsed × effectiveGasPrice`
   * and reported as the receipt's `l1Fee` (OP-stack chains).
   */
  readonly l1DataFee: boolean;
  /**
   * Block interval (ms), rounded down. Only sizes the `RootSubmitted` log search: rounding
   * down searches more blocks, never fewer.
   */
  readonly blockIntervalMs: number;
}

const PROFILES: Readonly<Record<SupportedChainId, ChainProfile>> = {
  // BSC fast finality: safe and finalized trail the head by about one block (measured
  // 2026-10-29), so the tag costs nothing and covers a reorg past 12 blocks. Not OP-stack: no
  // L1 data fee. Blocks measured at 0.45 s.
  [BSC_MAINNET_CHAIN_ID]: { finalityTag: "safe", l1DataFee: false, blockIntervalMs: 450 },
  // opBNB testnet: 0.25 s blocks, so `ANCHOR_CONFIRMATIONS=12` is 3 s. The safe head — blocks
  // whose batch is posted on BSC — trailed by ~50 blocks (~13 s) when measured. Every receipt
  // carries `l1Fee`, the share for posting the batch.
  [OPBNB_TESTNET_CHAIN_ID]: { finalityTag: "safe", l1DataFee: true, blockIntervalMs: 250 },
  // anvil reports safe and finalized 32 and 64 blocks behind its head — with 1 s blocks, a
  // minute of waiting in every e2e run for a chain nobody can reorg against our will. Its
  // automining makes the interval meaningless; 1 s sizes the search like before.
  [LOCAL_CHAIN_ID]: { finalityTag: "none", l1DataFee: false, blockIntervalMs: 1000 },
};

function profileOf(chainId: number): ChainProfile {
  const profile = (PROFILES as Record<number, ChainProfile>)[chainId];
  // Config validation admits only supported chains; reaching here otherwise is a code path that
  // skipped it, and guessing a profile would guess the spend cap and finality.
  if (!profile) throw new Error(`No anchor chain profile for chain ${chainId}`);
  return profile;
}

export function defaultFinalityTag(chainId: number): FinalityTag {
  return profileOf(chainId).finalityTag;
}

export function chargesL1DataFee(chainId: number): boolean {
  return profileOf(chainId).l1DataFee;
}

/**
 * OP-stack `GasPriceOracle` predeploy. `getL1Fee(bytes)` prices a transaction's L1 data fee at
 * the current L1 base fee.
 */
export const GAS_PRICE_ORACLE_ADDRESS = "0x420000000000000000000000000000000000000F";

/**
 * Margin on the oracle's L1 fee quote when reserving it for a send in flight.
 *
 * Unlike gas limit × max fee, the quote is not a ceiling the transaction signs: the fee is
 * charged at the L1 base fee in force when the block is built. Doubling provides headroom but
 * cannot bound a larger rise before inclusion. Actual spend can exceed the daily admission
 * budget; the signer wallet's funded balance must bound the intended loss separately. The
 * receipt's actual `l1Fee` replaces the reservation.
 */
export const L1_FEE_RESERVE_MULTIPLIER = 2n;

/**
 * How far back the worker looks for a batch's `RootSubmitted` log by default: a day.
 *
 * The search runs when the chain holds a batch the worker has no hash for — a send whose answer
 * was lost, found again on the next attempt, or a resubmission an operator starts hours later.
 * A fixed block count meant very different spans: 5,000 blocks were 83 minutes on anvil's 1 s
 * blocks, 21 minutes on opBNB. A missed log costs a person's attention, not funds, but a day
 * covers an operator's resubmission.
 */
const DEFAULT_LOG_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export function defaultLogLookbackBlocks(chainId: number): number {
  return Math.ceil(DEFAULT_LOG_LOOKBACK_MS / profileOf(chainId).blockIntervalMs);
}

/**
 * Blocks per `eth_getLogs` call. Public endpoints refuse wide ranges; 5,000 is accepted by the
 * common ones, so a long lookback goes out as several calls of this size.
 */
export const LOG_SEARCH_CHUNK_BLOCKS = 5_000;
