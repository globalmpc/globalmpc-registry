import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  checkSubmitAllowed,
  eoaSubmissionAllowed,
  trackTransaction,
  type Observation,
  type TransactionState,
} from "./anchor-state.js";
import { redactUrls } from "./redact-urls.js";
import type { FinalityTag } from "./chain-profile.js";

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
  /**
   * The block the node reports for `tag`. A failed read throws: without it nothing may be
   * confirmed, so the caller waits rather than falling back to depth alone.
   */
  finalizedBlockNumber(tag: Exclude<FinalityTag, "none">): Promise<number>;
  /** Current fee quote. Checked against the cap, then sent unchanged. */
  estimateFees(): Promise<FeeQuote>;
  /**
   * The L1 data fee to reserve for this send (wei), margin included; 0 on chains without one.
   * A failed quote throws: on a chain that charges it, sending unreserved would let the cap
   * undercount.
   */
  l1FeeBound(input: SendRootInput): Promise<bigint>;
  /**
   * Builds and signs a `submitRoot` transaction without sending it.
   *
   * Signs with `fees` and `gasLimit` as given — what passed the cap check. Estimating again would
   * let a fee spike between the check and the send slip past the cap. Signing apart from sending
   * gives the hash and nonce first, so the send is in the ledger before it can reach the network.
   */
  prepareSubmitRoot(input: SendRootInput): Promise<PreparedSend>;
  /** Sends a prepared transaction. Returns its hash. */
  broadcast(prepared: PreparedSend): Promise<string>;
  /**
   * The signer's transaction count at `blockNumber`: every nonce below it is taken by a mined
   * transaction. Asked at a block `confirmationDepth` deep so a reorg cannot free a nonce again.
   */
  confirmedNonce(address: string, blockNumber: number): Promise<number>;
  /** Gas limit of the latest block — the most any one transaction can burn in gas. */
  blockGasLimit(): Promise<bigint>;
  /**
   * What `contractAddress` already holds for `batchId` (`getBatch`), with the hash of the
   * transaction that stored it when a completed search finds its `RootSubmitted` log. null if the
   * batch is not on that contract. A failed read, or a search that could not finish, throws.
   *
   * The answer to a lost send result: a timeout or crash after the node accepted the transaction
   * leaves no hash in the DB, and sending again would anchor nothing new and burn gas.
   */
  anchoredBatch(batchId: string, contractAddress: string): Promise<AnchoredBatch | null>;
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

/**
 * Fee quote (wei per gas).
 *
 * Carries the transaction type with the numbers. Nodes without EIP-1559 quote a single gas
 * price; sending that as `maxFeePerGas` would build an EIP-1559 transaction, which viem refuses
 * on such a node (`Eip1559FeesNotSupportedError`). The EIP-1559 pair is sent whole, so what goes
 * out is exactly what the cap judged.
 */
export type FeeQuote =
  | { readonly type: "eip1559"; readonly maxFeePerGas: bigint; readonly maxPriorityFeePerGas: bigint }
  | { readonly type: "legacy"; readonly gasPrice: bigint };

/** The most one gas unit can cost under this quote — what the per-tx fee cap judges. */
export function feeCeilingOf(quote: FeeQuote): bigint {
  return quote.type === "eip1559" ? quote.maxFeePerGas : quote.gasPrice;
}

export interface SendRootInput extends SubmitRootInput {
  /** Already checked against `feeCapWei`. */
  readonly fees: FeeQuote;
  /**
   * Sent as the transaction's gas limit. Left to estimation, a send's cost has no bound until its
   * receipt, and the daily cap could not reserve it while it is in flight.
   */
  readonly gasLimit: bigint;
}

/** A signed, not yet sent, `submitRoot` transaction. */
export interface PreparedSend {
  readonly txHash: string;
  /** Signer address, lowercase. */
  readonly from: string;
  readonly nonce: number;
  readonly gasLimit: bigint;
  /** The most one gas unit can cost — `feeCeilingOf` the quote it was signed with. */
  readonly maxFeePerGas: bigint;
  /** The signed transaction. Opaque to the submitter; only `broadcast` reads it. */
  readonly raw: unknown;
}

export interface AnchoredBatch {
  readonly root: string;
  /** null when a completed search found no `RootSubmitted` log within the lookback range. */
  readonly txHash: string | null;
}

export interface SubmitterConfig {
  readonly chainId: number;
  readonly contractAddress: string;
  readonly confirmationDepth: number;
  readonly feeCapWei: bigint;
  readonly maxAttempts: number;
  readonly dropTimeoutMs: number;
  /**
   * Daily admission budget (wei), counting receipts and open fee reservations. OP-stack L1
   * reservations are estimates, so actual spend can exceed this value. Limit the funded wallet
   * balance separately; never use automatic refills to turn this budget into a loss guarantee.
   */
  readonly dailySpendCapWei: bigint;
  /**
   * Gas limit on every send. Gas limit × fee cap is the most one send can burn — what the daily
   * cap reserves for each transaction still waiting for its receipt.
   */
  readonly gasLimit: bigint;
  readonly eoaAllowedChainIds: readonly number[];
  /** Safe multisig address. Receives proposals on chains where EOA submission is blocked. */
  readonly safeAddress: string | null;
  /** How long to watch for reorgs after confirmation. Past it, the row leaves the watch set. */
  readonly reorgWatchMs: number;
  /** Minimum interval before rechecking the same transaction. */
  readonly recheckIntervalMs: number;
  /**
   * Block tag a receipt's block must also be at or below before `confirmed`, and before a nonce
   * read there settles a send (`ANCHOR_FINALITY_TAG`). `none`: depth alone.
   */
  readonly finalityTag: FinalityTag;
  /**
   * How long a row whose chain search failed stays unclaimed before it is searched again
   * (`ANCHOR_CHAIN_SEARCH_RETRY_MS`). The failing row steps aside meanwhile, so later rows on the
   * chain are not held behind it, and a public endpoint is not asked the whole search every poll.
   */
  readonly chainSearchRetryMs: number;
  /**
   * How long chain searches for one row may keep failing, from the first failure, before the row
   * goes to `reconciliation_required` with `chain_search_unavailable`
   * (`ANCHOR_CHAIN_SEARCH_GIVE_UP_MS`). A provider that can never finish the search — a smaller
   * `eth_getLogs` range limit, pruned history, a lasting rate limit — then reaches a person.
   */
  readonly chainSearchGiveUpMs: number;
  /**
   * The RPC endpoint. Used only to mask it out of stored errors — hosted endpoints carry the API
   * key in the URL, and stored errors are served by the API.
   */
  readonly rpcUrl?: string;
}

