import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { unprocessable } from "../errors.js";

/**
 * 투표 무게 — spec 04 §4.5.
 *
 * 무게는 **투표 시작 시점의 온체인 잔고**다. 요청 본문으로 받으면 던지는 사람이
 * 자기 무게를 정한다 — 투표가 아니라 선언이다.
 *
 * 시점을 고정하는 이유:
 *
 *   1. 투표 중에 토큰을 사서 무게를 늘릴 수 없다.
 *   2. 같은 토큰을 여러 지갑으로 옮겨 여러 번 던질 수 없다.
 *   3. 집계를 언제 다시 해도 같은 결과가 나온다.
 *
 * 스냅숏 조회는 아카이브 노드를 요구한다. 매 집계마다 다시 읽으면 결과가 노드
 * 상태에 좌우되므로 한 번 읽고 저장한다.
 */

/**
 * 잔고 조회.
 *
 * 주입하는 이유: 토큰 컨트랙트가 아직 없고(R4 이전), 아카이브 노드 없이는
 * 과거 블록을 읽을 수 없다. 두 상황을 테스트로 재현해야 한다.
 */
export type BalanceReader = (input: {
  readonly tokenAddress: string;
  readonly walletAddress: string;
  readonly blockNumber: number;
}) => Promise<bigint>;

export interface SnapshotConfig {
  /** 토큰 컨트랙트. 없으면 스냅숏을 만들지 않는다. */
  readonly tokenAddress: string | null;
  readonly chainId: number;
}

export interface WeightResult {
  readonly weight: bigint;
  /** 무게가 어디서 왔는가. 화면이 이것을 밝혀야 한다. */
  readonly source: "onchain_snapshot" | "manual";
  readonly blockNumber: number | null;
}

/**
 * 투표자의 무게를 정한다.
 *
 * 이미 스냅숏이 있으면 그것을 쓴다 — 두 번 읽으면 그 사이 블록이 재구성됐을
 * 때 다른 값이 나온다.
 *
 * 토큰이 설정되지 않았으면 `manual`로 떨어진다. **그 사실을 감추지 않는다** —
 * 수동 무게로 집계된 결과를 온체인 근거로 읽으면 안 된다.
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
  // 스냅숏 대상이 아니면 수동 무게다. 값이 없으면 투표할 수 없다.
  if (!input.snapshotBlock || !input.snapshotTokenAddress) {
    if (input.manualWeight === null) {
      throw unprocessable(
        "VOTE_WEIGHT_REQUIRED",
        "온체인 스냅숏이 없는 제안에는 무게를 직접 지정해야 한다",
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
    // 조회 실패를 잔고 0으로 읽지 않는다. 0은 "토큰이 없다"는 사실이고
    // 실패는 "모른다"이며, 전자로 기록하면 투표권을 조용히 뺏는다.
    throw unprocessable("VOTE_WEIGHT_UNAVAILABLE", "스냅숏 시점의 잔고를 읽지 못했다", {
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
 * 투표 시작 시 스냅숏 블록을 고정한다.
 *
 * head가 아니라 **확정된 블록**을 쓴다. head는 재구성될 수 있고, 그러면 이미
 * 던진 표의 무게 근거가 사라진다.
 */
export function snapshotBlockFor(headBlock: number, confirmationDepth: number): number {
  return Math.max(0, headBlock - confirmationDepth);
}
