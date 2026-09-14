import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import {
  chainBacklog,
  stepOnce,
  type ChainClient,
  type SafeProposer,
  type SubmitterConfig,
} from "../src/anchor-submitter.js";
import type { Observation } from "../src/anchor-state.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * anchor 제출 통합 테스트.
 *
 * ChainClient를 대역으로 바꿔 체인 응답을 조종한다. 실제 노드로는 reorg나 mempool
 * 이탈을 재현할 수 없다 — 재현할 수 없는 경우가 정확히 이 코드가 다뤄야 하는
 * 경우다.
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
  // 테스트는 즉시 다시 확인해야 한다. 간격을 두면 단계 진행을 못 본다.
  reorgWatchMs: 60 * 60 * 1000,
  recheckIntervalMs: 0,
  // 대부분의 케이스는 일일 상한과 무관하다. 상한 자체를 보는 케이스만 낮춰 쓴다.
  dailySpendCapWei: 10n ** 18n,
};

/** 영수증 한 건의 가스 비용 = 100_000 × 1 gwei = 1e14 wei. */
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

  async headBlockNumber(): Promise<number> {
    return this.head;
  }

  async estimateMaxFeePerGas(): Promise<bigint> {
    return this.fee;
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
    return this.observation;
  }
}

describeDb("anchor 제출과 확정", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let batchRowId: string;
  let transactionId: string;
  /** batch_id는 전역 UNIQUE다. 케이스마다 새로 만든다. */
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

    // 매번 새 tenant를 만든다. 이전 케이스의 트랜잭션을 worker가 집으면 어느
    // 케이스가 무엇을 바꿨는지 알 수 없다.
    tenantId = randomUUID();
    // reorg_events가 트랜잭션을 참조한다. 애플리케이션에는 삭제 경로가 없고
    // (append-only) 테스트만 superuser로 정리한다.
    await sql`DELETE FROM chain.reorg_events`;
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

  it("created를 제출하고 submitted로 옮긴다", async () => {
    const result = await step();

    expect(result.to).toBe("submitted");
    expect(chain.submitted).toEqual([
      { batchId: batchExternalId, root: ROOT, manifestHash: MANIFEST, schemaVersion: "1", recordCount: 2 },
    ]);

    const row = await stateOf();
    expect(row.state).toBe("submitted");
    expect(row.tx_hash).toBe(TX_HASH);
  });

  it("블록에 들어가도 깊이를 못 채우면 confirmed가 아니다", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 101;
    await step();

    const row = await stateOf();
    // 06 §6.8: included는 성공이 아니다. 공개 증명의 included도 아직 false다.
    expect(row.state).toBe("included");
    expect(row.confirmed_at).toBeNull();
  });

  it("깊이를 채우면 confirmed가 되고 시각이 남는다", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();

    const row = await stateOf();
    expect(row.state).toBe("confirmed");
    expect(row.confirmations).toBe(3);
    expect(row.confirmed_at).not.toBeNull();
  });

  it("reorg를 관측하면 확정을 되돌리고 사건을 남긴다", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();
    expect((await stateOf()).state).toBe("confirmed");

    // 같은 트랜잭션이 다른 블록에서 보인다 — 우리가 본 블록은 사라졌다.
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
    // 뒤집힌 사실은 지우지 않는다. 재확정돼도 한 번 뒤집혔다는 것이 남는다.
    expect(events).toHaveLength(1);
    expect(events[0]!["previous_block_hash"]).toBe(BLOCK_A);
    expect(events[0]!["detected_state"]).toBe("confirmed");
  });

  it("revert는 재시도하지 않는다", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A, "reverted");
    chain.head = 130;
    await step();

    expect((await stateOf()).state).toBe("reverted");

    // 이후 루프에서 다시 집히지 않는다.
    const next = await step();
    expect(next.handled).toBe(false);
  });

  it("제출 실패는 created로 남아 재시도된다", async () => {
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

  it("재시도 상한에 닿으면 failed로 끝낸다", async () => {
    // 무한 재시도가 가스 지갑을 비우지 않게 한다(O1).
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

  it("가스 상한을 넘으면 제출하지 않고 상태를 유지한다", async () => {
    chain.fee = 500_000_000_000n;
    await step();

    const row = await stateOf();
    expect(row.state).toBe("created");
    expect(row.last_error).toBe("FEE_ABOVE_CAP");
    // 시도 횟수를 소모하지 않는다. 조건이 바뀌면 그대로 진행되어야 한다.
    expect(row.attempts).toBe(0);
    expect(chain.submitted).toHaveLength(0);
  });

  /** Safe 서비스 대역. 실제 서비스로는 실행·거절을 재현할 수 없다. */
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

  it("제안을 Safe 서비스에 올리고 식별자를 남긴다", async () => {
    const safe = fakeSafe();
    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    expect(result.to).toBe("proposed");
    const [proposal] = await sql<{ safe_tx_hash: string | null; state: string }[]>`
      SELECT safe_tx_hash, state FROM chain.anchor_proposals
      WHERE transaction_id = ${transactionId}
    `;
    // 서명자가 Safe UI에서 대조할 식별자다. 없으면 어느 제안인지 찾을 수 없다.
    expect(proposal!.safe_tx_hash).toBe(`0x${"5a".repeat(32)}`);
    expect(proposal!.state).toBe("proposed");
  });

  it("제안 올리기에 실패하면 DB에도 남기지 않는다", async () => {
    const safe = fakeSafe({
      async propose() {
        throw new Error("service unavailable");
      },
    });

    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    // 올라가지 않은 제안을 `proposed`로 표시하면 서명을 기다리는 것처럼 보인다.
    expect(result.reason).toBe("propose_failed");
    expect((await stateOf()).state).toBe("created");
    const proposals = await sql`
      SELECT id FROM chain.anchor_proposals WHERE transaction_id = ${transactionId}
    `;
    expect(proposals).toHaveLength(0);
  });

  it("서명이 모이는 동안에는 상태를 바꾸지 않는다", async () => {
    const safe = fakeSafe();
    await stepOnce(sql, chain, safeConfigOf(), log, safe);

    const next = await stepOnce(sql, chain, safeConfigOf(), log, safe);
    expect(next.handled).toBe(false);
    expect((await stateOf()).state).toBe("proposed");
  });

  it("Safe에서 실행되면 일반 추적 경로로 넘어간다", async () => {
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
    // 확정 깊이·reorg 감시가 똑같이 걸린다. Safe로 실행됐다고 확정이 면제되지 않는다.
    expect(row.state).toBe("submitted");
    expect(row.tx_hash).toBe(executedHash);
  });

  it("Safe에서 거절되면 자동으로 다시 올리지 않는다", async () => {
    const safe = fakeSafe({
      async status() {
        return { kind: "rejected" };
      },
    });

    await stepOnce(sql, chain, safeConfigOf(), log, safe);
    const result = await stepOnce(sql, chain, safeConfigOf(), log, safe);

    expect(result.to).toBe("failed");
    // 왜 거절됐는지 확인하지 않고 다시 올리면 같은 이유로 또 거절된다.
    expect((await stateOf()).last_error).toBe("safe_proposal_rejected");
  });

  it("EOA가 막힌 체인에서는 제출하지 않고 Safe 제안을 만든다", async () => {
    const safeConfig = {
      ...config,
      eoaAllowedChainIds: [] as number[],
      safeAddress: `0x${"ab".repeat(20)}`,
    };

    const result = await stepOnce(sql, chain, safeConfig, log);
    expect(result.to).toBe("proposed");

    // 제안은 실행이 아니다. 체인에 아무것도 보내지 않았다.
    expect(chain.submitted).toHaveLength(0);
    expect(chain.encoded).toHaveLength(1);

    const row = await stateOf();
    // submitted로 표시하면 있지도 않은 트랜잭션의 영수증을 영원히 기다린다.
    expect(row.state).toBe("proposed");
    expect(row.tx_hash).toBeNull();

    const [proposal] = await sql<{ safe_address: string; calldata_hash: string; state: string }[]>`
      SELECT safe_address, calldata_hash, state FROM chain.anchor_proposals
      WHERE transaction_id = ${transactionId}
    `;
    expect(proposal!.state).toBe("proposed");
    expect(proposal!.safe_address).toBe(safeConfig.safeAddress);
  });

  it("proposed는 다시 집히지 않는다", async () => {
    const safeConfig = {
      ...config,
      eoaAllowedChainIds: [] as number[],
      safeAddress: `0x${"ab".repeat(20)}`,
    };
    await stepOnce(sql, chain, safeConfig, log);

    // Safe에서 실행되기 전에는 체인에 트랜잭션이 없다. 조회하면 "존재하지 않음"
    // 으로 판정해 dropped로 잘못 표시한다.
    const next = await stepOnce(sql, chain, safeConfig, log);
    expect(next.handled).toBe(false);
  });

  it("확정된 트랜잭션이 대기 중인 것을 굶기지 않는다", async () => {
    // 먼저 만든 것을 확정까지 보낸다.
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();
    expect((await stateOf()).state).toBe("confirmed");

    // 나중에 들어온 batch. 오래된 순으로만 집으면 확정된 앞의 행을 계속 다시
    // 집어 이 행이 영원히 제출되지 않는다.
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

  it("다른 체인의 트랜잭션은 집지 않는다", async () => {
    await sql`UPDATE chain.transactions SET chain_id = 56 WHERE id = ${transactionId}`;
    const result = await step();
    expect(result.handled).toBe(false);
  });

  it("backlog가 사람이 봐야 하는 것을 분리해 센다", async () => {
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

  it("확정된 트랜잭션이 사라지면 자동 복구하지 않는다", async () => {
    await step();
    chain.observation = receipt(100, BLOCK_A);
    chain.head = 102;
    await step();

    chain.observation = { kind: "unknown" };
    await step();

    // 조용히 created로 되돌려 재제출하면 같은 root를 두 번 올릴 수 있다.
    expect((await stateOf()).state).toBe("reconciliation_required");
  });

  describe("일일 가스 상한 (O1)", () => {
    /**
     * 이미 태운 가스를 심는다.
     *
     * `chain.transactions`의 `gas_used`·`effective_gas_price`는 지금까지 아무도
     * 쓰지 않던 컬럼이었다. 일일 상한은 그 두 값의 합으로 판정하므로, 영수증이
     * 도착할 때 값이 남는지부터 확인해야 상한이 의미를 갖는다.
     */
    async function seedSpend(gasUsed: bigint, price: bigint, submittedAt: string) {
      const id = randomUUID();
      await sql`
        INSERT INTO chain.transactions (
          id, tenant_id, intent_key, chain_id, state, tx_hash, block_number, block_hash,
          submitted_at, gas_used, effective_gas_price
        ) VALUES (
          ${id}, ${tenantId}, ${`spent:${id}`}, ${CHAIN_ID}, 'confirmed',
          ${`0x${"77".repeat(32)}`}, 90, ${BLOCK_A},
          ${sql.unsafe(submittedAt)}, ${gasUsed.toString()}, ${price.toString()}
        )
      `;
      return id;
    }

    it("영수증이 오면 실제 가스 비용을 기록한다", async () => {
      await step();
      chain.observation = receipt(100, BLOCK_A);
      await step();

      const [row] = await sql<{ gas_used: string | null; effective_gas_price: string | null }[]>`
        SELECT gas_used, effective_gas_price FROM chain.transactions WHERE id = ${transactionId}
      `;
      expect(row!.gas_used).toBe(String(GAS_USED));
      expect(row!.effective_gas_price).toBe(GAS_PRICE.toString());
    });

    it("오늘 태운 가스가 상한에 닿으면 새 batch를 제출하지 않는다", async () => {
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

    it("어제 태운 가스는 오늘 상한에 들어가지 않는다", async () => {
      // 상한은 하루 단위로 다시 열린다. 누적으로 세면 영원히 막힌다.
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

    it("다른 체인에서 태운 가스는 세지 않는다", async () => {
      // 상한은 체인별 지갑 하나를 지키는 것이다. 체인을 섞으면 한쪽 체인의
      // 사용량이 다른 쪽을 멈춘다.
      const id = randomUUID();
      await sql`
        INSERT INTO chain.transactions (
          id, tenant_id, intent_key, chain_id, state, tx_hash, block_number, block_hash,
          submitted_at, gas_used, effective_gas_price
        ) VALUES (
          ${id}, ${tenantId}, ${`other:${id}`}, ${CHAIN_ID + 1}, 'confirmed',
          ${`0x${"88".repeat(32)}`}, 90, ${BLOCK_A},
          now(), ${(GAS_USED * 100n).toString()}, ${GAS_PRICE.toString()}
        )
      `;

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