/**
 * Error text safe to store in `last_error` and log: URLs masked, then capped at 500 characters.
 * Masking comes first so the cap cannot cut a URL into a piece the pattern no longer matches.
 */
function errorText(config: SubmitterConfig, prefix: string | null, error: unknown): string {
  const text = redactUrls(String(error), [config.rpcUrl]);
  return (prefix ? `${prefix}: ${text}` : text).slice(0, 500);
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
    | { kind: "replaced"; replacedBy: string }
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
  /** The contract recorded with `tx_hash` (0101); NULL on rows recorded before that, or unsent. */
  readonly contract_address: string | null;
  /** When the current run of failed chain searches began (0102); NULL while none is failing. */
  readonly chain_search_failed_since: Date | null;
}

/**
 * The contract a hashed row's transaction is judged against: the one recorded with its hash.
 *
 * Not the current configuration — after `ANCHOR_CONTRACT_ADDRESS` moves to a new version, a send
 * to the old contract still in flight, a confirmed row inside the reorg watch, or a Safe proposal
 * built for the old contract and executed later all stored their root on the old one. Only a row
 * recorded before the worker stored the contract has none; it falls back to the configuration,
 * which is what it was judged against when it was sent.
 */
function trackedContractOf(row: PendingRow, config: SubmitterConfig): string {
  return (row.contract_address ?? config.contractAddress).toLowerCase();
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
           b.schema_version, b.record_count, t.contract_address, t.chain_search_failed_since
    FROM chain.transactions t
    LEFT JOIN chain.anchor_batches b ON b.id = t.batch_id
    -- Pick only this chain's transactions. Without the filter a worker on one chain looks up
    -- another chain's transactions on its own RPC and judges them "not found".
    -- proposed is not picked. Until Safe executes it there is no transaction on chain, and a
    -- lookup would judge it "not found" and wrongly mark it dropped.
    WHERE t.chain_id = ${chainId}
      -- A row whose chain search failed waits out its retry delay. Picked oldest-first, it would
      -- otherwise be claimed again on every pass and hold back every row behind it.
      AND (t.retry_after IS NULL OR t.retry_after <= now())
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
    -- NO KEY UPDATE, not UPDATE: still exclusive between workers, but it lets the send ledger's
    -- foreign key check on this row pass while the send is recorded on another connection.
    FOR NO KEY UPDATE OF t SKIP LOCKED
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
  /**
   * A row was looked at but nothing moved: the step waits on an outside condition — a cap, the
   * chain, the Safe service. Retrying at once changes nothing and only repeats RPC calls and
   * UPDATEs, so the loop backs off.
   */
  readonly waiting?: boolean;
}

/**
 * Whether the loop should sleep before the next step.
 *
 * Only a step that moved something runs the next one at once. Blocked outcomes — daily cap, fee
 * cap, a failed send or proposal, a transaction still pending — would otherwise spin until the
 * condition clears (for the daily cap, until UTC midnight).
 */
export function shouldBackOff(result: StepResult): boolean {
  return !result.handled || result.waiting === true;
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
  await settleSends(sql, chain, config, log);

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
      return submitPending(sql, tx, chain, config, log, row, safe);
    }

    return trackPending(tx, chain, config, log, row);
  }) as Promise<StepResult>;
}

/** Proposals read back per pass. Bounded so one pass stays short; the rest rotate in next. */
const PROPOSALS_PER_PASS = 10;

interface OpenProposal {
  readonly id: string;
  readonly transaction_id: string;
  readonly safe_tx_hash: string;
  /** The proposal's target: the contract the executed Safe transaction calls. */
  readonly contract_address: string;
}

/**
 * Checks whether uploaded proposals have been executed.
 *
 * Once Safe owners sign and execute, the result appears as a chain transaction. From then on it
 * follows the same tracking path as any transaction — confirmation depth and reorg watch apply
 * equally.
 *
 * **Every open proposal is read back, not only the oldest.** The oldest can wait for signatures
 * indefinitely; reading only it would never notice that a later one was executed. Each proposal is
 * asked about at most once per `recheckIntervalMs` — the service is external and rate-limited.
 */
