import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  checkSubmitAllowed,
  trackTransaction,
  type Observation,
  type TransactionState,
} from "./anchor-state.js";

/**
 * Anchor batch chain submission — spec 06 §6.8, 08 §8.9.
 *
 * The API creates the batch and leaves a `created` row in `chain.transactions`. Actual submission
 * happens here. Writing to the chain during request handling ties response time to chain state
 * and risks anchoring the same root twice on retry.
 *
 * What this module guarantees:
 *
 * - **A batch is submitted only once.** `intent_key` is UNIQUE, and rows are locked with
 *   `FOR UPDATE SKIP LOCKED`, so multiple workers never duplicate.
 * - **Submission and confirmation are separate steps.** A successful submission is only
 *   `submitted`; it becomes `confirmed` once the confirmation depth is met.
 * - **State is not only pushed forward.** A reorg reverses confirmation and is recorded.
 * - **The signing key never leaves this process.** It is never logged either.
 */

export interface ChainClient {
  /** Current head block number. */
  headBlockNumber(): Promise<number>;
  /** Estimated gas fee. Used for the cap check. */
  estimateMaxFeePerGas(): Promise<bigint>;
  /** Calls `submitRoot`. Returns the transaction hash. */
  submitRoot(input: SubmitRootInput): Promise<string>;
  /**
   * Builds `submitRoot` calldata. Used when proposing to Safe.
   *
   * Kept separate from submission because a proposal is not an execution. A single function
   * would invite the mistake "proposed, so it's on chain".
   */
  encodeSubmitRoot(input: SubmitRootInput): { calldata: string; calldataHash: string };
  /** Receipt lookup. `unknown` if absent, `pending` if still in the mempool. */
  observe(txHash: string): Promise<Observation>;
}

export interface SubmitRootInput {
  readonly batchId: string;
  readonly root: string;
  readonly manifestHash: string;
  readonly schemaVersion: string;
  readonly recordCount: number;
}

export interface SubmitterConfig {
  readonly chainId: number;
  readonly contractAddress: string;
  readonly confirmationDepth: number;
  readonly feeCapWei: bigint;
  readonly maxAttempts: number;
  readonly dropTimeoutMs: number;
  /**
   * Total gas (wei) that may be burned per day.
   *
   * Even with the per-tx cap (`feeCapWei`) and retry cap (`maxAttempts`) honored, a steady
   * stream of batches drains the wallet. The loss cap O1 requires is this daily total.
   */
  readonly dailySpendCapWei: bigint;
  readonly eoaAllowedChainIds: readonly number[];
  /** Safe multisig address. Receives proposals on chains where EOA submission is blocked. */
  readonly safeAddress: string | null;
  /** How long to watch for reorgs after confirmation. Past it, the row leaves the watch set. */
  readonly reorgWatchMs: number;
  /** Minimum interval before rechecking the same transaction. */
  readonly recheckIntervalMs: number;
}

/**
 * Safe proposal interface.
 *
 * The worker only uploads proposals and reads back execution results. Safe owners execute —
 * that separation is the basis for "not even MPC can change it alone".
 */
export interface SafeProposer {
  nextNonce(safeAddress: string): Promise<number>;
  propose(input: {
    safeAddress: string;
    to: string;
    data: string;
    nonce: number;
  }): Promise<{ safeTxHash: string; nonce: number }>;
  status(safeTxHash: string): Promise<
    | { kind: "pending"; confirmations: number; threshold: number }
    | { kind: "executed"; transactionHash: string }
    | { kind: "rejected" }
    | { kind: "unknown" }
  >;
}

export type Log = (record: Record<string, unknown>) => void;

interface PendingRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly batch_id: string | null;
  readonly state: TransactionState;
  readonly tx_hash: string | null;
  readonly block_number: string | null;
  readonly block_hash: string | null;
  readonly attempts: number;
  readonly submitted_at: Date | null;
  readonly external_batch_id: string | null;
  readonly merkle_root: string | null;
  readonly manifest_hash: string | null;
  readonly schema_version: string | null;
  readonly record_count: number | null;
}

/**
 * Locks one transaction to process.
 *
 * `SKIP LOCKED` skips rows another worker holds. Without locking, two workers submit the same
 * batch and spend gas twice.
 *
 * **Confirmed rows must not starve pending ones.** `confirmed` is also watched for reorgs, but
 * picking strictly oldest-first keeps re-picking confirmed rows and later `created` rows never
 * get submitted. Rows needing progress come first; confirmed rows are taken only once their
 * recheck interval has passed.
 *
 * Watching is not forever either. Some time after confirmation the chance of a reorg is
 * effectively gone, so the row leaves the set — otherwise the loop slows as confirmed rows pile up.
 */
