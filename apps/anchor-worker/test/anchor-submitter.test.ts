import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import {
  chainBacklog,
  inFlightSends,
  shouldBackOff,
  spentTodayWei,
  stepOnce,
  type ChainClient,
  feeCeilingOf,
  type FeeQuote,
  type PreparedSend,
  type SafeProposer,
  type SendRootInput,
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

const CHAIN_ID = 31337;
const ROOT = `0x${"11".repeat(32)}`;
const MANIFEST = `0x${"22".repeat(32)}`;
const TX_HASH = `0x${"44".repeat(32)}`;
const TX_HASH_2 = `0x${"55".repeat(32)}`;
const SIGNER = `0x${"5a".repeat(20)}`;
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
  // Equal to GAS_USED, so one send's most at the 1 gwei quote equals one receipt's cost.
  gasLimit: 100_000n,
  finalityTag: "none",
  // Retried at once unless a case tests the delay; given up only by cases that test it.
  chainSearchRetryMs: 0,
  chainSearchGiveUpMs: 60 * 60 * 1000,
};

const PRIORITY_FEE = 1_000_000n;

/** Gas cost of one receipt = 100_000 × 1 gwei = 1e14 wei. */
const GAS_USED = 100_000n;
const GAS_PRICE = 1_000_000_000n;
const RECEIPT_COST_WEI = GAS_USED * GAS_PRICE;

/** The case's batch id. Set per case; a successful receipt stores this batch unless told otherwise. */
let caseBatchId = "";