async function trackProposals(
  sql: postgres.Sql,
  config: SubmitterConfig,
  safe: SafeProposer,
  log: Log,
): Promise<StepResult> {
  const proposals = await sql<OpenProposal[]>`
    SELECT p.id, p.transaction_id, p.safe_tx_hash, p.contract_address
    FROM chain.anchor_proposals p
    JOIN chain.transactions t ON t.id = p.transaction_id
    WHERE p.state = 'proposed' AND p.chain_id = ${config.chainId}
      AND p.safe_tx_hash IS NOT NULL
      AND (
        p.checked_at IS NULL
        OR p.checked_at < now() - ${`${Math.round(config.recheckIntervalMs / 1000)} seconds`}::interval
      )
    -- Never-checked first, then least recently checked: every proposal gets its turn.
    ORDER BY p.checked_at NULLS FIRST, p.created_at
    LIMIT ${PROPOSALS_PER_PASS}
  `;

  const results: StepResult[] = [];
  for (const proposal of proposals) {
    results.push(await trackProposal(sql, safe, log, proposal));
  }
  return results.find((result) => result.handled) ?? { handled: false };
}

async function trackProposal(
  sql: postgres.Sql,
  safe: SafeProposer,
  log: Log,
  proposal: OpenProposal,
): Promise<StepResult> {
  const status = await safe.status(proposal.safe_tx_hash);
  await sql`UPDATE chain.anchor_proposals SET checked_at = now() WHERE id = ${proposal.id}`;

  if (status.kind === "executed") {
    await sql.begin(async (tx) => {
      await tx`
        UPDATE chain.anchor_proposals
        SET state = 'executed', resolved_at = now()
        WHERE id = ${proposal.id}
      `;
      // From here it follows the regular tracking path. Confirmation depth and reorg watch apply
      // equally — execution via Safe does not exempt it from confirmation.
      // The contract is the proposal's own target, recorded with the hash it produced — not
      // this worker's current configuration, which may have moved to another deployment since.
      await tx`
        UPDATE chain.transactions
        SET state = 'submitted', tx_hash = ${status.transactionHash},
            contract_address = ${proposal.contract_address},
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
    return closeUnexecutable(sql, log, proposal, "safe_proposal_rejected");
  }

  if (status.kind === "replaced") {
    // Another transaction executed at this nonce — a rejection in the Safe UI, or another
    // proposal. This one can never execute; waiting on it would block forever.
    return closeUnexecutable(sql, log, proposal, "safe_proposal_replaced", {
      replacedBy: status.replacedBy,
    });
  }

  // pending and unknown are left as is. Signatures are still being collected or the service has
  // not propagated yet; either way there is nothing for us to do. A proposal that stays here too
  // long surfaces through the `anchor_proposal_oldest_age_seconds` gauge.
  return { handled: false };
}

/**
 * Ends a proposal that will never execute.
 *
 * The transaction does not go back to created. Re-uploading without checking why it was rejected
 * gets it rejected again for the same reason. `failed` raises the anchor failure alert, and an
 * operator resubmits through the API.
 */
async function closeUnexecutable(
  sql: postgres.Sql,
  log: Log,
  proposal: OpenProposal,
  reason: "safe_proposal_rejected" | "safe_proposal_replaced",
  detail: Record<string, unknown> = {},
): Promise<StepResult> {
  await sql.begin(async (tx) => {
    await tx`
      UPDATE chain.anchor_proposals
      SET state = 'rejected', resolved_at = now()
      WHERE id = ${proposal.id}
    `;
    await tx`
      UPDATE chain.transactions
      SET state = 'failed', last_error = ${reason}, updated_at = now()
      WHERE id = ${proposal.transaction_id}
    `;
  });
  log({ level: "warn", msg: "anchor.proposal.rejected", proposalId: proposal.id, reason, ...detail });
  return { handled: true, transactionId: proposal.transaction_id, from: "proposed", to: "failed" };
}

/**
 * Total gas burned on this chain today (UTC), with the L1 data fee on chains that charge one.
 *
 * **Counts only transactions with a receipt.** A submitted transaction not yet in a block has no
 * known cost; `inFlightSends` reserves its most until the receipt arrives.
 *
 * **Summed from the `chain.gas_spend` ledger, one row per mined transaction hash.** The columns on
 * `chain.transactions` describe only the latest attempt: a resubmission clears the row and the
 * next receipt overwrites it, so an earlier attempt's gas would drop out of the total.
 *
 * Counts across tenants. The wallet is one, not split per tenant.
 *
 * The day boundary is UTC and the day is the one the receipt was first seen. Following the server
 * timezone would silently shift when the cap reopens whenever the deployment location changes.
 */
export async function spentTodayWei(
  sql: postgres.Sql | postgres.TransactionSql,
  chainId: number,
): Promise<bigint> {
  const [row] = await sql<{ spent: string }[]>`
    SELECT COALESCE(SUM(gas_used * effective_gas_price + l1_fee), 0)::TEXT AS spent
    FROM chain.gas_spend
    WHERE chain_id = ${chainId}
      AND observed_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
  `;
  return BigInt(row?.spent ?? "0");
}

/**
 * What unsettled sends can still burn on this chain, from the send ledger.
 *
 * Every hash the signer signed is in `chain.anchor_sends` from before its broadcast until it is
 * settled — by its receipt, or by its nonce being taken by another transaction. Neither the state
 * of its `chain.transactions` row nor time settles it: a reset or dropped row's transaction can
 * still be mined. A row whose receipt is already in the gas ledger counts there instead.
 *
 * `bounded` sums gas limit × max fee, plus the reserved L1 data fee, for rows that recorded them. `unbounded` counts rows sent
 * before gas limits were fixed; the caller prices each at the block gas limit.
 */
export async function inFlightSends(
  sql: postgres.Sql | postgres.TransactionSql,
  chainId: number,
  feeCapWei: bigint,
): Promise<{ readonly boundedWei: bigint; readonly unbounded: number }> {
  const [row] = await sql<{ bounded: string; unbounded: string }[]>`
    SELECT
      COALESCE(
        SUM(
          s.gas_limit * COALESCE(s.max_fee_per_gas, ${feeCapWei.toString()}::NUMERIC)
            + s.l1_fee_bound
        ) FILTER (WHERE s.gas_limit IS NOT NULL),
        0
      )::TEXT AS bounded,
      count(*) FILTER (WHERE s.gas_limit IS NULL)::TEXT AS unbounded
    FROM chain.anchor_sends s
    WHERE s.chain_id = ${chainId}
      AND s.settled_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM chain.gas_spend g
        WHERE g.chain_id = s.chain_id AND g.tx_hash = s.tx_hash
      )
  `;
  return { boundedWei: BigInt(row?.bounded ?? "0"), unbounded: Number(row?.unbounded ?? 0) };
}

/**
 * Serializes the spend check and the send across workers on one chain.
 *
 * Each worker holds a different `created` row (SKIP LOCKED), so row locks do not stop two of them
 * from reading the same spend and both sending. This transaction-scoped lock is held from the
 * check until the send is recorded and committed; the next worker then sees it in flight. One
 * wallet signs for the chain, so sends are not parallel anyway.
 */
async function lockChainSpend(tx: postgres.TransactionSql, chainId: number): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`anchor-spend:${chainId}`}, 0))`;
}

async function submitPending(
  sql: postgres.Sql,
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

  // Taken before reading the spend, so the reads below see every send committed before it.
  await lockChainSpend(tx, config.chainId);

  const [feeResult, spentToday, inFlightRows] = await Promise.all([
    chain.estimateFees().then(
      (quote) => ({ quote }),
      (error: unknown) => ({ error }),
    ),
    spentTodayWei(tx, config.chainId),
    inFlightSends(tx, config.chainId, config.feeCapWei),
  ]);
  if ("error" in feeResult) {
    return recordFailedRead(tx, config, log, row, "fee_estimate_failed", feeResult.error);
  }
  // A send with no recorded gas limit is bounded only by the block. Without that bound the
  // check cannot be made, so the row waits rather than sending on a guess.
  let inFlight = inFlightRows.boundedWei;
  if (inFlightRows.unbounded > 0) {
    try {
      inFlight += BigInt(inFlightRows.unbounded) * (await chain.blockGasLimit()) * config.feeCapWei;
    } catch (error) {
      return recordFailedRead(tx, config, log, row, "block_gas_limit_failed", error);
    }
  }
  const fees = feeResult.quote;
  const sendInput: SendRootInput = {
    batchId: row.external_batch_id,
    root: row.merkle_root,
    manifestHash: row.manifest_hash,
    schemaVersion: row.schema_version ?? "1",
    recordCount: row.record_count,
    fees,
    gasLimit: config.gasLimit,
  };
  // Priced for exactly what will be signed: same calldata, fees and gas limit. Only a send this
  // wallet pays for is priced; a Safe proposal spends the executing owner's gas, and a failed
  // quote must not hold it back.
  let l1FeeBound = 0n;
  if (eoaSubmissionAllowed(config.chainId, config.eoaAllowedChainIds)) {
    try {
      l1FeeBound = await chain.l1FeeBound(sendInput);
    } catch (error) {
      return recordFailedRead(tx, config, log, row, "l1_fee_estimate_failed", error);
    }
  }
  const guardInput = {
    chainId: config.chainId,
    maxFeePerGas: feeCeilingOf(fees),
    feeCapWei: config.feeCapWei,
    attempts: row.attempts,
    maxAttempts: config.maxAttempts,
    eoaAllowedChainIds: config.eoaAllowedChainIds,
    safeAddress: config.safeAddress,
    dailySpendCapWei: config.dailySpendCapWei,
    spentTodayWei: spentToday,
    inFlightMaxWei: inFlight,
    gasLimit: config.gasLimit,
    l1FeeBoundWei: l1FeeBound,
  };
  const guard = checkSubmitAllowed(guardInput, "preflight");

  if (!guard.allow) {
    return recordSubmissionBlocked(tx, log, row, guard.reason);
  }

  if (guard.via === "safe_proposal") {
    return proposeToSafe(tx, chain, config, log, row, safe);
  }

  // An earlier attempt may be on chain although no hash was recorded: the send answer was lost
  // (timeout), or the process died before this transaction committed — the attempt count below
  // is rolled back with it. Ask the chain before sending again.
  const reconciled = await reconcileBeforeSend(tx, chain, config, log, row);
  if (reconciled) return reconciled;

  let prepared: PreparedSend;
  try {
    prepared = await chain.prepareSubmitRoot(sendInput);
  } catch (error) {
    await countSendAttempt(tx, row);
    return recordFailedSend(tx, config, log, row, error);
  }

  // Only a reservation for this exact transaction, signer and nonce can occupy the retry
  // slot. Signing supplies that identity; it does not broadcast or create a ledger entry.
  let retryReservationWei = 0n;
  if (l1FeeBound > 0n) {
    try {
      const [retry] = await tx<{ reserved: string }[]>`
        SELECT COALESCE(MAX(s.gas_limit * COALESCE(s.max_fee_per_gas, ${config.feeCapWei.toString()}::NUMERIC)
          + s.l1_fee_bound), 0)::TEXT AS reserved
        FROM chain.anchor_sends s
        WHERE s.chain_id = ${config.chainId} AND s.transaction_id = ${row.id}
          AND s.signer = ${prepared.from.toLowerCase()} AND s.nonce = ${prepared.nonce}
          AND s.settled_at IS NULL AND s.gas_limit IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM chain.gas_spend g
            WHERE g.chain_id = s.chain_id AND g.tx_hash = s.tx_hash
          )
      `;
      retryReservationWei = BigInt(retry?.reserved ?? "0");
    } catch (error) {
      return recordFailedRead(tx, config, log, row, "retry_reservation_read_failed", error);
    }
  }
  const finalGuard = checkSubmitAllowed({
    ...guardInput,
    retryReservationWei,
  });
  if (!finalGuard.allow) return recordSubmissionBlocked(tx, log, row, finalGuard.reason);
  await countSendAttempt(tx, row);

  // In the ledger before it can reach the network, committed on its own connection. If this
  // transaction rolls back or the process dies after the broadcast, the send still counts
  // against the cap until its receipt or its nonce settles it.
  try {
    await recordSend(sql, config, row, prepared, l1FeeBound);
  } catch (error) {
    // Not in the ledger means not counted against the cap: never broadcast it. The row waits
    // and the same send is signed again next time.
    return recordFailedRead(tx, config, log, row, "send_ledger_failed", error);
  }

  try {
    await chain.broadcast(prepared);
  } catch (error) {
    // The row stays created and is retried. The ledger row stays open: a timeout may hide a
    // send that reached the network. A send that did not is settled once its nonce is reused.
    return recordFailedSend(tx, config, log, row, error);
  }

  const txHash = prepared.txHash;
  await tx`
    UPDATE chain.transactions
    SET state = 'submitted', tx_hash = ${txHash},
        contract_address = ${config.contractAddress.toLowerCase()},
        submitted_at = now(), last_error = NULL, updated_at = now()
    WHERE id = ${row.id}
  `;

  log({ level: "info", msg: "anchor.submitted", transactionId: row.id, txHash });
  return { handled: true, transactionId: row.id, from: "created", to: "submitted" };
}

async function recordSubmissionBlocked(
  tx: postgres.TransactionSql,
  log: Log,
  row: PendingRow,
  reason: string,
): Promise<StepResult> {
  // Record why it is blocked and keep the state. It proceeds on a later loop once conditions
  // change. Hitting the attempt cap never changes, though, so that ends as failed.
  if (reason === "MAX_ATTEMPTS_REACHED") {
    await fail(tx, row.id, reason);
    return { handled: true, transactionId: row.id, from: row.state, to: "failed" };
  }

  await tx`
    UPDATE chain.transactions
    SET last_error = ${reason}, updated_at = now()
    WHERE id = ${row.id}
  `;
  log({ level: "warn", msg: "anchor.submit.blocked", transactionId: row.id, reason });
  return {
    handled: true,
    transactionId: row.id,
    from: row.state,
    to: row.state,
    reason,
    waiting: true,
  };
}

async function countSendAttempt(tx: postgres.TransactionSql, row: PendingRow): Promise<void> {
  await tx`
    UPDATE chain.transactions SET attempts = attempts + 1, updated_at = now()
    WHERE id = ${row.id}
  `;
}

async function recordSend(
  sql: postgres.Sql,
  config: SubmitterConfig,
  row: PendingRow,
  prepared: PreparedSend,
  l1FeeBound: bigint,
): Promise<void> {
  // Re-signing identical input gives the identical transaction and hash: one row.
  await sql`
    INSERT INTO chain.anchor_sends (
      chain_id, tx_hash, transaction_id, tenant_id, signer, nonce, gas_limit, max_fee_per_gas,
      l1_fee_bound
    ) VALUES (
      ${config.chainId}, ${prepared.txHash.toLowerCase()}, ${row.id}, ${row.tenant_id},
      ${prepared.from.toLowerCase()}, ${prepared.nonce}, ${prepared.gasLimit.toString()},
      ${prepared.maxFeePerGas.toString()}, ${l1FeeBound.toString()}
    )
    ON CONFLICT (chain_id, tx_hash) DO NOTHING
  `;
}

/** A send failed before or at broadcast. The state stays created and the loop backs off. */
async function recordFailedSend(
  tx: postgres.TransactionSql,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
  error: unknown,
): Promise<StepResult> {
  const message = errorText(config, null, error);
  await tx`
    UPDATE chain.transactions
    SET last_error = ${message}, updated_at = now()
    WHERE id = ${row.id}
  `;
  log({ level: "error", msg: "anchor.submit.failed", transactionId: row.id, error: message });
  // Back off before the retry. Retrying at once spends every attempt within milliseconds,
  // before a transient RPC failure has had a chance to clear.
  return {
    handled: true,
    transactionId: row.id,
    from: "created",
    to: "created",
    reason: "submit_failed",
    waiting: true,
  };
}

/** Open sends asked about per pass. Bounded so one pass stays short; the rest rotate in next. */
const SENDS_PER_PASS = 10;

interface OpenSend {
  readonly tx_hash: string;
  readonly transaction_id: string;
  readonly tenant_id: string;
  readonly signer: string | null;
  readonly nonce: string | null;
}

/**
 * Settles open sends in the ledger. Runs outside any row lock — every call here is an RPC.
 *
 * A send settles only on evidence it can cost nothing more than the gas ledger holds:
 *
 * - **receipt** — recorded in `chain.gas_spend` at its actual cost (reverted ones burn gas too);
 * - **nonce consumed** — the signer's nonce at a block `confirmationDepth` deep is past this
 *   send's nonce, and the send has no receipt. That nonce is taken by another transaction, so
 *   this one can never be mined.
 *
 * The nonce is read **before** the receipt lookup. Read after, the send itself could be mined in
 * between and be settled as "consumed by another" with its gas never recorded.
 *
 * A failed lookup leaves the send open — open is what keeps the cap closed.
 */
async function settleSends(
  sql: postgres.Sql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
): Promise<void> {
  const sends = await sql<OpenSend[]>`
    SELECT tx_hash, transaction_id, tenant_id, signer, nonce::TEXT AS nonce
    FROM chain.anchor_sends
    WHERE chain_id = ${config.chainId}
      AND settled_at IS NULL
      AND (
        checked_at IS NULL
        OR checked_at < now() - ${`${Math.round(config.recheckIntervalMs / 1000)} seconds`}::interval
      )
    ORDER BY checked_at NULLS FIRST, sent_at
    LIMIT ${SENDS_PER_PASS}
  `;
  if (sends.length === 0) return;

  // A nonce read at a block a reorg can still undo could settle a send that then gets mined, so
  // the block is also held at or below the finalized head, like confirmation.
  let depthBlock: number;
  try {
    depthBlock = (await chain.headBlockNumber()) - config.confirmationDepth + 1;
    if (config.finalityTag !== "none") {
      depthBlock = Math.min(depthBlock, await chain.finalizedBlockNumber(config.finalityTag));
    }
  } catch (error) {
    log({ level: "warn", msg: "anchor.sends.check_failed", error: errorText(config, null, error) });
    return;
  }

  const confirmedNonces = new Map<string, number>();
  for (const send of sends) {
    try {
      await settleSend(sql, chain, config, log, send, depthBlock, confirmedNonces);
    } catch (error) {
      await sql`
        UPDATE chain.anchor_sends SET checked_at = now()
        WHERE chain_id = ${config.chainId} AND tx_hash = ${send.tx_hash}
      `;
      log({
        level: "warn",
        msg: "anchor.sends.check_failed",
        txHash: send.tx_hash,
        error: errorText(config, null, error),
      });
    }
  }
}

async function settleSend(
  sql: postgres.Sql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  send: OpenSend,
  depthBlock: number,
  confirmedNonces: Map<string, number>,
): Promise<void> {
  let takenBelow: number | null = null;
  if (send.nonce !== null && send.signer !== null && depthBlock >= 0) {
    const cached = confirmedNonces.get(send.signer);
    takenBelow = cached ?? (await chain.confirmedNonce(send.signer, depthBlock));
    confirmedNonces.set(send.signer, takenBelow);
  }

  const observation = await chain.observe(send.tx_hash);

  if (observation.kind === "receipt") {
    await sql.begin(async (tx) => {
      await tx`
        INSERT INTO chain.gas_spend (
          chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price, l1_fee
        ) VALUES (
          ${config.chainId}, ${send.tx_hash}, ${send.transaction_id}, ${send.tenant_id},
          ${observation.gasUsed.toString()}, ${observation.effectiveGasPrice.toString()},
          ${observation.l1Fee.toString()}
        )
        ON CONFLICT (chain_id, tx_hash) DO NOTHING
      `;
      await settle(tx, config.chainId, send.tx_hash, "receipt");
      // A dropped row whose transaction was mined after all: the batch may be on chain. The
      // state stays a person's call; the row says why it needs a look.
      await tx`
        UPDATE chain.transactions
        SET last_error = 'mined_after_drop', updated_at = now()
        WHERE id = ${send.transaction_id} AND state = 'dropped' AND tx_hash = ${send.tx_hash}
      `;
    });
    log({ level: "info", msg: "anchor.send.settled", txHash: send.tx_hash, reason: "receipt" });
    return;
  }

  if (takenBelow !== null && Number(send.nonce) < takenBelow) {
    await settle(sql, config.chainId, send.tx_hash, "nonce_consumed");
    log({ level: "info", msg: "anchor.send.settled", txHash: send.tx_hash, reason: "nonce_consumed" });
    return;
  }

  await sql`
    UPDATE chain.anchor_sends SET checked_at = now()
    WHERE chain_id = ${config.chainId} AND tx_hash = ${send.tx_hash}
  `;
}

async function settle(
  sql: postgres.Sql | postgres.TransactionSql,
  chainId: number,
  txHash: string,
  reason: "receipt" | "nonce_consumed",
): Promise<void> {
  await sql`
    UPDATE chain.anchor_sends
    SET settled_at = now(), settled_reason = ${reason}, checked_at = now()
    WHERE chain_id = ${chainId} AND tx_hash = ${txHash} AND settled_at IS NULL
  `;
}

/**
 * Checks the chain for this batch before a send.
 *
 * - Not on chain: null — send as usual.
 * - On chain with our root and a findable transaction: adopt that hash and track it like any
 *   submitted transaction. No second send.
 * - Anything else: `reconciliation_required`. The batch is on chain but we cannot say by which
 *   transaction, or the batch id holds another root. A person decides; sending cannot fix either.
 */
async function reconcileBeforeSend(
  tx: postgres.TransactionSql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
): Promise<StepResult | null> {
  let anchored: AnchoredBatch | null;
  try {
    // A new send goes to the configured contract, so that is the one asked.
    anchored = await chain.anchoredBatch(row.external_batch_id!, config.contractAddress);
  } catch (error) {
    // Without an answer the worker must not send. The row waits and is asked again later, until
    // the search has failed for too long.
    return recordFailedSearch(tx, config, log, row, "reconciliation_check_failed", error);
  }
  await clearFailedSearch(tx, row);
  if (!anchored) return null;

  if (anchored.root !== row.merkle_root) {
    return requireReconciliation(tx, log, row, "batch_on_chain_with_different_root");
  }
  if (!anchored.txHash) {
    return requireReconciliation(tx, log, row, "batch_on_chain_transaction_unknown");
  }

  await tx`
    UPDATE chain.transactions
    SET state = 'submitted', tx_hash = ${anchored.txHash},
        contract_address = ${config.contractAddress.toLowerCase()},
        submitted_at = COALESCE(submitted_at, now()),
        last_error = 'reconciled_from_chain', updated_at = now()
    WHERE id = ${row.id}
  `;
  log({ level: "warn", msg: "anchor.reconciled", transactionId: row.id, txHash: anchored.txHash });
  return {
    handled: true,
    transactionId: row.id,
    from: row.state,
    to: "submitted",
    reason: "reconciled_from_chain",
  };
}

async function requireReconciliation(
  tx: postgres.TransactionSql,
  log: Log,
  row: PendingRow,
  reason: string,
  lastError: string = reason,
): Promise<StepResult> {
  // The search schedule ends here: a person decides, and a resubmission starts with none.
  await tx`
    UPDATE chain.transactions
    SET state = 'reconciliation_required', last_error = ${lastError},
        chain_search_failed_since = NULL, retry_after = NULL, updated_at = now()
    WHERE id = ${row.id}
  `;
  log({ level: "warn", msg: "anchor.reconciliation_required", transactionId: row.id, reason });
  return { handled: true, transactionId: row.id, from: row.state, to: "reconciliation_required", reason };
}

/**
 * A chain search for this row failed: a failed read, a refused range, or a node behind the batch.
 * None of them is proof of absence, so the row keeps its state and is not claimed again for
 * `chainSearchRetryMs`. Once searches have kept failing for `chainSearchGiveUpMs` since the first,
 * the row goes to a person: a provider that cannot finish the search would otherwise leave it
 * waiting forever, never counted as an attempt and never raising `anchor.needs_attention`.
 */
async function recordFailedSearch(
  tx: postgres.TransactionSql,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
  reason: string,
  error: unknown,
): Promise<StepResult> {
  const message = errorText(config, reason, error);
  // Timed on the database clock, like every other interval the claim compares.
  const [schedule] = await tx<{ give_up: boolean }[]>`
    UPDATE chain.transactions
    SET last_error = ${message},
        chain_search_failed_since = COALESCE(chain_search_failed_since, now()),
        retry_after = now() + ${`${config.chainSearchRetryMs} milliseconds`}::interval,
        updated_at = now()
    WHERE id = ${row.id}
    RETURNING chain_search_failed_since
      <= now() - ${`${config.chainSearchGiveUpMs} milliseconds`}::interval AS give_up
  `;
  if (schedule?.give_up) {
    return requireReconciliation(
      tx,
      log,
      row,
      "chain_search_unavailable",
      errorText(config, "chain_search_unavailable", error),
    );
  }
  log({ level: "warn", msg: "anchor.chain_search.failed", transactionId: row.id, reason, error: message });
  return {
    handled: true,
    transactionId: row.id,
    from: row.state,
    to: row.state,
    reason,
    waiting: true,
  };
}

/** A chain search for this row answered: the failure run, if any, is over. */
async function clearFailedSearch(tx: postgres.TransactionSql, row: PendingRow): Promise<void> {
  if (row.chain_search_failed_since === null) return;
  await tx`
    UPDATE chain.transactions SET chain_search_failed_since = NULL, retry_after = NULL
    WHERE id = ${row.id}
  `;
}

/**
 * A receipt that did not store the batch, for a batch that is on chain anyway.
 *
 * The retry went out while the first send was still in the mempool; both were mined and ours
 * reverted with `BatchAlreadyExists` (`duplicate_send_reverted`) — or, through a Safe, the inner
 * call failed and the execution still succeeded (`anchored_by_another_transaction`). The batch is
 * anchored — by the other transaction. Follow that one instead of marking the batch reverted.
 * This one's gas is already in the ledger.
 */
async function followAnchoringTransaction(
  tx: postgres.TransactionSql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
  reason: "duplicate_send_reverted" | "anchored_by_another_transaction",
): Promise<StepResult | null> {
  if (!row.external_batch_id) return null;
  // The contract this row's transaction was sent to. A duplicate reverted there because that
  // contract already held the batch; another contract's copy would be a different anchor.
  const contract = trackedContractOf(row, config);
  let anchored: AnchoredBatch | null;
  try {
    anchored = await chain.anchoredBatch(row.external_batch_id, contract);
  } catch (error) {
    // Without an answer a duplicate cannot be told from a real revert, nor a receipt without the
    // root from a batch stored by another transaction. Keep the state and ask again later.
    return recordFailedSearch(
      tx,
      config,
      log,
      row,
      reason === "duplicate_send_reverted" ? "duplicate_check_failed" : "anchored_elsewhere_check_failed",
      error,
    );
  }
  await clearFailedSearch(tx, row);
  if (!anchored?.txHash || anchored.root !== row.merkle_root || anchored.txHash === row.tx_hash) {
    return null;
  }

  // The contract the hash was found on is recorded with it, in the same UPDATE: a public proof
  // names the pair, and it must not pair this hash with another contract.
  await tx`
    UPDATE chain.transactions
    SET state = 'submitted', tx_hash = ${anchored.txHash},
        contract_address = ${contract},
        block_number = NULL, block_hash = NULL, confirmations = 0, confirmed_at = NULL,
        last_error = ${reason}, updated_at = now()
    WHERE id = ${row.id}
  `;
  log({
    level: "warn",
    msg: reason === "duplicate_send_reverted" ? "anchor.duplicate_reverted" : "anchor.anchored_elsewhere",
    transactionId: row.id,
    // The transaction that did not store the batch; the row now follows `txHash`.
    previousTxHash: row.tx_hash,
    txHash: anchored.txHash,
  });
  return {
    handled: true,
    transactionId: row.id,
    from: row.state,
    to: "submitted",
    reason,
  };
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
    return {
      handled: true,
      transactionId: row.id,
      from: row.state,
      to: "proposed",
      reason: "already_proposed",
      waiting: true,
    };
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
      const message = errorText(config, null, error);
      await tx`
        UPDATE chain.transactions
        SET last_error = ${`safe_propose_failed: ${message}`}, updated_at = now()
        WHERE id = ${row.id}
      `;
      log({ level: "error", msg: "anchor.propose.failed", transactionId: row.id, error: message });
      return {
        handled: true,
        transactionId: row.id,
        from: row.state,
        to: row.state,
        reason: "propose_failed",
        waiting: true,
      };
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

/**
 * Whether this receipt carries `contract`'s `RootSubmitted` for exactly this batch and root. The
 * same event from any other address stores nothing on the contract the row names.
 */
function storedRoot(
  observation: Extract<Observation, { kind: "receipt" }>,
  contract: string,
  batchId: string,
  root: string,
): boolean {
  return observation.rootSubmissions.some(
    (log) =>
      log.contract === contract &&
      log.batchId === batchId.toLowerCase() &&
      log.root === root.toLowerCase(),
  );
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

  let observation: Observation;
  let headBlockNumber: number;
  try {
    [observation, headBlockNumber] = await Promise.all([
      chain.observe(row.tx_hash),
      chain.headBlockNumber(),
    ]);
  } catch (error) {
    return recordFailedRead(tx, config, log, row, "observation_failed", error);
  }

  if (observation.kind === "receipt") {
    // Record the cost even when the observation does not change the state. A branch below
    // ("nothing changed: stamp the time and return") would otherwise skip recording the cost
    // despite a receipt, and the daily cap would see 0 and stay open forever.
    //
    // The row's columns hold the latest attempt only. The daily cap sums the ledger, which
    // keeps one row per mined hash — a resubmission or reorg re-observation does not erase an
    // earlier attempt's gas, and seeing the same hash again does not count it twice.
    await tx`
      UPDATE chain.transactions
      SET gas_used = ${observation.gasUsed.toString()},
          effective_gas_price = ${observation.effectiveGasPrice.toString()}
      WHERE id = ${row.id}
    `;
    await tx`
      INSERT INTO chain.gas_spend (
        chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price, l1_fee
      ) VALUES (
        ${config.chainId}, ${row.tx_hash}, ${row.id}, ${row.tenant_id},
        ${observation.gasUsed.toString()}, ${observation.effectiveGasPrice.toString()},
        ${observation.l1Fee.toString()}
      )
      ON CONFLICT (chain_id, tx_hash) DO NOTHING
    `;
    await settle(tx, config.chainId, row.tx_hash, "receipt");
  }

  if (observation.kind === "receipt" && observation.status === "reverted") {
    const followed = await followAnchoringTransaction(tx, chain, config, log, row, "duplicate_send_reverted");
    if (followed) return followed;
  }

  if (
    observation.kind === "receipt" &&
    observation.status === "success" &&
    row.external_batch_id &&
    row.merkle_root &&
    !storedRoot(observation, trackedContractOf(row, config), row.external_batch_id, row.merkle_root)
  ) {
    // Mined and successful, yet the contract recorded no root for this batch here: a Safe
    // execution whose inner call failed, or a transaction to some other address. Confirming it
    // would publish a proof the chain does not back. If another transaction stored the batch,
    // follow that one; otherwise a person looks, as with any batch whose chain state is unclear.
    const followed = await followAnchoringTransaction(
      tx,
      chain,
      config,
      log,
      row,
      "anchored_by_another_transaction",
    );
    if (followed) return followed;
    return requireReconciliation(tx, log, row, "receipt_without_root_submitted");
  }

  let finalizedBlockNumber: number | null = null;
  if (observation.kind === "receipt" && config.finalityTag !== "none") {
    try {
      finalizedBlockNumber = await chain.finalizedBlockNumber(config.finalityTag);
    } catch (error) {
      return recordFailedRead(tx, config, log, row, "finality_read_failed", error);
    }
  }

  const result = trackTransaction({
    state: row.state,
    recordedBlockNumber: row.block_number ? Number(row.block_number) : null,
    recordedBlockHash: row.block_hash,
    observation,
    headBlockNumber,
    confirmationDepth: config.confirmationDepth,
    finalizedBlockNumber,
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
    return {
      handled: true,
      transactionId: row.id,
      from: row.state,
      to: row.state,
      reason: result.reason,
      // A pending transaction is picked again at once; without a back-off the loop polls the
      // node as fast as it answers. Confirmed rows are already spaced by `recheckIntervalMs`.
      waiting: row.state !== "confirmed",
    };
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

/**
 * A chain read failed (node restart, rate limit). Keep the state, record why the row waits and
 * back off, instead of surfacing only as a loop error with nothing on the row.
 */
async function recordFailedRead(
  tx: postgres.TransactionSql,
  config: SubmitterConfig,
  log: Log,
  row: PendingRow,
  reason: string,
  error: unknown,
): Promise<StepResult> {
  const message = errorText(config, reason, error);
  await tx`
    UPDATE chain.transactions
    SET last_error = ${message}, updated_at = now()
    WHERE id = ${row.id}
  `;
  log({ level: "warn", msg: "anchor.chain_read.failed", transactionId: row.id, reason, error: message });
  return {
    handled: true,
    transactionId: row.id,
    from: row.state,
    to: row.state,
    reason,
    waiting: true,
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
