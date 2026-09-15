import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import {
  chainBacklog,
  shouldBackOff,
  stepOnce,
  type ChainClient,
  type FeeQuote,
  type SafeProposer,
  type SubmitterConfig,
} from "../src/anchor-submitter.js";
import type { Observation } from "../src/anchor-state.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
  * anchor submission integration test.
 *
  * Swaps in a ChainClient double to control chain responses. A real node cannot reproduce a reorg
  * or mempool drop — and the cases that cannot be reproduced are exactly the ones this code must
  * handle.
 */

const CHAIN_ID = 97;
const ROOT = `0x${"11".repeat(32)}`;
const MANIFEST = `0x${"22".repeat(32)}`;
const TX_HASH = `0x${"44".repeat(32)}`;
const BLOCK_A = `0x${"aa".repeat(32)}`;
const BLOCK_B = `0x${"bb".repeat(32)}`;

const config: SubmitterConfig = {
  chainId: CHAIN_ID,
  contractAddress: `0x${"cc".repeat(20)}`,
  confirmationDepth: 3,
  feeCapWei: 100_000_000_000n,
  maxAttempts: 3,
  dropTimeoutMs: 60_000,
  eoaAllowedChainIds: [CHAIN_ID],
  safeAddress: null,
  // Tests must re-check immediately. With an interval, stage transitions go unobserved.
  reorgWatchMs: 60 * 60 * 1000,
  recheckIntervalMs: 0,
  // Most cases are unrelated to the daily cap. Only cases that test the cap itself lower it.
  dailySpendCapWei: 10n ** 18n,
};

const PRIORITY_FEE = 1_000_000n;

/** Gas cost of one receipt = 100_000 × 1 gwei = 1e14 wei. */
const GAS_USED = 100_000n;
const GAS_PRICE = 1_000_000_000n;
const RECEIPT_COST_WEI = GAS_USED * GAS_PRICE;

const receipt = (
  blockNumber: number,
  blockHash: string,
  status: "success" | "reverted" = "success",
): Observation => ({
  kind: "receipt",
  status,
  blockNumber,
  blockHash,
  gasUsed: GAS_USED,
  effectiveGasPrice: GAS_PRICE,
});

class FakeChain implements ChainClient {
  head = 100;
  fee = 1_000_000_000n;
  observation: Observation = { kind: "pending" };
  submitError: Error | null = null;
  submitted: unknown[] = [];
  encoded: unknown[] = [];
  /** What `getBatch` and the RootSubmitted log say about the batch. null = not on chain. */
  anchored: { root: string; txHash: string | null } | null = null;
  /** Set to make the chain read fail, as a node restart or rate limit would. */
  anchoredError: Error | null = null;

  async anchoredBatch(): Promise<{ root: string; txHash: string | null } | null> {
    if (this.anchoredError) throw this.anchoredError;
    return this.anchored;
  }

  async headBlockNumber(): Promise<number> {
    return this.head;
  }

  /** Overrides the default EIP-1559 quote built from `fee`. */
  quote: FeeQuote | null = null;

  /** Set to make the fee quote or the transaction lookup fail. */
  feeError: Error | null = null;
  observeError: Error | null = null;

  async estimateFees(): Promise<FeeQuote> {
    if (this.feeError) throw this.feeError;
    return this.quote ?? { type: "eip1559", maxFeePerGas: this.fee, maxPriorityFeePerGas: PRIORITY_FEE };
  }

  async submitRoot(input: unknown): Promise<string> {
    if (this.submitError) throw this.submitError;
    this.submitted.push(input);
    return TX_HASH;
  }

  encodeSubmitRoot(input: { batchId: string }): { calldata: string; calldataHash: string } {
    this.encoded.push(input);
    return { calldata: "0xdeadbeef", calldataHash: `0x${"ee".repeat(32)}` };
  }

  async observe(): Promise<Observation> {
    if (this.observeError) throw this.observeError;
    return this.observation;
  }
}

