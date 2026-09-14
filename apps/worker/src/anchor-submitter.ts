import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  checkSubmitAllowed,
  trackTransaction,
  type Observation,
  type TransactionState,
} from "./anchor-state.js";

/**
 * anchor batch 체인 제출 — spec 06 §6.8, 08 §8.9.
 *
 * API는 batch를 만들고 `chain.transactions`에 `created` 행을 남긴다. 실제 제출은
 * 여기서 한다. 요청 처리 중에 체인에 쓰면 응답 시간이 체인 상태에 묶이고,
 * 재시도할 때 같은 root를 두 번 올릴 위험이 생긴다.
 *
 * 이 모듈이 지키는 것:
 *
 * - **한 batch는 한 번만 제출된다.** `intent_key`가 UNIQUE이고, 행을 잠글 때
 *   `FOR UPDATE SKIP LOCKED`를 써서 worker를 여러 개 띄워도 중복되지 않는다.
 * - **제출과 확정은 다른 단계다.** 제출 성공은 `submitted`일 뿐이며 확정 깊이를
 *   채워야 `confirmed`가 된다.
 * - **상태를 앞으로만 밀지 않는다.** reorg는 확정을 되돌리고 그 사건을 남긴다.
 * - **서명 키는 이 프로세스 밖으로 나가지 않는다.** 로그에도 찍지 않는다.
 */

export interface ChainClient {
  /** 현재 head 블록 번호. */
  headBlockNumber(): Promise<number>;
  /** 예상 가스 요금. 상한 검사에 쓴다. */
  estimateMaxFeePerGas(): Promise<bigint>;
  /** `submitRoot` 호출. 반환값은 트랜잭션 해시다. */
  submitRoot(input: SubmitRootInput): Promise<string>;
  /**
   * `submitRoot` calldata를 만든다. Safe에 제안할 때 쓴다.
   *
   * 제출과 분리한 이유: 제안은 실행이 아니다. 같은 함수로 묶으면 "제안했으니
   * 올라갔다"고 착각할 여지가 생긴다.
   */
  encodeSubmitRoot(input: SubmitRootInput): { calldata: string; calldataHash: string };
  /** 영수증 조회. 없으면 `unknown`, 아직 mempool이면 `pending`. */
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
   * 하루에 태울 수 있는 가스 총액(wei).
   *
   * per-tx 상한(`feeCapWei`)과 재시도 상한(`maxAttempts`)을 다 지켜도 batch가
   * 계속 생기면 지갑은 빈다. O1이 요구하는 손실 상한은 이 하루 총액이다.
   */
  readonly dailySpendCapWei: bigint;
  readonly eoaAllowedChainIds: readonly number[];
  /** Safe multisig 주소. EOA 제출이 막힌 체인에서 제안 대상이 된다. */
  readonly safeAddress: string | null;
  /** 확정 후 reorg를 감시하는 기간. 지나면 감시 대상에서 뺀다. */
  readonly reorgWatchMs: number;
  /** 같은 트랜잭션을 다시 확인하기까지의 최소 간격. */
  readonly recheckIntervalMs: number;
}

/**
 * Safe 제안 인터페이스.
 *
 * worker는 제안을 올리고 실행 결과를 되읽기만 한다. 실행은 Safe owner들이 한다 —
 * 그 분리가 "MPC 자신도 단독으로 바꿀 수 없다"의 근거다.
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
 * 처리할 트랜잭션 하나를 잠근다.
 *
 * `SKIP LOCKED`로 다른 worker가 잡은 행을 건너뛴다. 잠금 없이 처리하면 두 worker가
 * 같은 batch를 제출해 가스를 두 번 쓴다.
 *
 * **확정된 것이 대기 중인 것을 굶기지 않게 한다.** `confirmed`도 reorg 감시
 * 대상이지만, 오래된 순으로만 집으면 확정된 행을 계속 다시 집어 뒤의 `created`가
 * 영원히 제출되지 않는다. 진행이 필요한 것을 먼저 보고, 확정된 것은 감시 주기가
 * 지난 것만 본다.
 *
 * 감시도 영원히 하지 않는다. 확정 후 일정 시간이 지나면 reorg 가능성이 사실상
 * 사라지므로 대상에서 뺀다 — 그러지 않으면 확정 행이 쌓일수록 루프가 느려진다.
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
    -- 자기 체인의 트랜잭션만 집는다. 필터가 없으면 testnet worker가 mainnet
    -- 트랜잭션을 자기 RPC로 조회해 "존재하지 않음"으로 판정한다.
    -- proposed는 집지 않는다. Safe에서 실행되기 전에는 체인에 트랜잭션이 없고,
    -- 조회하면 "존재하지 않음"으로 판정해 dropped로 잘못 표시한다.
    WHERE t.chain_id = ${chainId}
      AND (
        t.state IN ('created', 'submitted', 'included')
        OR (
          t.state = 'confirmed'
          AND t.confirmed_at > now() - ${`${Math.round(reorgWatchMs / 1000)} seconds`}::interval
          AND t.updated_at < now() - ${`${Math.round(recheckIntervalMs / 1000)} seconds`}::interval
        )
      )
    -- 진행이 필요한 것이 먼저다. 확정된 것의 재확인은 그다음이다.
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
 * 한 트랜잭션을 한 단계 전진시킨다.
 *
 * 한 번에 하나만 처리하고 각각을 자기 DB 트랜잭션에 담는다. 여러 개를 한
 * 트랜잭션에 묶으면 하나의 RPC 실패가 나머지의 진행까지 되돌린다.
 */
