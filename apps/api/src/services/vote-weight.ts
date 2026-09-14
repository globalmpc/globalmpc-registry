import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { unprocessable } from "../errors.js";

/**
 * Vote weight — spec 04 §4.5.
 *
 * Weight is **the on-chain balance at voting start**. Taking it from the request body lets the
 * voter set their own weight — a declaration, not a vote.
 *
 * Why the moment is pinned:
 *
 *   1. Tokens cannot be bought mid-vote to increase weight.
 *   2. The same tokens cannot be moved across wallets to vote multiple times.
 *   3. Re-tallying at any time gives the same result.
 *
 * Snapshot lookups require an archive node. Re-reading on every tally ties the result to node
 * state, so it is read once and stored.
 */

/**
 * Balance lookup.
 *
 * Why it is injected: the token contract does not exist yet (pre-R4), and past blocks cannot be
 * read without an archive node. Tests must reproduce both situations.
 */
export type BalanceReader = (input: {
  readonly tokenAddress: string;
  readonly walletAddress: string;
  readonly blockNumber: number;
}) => Promise<bigint>;

export interface SnapshotConfig {
  /** Token contract. Absent means no snapshot is taken. */
  readonly tokenAddress: string | null;
  readonly chainId: number;
}

export interface WeightResult {
  readonly weight: bigint;
  /** Where the weight came from. The screen must disclose this. */
  readonly source: "onchain_snapshot" | "manual";
  readonly blockNumber: number | null;
}

/**
 * Determines a voter's weight.
 *
 * An existing snapshot is reused — reading twice can yield different values if blocks were
 * reorganized in between.
 *
 * Without a configured token it falls back to `manual`. **That fact is not hidden** —
 * results tallied with manual weight must not be read as on-chain evidence.
 */
export async function resolveVoteWeight(
  tx: postgres.TransactionSql,
  input: {
    readonly tenantId: string;
    readonly proposalId: string;
    readonly walletAddress: string;
    readonly snapshotBlock: number | null;
    readonly snapshotTokenAddress: string | null;
    readonly manualWeight: string | null;
  },
  readBalance: BalanceReader,
): Promise<WeightResult> {
  // Not a snapshot target means manual weight. Without a value, voting is not possible.
  if (!input.snapshotBlock || !input.snapshotTokenAddress) {
    if (input.manualWeight === null) {
      throw unprocessable(
        "VOTE_WEIGHT_REQUIRED",
        "Weight must be specified directly for proposals without an on-chain snapshot",
      );
    }
    return { weight: BigInt(input.manualWeight), source: "manual", blockNumber: null };
  }

  const [existing] = await tx<{ weight: string; block_number: string }[]>`
    SELECT weight::text, block_number::text FROM core.governance_vote_weights
    WHERE proposal_id = ${input.proposalId} AND wallet_address = ${input.walletAddress}
  `;

  if (existing) {
    return {
      weight: BigInt(existing.weight),
      source: "onchain_snapshot",
      blockNumber: Number(existing.block_number),
    };
  }

  let weight: bigint;
  try {
    weight = await readBalance({
      tokenAddress: input.snapshotTokenAddress,
      walletAddress: input.walletAddress,
      blockNumber: input.snapshotBlock,
    });
  } catch (error) {
    // Do not read a failed lookup as a zero balance. 0 is the fact "holds no tokens", while
    // failure is "unknown"; recording the former silently takes away voting power.
    throw unprocessable("VOTE_WEIGHT_UNAVAILABLE", "Could not read the balance at the snapshot block", {
      blockNumber: String(input.snapshotBlock),
      reason: String(error).slice(0, 200),
    });
  }

  await tx`
    INSERT INTO core.governance_vote_weights (
      id, tenant_id, proposal_id, wallet_address, weight, block_number
    ) VALUES (
      ${randomUUID()}, ${input.tenantId}, ${input.proposalId}, ${input.walletAddress},
      ${weight.toString()}, ${input.snapshotBlock}
    )
    ON CONFLICT (proposal_id, wallet_address) DO NOTHING
  `;

  return { weight, source: "onchain_snapshot", blockNumber: input.snapshotBlock };
}

/**
 * Pins the snapshot block at voting start.
 *
 * Uses a **finalized block**, not the head. The head can be reorganized, taking away the
 * weight basis of votes already cast.
 */
export function snapshotBlockFor(headBlock: number, confirmationDepth: number): number {
  return Math.max(0, headBlock - confirmationDepth);
}