describeDb("anchor submission and finality", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let batchRowId: string;
  let transactionId: string;
  /** batch_id is globally UNIQUE. Create a new one per case. */
  let batchExternalId: string;
  let chain: FakeChain;
  const logs: Record<string, unknown>[] = [];
  const log = (record: Record<string, unknown>) => {
    logs.push(record);
  };

  beforeAll(async () => {
    sql = postgres(process.env["DATABASE_URL"]!, { onnotice: () => {}, prepare: false });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    chain = new FakeChain();
    logs.length = 0;

    // Create a new tenant every time. If the worker picks up an earlier case's transaction, there is
    // no telling which case changed what.
    tenantId = randomUUID();
    // reorg_events references transactions. The application has no delete path (append-only);
    // only tests clean up, as superuser.
    await sql`DELETE FROM chain.reorg_events`;
    await sql`DELETE FROM chain.gas_spend`;
    await sql`DELETE FROM chain.anchor_proposals`;
    await sql`DELETE FROM chain.transactions WHERE chain_id = ${CHAIN_ID}`;
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`anchor-${tenantId.slice(0, 8)}`}, 'anchor test')
    `;

    batchRowId = randomUUID();
    batchExternalId = `0x${batchRowId.replace(/-/g, "").repeat(2)}`;
    await sql`
      INSERT INTO chain.anchor_batches (
        id, tenant_id, batch_id, merkle_root, manifest_hash,
        manifest_object_key, schema_version, record_count
      ) VALUES (
        ${batchRowId}, ${tenantId}, ${batchExternalId}, ${ROOT}, ${MANIFEST},
        'manifests/test.json', '1', 2
      )
    `;

    transactionId = randomUUID();
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state)
      VALUES (
        ${transactionId}, ${tenantId}, ${batchRowId},
        ${`anchor:${batchExternalId}`}, ${CHAIN_ID}, 'created'
      )
    `;
  });

  async function stateOf() {
    const [row] = await sql<
      {
        state: string;
        tx_hash: string | null;
        block_hash: string | null;
        confirmations: number;
        attempts: number;
        last_error: string | null;
        confirmed_at: Date | null;
      }[]
    >`
      SELECT state, tx_hash, block_hash, confirmations, attempts, last_error, confirmed_at
      FROM chain.transactions WHERE id = ${transactionId}
    `;
    return row!;
  }

  const step = () => stepOnce(sql, chain, config, log);

  it("submits created and moves it to submitted", async () => {
    const result = await step();

    expect(result.to).toBe("submitted");
    expect(chain.submitted).toEqual([
      {
        batchId: batchExternalId,
        root: ROOT,
        manifestHash: MANIFEST,
        schemaVersion: "1",
        recordCount: 2,
        fees: { type: "eip1559", maxFeePerGas: chain.fee, maxPriorityFeePerGas: PRIORITY_FEE },
      },
    ]);

    const row = await stateOf();
    expect(row.state).toBe("submitted");
    expect(row.tx_hash).toBe(TX_HASH);
  });

  it("is not confirmed when in a block but short of the required depth", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 101;
    await step();

    const row = await stateOf();
    // 06 §6.8: included is not success. The public proof's included is still false.
    expect(row.state).toBe("included");
    expect(row.confirmed_at).toBeNull();
  });

  it("becomes confirmed once the depth is reached and records the time", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();

    const row = await stateOf();
    expect(row.state).toBe("confirmed");
    expect(row.confirmations).toBe(3);
    expect(row.confirmed_at).not.toBeNull();
  });

  it("reverts finality and records an incident when a reorg is observed", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();
    expect((await stateOf()).state).toBe("confirmed");

    // The same transaction appears in a different block — the block we saw is gone.
    chain.observation = receipt(140, BLOCK_B);
    chain.head = 141;
    await step();

    const row = await stateOf();
    expect(row.state).toBe("included");
    expect(row.block_hash).toBe(BLOCK_B);

    const events = await sql`
      SELECT previous_block_hash, detected_state FROM chain.reorg_events
      WHERE transaction_id = ${transactionId}
    `;
    // Never erase the reversal. Even after re-confirmation, the fact that it was reversed remains.
    expect(events).toHaveLength(1);
    expect(events[0]!["previous_block_hash"]).toBe(BLOCK_A);
    expect(events[0]!["detected_state"]).toBe("confirmed");
  });

  it("does not retry a revert", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A, "reverted");
    chain.head = 130;
    await step();

    expect((await stateOf()).state).toBe("reverted");

    // Not picked up again by later loops.
    const next = await step();
    expect(next.handled).toBe(false);
  });

  it("a submission failure stays created and is retried", async () => {
    chain.submitError = new Error("nonce too low");
    await step();

    const row = await stateOf();
    expect(row.state).toBe("created");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("nonce too low");

    chain.submitError = null;
    await step();
    expect((await stateOf()).state).toBe("submitted");
  });

  it("ends as failed at the retry cap", async () => {
    // Keeps unlimited retries from draining the gas wallet (O1).
    chain.submitError = new Error("insufficient funds");
    await step();
    await step();
    await step();

    expect((await stateOf()).attempts).toBe(3);

    await step();
    const row = await stateOf();
    expect(row.state).toBe("failed");
    expect(row.last_error).toBe("MAX_ATTEMPTS_REACHED");
  });

  it("does not submit above the gas cap and keeps the state", async () => {
    chain.fee = 500_000_000_000n;
    await step();

    const row = await stateOf();
    expect(row.state).toBe("created");
    expect(row.last_error).toBe("FEE_ABOVE_CAP");
    // Does not consume an attempt. Once conditions change, it must proceed as-is.
    expect(row.attempts).toBe(0);
    expect(chain.submitted).toHaveLength(0);
  });

  it("sends with the fee quote that passed the cap check", async () => {
    // Letting the send estimate the fee again opens a window where a spike slips past the cap.
    // The whole quote travels, so what is sent is exactly what the cap judged.
    chain.fee = 42_000_000_000n;
    await step();

    expect(chain.submitted).toHaveLength(1);
    expect((chain.submitted[0] as { fees?: FeeQuote }).fees).toEqual({
      type: "eip1559",
      maxFeePerGas: 42_000_000_000n,
      maxPriorityFeePerGas: PRIORITY_FEE,
    });
  });

  it("checks and sends a legacy gas price the same way", async () => {
    // Nodes without EIP-1559 quote one gas price. It is the ceiling the cap judges.
    chain.quote = { type: "legacy", gasPrice: 500_000_000_000n };
    await step();
    expect((await stateOf()).last_error).toBe("FEE_ABOVE_CAP");

    chain.quote = { type: "legacy", gasPrice: 3_000_000_000n };
    await step();
    expect((chain.submitted[0] as { fees?: FeeQuote }).fees).toEqual(chain.quote);
  });

  it("revokes finality when a confirmed transaction is back in the mempool", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();
    expect((await stateOf()).state).toBe("confirmed");

    chain.observation = { kind: "pending" };
    await step();

    const row = await stateOf();
    expect(row.state).toBe("submitted");
    expect(row.confirmed_at).toBeNull();
    const events = await sql`
      SELECT detected_state FROM chain.reorg_events WHERE transaction_id = ${transactionId}
    `;
    expect(events).toHaveLength(1);
  });

  describe("reconciling with the chain when a send result was lost", () => {
    const LOST_HASH = `0x${"3d".repeat(32)}`;

    it("recovers the hash of an earlier attempt that anchored the batch instead of sending again", async () => {
      // The node accepted the first send but the answer never arrived (timeout, crash). A second
      // send would burn gas on BatchAlreadyExists and the proof would track the wrong transaction.
      chain.submitError = new Error("request timed out");
      await step();
      expect((await stateOf()).state).toBe("created");

      chain.submitError = null;
      chain.anchored = { root: ROOT, txHash: LOST_HASH };
      const result = await step();

      expect(result.to).toBe("submitted");
      expect(chain.submitted).toHaveLength(0);
      const row = await stateOf();
      expect(row.state).toBe("submitted");
      expect(row.tx_hash).toBe(LOST_HASH);
    });

    it("backs off with a recorded reason when the chain cannot be asked, and does not send", async () => {
      // Without an answer the worker must not send — and the row should say why it is waiting.
      chain.anchoredError = new Error("rpc unavailable");
      const result = await step();

      expect(shouldBackOff(result)).toBe(true);
      expect(result.reason).toBe("reconciliation_check_failed");
      expect(chain.submitted).toHaveLength(0);
      const row = await stateOf();
      expect(row.state).toBe("created");
      expect(row.last_error).toContain("reconciliation_check_failed");
    });

    it("stops for a person when the batch is on chain but its transaction is not found", async () => {
      chain.anchored = { root: ROOT, txHash: null };
      await step();

      const row = await stateOf();
      expect(row.state).toBe("reconciliation_required");
      expect(row.last_error).toBe("batch_on_chain_transaction_unknown");
      expect(chain.submitted).toHaveLength(0);
    });

    it("stops for a person when the batch id is on chain with a different root", async () => {
      chain.anchored = { root: `0x${"99".repeat(32)}`, txHash: LOST_HASH };
      await step();

      const row = await stateOf();
      expect(row.state).toBe("reconciliation_required");
      expect(row.last_error).toBe("batch_on_chain_with_different_root");
      expect(chain.submitted).toHaveLength(0);
    });

    it("follows the transaction that anchored the batch when a duplicate send reverts", async () => {
      // The first send was still in the mempool when the retry went out. Both were mined; ours
      // reverted with BatchAlreadyExists. The batch is anchored — by the first transaction.
      await step();
      chain.observation = receipt(100, BLOCK_A, "reverted");
      chain.anchored = { root: ROOT, txHash: LOST_HASH };
      await step();

      const row = await stateOf();
      expect(row.state).toBe("submitted");
      expect(row.tx_hash).toBe(LOST_HASH);
      expect(row.block_hash).toBeNull();
      // The reverted duplicate still burned gas. It stays in today's total.
      const [spent] = await sql<{ tx_hash: string }[]>`
        SELECT tx_hash FROM chain.gas_spend WHERE transaction_id = ${transactionId}
      `;
      expect(spent!.tx_hash).toBe(TX_HASH);
    });

    it("backs off with a recorded reason when a reverted send cannot be checked against the chain", async () => {
      // Without an answer the worker cannot tell a duplicate from a real revert. It must not
      // mark the batch reverted, and the row should say why it is waiting.
      await step();
      chain.observation = receipt(100, BLOCK_A, "reverted");
      chain.anchoredError = new Error("rpc unavailable");
      const result = await step();

      expect(shouldBackOff(result)).toBe(true);
      expect(result.reason).toBe("duplicate_check_failed");
      const row = await stateOf();
      expect(row.state).toBe("submitted");
      expect(row.last_error).toContain("duplicate_check_failed");
    });
  });

  describe("failed chain reads are recorded on the row", () => {
    it("backs off with a recorded reason when the fee quote fails, and does not send", async () => {
      chain.feeError = new Error("rpc unavailable");
      const result = await step();

      expect(shouldBackOff(result)).toBe(true);
      expect(result.reason).toBe("fee_estimate_failed");
      expect(chain.submitted).toHaveLength(0);
      const row = await stateOf();
      expect(row.state).toBe("created");
      expect(row.last_error).toContain("fee_estimate_failed");
    });

    it("backs off with a recorded reason when the transaction cannot be looked up", async () => {
      await step();
      chain.observeError = new Error("rpc unavailable");
      const result = await step();

      expect(shouldBackOff(result)).toBe(true);
      expect(result.reason).toBe("observation_failed");
      const row = await stateOf();
      expect(row.state).toBe("submitted");
      expect(row.last_error).toContain("observation_failed");
    });
  });

  describe("loop back-off (blocked outcomes do not spin)", () => {
    it("backs off when the submission is blocked by a cap", async () => {
      chain.fee = 500_000_000_000n;
      expect(shouldBackOff(await step())).toBe(true);
    });

    it("backs off while a submitted transaction is still pending", async () => {
      await step();
      chain.observation = { kind: "pending" };
      expect(shouldBackOff(await step())).toBe(true);
    });

    it("backs off after a failed send instead of spending every attempt at once", async () => {
      chain.submitError = new Error("rpc timeout");
      expect(shouldBackOff(await step())).toBe(true);
    });

    it("does not back off after progress", async () => {
      expect(shouldBackOff(await step())).toBe(false);
    });

    it("backs off when nothing is left to do", async () => {
      await sql`UPDATE chain.transactions SET state = 'failed' WHERE id = ${transactionId}`;
      expect(shouldBackOff(await step())).toBe(true);
    });
  });

  /** Safe service double. The real service cannot reproduce execution or rejection. */
  function fakeSafe(overrides: Partial<SafeProposer> = {}): SafeProposer {
    return {
      async nextNonce() {
        return 7;
      },
      async propose() {
        return { safeTxHash: `0x${"5a".repeat(32)}`, nonce: 7 };
      },
      async status() {
        return { kind: "pending", confirmations: 1, threshold: 3 };
      },
      ...overrides,
    };
  }

  const safeConfigOf = () => ({
    ...config,
    eoaAllowedChainIds: [] as number[],
    safeAddress: `0x${"ab".repeat(20)}`,
  });

  it("posts the proposal to the Safe service and records its identifier", async () => {
    const safe = fakeSafe();
    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    expect(result.to).toBe("proposed");
    const [proposal] = await sql<{ safe_tx_hash: string | null; state: string }[]>`
      SELECT safe_tx_hash, state FROM chain.anchor_proposals
      WHERE transaction_id = ${transactionId}
    `;
    // The identifier signers match against in the Safe UI. Without it, the proposal cannot be found.
    expect(proposal!.safe_tx_hash).toBe(`0x${"5a".repeat(32)}`);
    expect(proposal!.state).toBe("proposed");
  });

  it("records nothing in the DB when posting the proposal fails", async () => {
    const safe = fakeSafe({
      async propose() {
        throw new Error("service unavailable");
      },
    });

    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    // Marking an unposted proposal as `proposed` would make it look like it awaits signatures.
    expect(result.reason).toBe("propose_failed");
    expect((await stateOf()).state).toBe("created");
    const proposals = await sql`
      SELECT id FROM chain.anchor_proposals WHERE transaction_id = ${transactionId}
    `;
    expect(proposals).toHaveLength(0);
  });

  it("does not change state while signatures are being collected", async () => {
    const safe = fakeSafe();
    await stepOnce(sql, chain, safeConfigOf(), log, safe);

    const next = await stepOnce(sql, chain, safeConfigOf(), log, safe);
    expect(next.handled).toBe(false);
    expect((await stateOf()).state).toBe("proposed");
  });

  it("moves to the normal tracking path once executed on the Safe", async () => {
    const executedHash = `0x${"7c".repeat(32)}`;
    let executed = false;
    const safe = fakeSafe({
      async status() {
        return executed
          ? { kind: "executed", transactionHash: executedHash }
          : { kind: "pending", confirmations: 1, threshold: 3 };
      },
    });

    await stepOnce(sql, chain, safeConfigOf(), log, safe);
    executed = true;

    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);
    expect(result.to).toBe("submitted");

    const row = await stateOf();
    // The same finality depth and reorg watch apply. Executing via Safe does not exempt finality.
    expect(row.state).toBe("submitted");
    expect(row.tx_hash).toBe(executedHash);
  });

  it("does not repost automatically when rejected on the Safe", async () => {
    const safe = fakeSafe({
      async status() {
        return { kind: "rejected" };
      },
    });

    await stepOnce(sql, chain, safeConfigOf(), log, safe);
    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    expect(result.to).toBe("failed");
    // Reposting without checking why it was rejected gets it rejected again for the same reason.
    expect((await stateOf()).last_error).toBe("safe_proposal_rejected");
  });

  /** Adds another batch waiting in `created`. */
  async function addCreatedTransaction(): Promise<string> {
    const rowId = randomUUID();
    const externalId = `0x${rowId.replace(/-/g, "").repeat(2)}`;
    const id = randomUUID();
    await sql`
      INSERT INTO chain.anchor_batches (
        id, tenant_id, batch_id, merkle_root, manifest_hash,
        manifest_object_key, schema_version, record_count
      ) VALUES (
        ${rowId}, ${tenantId}, ${externalId}, ${ROOT}, ${MANIFEST}, 'manifests/more.json', '1', 1
      )
    `;
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state)
      VALUES (${id}, ${tenantId}, ${rowId}, ${`anchor:${externalId}`}, ${CHAIN_ID}, 'created')
    `;
    return id;
  }

  /** A Safe double that hands out nonces in order and a distinct hash per nonce. */
  function sequentialSafe(statusOf: SafeProposer["status"]): SafeProposer {
    let nonce = 7;
    return {
      async nextNonce() {
        return nonce++;
      },
      async propose(input) {
        return { safeTxHash: `0x${input.nonce.toString(16).padStart(64, "0")}`, nonce: input.nonce };
      },
      status: statusOf,
    };
  }

  const hashOfNonce = (nonce: number) => `0x${nonce.toString(16).padStart(64, "0")}`;

  it("reads back every open proposal, not only the oldest", async () => {
    // The oldest proposal can wait for signatures indefinitely. A later one that was executed
    // must still reach the chain-tracking path.
    const laterId = await addCreatedTransaction();
    const executedHash = `0x${"7c".repeat(32)}`;
    const safe = sequentialSafe(async (safeTxHash) =>
      safeTxHash === hashOfNonce(8)
        ? { kind: "executed", transactionHash: executedHash }
        : { kind: "pending", confirmations: 1, threshold: 3 },
    );

    await stepOnce(sql, chain, safeConfigOf(), log, safe);
    await stepOnce(sql, chain, safeConfigOf(), log, safe);
    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    expect(result.transactionId).toBe(laterId);
    expect(result.to).toBe("submitted");
    expect((await stateOf()).state).toBe("proposed");
  });

  it("ends a proposal replaced on the Safe as failed, so it can be resubmitted", async () => {
    // A rejection in the Safe UI executes another transaction at the same nonce. Ours can never
    // execute; left as proposed it would wait forever without an alert.
    const safe = sequentialSafe(async () => ({ kind: "replaced", replacedBy: `0x${"99".repeat(32)}` }));

    await stepOnce(sql, chain, safeConfigOf(), log, safe);
    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    expect(result.to).toBe("failed");
    const row = await stateOf();
    expect(row.state).toBe("failed");
    expect(row.last_error).toBe("safe_proposal_replaced");
    const [proposal] = await sql<{ state: string }[]>`
      SELECT state FROM chain.anchor_proposals WHERE transaction_id = ${transactionId}
    `;
    expect(proposal!.state).toBe("rejected");
  });

  it("does not ask the Safe service about the same proposal within the recheck interval", async () => {
    // Every open proposal is read back now; unthrottled, that is one service call per proposal
    // per loop.
    let calls = 0;
    const safe = sequentialSafe(async () => {
      calls += 1;
      return { kind: "pending", confirmations: 1, threshold: 3 };
    });
    const throttled = { ...safeConfigOf(), recheckIntervalMs: 60_000 };

    await stepOnce(sql, chain, throttled, log, safe);
    await stepOnce(sql, chain, throttled, log, safe);
    await stepOnce(sql, chain, throttled, log, safe);

    expect(calls).toBe(1);
  });

  it("creates a Safe proposal instead of submitting on a chain where EOA is blocked", async () => {
    const safeConfig = {
      ...config,
      eoaAllowedChainIds: [] as number[],
      safeAddress: `0x${"ab".repeat(20)}`,
    };

    const result = await stepOnce(sql, chain, safeConfig, log);
    expect(result.to).toBe("proposed");

    // A proposal is not execution. Nothing was sent to the chain.
    expect(chain.submitted).toHaveLength(0);
    expect(chain.encoded).toHaveLength(1);

    const row = await stateOf();
    // Marking it submitted would wait forever for the receipt of a transaction that does not exist.
    expect(row.state).toBe("proposed");
    expect(row.tx_hash).toBeNull();

    const [proposal] = await sql<{ safe_address: string; calldata_hash: string; state: string }[]>`
      SELECT safe_address, calldata_hash, state FROM chain.anchor_proposals
      WHERE transaction_id = ${transactionId}
    `;
    expect(proposal!.state).toBe("proposed");
    expect(proposal!.safe_address).toBe(safeConfig.safeAddress);
  });

  it("proposed is not picked up again", async () => {
    const safeConfig = {
      ...config,
      eoaAllowedChainIds: [] as number[],
      safeAddress: `0x${"ab".repeat(20)}`,
    };
    await stepOnce(sql, chain, safeConfig, log);

    // Before execution on the Safe, no transaction exists on chain. Querying would judge it
    // "does not exist" and wrongly mark it dropped.
    const next = await stepOnce(sql, chain, safeConfig, log);
    expect(next.handled).toBe(false);
  });

  it("confirmed transactions do not starve pending ones", async () => {
    // Take the first one all the way to confirmed.
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();
    expect((await stateOf()).state).toBe("confirmed");

    // A later batch. Picking only by age would keep re-picking the confirmed earlier row, and this
    // row would never be submitted.
    const laterBatchRowId = randomUUID();
    const laterBatchExternalId = `0x${laterBatchRowId.replace(/-/g, "").repeat(2)}`;
    const laterTransactionId = randomUUID();
    await sql`
      INSERT INTO chain.anchor_batches (
        id, tenant_id, batch_id, merkle_root, manifest_hash,
        manifest_object_key, schema_version, record_count
      ) VALUES (
        ${laterBatchRowId}, ${tenantId}, ${laterBatchExternalId}, ${ROOT}, ${MANIFEST},
        'manifests/later.json', '1', 1
      )
    `;
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state)
      VALUES (
        ${laterTransactionId}, ${tenantId}, ${laterBatchRowId},
        ${`anchor:${laterBatchExternalId}`}, ${CHAIN_ID}, 'created'
      )
    `;

    chain.observation = { kind: "pending" };
    const result = await step();

    expect(result.transactionId).toBe(laterTransactionId);
    expect(result.to).toBe("submitted");
  });

  it("does not pick up transactions from another chain", async () => {
    await sql`UPDATE chain.transactions SET chain_id = 56 WHERE id = ${transactionId}`;
    const result = await step();
    expect(result.handled).toBe(false);
  });

  it("backlog counts items needing human attention separately", async () => {
    chain.submitError = new Error("boom");
    await step();
    expect((await chainBacklog(sql, CHAIN_ID)).pending).toBe(1);

    chain.submitError = null;
    await step();
    chain.observation = receipt(100, BLOCK_A, "reverted");
    await step();

    const backlog = await chainBacklog(sql, CHAIN_ID);
    expect(backlog.needsAttention).toBe(1);
    expect(backlog.confirmed).toBe(0);
  });

  it("does not auto-recover when a confirmed transaction disappears", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();

    chain.observation = { kind: "unknown" };
    await step();

    // Silently reverting to created and resubmitting could submit the same root twice.
    expect((await stateOf()).state).toBe("reconciliation_required");
  });

  describe("daily gas cap (O1)", () => {
    /**
      * Seeds gas already burned.
     *
      * The daily cap is judged on the `chain.gas_spend` ledger, so the cap only means something once
      * we confirm a row lands there when the receipt arrives.
     */
    async function seedSpend(gasUsed: bigint, price: bigint, observedAt: string, chainId = CHAIN_ID) {
      const id = randomUUID();
      const txHash = `0x${id.replace(/-/g, "").repeat(2)}`;
      await sql`
        INSERT INTO chain.transactions (
          id, tenant_id, intent_key, chain_id, state, tx_hash, block_number, block_hash,
          submitted_at, gas_used, effective_gas_price
        ) VALUES (
          ${id}, ${tenantId}, ${`spent:${id}`}, ${chainId}, 'confirmed',
          ${txHash}, 90, ${BLOCK_A},
          ${sql.unsafe(observedAt)}, ${gasUsed.toString()}, ${price.toString()}
        )
      `;
      await sql`
        INSERT INTO chain.gas_spend (
          chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price, observed_at
        ) VALUES (
          ${chainId}, ${txHash}, ${id}, ${tenantId}, ${gasUsed.toString()}, ${price.toString()},
          ${sql.unsafe(observedAt)}
        )
      `;
      return id;
    }

    it("records the actual gas cost when the receipt arrives", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A);
      await step();

      const [row] = await sql<{ gas_used: string | null; effective_gas_price: string | null }[]>`
        SELECT gas_used, effective_gas_price FROM chain.transactions WHERE id = ${transactionId}
      `;
      expect(row!.gas_used).toBe(String(GAS_USED));
      expect(row!.effective_gas_price).toBe(GAS_PRICE.toString());
    });

    it("does not submit a new batch once gas burned today reaches the cap", async () => {
      await seedSpend(GAS_USED, GAS_PRICE, "now()");

      const result = await stepOnce(
        sql,
        chain,
        { ...config, dailySpendCapWei: RECEIPT_COST_WEI },
        log,
      );

      expect(result.reason).toBe("DAILY_SPEND_CAP_REACHED");
      expect(chain.submitted).toEqual([]);
      const row = await stateOf();
      expect(row.state).toBe("created");
      expect(row.last_error).toBe("DAILY_SPEND_CAP_REACHED");
    });

    it("gas burned by an earlier attempt still counts after a resubmission", async () => {
      // A reverted attempt burned gas. The operator resubmits; the API resets the row the same
      // way as below. That reset must not make the burned gas disappear from today's total.
      await step();
      chain.observation = receipt(100, BLOCK_A, "reverted");
      await step();
      expect((await stateOf()).state).toBe("reverted");

      await sql`
        UPDATE chain.transactions
        SET state = 'created', attempts = 0,
            tx_hash = NULL, block_number = NULL, block_hash = NULL,
            confirmations = 0, confirmed_at = NULL, submitted_at = NULL,
            last_error = 'resubmitted_from_reverted', updated_at = now()
        WHERE id = ${transactionId}
      `;

      const result = await stepOnce(
        sql,
        chain,
        { ...config, dailySpendCapWei: RECEIPT_COST_WEI },
        log,
      );

      expect(result.reason).toBe("DAILY_SPEND_CAP_REACHED");
      expect(chain.submitted).toHaveLength(1);
    });

    it("gas burned yesterday does not count toward today's cap", async () => {
      // The cap reopens daily. Counting cumulatively would block forever.
      await seedSpend(GAS_USED, GAS_PRICE, "now() - interval '2 days'");

      const result = await stepOnce(
        sql,
        chain,
        { ...config, dailySpendCapWei: RECEIPT_COST_WEI },
        log,
      );

      expect(result.to).toBe("submitted");
      expect(chain.submitted).toHaveLength(1);
    });

    it("does not count gas burned on another chain", async () => {
      // The cap guards one wallet per chain. Mixing chains would let one chain's usage halt the
      // other.
      await seedSpend(GAS_USED * 100n, GAS_PRICE, "now()", CHAIN_ID + 1);

      const result = await stepOnce(
        sql,
        chain,
        { ...config, dailySpendCapWei: RECEIPT_COST_WEI },
        log,
      );

      expect(result.to).toBe("submitted");
    });
  });
});