const receipt = (
  blockNumber: number,
  blockHash: string,
  status: "success" | "reverted" = "success",
  extra: {
    l1Fee?: bigint;
    rootSubmissions?: { batchId: string; root: string; contract?: string }[];
    /** The contract that emitted the default RootSubmitted. Default: the configured one. */
    contract?: string;
  } = {},
): Observation => ({
  kind: "receipt",
  status,
  blockNumber,
  blockHash,
  gasUsed: GAS_USED,
  effectiveGasPrice: GAS_PRICE,
  l1Fee: extra.l1Fee ?? 0n,
  // A reverted call emits nothing; a successful submitRoot emits RootSubmitted for its batch.
  rootSubmissions: (
    extra.rootSubmissions ?? (status === "success" ? [{ batchId: caseBatchId, root: ROOT }] : [])
  ).map((log) => ({ contract: extra.contract ?? config.contractAddress, ...log })),
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
  /** When set, only this contract holds `anchored`; every other contract holds nothing. */
  anchoredOn: string | null = null;
  /** The contract each `anchoredBatch` call asked. */
  anchoredAsked: string[] = [];
  /** Set to make the chain read fail, as a node restart or rate limit would. */
  anchoredError: Error | null = null;

  async anchoredBatch(
    _batchId: string,
    contractAddress: string,
  ): Promise<{ root: string; txHash: string | null } | null> {
    this.anchoredAsked.push(contractAddress.toLowerCase());
    if (this.anchoredError) throw this.anchoredError;
    if (this.anchoredOn !== null && this.anchoredOn !== contractAddress.toLowerCase()) return null;
    return this.anchored;
  }

  async headBlockNumber(): Promise<number> {
    return this.head;
  }

  /** What the node reports for the finality tag. null: the read fails. */
  finalized: number | null = 0;
  finalizedTags: string[] = [];

  async finalizedBlockNumber(tag: string): Promise<number> {
    this.finalizedTags.push(tag);
    if (this.finalized === null) throw new Error("tag not supported");
    return this.finalized;
  }

  /** The L1 data fee reserved per send. Error: the oracle read fails. */
  l1Fee: bigint | Error = 0n;
  l1FeeInputs: SendRootInput[] = [];

  async l1FeeBound(input: SendRootInput): Promise<bigint> {
    this.l1FeeInputs.push(input);
    if (this.l1Fee instanceof Error) throw this.l1Fee;
    return this.l1Fee;
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

  /** Hashes handed out by successive sends. Empty: every send is TX_HASH. */
  hashes: string[] = [];
  /** Nonce the next send is signed with. */
  nextNonce = 0;
  /** Signer's nonce at the block `confirmationDepth` deep: every nonce below it is taken. */
  confirmedNonceValue = 0;
  confirmedNonceAt: number[] = [];
  blockGasLimitValue = 30_000_000n;

  async prepareSubmitRoot(input: SendRootInput): Promise<PreparedSend> {
    const txHash = this.hashes.shift() ?? TX_HASH;
    const nonce = this.nextNonce;
    return {
      txHash,
      from: SIGNER,
      nonce,
      gasLimit: input.gasLimit,
      maxFeePerGas: feeCeilingOf(input.fees),
      raw: { input },
    };
  }

  async broadcast(prepared: PreparedSend): Promise<string> {
    if (this.submitError) {
      // Signing alone does not consume the nonce; neither does a rejected broadcast.
      throw this.submitError;
    }
    this.nextNonce = prepared.nonce + 1;
    this.submitted.push((prepared.raw as { input: unknown }).input);
    return prepared.txHash;
  }

  async confirmedNonce(_address: string, blockNumber: number): Promise<number> {
    this.confirmedNonceAt.push(blockNumber);
    return this.confirmedNonceValue;
  }

  blockGasLimitError: Error | null = null;

  async blockGasLimit(): Promise<bigint> {
    if (this.blockGasLimitError) throw this.blockGasLimitError;
    return this.blockGasLimitValue;
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
    await sql`DELETE FROM chain.anchor_sends`;
    await sql`DELETE FROM chain.anchor_proposals`;
    await sql`DELETE FROM chain.transactions WHERE chain_id = ${CHAIN_ID}`;
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`anchor-${tenantId.slice(0, 8)}`}, 'anchor test')
    `;

    batchRowId = randomUUID();
    batchExternalId = `0x${batchRowId.replace(/-/g, "").repeat(2)}`;
    caseBatchId = batchExternalId;
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
        gasLimit: config.gasLimit,
      },
    ]);

    const row = await stateOf();
    expect(row.state).toBe("submitted");
    expect(row.tx_hash).toBe(TX_HASH);
  });

  /** The contract recorded with the row's hash — what public proofs name. */
  async function contractOf() {
    const [row] = await sql<{ contract_address: string | null }[]>`
      SELECT contract_address FROM chain.transactions WHERE id = ${transactionId}
    `;
    return row!.contract_address;
  }

  /** A later contract version: deployed at a new address, the earlier one stays readable. */
  const NEXT_CONTRACT = `0x${"dd".repeat(20)}`;

  it("records the contract it sent to in the same update as the hash", async () => {
    expect(await contractOf()).toBeNull();
    await step();
    expect(await stateOf()).toMatchObject({ state: "submitted", tx_hash: TX_HASH });
    expect(await contractOf()).toBe(config.contractAddress);
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

    it("records the contract the recovered hash was found on", async () => {
      chain.anchored = { root: ROOT, txHash: LOST_HASH };
      await step();
      expect(await stateOf()).toMatchObject({ state: "submitted", tx_hash: LOST_HASH });
      expect(await contractOf()).toBe(config.contractAddress);
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

    it("follows on the row's own contract after the configuration moved to another", async () => {
      // Sent to the first contract; the worker now sends to a later one. The duplicate reverted
      // because the first contract already held the batch, so that is where the other
      // transaction is found, and the followed hash stays paired with it.
      await step();
      expect(await contractOf()).toBe(config.contractAddress);
      chain.observation = receipt(100, BLOCK_A, "reverted");
      chain.anchored = { root: ROOT, txHash: LOST_HASH };
      chain.anchoredOn = config.contractAddress;
      const result = await stepOnce(sql, chain, { ...config, contractAddress: NEXT_CONTRACT }, log);

      expect(result).toMatchObject({ to: "submitted", reason: "duplicate_send_reverted" });
      expect(chain.anchoredAsked.at(-1)).toBe(config.contractAddress);
      expect(await stateOf()).toMatchObject({ state: "submitted", tx_hash: LOST_HASH });
      expect(await contractOf()).toBe(config.contractAddress);
    });

    it("follows on the configured contract for a row recorded without one, and records it", async () => {
      // A row hashed before the worker recorded the contract has only the configuration to go by.
      await sql`
        UPDATE chain.transactions
        SET state = 'submitted', tx_hash = ${TX_HASH}, submitted_at = now()
        WHERE id = ${transactionId}
      `;
      expect(await contractOf()).toBeNull();
      chain.observation = receipt(100, BLOCK_A, "reverted");
      chain.anchored = { root: ROOT, txHash: LOST_HASH };
      chain.anchoredOn = NEXT_CONTRACT;
      await stepOnce(sql, chain, { ...config, contractAddress: NEXT_CONTRACT }, log);

      expect(chain.anchoredAsked).toEqual([NEXT_CONTRACT]);
      expect(await stateOf()).toMatchObject({ state: "submitted", tx_hash: LOST_HASH });
      expect(await contractOf()).toBe(NEXT_CONTRACT);
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

  describe("RPC URLs in errors are masked before they are stored (L5)", () => {
    // Hosted RPC endpoints carry the API key in the path or query. viem quotes the URL in its
    // error messages, and last_error is served by `GET /anchor-batches` as `lastError`.
    const RPC_URL = "https://bsc.rpc.example/v1/SECRETPATHKEY?apikey=SECRETQUERYKEY";
    const viemError = (url: string) =>
      new Error(`HTTP request failed.\n\nStatus: 429\nURL: ${url}\nRequest body: {"method":"eth_call"}`);
    const masked = { ...config, rpcUrl: RPC_URL };
    const stepMasked = () => stepOnce(sql, chain, masked, log);

    function expectNoSecret(text: string | null | undefined) {
      expect(text ?? "").not.toContain("SECRETPATHKEY");
      expect(text ?? "").not.toContain("SECRETQUERYKEY");
      expect(text ?? "").not.toContain("SECRETOTHER");
    }

    it("masks the configured RPC URL when a send fails", async () => {
      chain.submitError = viemError(RPC_URL);
      await stepMasked();

      const row = await stateOf();
      expect(row.last_error).toContain("HTTP request failed");
      expectNoSecret(row.last_error);
      for (const record of logs) expectNoSecret(JSON.stringify(record));
    });

    it("masks the path and query of any other URL in the error", async () => {
      chain.submitError = viemError("https://fallback.example/rpc/SECRETOTHER?key=SECRETOTHER");
      await stepMasked();

      const row = await stateOf();
      expect(row.last_error).toContain("fallback.example");
      expectNoSecret(row.last_error);
    });

    it("masks it on failed chain reads too", async () => {
      chain.feeError = viemError(RPC_URL);
      await stepMasked();
      expectNoSecret((await stateOf()).last_error);

      chain.feeError = null;
      chain.anchoredError = viemError(RPC_URL);
      await stepMasked();
      expectNoSecret((await stateOf()).last_error);

      chain.anchoredError = null;
      await stepMasked();
      chain.observeError = viemError(RPC_URL);
      await stepMasked();
      const row = await stateOf();
      expect(row.last_error).toContain("observation_failed");
      expectNoSecret(row.last_error);
    });

    it("masks it when a reverted send cannot be checked against the chain", async () => {
      await stepMasked();
      chain.observation = receipt(100, BLOCK_A, "reverted");
      chain.anchoredError = viemError(RPC_URL);
      await stepMasked();

      const row = await stateOf();
      expect(row.last_error).toContain("duplicate_check_failed");
      expectNoSecret(row.last_error);
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

  it("records the proposal's target with the executed hash, not the worker's current contract", async () => {
    const executedHash = `0x${"7d".repeat(32)}`;
    let executed = false;
    const safe = fakeSafe({
      async status() {
        return executed
          ? { kind: "executed", transactionHash: executedHash }
          : { kind: "pending", confirmations: 1, threshold: 3 };
      },
    });

    await stepOnce(sql, chain, safeConfigOf(), log, safe);
    const [proposal] = await sql<{ contract_address: string }[]>`
      SELECT contract_address FROM chain.anchor_proposals WHERE transaction_id = ${transactionId}
    `;
    expect(proposal!.contract_address).toBe(config.contractAddress);

    // Owners execute after the worker was reconfigured for a new contract version. What they
    // executed is the proposal, which calls the contract it was built for.
    executed = true;
    const result = await stepOnce(sql, chain, { ...safeConfigOf(), contractAddress: NEXT_CONTRACT }, log, safe);
    expect(result.to).toBe("submitted");
    expect(await stateOf()).toMatchObject({ state: "submitted", tx_hash: executedHash });
    expect(await contractOf()).toBe(config.contractAddress);
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

    describe("transactions still waiting for a receipt (in flight)", () => {
      /** The most one in-flight transaction can burn: gas limit × fee cap. */
      const IN_FLIGHT_MAX = config.gasLimit * config.feeCapWei;
      /** The most this send can burn at the 1 gwei quote. */
      const SEND_MAX = config.gasLimit * GAS_PRICE;

      async function insertCreated(): Promise<string> {
        const batch = randomUUID();
        const external = `0x${batch.replace(/-/g, "").repeat(2)}`;
        await sql`
          INSERT INTO chain.anchor_batches (
            id, tenant_id, batch_id, merkle_root, manifest_hash,
            manifest_object_key, schema_version, record_count
          ) VALUES (
            ${batch}, ${tenantId}, ${external}, ${ROOT}, ${MANIFEST}, 'manifests/second.json', '1', 2
          )
        `;
        const id = randomUUID();
        await sql`
          INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state)
          VALUES (${id}, ${tenantId}, ${batch}, ${`anchor:${external}`}, ${CHAIN_ID}, 'created')
        `;
        return id;
      }

      async function insertInFlight(): Promise<{ id: string; txHash: string }> {
        const id = randomUUID();
        const txHash = `0x${id.replace(/-/g, "").repeat(2)}`;
        await sql`
          INSERT INTO chain.transactions (
            id, tenant_id, intent_key, chain_id, state, tx_hash, submitted_at
          ) VALUES (
            ${id}, ${tenantId}, ${`inflight:${id}`}, ${CHAIN_ID}, 'submitted', ${txHash}, now()
          )
        `;
        // Sent at the fee cap, so its most is gas limit × fee cap.
        await sql`
          INSERT INTO chain.anchor_sends (
            chain_id, tx_hash, transaction_id, tenant_id, signer, nonce, gas_limit, max_fee_per_gas
          ) VALUES (
            ${CHAIN_ID}, ${txHash}, ${id}, ${tenantId}, ${SIGNER}, 99,
            ${config.gasLimit.toString()}, ${config.feeCapWei.toString()}
          )
        `;
        return { id, txHash };
      }

      it("sends with the configured gas limit, so its most is bounded", async () => {
        await step();
        expect(chain.submitted[0]).toMatchObject({ gasLimit: config.gasLimit });
      });

      it("counts a sent transaction with no receipt yet at its most", async () => {
        await insertInFlight();

        const result = await stepOnce(
          sql,
          chain,
          { ...config, dailySpendCapWei: IN_FLIGHT_MAX + SEND_MAX - 1n },
          log,
        );

        expect(result.reason).toBe("DAILY_SPEND_CAP_REACHED");
        expect(chain.submitted).toEqual([]);
      });

      it("submits when the in-flight most and this send's most fit under the cap", async () => {
        await insertInFlight();

        const result = await stepOnce(
          sql,
          chain,
          { ...config, dailySpendCapWei: IN_FLIGHT_MAX + SEND_MAX },
          log,
        );

        expect(result.to).toBe("submitted");
      });

      it("counts it at its actual cost once its receipt is in the ledger", async () => {
        const inFlight = await insertInFlight();
        await sql`
          INSERT INTO chain.gas_spend (
            chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price
          ) VALUES (
            ${CHAIN_ID}, ${inFlight.txHash}, ${inFlight.id}, ${tenantId},
            ${GAS_USED.toString()}, ${GAS_PRICE.toString()}
          )
        `;

        const result = await stepOnce(
          sql,
          chain,
          { ...config, dailySpendCapWei: RECEIPT_COST_WEI + SEND_MAX },
          log,
        );

        expect(result.to).toBe("submitted");
      });

      it("two workers cannot both pass the check before either has recorded its send", async () => {
        // Each worker locks a different created row (SKIP LOCKED), so row locks alone let both
        // read the same spend and both send. The cap here fits exactly one send.
        await insertCreated();
        let releaseSend!: () => void;
        const sendGate = new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        let firstEntered!: () => void;
        const entered = new Promise<void>((resolve) => {
          firstEntered = resolve;
        });
        class GatedChain extends FakeChain {
          sends = 0;
          override async prepareSubmitRoot(input: SendRootInput): Promise<PreparedSend> {
            this.sends += 1;
            return { ...(await super.prepareSubmitRoot(input)), txHash: `0x${String(this.sends).padStart(64, "0")}` };
          }

          override async broadcast(prepared: PreparedSend): Promise<string> {
            this.submitted.push((prepared.raw as { input: unknown }).input);
            firstEntered();
            await sendGate;
            return prepared.txHash;
          }
        }
        const gated = new GatedChain();
        const capped = { ...config, dailySpendCapWei: SEND_MAX };

        const first = stepOnce(sql, gated, capped, log);
        await entered;
        const second = stepOnce(sql, gated, capped, log);
        // Give the second worker time to reach its send, were nothing holding it back.
        await new Promise((resolve) => setTimeout(resolve, 300));
        releaseSend();
        const results = await Promise.all([first, second]);

        expect(gated.submitted).toHaveLength(1);
        expect(results.map((result) => result.reason)).toContain("DAILY_SPEND_CAP_REACHED");
      });
    });

    describe("every send is in the send ledger until settled (fail-closed)", () => {
      // The cap must not open because a row's state moved on. Every hash this wallet signed counts
      // at its most until its receipt is recorded or its nonce is taken by another transaction.
      const SEND_MAX = config.gasLimit * GAS_PRICE;
      const capOne = { ...config, dailySpendCapWei: SEND_MAX };

      /** What `POST /anchor-batches/:id/resubmit` does to the row. */
      async function resubmitFrom(state: string) {
        await sql`UPDATE chain.transactions SET state = ${state} WHERE id = ${transactionId}`;
        await sql`
          UPDATE chain.transactions
          SET state = 'created', attempts = 0,
              tx_hash = NULL, block_number = NULL, block_hash = NULL,
              confirmations = 0, confirmed_at = NULL, submitted_at = NULL,
              last_error = ${`resubmitted_from_${state}`}, updated_at = now()
          WHERE id = ${transactionId}
        `;
      }

      async function ledger() {
        return sql<{ tx_hash: string; nonce: string | null; settled_reason: string | null }[]>`
          SELECT tx_hash, nonce::TEXT, settled_reason FROM chain.anchor_sends
          WHERE transaction_id = ${transactionId} ORDER BY sent_at, tx_hash
        `;
      }

      it("records the send with its nonce, gas limit and fee before it counts as sent", async () => {
        await step();

        const [row] = await sql<
          { tx_hash: string; signer: string; nonce: string; gas_limit: string; max_fee_per_gas: string }[]
        >`
          SELECT tx_hash, signer, nonce::TEXT, gas_limit::TEXT, max_fee_per_gas::TEXT
          FROM chain.anchor_sends WHERE transaction_id = ${transactionId}
        `;
        expect(row).toEqual({
          tx_hash: TX_HASH,
          signer: SIGNER,
          nonce: "0",
          gas_limit: config.gasLimit.toString(),
          max_fee_per_gas: chain.fee.toString(),
        });
      });

      it("keeps a failed broadcast in flight — it may have reached the network", async () => {
        chain.submitError = new Error("timeout");
        await step();

        expect(await ledger()).toEqual([{ tx_hash: TX_HASH, nonce: "0", settled_reason: null }]);
      });

      it("still counts an earlier hash after a resubmission cleared it from the row", async () => {
        await step();
        await resubmitFrom("dropped");

        const result = await stepOnce(sql, chain, capOne, log);

        expect(result.reason).toBe("DAILY_SPEND_CAP_REACHED");
        expect(chain.submitted).toHaveLength(1);
      });

      it("still counts a dropped send however long ago it was sent", async () => {
        await step();
        await sql`
          UPDATE chain.transactions
          SET state = 'dropped', submitted_at = now() - interval '3 days'
          WHERE id = ${transactionId}
        `;
        await resubmitFrom("dropped");
        chain.observation = { kind: "unknown" };

        const result = await stepOnce(sql, chain, capOne, log);

        expect(result.reason).toBe("DAILY_SPEND_CAP_REACHED");
      });

      it("records the receipt of an earlier hash after its row has moved on", async () => {
        await step();
        await resubmitFrom("dropped");
        chain.observation = receipt(100, BLOCK_A);

        await stepOnce(sql, chain, capOne, log);

        const [spend] = await sql<{ tx_hash: string }[]>`
          SELECT tx_hash FROM chain.gas_spend WHERE transaction_id = ${transactionId}
        `;
        expect(spend?.tx_hash).toBe(TX_HASH);
        expect((await ledger())[0]?.settled_reason).toBe("receipt");
      });

      it("settles a send whose nonce another transaction took, confirmed at depth", async () => {
        await step();
        await resubmitFrom("dropped");
        chain.observation = { kind: "unknown" };
        chain.confirmedNonceValue = 1;
        chain.hashes = [TX_HASH_2];

        const result = await stepOnce(sql, chain, capOne, log);

        // Asked at the block `confirmationDepth` deep, so a reorg cannot hand the nonce back.
        expect(chain.confirmedNonceAt).toContain(chain.head - config.confirmationDepth + 1);
        expect((await ledger())[0]?.settled_reason).toBe("nonce_consumed");
        expect(result.to).toBe("submitted");
      });

      it("does not settle by nonce while the nonce is still free at depth", async () => {
        await step();
        await resubmitFrom("dropped");
        chain.observation = { kind: "unknown" };
        chain.confirmedNonceValue = 0;

        const result = await stepOnce(sql, chain, capOne, log);

        expect((await ledger())[0]?.settled_reason).toBeNull();
        expect(result.reason).toBe("DAILY_SPEND_CAP_REACHED");
      });

      it("settles by receipt, not by nonce, when its own transaction took the nonce", async () => {
        await step();
        await resubmitFrom("dropped");
        chain.observation = receipt(100, BLOCK_A);
        chain.confirmedNonceValue = 1;

        await stepOnce(sql, chain, capOne, log);

        expect((await ledger())[0]?.settled_reason).toBe("receipt");
      });

      it("keeps the send in flight when the chain cannot be asked", async () => {
        await step();
        await resubmitFrom("dropped");
        chain.observeError = new Error("rpc unavailable");
        chain.confirmedNonceValue = 1;

        const result = await stepOnce(sql, chain, capOne, log);

        expect((await ledger())[0]?.settled_reason).toBeNull();
        expect(result.reason).toBe("DAILY_SPEND_CAP_REACHED");
      });

      it("does not broadcast when the send cannot be written to the ledger", async () => {
        // An invalid hash fails the ledger's CHECK — any failure to commit the row will do.
        chain.hashes = ["0xnot-a-hash"];

        const result = await step();

        expect(chain.submitted).toEqual([]);
        expect(result.reason).toBe("send_ledger_failed");
        const row = await stateOf();
        expect(row.state).toBe("created");
        expect(row.last_error).toContain("send_ledger_failed");
      });

      it("waits when the block gas limit for an unbounded send cannot be read", async () => {
        await sql`
          INSERT INTO chain.anchor_sends (chain_id, tx_hash, transaction_id, tenant_id)
          VALUES (${CHAIN_ID}, ${TX_HASH_2}, ${transactionId}, ${tenantId})
        `;
        chain.observation = { kind: "unknown" };
        chain.blockGasLimitError = new Error("rpc unavailable");

        const result = await step();

        expect(result.reason).toBe("block_gas_limit_failed");
        expect(chain.submitted).toEqual([]);
      });

      it("counts a send recorded without a gas limit at the block gas limit", async () => {
        // Sent before every send carried a fixed gas limit: its most is bounded only by the block.
        await sql`
          INSERT INTO chain.anchor_sends (chain_id, tx_hash, transaction_id, tenant_id)
          VALUES (${CHAIN_ID}, ${TX_HASH_2}, ${transactionId}, ${tenantId})
        `;
        chain.observation = { kind: "unknown" };
        const legacyMax = chain.blockGasLimitValue * config.feeCapWei;

        const blocked = await stepOnce(
          sql,
          chain,
          { ...config, dailySpendCapWei: legacyMax + SEND_MAX - 1n },
          log,
        );
        expect(blocked.reason).toBe("DAILY_SPEND_CAP_REACHED");

        const allowed = await stepOnce(
          sql,
          chain,
          { ...config, dailySpendCapWei: legacyMax + SEND_MAX },
          log,
        );
        expect(allowed.to).toBe("submitted");
      });
    });

    describe("a dropped transaction that is mined later", () => {
      // `dropped` means "the node no longer knows it", not "it will never be mined". Another node
      // can still hold and mine it; its gas then leaves the wallet and must reach the ledger.
      async function dropIt() {
        await step();
        await sql`
          UPDATE chain.transactions SET submitted_at = now() - interval '2 minutes'
          WHERE id = ${transactionId}
        `;
        chain.observation = { kind: "unknown" };
        await step();
        expect((await stateOf()).state).toBe("dropped");
      }

      async function ledgerRows() {
        return sql<{ tx_hash: string; gas_used: string }[]>`
          SELECT tx_hash, gas_used::TEXT FROM chain.gas_spend WHERE transaction_id = ${transactionId}
        `;
      }

      it("records its gas in the ledger", async () => {
        await dropIt();
        chain.observation = receipt(100, BLOCK_A);

        await step();

        expect(await ledgerRows()).toEqual([{ tx_hash: TX_HASH, gas_used: String(GAS_USED) }]);
        // Still a human's call: the state stays dropped, the row says why it needs a look.
        const row = await stateOf();
        expect(row.state).toBe("dropped");
        expect(row.last_error).toBe("mined_after_drop");
      });

      it("counts it once, however often it is seen again", async () => {
        await dropIt();
        chain.observation = receipt(100, BLOCK_A);
        await step();
        await step();
        await step();

        expect(await ledgerRows()).toHaveLength(1);
      });

      it("keeps watching it however long ago it was sent", async () => {
        // No watch window: a window is a time after which the cap stops counting a send that
        // can still be mined.
        await dropIt();
        await sql`
          UPDATE chain.transactions SET submitted_at = now() - interval '3 days'
          WHERE id = ${transactionId}
        `;
        chain.observation = receipt(100, BLOCK_A);

        await step();

        expect(await ledgerRows()).toHaveLength(1);
      });

      it("does not starve a created transaction", async () => {
        await dropIt();
        const otherBatch = randomUUID();
        const otherExternal = `0x${otherBatch.replace(/-/g, "").repeat(2)}`;
        await sql`
          INSERT INTO chain.anchor_batches (
            id, tenant_id, batch_id, merkle_root, manifest_hash,
            manifest_object_key, schema_version, record_count
          ) VALUES (
            ${otherBatch}, ${tenantId}, ${otherExternal}, ${ROOT}, ${MANIFEST},
            'manifests/other.json', '1', 2
          )
        `;
        const otherTx = randomUUID();
        await sql`
          INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state)
          VALUES (${otherTx}, ${tenantId}, ${otherBatch}, ${`anchor:${otherExternal}`}, ${CHAIN_ID}, 'created')
        `;

        const result = await step();

        expect(result.transactionId).toBe(otherTx);
      });
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

  describe("L1 data fee on OP-stack chains (opBNB)", () => {
    /** An L1 fee large enough that leaving it out changes the day's total visibly. */
    const L1_FEE = 70_000_000_000_000n;

    it("records the receipt's L1 data fee and counts it in today's spend", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A, "success", { l1Fee: L1_FEE });
      await step();

      const [row] = await sql<{ l1_fee: string }[]>`
        SELECT l1_fee::TEXT FROM chain.gas_spend WHERE tx_hash = ${TX_HASH}
      `;
      expect(row!.l1_fee).toBe(L1_FEE.toString());
      expect(await spentTodayWei(sql, CHAIN_ID)).toBe(RECEIPT_COST_WEI + L1_FEE);
    });

    it("reserves the quoted L1 fee for a send in flight, priced on what was signed", async () => {
      chain.l1Fee = L1_FEE;
      await step();

      // Quoted for the exact input that was then signed and sent.
      expect(chain.l1FeeInputs).toEqual(chain.submitted);
      const [send] = await sql<{ l1_fee_bound: string }[]>`
        SELECT l1_fee_bound::TEXT FROM chain.anchor_sends WHERE tx_hash = ${TX_HASH}
      `;
      expect(send!.l1_fee_bound).toBe(L1_FEE.toString());
      expect((await inFlightSends(sql, CHAIN_ID, config.feeCapWei)).boundedWei).toBe(
        config.gasLimit * chain.fee + L1_FEE,
      );
    });

    it("blocks a send whose L1 fee would carry the day past the cap", async () => {
      // Gas limit × the 1 gwei quote fills the cap exactly; one wei of L1 fee is over it.
      const cap = { ...config, dailySpendCapWei: config.gasLimit * chain.fee };
      chain.l1Fee = 1n;
      expect((await stepOnce(sql, chain, cap, log)).reason).toBe("DAILY_SPEND_CAP_REACHED");
      expect(chain.submitted).toEqual([]);

      chain.l1Fee = 0n;
      expect((await stepOnce(sql, chain, cap, log)).to).toBe("submitted");
    });

    it("preserves retry headroom after a receipt has already spent one wei", async () => {
      chain.l1Fee = L1_FEE;
      chain.fee = config.feeCapWei;
      await sql`
        INSERT INTO chain.gas_spend (chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price)
        VALUES (${CHAIN_ID}, ${`0x${"77".repeat(32)}`}, ${transactionId}, ${tenantId}, 1, 1)
      `;
      const capped = { ...config, dailySpendCapWei: 2n * (config.gasLimit * config.feeCapWei + L1_FEE) };
      const blocked = await stepOnce(sql, chain, capped, log);
      expect(blocked).toMatchObject({ reason: "DAILY_SPEND_CAP_TOO_LOW_FOR_RETRY", waiting: true });
      expect(chain.submitted).toEqual([]);
      expect(await sql`SELECT 1 FROM chain.anchor_sends WHERE transaction_id = ${transactionId}`).toHaveLength(0);
    });

    it.each(["same nonce", "another nonce", "another signer", "another transaction"])(
      "uses only an existing reservation for the prepared identity: %s",
      async (identity) => {
        chain.l1Fee = L1_FEE;
        chain.fee = config.feeCapWei;
        const reserve = config.gasLimit * config.feeCapWei + L1_FEE;
        let owner = transactionId;
        if (identity === "another transaction") {
          owner = randomUUID();
          await sql`
            INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state)
            VALUES (${owner}, ${tenantId}, ${batchRowId}, ${`other:${owner}`}, ${CHAIN_ID}, 'failed')
          `;
        }
        await sql`
          INSERT INTO chain.anchor_sends (
            chain_id, tx_hash, transaction_id, tenant_id, signer, nonce,
            gas_limit, max_fee_per_gas, l1_fee_bound
          ) VALUES (
            ${CHAIN_ID}, ${TX_HASH_2}, ${owner}, ${tenantId},
            ${identity === "another signer" ? `0x${"6b".repeat(20)}` : SIGNER},
            ${identity === "another nonce" ? 1 : 0},
            ${config.gasLimit.toString()}, ${config.feeCapWei.toString()}, ${L1_FEE.toString()}
          )
        `;
        const result = await stepOnce(sql, chain, { ...config, dailySpendCapWei: 2n * reserve }, log);
        if (identity === "same nonce") {
          expect(result.to).toBe("submitted");
          expect(chain.submitted).toHaveLength(1);
        } else {
          expect(result).toMatchObject({ reason: "DAILY_SPEND_CAP_TOO_LOW_FOR_RETRY", waiting: true });
          expect(chain.submitted).toHaveLength(0);
          expect((await stateOf()).attempts).toBe(0);
        }
        const [prior] = await sql`SELECT settled_at FROM chain.anchor_sends WHERE tx_hash = ${TX_HASH_2}`;
        expect(prior!.settled_at).toBeNull();
      },
    );

    it.each(["settled", "receipted"])("ignores a %s reservation as retry credit", async (status) => {
      chain.l1Fee = L1_FEE;
      chain.fee = config.feeCapWei;
      const reserve = config.gasLimit * config.feeCapWei + L1_FEE;
      for (const [hash, signer] of [[TX_HASH_2, SIGNER], [`0x${"77".repeat(32)}`, `0x${"6b".repeat(20)}`]]) {
        await sql`
          INSERT INTO chain.anchor_sends (
            chain_id, tx_hash, transaction_id, tenant_id, signer, nonce,
            gas_limit, max_fee_per_gas, l1_fee_bound
          ) VALUES (
            ${CHAIN_ID}, ${hash!}, ${transactionId}, ${tenantId}, ${signer!}, 0,
            ${config.gasLimit.toString()}, ${config.feeCapWei.toString()}, ${L1_FEE.toString()}
          )
        `;
      }
      if (status === "settled") {
        await sql`UPDATE chain.anchor_sends SET settled_at = now(), settled_reason = 'operator' WHERE tx_hash = ${TX_HASH_2}`;
      } else {
        await sql`
          INSERT INTO chain.gas_spend (chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price)
          VALUES (${CHAIN_ID}, ${TX_HASH_2}, ${transactionId}, ${tenantId}, 1, 1)
        `;
      }
      const cap = 2n * reserve + (status === "receipted" ? 1n : 0n);
      const result = await stepOnce(sql, chain, { ...config, dailySpendCapWei: cap }, log);
      expect(result).toMatchObject({ reason: "DAILY_SPEND_CAP_TOO_LOW_FOR_RETRY", waiting: true });
      expect(chain.submitted).toHaveLength(0);
      expect((await stateOf()).attempts).toBe(0);
    });

    it("requires retry room including L1 fees before admitting the first broadcast", async () => {
      chain.l1Fee = L1_FEE;
      const gasOnlyMinimum = 2n * config.gasLimit * config.feeCapWei;
      const capped = { ...config, dailySpendCapWei: gasOnlyMinimum };

      const blocked = await stepOnce(sql, chain, capped, log);

      expect(blocked).toMatchObject({ reason: "DAILY_SPEND_CAP_TOO_LOW_FOR_RETRY", waiting: true });
      expect(chain.nextNonce).toBe(0);
      expect(await sql`SELECT 1 FROM chain.anchor_sends WHERE transaction_id = ${transactionId}`).toHaveLength(0);

      // At the inclusive minimum a failed broadcast keeps its reservation, yet a replacement
      // at the configured gas ceiling can still reuse its free nonce.
      capped.dailySpendCapWei += 2n * L1_FEE;
      chain.fee = config.feeCapWei;
      chain.hashes = [TX_HASH, TX_HASH_2];
      chain.submitError = new Error("broadcast rejected before reaching the network");
      expect((await stepOnce(sql, chain, capped, log)).reason).toBe("submit_failed");
      expect((await inFlightSends(sql, CHAIN_ID, config.feeCapWei)).boundedWei).toBe(
        config.gasLimit * config.feeCapWei + L1_FEE,
      );

      chain.submitError = null;
      expect((await stepOnce(sql, chain, capped, log)).to).toBe("submitted");
      const sends = await sql<{ nonce: string; settled_at: Date | null }[]>`
        SELECT nonce::TEXT, settled_at FROM chain.anchor_sends
        WHERE transaction_id = ${transactionId}
      `;
      expect(sends).toHaveLength(2);
      expect(sends.every((send) => send.nonce === "0" && send.settled_at === null)).toBe(true);
    });

    it("waits with a recorded reason when the L1 fee cannot be quoted, and does not send", async () => {
      chain.l1Fee = new Error("oracle unavailable");
      const result = await step();

      expect(result).toMatchObject({ reason: "l1_fee_estimate_failed", waiting: true });
      expect(chain.submitted).toEqual([]);
      const row = await stateOf();
      expect(row.state).toBe("created");
      expect(row.last_error).toMatch(/^l1_fee_estimate_failed: /);
      const sends = await sql`SELECT 1 FROM chain.anchor_sends WHERE transaction_id = ${transactionId}`;
      expect(sends).toHaveLength(0);
    });

    it("does not price the L1 fee for a Safe proposal, which this wallet does not pay", async () => {
      chain.l1Fee = new Error("oracle unavailable");
      const result = await stepOnce(sql, chain, safeConfigOf(), log, fakeSafe());

      expect(result.to).toBe("proposed");
      expect(chain.l1FeeInputs).toEqual([]);
    });
  });

  describe("a successful receipt confirms only if it stored the root", () => {
    it("hands a receipt with no RootSubmitted to a person instead of confirming it", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A, "success", { rootSubmissions: [] });
      chain.head = 102;
      const result = await step();

      expect(result).toMatchObject({
        to: "reconciliation_required",
        reason: "receipt_without_root_submitted",
      });
      const row = await stateOf();
      expect(row.state).toBe("reconciliation_required");
      expect(row.confirmed_at).toBeNull();
      // Its gas was burned all the same.
      const spent = await sql`SELECT 1 FROM chain.gas_spend WHERE tx_hash = ${TX_HASH}`;
      expect(spent).toHaveLength(1);
    });

    it.each([
      ["another root", () => [{ batchId: caseBatchId, root: `0x${"99".repeat(32)}` }]],
      ["another batch", () => [{ batchId: `0x${"98".repeat(32)}`, root: ROOT }]],
    ])("does not confirm a RootSubmitted for %s", async (_label, logs) => {
      await step();
      chain.observation = receipt(100, BLOCK_A, "success", { rootSubmissions: logs() });
      chain.head = 102;
      await step();

      expect((await stateOf()).state).toBe("reconciliation_required");
    });

    it("follows another transaction that stored the batch", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A, "success", { rootSubmissions: [] });
      chain.anchored = { root: ROOT, txHash: TX_HASH_2 };
      const result = await step();

      expect(result).toMatchObject({ to: "submitted", reason: "anchored_by_another_transaction" });
      const row = await stateOf();
      expect(row.tx_hash).toBe(TX_HASH_2);
      expect(row.last_error).toBe("anchored_by_another_transaction");
    });

    it("waits instead of handing it to a person when the search for another transaction fails", async () => {
      // A rate-limited log search is not "no other transaction stored it".
      await step();
      chain.observation = receipt(100, BLOCK_A, "success", { rootSubmissions: [] });
      chain.anchoredError = new Error("RootSubmitted search incomplete");
      const result = await step();

      expect(result).toMatchObject({
        to: "submitted",
        reason: "anchored_elsewhere_check_failed",
        waiting: true,
      });
      expect(await stateOf()).toMatchObject({ state: "submitted" });
      expect((await stateOf()).last_error).toMatch(/^anchored_elsewhere_check_failed: .*search incomplete/);

      chain.anchoredError = null;
      chain.anchored = { root: ROOT, txHash: TX_HASH_2 };
      expect(await step()).toMatchObject({ to: "submitted", reason: "anchored_by_another_transaction" });
    });

    it("does not confirm a Safe execution whose inner call failed", async () => {
      // Safe's execTransaction succeeds and emits ExecutionFailure when the inner call reverts.
      const executedHash = `0x${"7c".repeat(32)}`;
      const safe = fakeSafe({
        async status() {
          return { kind: "executed", transactionHash: executedHash };
        },
      });
      await stepOnce(sql, chain, safeConfigOf(), log, safe);
      await stepOnce(sql, chain, safeConfigOf(), log, safe);
      expect((await stateOf()).state).toBe("submitted");

      chain.observation = receipt(100, BLOCK_A, "success", { rootSubmissions: [] });
      chain.head = 102;
      await stepOnce(sql, chain, safeConfigOf(), log, safe);

      const row = await stateOf();
      expect(row.state).toBe("reconciliation_required");
      expect(row.last_error).toBe("receipt_without_root_submitted");
    });
  });

  describe("a hashed row is judged against the contract recorded with its hash", () => {
    const moved = { ...config, contractAddress: NEXT_CONTRACT };

    it("keeps a confirmed row confirmed when rechecked after the configuration moved", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A);
      chain.head = 102;
      await step();
      expect((await stateOf()).state).toBe("confirmed");

      // Inside the reorg watch, the worker now configured for the next contract version.
      chain.head = 110;
      const result = await stepOnce(sql, chain, moved, log);

      expect(result).toMatchObject({ from: "confirmed", to: "confirmed" });
      expect(await stateOf()).toMatchObject({ state: "confirmed", last_error: null });
      expect(await contractOf()).toBe(config.contractAddress);
    });

    it("still refuses the old contract's event for a row recorded against the new one", async () => {
      // Contrast: the stored contract decides, in both directions.
      await stepOnce(sql, chain, moved, log);
      expect(await contractOf()).toBe(NEXT_CONTRACT);
      chain.observation = receipt(100, BLOCK_A, "success", { contract: config.contractAddress });
      chain.head = 102;
      await stepOnce(sql, chain, moved, log);

      expect(await stateOf()).toMatchObject({
        state: "reconciliation_required",
        last_error: "receipt_without_root_submitted",
      });
    });

    it("confirms a Safe proposal for the old contract executed after the switch", async () => {
      const executedHash = `0x${"7e".repeat(32)}`;
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
      const safeMoved = { ...safeConfigOf(), contractAddress: NEXT_CONTRACT };
      await stepOnce(sql, chain, safeMoved, log, safe);
      expect(await contractOf()).toBe(config.contractAddress);

      // The owners' execution called the proposal's target, so its RootSubmitted is from there.
      chain.observation = receipt(100, BLOCK_A, "success", { contract: config.contractAddress });
      chain.head = 102;
      await stepOnce(sql, chain, safeMoved, log, safe);

      expect(await stateOf()).toMatchObject({ state: "confirmed", tx_hash: executedHash });
    });

    it("falls back to the configured contract for a row recorded without one", async () => {
      // Hashed before the worker recorded the contract: only the configuration says where.
      await sql`
        UPDATE chain.transactions
        SET state = 'submitted', tx_hash = ${TX_HASH}, submitted_at = now()
        WHERE id = ${transactionId}
      `;
      chain.observation = receipt(100, BLOCK_A);
      chain.head = 102;
      await step();
      expect((await stateOf()).state).toBe("confirmed");
      expect(await contractOf()).toBeNull();
    });

    it("judges a row recorded without one by the configuration, so a moved one does not match", async () => {
      await sql`
        UPDATE chain.transactions
        SET state = 'submitted', tx_hash = ${TX_HASH}, submitted_at = now()
        WHERE id = ${transactionId}
      `;
      chain.observation = receipt(100, BLOCK_A);
      chain.head = 102;
      await stepOnce(sql, chain, moved, log);

      expect((await stateOf()).state).toBe("reconciliation_required");
    });

    it("asks the configured contract before a new send", async () => {
      await stepOnce(sql, chain, moved, log);
      expect(chain.anchoredAsked).toEqual([NEXT_CONTRACT]);
    });
  });

  describe("a chain search that keeps failing", () => {
    const retrying = { ...config, chainSearchRetryMs: 60_000 };

    async function scheduleOf() {
      const [row] = await sql<
        { chain_search_failed_since: Date | null; retry_after: Date | null; attempts: number }[]
      >`
        SELECT chain_search_failed_since, retry_after, attempts
        FROM chain.transactions WHERE id = ${transactionId}
      `;
      return row!;
    }
    /** Moves the start of the failure run back, as if searches had failed for that long. */
    async function failingFor(ms: number) {
      await sql`
        UPDATE chain.transactions
        SET chain_search_failed_since = now() - ${`${ms} milliseconds`}::interval
        WHERE id = ${transactionId}
      `;
    }

    it("hands a batch whose search never finishes to a person once the bound has passed", async () => {
      chain.anchoredError = new Error("RootSubmitted search incomplete");
      const first = await step();
      expect(first).toMatchObject({ to: "created", reason: "reconciliation_check_failed", waiting: true });
      expect((await scheduleOf()).chain_search_failed_since).toBeInstanceOf(Date);

      // Still failing, inside the bound: it keeps waiting, and no attempt is spent.
      await failingFor(config.chainSearchGiveUpMs - 60_000);
      expect(await step()).toMatchObject({ to: "created", waiting: true });

      // Still failing past the bound: a person looks, and the row leaves the queue.
      await failingFor(config.chainSearchGiveUpMs + 1);
      const gaveUp = await step();
      expect(gaveUp).toMatchObject({ to: "reconciliation_required", reason: "chain_search_unavailable" });
      expect((await stateOf()).last_error).toMatch(/^chain_search_unavailable: .*search incomplete/);
      expect(await scheduleOf()).toMatchObject({
        chain_search_failed_since: null,
        retry_after: null,
        attempts: 0,
      });
      expect(chain.submitted).toHaveLength(0);
      expect((await chainBacklog(sql, CHAIN_ID)).needsAttention).toBe(1);
      expect(await step()).toMatchObject({ handled: false });
    });

    it("gives up the same way on a followed transaction whose search never finishes", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A, "reverted");
      chain.anchoredError = new Error("429 Too Many Requests");
      expect(await step()).toMatchObject({ reason: "duplicate_check_failed", waiting: true });
      await failingFor(config.chainSearchGiveUpMs + 1);
      expect(await step()).toMatchObject({ to: "reconciliation_required", reason: "chain_search_unavailable" });
    });

    it("starts the bound again once a search answers", async () => {
      chain.anchoredError = new Error("429 Too Many Requests");
      await step();
      await failingFor(config.chainSearchGiveUpMs - 1_000);
      chain.anchoredError = null;
      expect(await step()).toMatchObject({ to: "submitted" });
      expect(await scheduleOf()).toMatchObject({ chain_search_failed_since: null, retry_after: null });
    });

    it("steps aside for its retry delay, so a later row on the chain is still sent", async () => {
      // A second batch, created after the failing one: oldest-first, it would sit behind it.
      const laterBatchRow = randomUUID();
      const laterBatchId = `0x${laterBatchRow.replace(/-/g, "").repeat(2)}`;
      const laterTransaction = randomUUID();
      await sql`
        INSERT INTO chain.anchor_batches (
          id, tenant_id, batch_id, merkle_root, manifest_hash,
          manifest_object_key, schema_version, record_count
        ) VALUES (
          ${laterBatchRow}, ${tenantId}, ${laterBatchId}, ${ROOT}, ${MANIFEST},
          'manifests/later.json', '1', 2
        )
      `;
      await sql`
        INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state, created_at)
        VALUES (
          ${laterTransaction}, ${tenantId}, ${laterBatchRow},
          ${`anchor:${laterBatchId}`}, ${CHAIN_ID}, 'created', now() + interval '1 second'
        )
      `;

      chain.anchoredError = new Error("429 Too Many Requests");
      const failed = await stepOnce(sql, chain, retrying, log);
      expect(failed).toMatchObject({ transactionId, reason: "reconciliation_check_failed" });
      expect((await scheduleOf()).retry_after!.getTime()).toBeGreaterThan(Date.now() + 30_000);

      // The endpoint answers again; the next pass takes the later row, not the waiting one.
      chain.anchoredError = null;
      chain.hashes = [TX_HASH_2];
      const next = await stepOnce(sql, chain, retrying, log);
      expect(next).toMatchObject({ transactionId: laterTransaction, to: "submitted" });
      expect((await stateOf()).state).toBe("created");
      expect(await stepOnce(sql, chain, retrying, log)).not.toMatchObject({ transactionId });

      // Once its delay is over it is searched again.
      await sql`UPDATE chain.transactions SET retry_after = now() WHERE id = ${transactionId}`;
      expect(await stepOnce(sql, chain, retrying, log)).toMatchObject({ transactionId, to: "submitted" });
    });
  });

  describe("finality tag", () => {
    const safeHead = { ...config, finalityTag: "safe" as const };

    it("stays included past the depth until the block is at or below the safe head", async () => {
      await stepOnce(sql, chain, safeHead, log);
      chain.observation = receipt(100, BLOCK_A);
      chain.head = 110;
      chain.finalized = 99;
      const waiting = await stepOnce(sql, chain, safeHead, log);

      expect(waiting).toMatchObject({ to: "included", reason: "awaiting_finality" });
      expect(chain.finalizedTags).toContain("safe");
      expect((await stateOf()).confirmed_at).toBeNull();

      chain.finalized = 100;
      await stepOnce(sql, chain, safeHead, log);
      expect((await stateOf()).state).toBe("confirmed");
    });

    it("waits with a recorded reason when the tag cannot be read, instead of using depth alone", async () => {
      await stepOnce(sql, chain, safeHead, log);
      chain.observation = receipt(100, BLOCK_A);
      chain.head = 110;
      chain.finalized = null;
      const result = await stepOnce(sql, chain, safeHead, log);

      expect(result).toMatchObject({ reason: "finality_read_failed", waiting: true });
      const row = await stateOf();
      expect(row.state).toBe("submitted");
      expect(row.last_error).toMatch(/^finality_read_failed: /);
    });

    it("does not read a tag when it is none", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A);
      chain.head = 102;
      await step();

      expect((await stateOf()).state).toBe("confirmed");
      expect(chain.finalizedTags).toEqual([]);
    });

    it("reads a nonce for settling no higher than the finalized head", async () => {
      // A nonce taken at a block a reorg can undo can be freed again, and the send then mined.
      await stepOnce(sql, chain, safeHead, log);
      chain.observation = { kind: "unknown" };
      chain.head = 100;
      chain.finalized = 50;
      await stepOnce(sql, chain, safeHead, log);

      expect(chain.confirmedNonceAt).toEqual([50]);
    });
  });
});