export async function stepOnce(
  sql: postgres.Sql,
  chain: ChainClient,
  config: SubmitterConfig,
  log: Log,
  safe?: SafeProposer,
): Promise<StepResult> {
  // 제안 상태 확인은 DB 트랜잭션 밖에서 한다. 외부 서비스 호출을 트랜잭션에
  // 묶으면 그 지연만큼 행이 잠긴다.
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
 * 올라간 제안의 실행 여부를 확인한다.
 *
 * Safe owner들이 서명하고 실행하면 그 결과가 체인 트랜잭션으로 나온다. 그때부터
 * 일반 트랜잭션과 같은 추적 경로를 탄다 — 확정 깊이·reorg 감시가 똑같이 걸린다.
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
      // 이제부터 일반 트랜잭션과 같은 추적 경로를 탄다. 확정 깊이·reorg 감시가
      // 똑같이 걸린다 — Safe로 실행됐다고 확정이 면제되지 않는다.
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
    // 트랜잭션은 created로 되돌리지 않는다. 왜 거절됐는지 확인하지 않은 채
    // 다시 올리면 같은 이유로 또 거절된다.
    await sql`
      UPDATE chain.transactions
      SET state = 'failed', last_error = 'safe_proposal_rejected', updated_at = now()
      WHERE id = ${proposal.transaction_id}
    `;
    log({ level: "warn", msg: "anchor.proposal.rejected", proposalId: proposal.id });
    return { handled: true, transactionId: proposal.transaction_id, from: "proposed", to: "failed" };
  }

  // pending·unknown은 그대로 둔다. 서명이 모이는 중이거나 서비스가 아직
  // 전파하지 못한 것이며, 둘 다 우리가 할 일이 없다.
  return { handled: false };
}

/**
 * 오늘(UTC) 이 체인에서 태운 가스 총액.
 *
 * **영수증이 도착한 것만 센다.** 제출했지만 아직 블록에 들어가지 않은 건은 실제
 * 비용을 모른다 — 그 구간의 노출은 `feeCapWei` × `maxAttempts`가 막는다.
 *
 * tenant를 가로질러 센다. 지갑은 tenant별로 나뉘어 있지 않고 하나다.
 *
 * 하루 경계는 UTC다. 서버 timezone을 따르면 배포 위치가 바뀔 때 상한이 열리는
 * 시각이 조용히 이동한다.
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
    // batch 없는 트랜잭션은 제출할 대상이 없다. 조용히 재시도하면 영원히 돈다.
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
    // 막힌 이유를 남기고 상태는 그대로 둔다. 조건이 바뀌면 다음 루프에서 진행된다.
    // 단 시도 상한에 닿은 것은 조건이 바뀌지 않으므로 failed로 끝낸다.
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

  // 시도 횟수를 **제출 전에** 올린다. 제출 후 크래시가 나면 이 값이 남아 무한
  // 재시도를 막는다. 성공한 제출을 실패로 오인하는 것보다 한 번 덜 시도하는 편이
  // 안전하다 — 같은 root의 중복 제출은 가스를 태운다.
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
    // 제출 실패는 재시도 대상이다. 상태는 created로 남는다.
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
 * Safe에 제안만 만든다.
 *
 * **실행하지 않는다.** 서명 수집과 실행은 Safe 쪽에서 사람이 한다. 상태를
 * `submitted`가 아니라 `proposed`로 두는 것이 그 사실을 지킨다 — submitted로
 * 표시하면 있지도 않은 트랜잭션의 영수증을 영원히 기다린다.
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

  // 활성 제안은 하나뿐이다(0014의 부분 UNIQUE). 두 개면 서명자들이 어느 것을
  // 실행할지 모르고, 둘 다 실행되면 같은 root가 두 번 올라간다.
  const [existing] = await tx<{ id: string }[]>`
    SELECT id FROM chain.anchor_proposals
    WHERE transaction_id = ${row.id} AND state = 'proposed'
  `;

  if (existing) {
    return { handled: true, transactionId: row.id, from: row.state, to: "proposed", reason: "already_proposed" };
  }

  // Safe 서비스에 실제로 올린다. 실패하면 DB에도 남기지 않는다 — 올라가지
  // 않은 제안을 `proposed`로 표시하면 서명을 기다리는 것처럼 보인다.
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
    // 서명자가 Safe UI에서 본 것과 대조할 값이다.
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
    // 상태가 바뀌지 않는 관측에서도 비용은 남긴다. 아래에 "바뀐 것이 없으면
    // 시각만 찍고 끝낸다"는 분기가 있어, 거기 걸리면 영수증이 왔는데도 비용이
    // 기록되지 않는다. 그러면 일일 상한이 0을 보고 영원히 열려 있게 된다.
    //
    // 재제출로 새 영수증이 오면 마지막 값이 남는다 — 뒤집힌 시도에서 태운
    // 가스는 이 합계에 들어가지 않는다. 그 구간의 상한은 재시도 상한이다.
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
    // 확정이 뒤집힌 사건은 지우지 않고 남긴다. 재제출로 결과가 같아지더라도
    // 한 번 뒤집혔다는 사실 자체가 신뢰도 판단의 근거다.
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
    // 바뀐 것이 없어도 확인 시각은 남긴다. 그러지 않으면 같은 행을 즉시 다시
    // 집어 뒤의 대기 건이 진행되지 않는다.
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

/** 진행 중인 트랜잭션 통계. 관측용이며 판정에 쓰지 않는다. */
export async function chainBacklog(
  sql: postgres.Sql,
  chainId: number,
): Promise<{
  readonly pending: number;
  /** Safe에 제안만 된 것. 제출된 것이 아니다. */
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