async function claimPending(
  tx: postgres.TransactionSql,
  chainId: number,
  reorgWatchMs: number,
  recheckIntervalMs: number,
): Promise<PendingRow | undefined> {
  const [row] = await tx<PendingRow[]>`
    SELECT t.id, t.tenant_id, t.batch_id, t.state, t.tx_hash,
           t.block_number, t.block_hash, t.attempts, t.submitted_at,
           b.batch_id AS external_batch_id, b.merkle_root, b.manifest_hash,
           b.schema_version, b.record_count
    FROM chain.transactions t
    LEFT JOIN chain.anchor_batches b ON b.id = t.batch_id
    -- Pick only this chain's transactions. Without the filter a testnet worker looks up
    -- mainnet transactions on its own RPC and judges them "not found".
    -- proposed is not picked. Until Safe executes it there is no transaction on chain, and a
    -- lookup would judge it "not found" and wrongly mark it dropped.
    WHERE t.chain_id = ${chainId}
      AND (
        t.state IN ('created', 'submitted', 'included')
        OR (
          t.state = 'confirmed'
          AND t.confirmed_at > now() - ${`${Math.round(reorgWatchMs / 1000)} seconds`}::interval
          AND t.updated_at < now() - ${`${Math.round(recheckIntervalMs / 1000)} seconds`}::interval
        )
      )
    -- Rows needing progress first. Rechecks of confirmed rows come after.
    ORDER BY (t.state = 'confirmed'), t.created_at
    FOR UPDATE OF t SKIP LOCKED
    LIMIT 1
  `;
  return row;
}

export interface StepResult {
  readonly handled: boolean;
  readonly transactionId?: string;
  readonly from?: TransactionState;
  readonly to?: TransactionState;
  readonly reason?: string;
}

/**
 * Advances one transaction by one step.
 *
 * Handles one at a time, each in its own DB transaction. Bundling several into one transaction
 * lets one RPC failure roll back the progress of the rest.
 */
export async function stepOnce(
  sql: postgres.Sql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  safe?: SafeProposer,
): Promise<StepResult> {
  // Proposal status is checked outside the DB transaction. Wrapping an external service call in
  // a transaction keeps rows locked for its full latency.
  const proposalResult = safe ? await trackProposals(sql, config, safe, log) : null;
  if (proposalResult?.handled) return proposalResult;

  return sql.begin(async (tx) => {
    const row = await claimPending(
      tx,
      config.chainId,
      config.reorgWatchMs,
      config.recheckIntervalMs,
    );
    if (!row) return { handled: false };

    if (row.state === "created") {
      return submitPending(tx, chain, config, log, row, safe);
    }

    return trackPending(tx, chain, config, log, row);
  }) as Promise<StepResult>;
}

/**
 * Checks whether an uploaded proposal has been executed.
 *
 * Once Safe owners sign and execute, the result appears as a chain transaction. From then on it
 * follows the same tracking path as any transaction — confirmation depth and reorg watch apply
 * equally.
 */
