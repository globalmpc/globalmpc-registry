import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import { resolveVoteWeight, snapshotBlockFor } from "../src/services/vote-weight.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 투표 무게 스냅숏 — 04 §4.5.
 *
 * 핵심은 **던지는 사람이 자기 무게를 정할 수 없다**는 것이다. 요청 본문의
 * 값은 토큰이 설정되지 않은 제안에서만 쓰인다.
 */

describe("스냅숏 블록 선정", () => {
  it("head가 아니라 확정된 블록을 쓴다", () => {
    // head는 재구성될 수 있고, 그러면 이미 던진 표의 무게 근거가 사라진다.
    expect(snapshotBlockFor(1000, 12)).toBe(988);
  });

  it("체인 초기에도 음수가 되지 않는다", () => {
    expect(snapshotBlockFor(5, 12)).toBe(0);
  });
});

describeDb("무게 해석", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let proposalId: string;
  const wallet = `0x${"1f".repeat(20)}`;
  const token = `0x${"2e".repeat(20)}`;

  beforeAll(async () => {
    sql = postgres(process.env["DATABASE_URL"]!, { onnotice: () => {}, prepare: false });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    tenantId = randomUUID();
    proposalId = randomUUID();

    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`vw-${tenantId.slice(0, 8)}`}, 'vote weight')
    `;
    const subjectId = randomUUID();
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${tenantId}, 'person', 'proposer')
    `;
    await sql`
      INSERT INTO core.governance_proposals (
        id, tenant_id, space, proposal_type, title, rationale, proposer_subject_id,
        quorum_numerator, quorum_denominator, threshold_numerator, threshold_denominator
      ) VALUES (
        ${proposalId}, ${tenantId}, 'protocol', 'fee_schedule', '제목', '이유',
        ${subjectId}, 1, 4, 1, 2
      )
    `;
  });

  const base = () => ({
    tenantId,
    proposalId,
    walletAddress: wallet,
    snapshotBlock: 1000,
    snapshotTokenAddress: token,
    manualWeight: null,
  });

  it("온체인 잔고를 읽어 무게로 쓴다", async () => {
    const result = await sql.begin((tx) =>
      resolveVoteWeight(tx, base(), async () => 5000n),
    );

    expect(result).toMatchObject({ weight: 5000n, source: "onchain_snapshot" });
  });

  it("요청 본문의 무게를 무시한다", async () => {
    // 던지는 사람이 자기 무게를 정하면 투표가 아니라 선언이다.
    const result = await sql.begin((tx) =>
      resolveVoteWeight(tx, { ...base(), manualWeight: "999999" }, async () => 100n),
    );

    expect((result as { weight: bigint }).weight).toBe(100n);
  });

  it("두 번째 조회는 저장된 값을 쓴다", async () => {
    await sql.begin((tx) => resolveVoteWeight(tx, base(), async () => 100n));

    // 다시 읽으면 그 사이 블록이 재구성됐을 때 다른 값이 나온다.
    const second = await sql.begin((tx) =>
      resolveVoteWeight(tx, base(), async () => 999n),
    );
    expect((second as { weight: bigint }).weight).toBe(100n);
  });

  it("조회 실패를 잔고 0으로 읽지 않는다", async () => {
    // 0은 "토큰이 없다"는 사실이고 실패는 "모른다"다. 전자로 기록하면
    // 투표권을 조용히 뺏는다.
    await expect(
      sql.begin((tx) =>
        resolveVoteWeight(tx, base(), async () => {
          throw new Error("archive node required");
        }),
      ),
    ).rejects.toThrow(/읽지 못했다|VOTE_WEIGHT_UNAVAILABLE/);
  });

  it("토큰이 없으면 수동 무게로 떨어진다", async () => {
    const result = await sql.begin((tx) =>
      resolveVoteWeight(
        tx,
        { ...base(), snapshotBlock: null, snapshotTokenAddress: null, manualWeight: "42" },
        async () => 0n,
      ),
    );

    // 그 사실을 감추지 않는다 — 수동 무게로 집계된 결과를 온체인 근거로
    // 읽으면 안 된다.
    expect(result).toMatchObject({ weight: 42n, source: "manual", blockNumber: null });
  });

  it("토큰도 수동 무게도 없으면 투표할 수 없다", async () => {
    await expect(
      sql.begin((tx) =>
        resolveVoteWeight(
          tx,
          { ...base(), snapshotBlock: null, snapshotTokenAddress: null },
          async () => 0n,
        ),
      ),
    ).rejects.toThrow(/VOTE_WEIGHT_REQUIRED|지정해야/);
  });

  it("스냅숏된 무게는 수정할 수 없다", async () => {
    await sql.begin((tx) => resolveVoteWeight(tx, base(), async () => 100n));

    // 무게를 고칠 수 있으면 결과를 고칠 수 있다.
    await expect(
      sql`
        UPDATE core.governance_vote_weights SET weight = 999
        WHERE proposal_id = ${proposalId}
      `,
    ).rejects.toThrow(/수정할 수 없다/);
  });

  it("스냅숏 블록은 정해진 뒤 바뀌지 않는다", async () => {
    await sql`
      UPDATE core.governance_proposals SET snapshot_block = 1000 WHERE id = ${proposalId}
    `;

    // 투표 중에 블록을 옮기면 이미 던진 표의 무게 근거가 사라진다.
    await expect(
      sql`
        UPDATE core.governance_proposals SET snapshot_block = 2000 WHERE id = ${proposalId}
      `,
    ).rejects.toThrow(/바꿀 수 없다/);
  });

  it("18 decimals 무게도 정밀도를 잃지 않는다", async () => {
    const huge = 10n ** 24n + 7n;
    const result = await sql.begin((tx) => resolveVoteWeight(tx, base(), async () => huge));
    expect((result as { weight: bigint }).weight).toBe(huge);
  });
});