async function trackProposals(
  sql: postgres.Sql,
  config: SubmitterConfig,
  safe: SafeProposer,
  log: Log,
): Promise<StepResult> {
  const [proposal] = await sql<
    { id: string; transaction_id: string; safe_tx_hash: string | null }[]
  >`
    SELECT p.id, p.transaction_id, p.safe_tx_hash
    FROM chain.anchor_proposals p
    JOIN chain.transactions t ON t.id = p.transaction_id
    WHERE p.state = 'proposed' AND p.chain_id = ${config.chainId}
      AND p.safe_tx_hash IS NOT NULL
    ORDER BY p.created_at
    LIMIT 1
  `;

  if (!proposal?.safe_tx_hash) return { handled: false };

  const status = await safe.status(proposal.safe_tx_hash);

  if (status.kind === "executed") {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE chain.anchor_proposals
        SET state = 'executed', resolved_at = now()
        WHERE id = ${proposal.id}
      `;
      // From here it follows the regular tracking path. Confirmation depth and reorg watch apply
      // equally — execution via Safe does not exempt it from confirmation.
      await tx`
        UPDATE chain.transactions
        SET state = 'submitted', tx_hash = ${status.transactionHash},
            submitted_at = now(), updated_at = now()
        WHERE id = ${proposal.transaction_id}
      `;
    });

    log({
      level: "info",
      msg: "anchor.proposal.executed",
      proposalId: proposal.id,
      txHash: status.transactionHash,
    });
    return {
      handled: true,
      transactionId: proposal.transaction_id,
      from: "proposed",
      to: "submitted",
    };
  }

  if (status.kind === "rejected") {
    await sql`
      UPDATE chain.anchor_proposals
      SET state = 'rejected', resolved_at = now()
      WHERE id = ${proposal.id}
    `;
    // The transaction does not go back to created. Re-uploading without checking why it was
    // rejected gets it rejected again for the same reason.
    await sql`
      UPDATE chain.transactions
      SET state = 'failed', last_error = 'safe_proposal_rejected', updated_at = now()
      WHERE id = ${proposal.transaction_id}
    `;
    log({ level: "warn", msg: "anchor.proposal.rejected", proposalId: proposal.id });
    return { handled: true, transactionId: proposal.transaction_id, from: "proposed", to: "failed" };
  }

  // pending and unknown are left as is. Signatures are still being collected or the service has
  // not propagated yet; either way there is nothing for us to do.
  return { handled: false };
}

/**
 * Total gas burned on this chain today (UTC).
 *
 * **Counts only transactions with a receipt.** A submitted transaction not yet in a block has no
 * known cost — exposure in that window is bounded by `feeCapWei` × `maxAttempts`.
 *
 * Counts across tenants. The wallet is one, not split per tenant.
 *
 * The day boundary is UTC. Following the server timezone would silently shift when the cap
 * reopens whenever the deployment location changes.
 */
export async function spentTodayWei(
  sql: postgres.Sql | postgres.TransactionSql,
  chainId: number,
): Promise<bigint> {
  const [row] = await sql<{ spent: string }[]>`
    SELECT COALESCE(SUM(gas_used::NUMERIC * effective_gas_price), 0)::TEXT AS spent
    FROM chain.transactions
    WHERE chain_id = ${chainId}
      AND gas_used IS NOT NULL
      AND effective_gas_price IS NOT NULL
      AND submitted_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  return BigInt(row?.spent ?? "0");
}

async function submitPending(
  tx: postgres.TransactionSql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
  safe?: SafeProposer,
): Promise<StepResult> {
  if (!row.external_batch_id || !row.merkle_root || !row.manifest_hash || !row.record_count) {
    // A transaction without a batch has nothing to submit. Silent retries would loop forever.
    await fail(tx, row.id, "BATCH_MISSING");
    return { handled: true, transactionId: row.id, from: row.state, to: "failed" };
  }

  const [maxFeePerGas, spentToday] = await Promise.all([
    chain.estimateMaxFeePerGas(),
    spentTodayWei(tx, config.chainId),
  ]);
  const guard = checkSubmitAllowed({
    chainId: config.chainId,
    maxFeePerGas,
    feeCapWei: config.feeCapWei,
    attempts: row.attempts,
    maxAttempts: config.maxAttempts,
    eoaAllowedChainIds: config.eoaAllowedChainIds,
    safeAddress: config.safeAddress,
    dailySpendCapWei: config.dailySpendCapWei,
    spentTodayWei: spentToday,
  });

  if (!guard.allow) {
    // Record why it is blocked and keep the state. It proceeds on a later loop once conditions
    // change. Hitting the attempt cap never changes, though, so that ends as failed.
    if (guard.reason === "MAX_ATTEMPTS_REACHED") {
      await fail(tx, row.id, guard.reason);
      return { handled: true, transactionId: row.id, from: row.state, to: "failed" };
    }

    await tx`
      UPDATE chain.transactions
      SET last_error = ${guard.reason}, updated_at = now()
      WHERE id = ${row.id}
    `;
    log({ level: "warn", msg: "anchor.submit.blocked", transactionId: row.id, reason: guard.reason });
    return { handled: true, transactionId: row.id, from: row.state, to: row.state, reason: guard.reason };
  }

  if (guard.via === "safe_proposal") {
    return proposeToSafe(tx, chain, config, log, row, safe);
  }

  // Increment attempts **before** submitting. If the process crashes after submission, the count
  // survives and prevents endless retries. One attempt too few is safer than mistaking a
  // successful submission for a failure — a duplicate submission of the same root burns gas.
  await tx`
    UPDATE chain.transactions
    SET attempts = attempts + 1, updated_at = now()
    WHERE id = ${row.id}
  `;

  try {
    const txHash = await chain.submitRoot({
      batchId: row.external_batch_id,
      root: row.merkle_root,
      manifestHash: row.manifest_hash,
      schemaVersion: row.schema_version ?? "1",
      recordCount: row.record_count,
    });

    await tx`
      UPDATE chain.transactions
      SET state = 'submitted', tx_hash = ${txHash},
          contract_address = ${config.contractAddress.toLowerCase()},
          submitted_at = now(), last_error = NULL, updated_at = now()
      WHERE id = ${row.id}
    `;

    log({ level: "info", msg: "anchor.submitted", transactionId: row.id, txHash });
    return { handled: true, transactionId: row.id, from: "created", to: "submitted" };
  } catch (error) {
    // A submission failure is retried. The state stays created.
    const message = String(error).slice(0, 500);
    await tx`
      UPDATE chain.transactions
      SET last_error = ${message}, updated_at = now()
      WHERE id = ${row.id}
    `;
    log({ level: "error", msg: "anchor.submit.failed", transactionId: row.id, error: message });
    return { handled: true, transactionId: row.id, from: "created", to: "created", reason: "submit_failed" };
  }
}

/**
 * Creates a Safe proposal only.
 *
 * **Does not execute.** Humans collect signatures and execute on the Safe side. Keeping the
 * state at `proposed` rather than `submitted` preserves that fact — marking it submitted would
 * wait forever for the receipt of a transaction that does not exist.
 */
async function proposeToSafe(
  tx: postgres.TransactionSql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
  safe?: SafeProposer,
): Promise<StepResult> {
  const { calldata, calldataHash } = chain.encodeSubmitRoot({
    batchId: row.external_batch_id!,
    root: row.merkle_root!,
    manifestHash: row.manifest_hash!,
    schemaVersion: row.schema_version ?? "1",
    recordCount: row.record_count!,
  });

  // Only one active proposal exists (partial UNIQUE in 0014). With two, signers would not know
  // which to execute, and executing both anchors the same root twice.
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM chain.anchor_proposals
    WHERE transaction_id = ${row.id} AND state = 'proposed'
  `;

  if (existing) {
    return { handled: true, transactionId: row.id, from: row.state, to: "proposed", reason: "already_proposed" };
  }

  // Actually upload to the Safe service. On failure nothing is written to the DB either — a
  // proposal marked `proposed` that never got uploaded would look like it awaits signatures.
  let safeTxHash: string | null = null;
  if (safe) {
    try {
      const nonce = await safe.nextNonce(config.safeAddress!);
      const proposed = await safe.propose({
        safeAddress: config.safeAddress!,
        to: config.contractAddress,
        data: calldata,
        nonce,
      });
      safeTxHash = proposed.safeTxHash;
    } catch (error) {
      const message = String(error).slice(0, 500);
      await tx`
        UPDATE chain.transactions
        SET last_error = ${`safe_propose_failed: ${message}`}, updated_at = now()
        WHERE id = ${row.id}
      `;
      log({ level: "error", msg: "anchor.propose.failed", transactionId: row.id, error: message });
      return { handled: true, transactionId: row.id, from: row.state, to: row.state, reason: "propose_failed" };
    }
  }

  const proposalId = randomUUID();
  await tx`
    INSERT INTO chain.anchor_proposals (
      id, tenant_id, transaction_id, chain_id, safe_address,
      contract_address, calldata, calldata_hash, safe_tx_hash
    ) VALUES (
      ${proposalId}, ${row.tenant_id}, ${row.id}, ${config.chainId},
      ${config.safeAddress!.toLowerCase()}, ${config.contractAddress.toLowerCase()},
      ${calldata}, ${calldataHash}, ${safeTxHash}
    )
  `;

  await tx`
    UPDATE chain.transactions
    SET state = 'proposed',
        contract_address = ${config.contractAddress.toLowerCase()},
        last_error = NULL, updated_at = now()
    WHERE id = ${row.id}
  `;

  log({
    level: "info",
    msg: "anchor.proposed",
    transactionId: row.id,
    proposalId,
    safeAddress: config.safeAddress,
    // Value signers compare against what they see in the Safe UI.
    calldataHash,
    safeTxHash,
  });

  return { handled: true, transactionId: row.id, from: "created", to: "proposed", reason: "safe_proposal_created" };
}

async function trackPending(
  tx: postgres.TransactionSql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
): Promise<StepResult> {
  if (!row.tx_hash) {
    await fail(tx, row.id, "TX_HASH_MISSING");
    return { handled: true, transactionId: row.id, from: row.state, to: "failed" };
  }

  const [observation, headBlockNumber] = await Promise.all([
    chain.observe(row.tx_hash),
    chain.headBlockNumber(),
  ]);

  if (observation.kind === "receipt") {
    // Record the cost even when the observation does not change the state. A branch below
    // ("nothing changed: stamp the time and return") would otherwise skip recording the cost
    // despite a receipt, and the daily cap would see 0 and stay open forever.
    //
    // When a resubmission yields a new receipt, the last value wins — gas burned by an
    // overturned attempt is not in this sum. That window is bounded by the retry cap.
    await tx`
      UPDATE chain.transactions
      SET gas_used = ${observation.gasUsed.toString()},
          effective_gas_price = ${observation.effectiveGasPrice.toString()}
      WHERE id = ${row.id}
    `;
  }

  const result = trackTransaction({
    state: row.state,
    recordedBlockNumber: row.block_number ? Number(row.block_number) : null,
    recordedBlockHash: row.block_hash,
    observation,
    headBlockNumber,
    confirmationDepth: config.confirmationDepth,
    elapsedSinceSubmitMs: row.submitted_at ? Date.now() - row.submitted_at.getTime() : 0,
    dropTimeoutMs: config.dropTimeoutMs,
  });

  if (result.reorged && row.block_number && row.block_hash) {
    // An overturned confirmation is kept, never deleted. Even if resubmission restores the same
    // result, the fact that it flipped once is itself evidence for judging reliability.
    await tx`
      INSERT INTO chain.reorg_events (
        id, tenant_id, transaction_id, previous_block_number,
        previous_block_hash, detected_state
      ) VALUES (
        ${randomUUID()}, ${row.tenant_id}, ${row.id}, ${row.block_number},
        ${row.block_hash}, ${row.state}
      )
    `;
    log({
      level: "warn",
      msg: "anchor.reorg.detected",
      transactionId: row.id,
      previousBlockHash: row.block_hash,
      newBlockHash: result.blockHash,
    });
  }

  if (result.nextState === row.state && result.blockHash === row.block_hash) {
    // Stamp the check time even when nothing changed. Otherwise the same row is re-picked
    // immediately and pending rows behind it never progress.
    await tx`UPDATE chain.transactions SET updated_at = now() WHERE id = ${row.id}`;
    return { handled: true, transactionId: row.id, from: row.state, to: row.state, reason: result.reason };
  }

  await tx`
    UPDATE chain.transactions
    SET state = ${result.nextState},
        block_number = ${result.blockNumber},
        block_hash = ${result.blockHash},
        confirmations = ${result.confirmations},
        confirmed_at = ${result.nextState === "confirmed" ? tx`now()` : null},
        updated_at = now()
    WHERE id = ${row.id}
  `;

  log({
    level: "info",
    msg: "anchor.state.changed",
    transactionId: row.id,
    from: row.state,
    to: result.nextState,
    confirmations: result.confirmations,
    reason: result.reason,
  });

  return {
    handled: true,
    transactionId: row.id,
    from: row.state,
    to: result.nextState,
    reason: result.reason,
  };
}

async function fail(
  tx: postgres.TransactionSql,
  id: string,
  reason: string,
): Promise<void> {
  await tx`
    UPDATE chain.transactions
    SET state = 'failed', last_error = ${reason}, updated_at = now()
    WHERE id = ${id}
  `;
}

/** Stats on in-flight transactions. For observability only; never used for decisions. */
export async function chainBacklog(
  sql: postgres.Sql,
  chainId: number,
): Promise<{
  readonly pending: number;
  /** Only proposed to Safe. Not submitted. */
  readonly proposed: number;
  readonly submitted: number;
  readonly confirmed: number;
  readonly needsAttention: number;
}> {
  const [row] = await sql<
    {
      pending: string;
      proposed: string;
      submitted: string;
      confirmed: string;
      needs_attention: string;
    }[]
  >`
    SELECT
      count(*) FILTER (WHERE state = 'created') AS pending,
      count(*) FILTER (WHERE state = 'proposed') AS proposed,
      count(*) FILTER (WHERE state IN ('submitted', 'included')) AS submitted,
      count(*) FILTER (WHERE state = 'confirmed') AS confirmed,
      count(*) FILTER (WHERE state IN ('failed', 'reverted', 'dropped', 'reconciliation_required'))
        AS needs_attention
    FROM chain.transactions
    WHERE chain_id = ${chainId}
  `;

  return {
    pending: Number(row?.pending ?? 0),
    proposed: Number(row?.proposed ?? 0),
    submitted: Number(row?.submitted ?? 0),
    confirmed: Number(row?.confirmed ?? 0),
    needsAttention: Number(row?.needs_attention ?? 0),
  };
}
