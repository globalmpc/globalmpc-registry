import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 공개 통합 검색.
 *
 * 방문자가 가진 단서가 registry key가 아니라 BscScan의 transaction hash나
 * 증명서의 root·leaf여도 공개 기록에 닿아야 한다. 그리고 그 경로로 게시되지
 * 않은 것이나 tenant가 새지 않아야 한다.
 */
describeDb("공개 통합 검색", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  const publicKey = `SRCH-${randomUUID().slice(0, 8)}`;
  const txHash = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  let anchored: { entryVersionId: string; leafHash: string; root: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);

    const publish = (key: string) => app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey: key,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    const published = await publish(publicKey);
    expect(published.statusCode).toBe(200);
    // leaf가 하나뿐인 batch는 root가 곧 leaf hash다. 형제를 두어야 root 경로가 따로 시험된다.
    expect((await publish(`${publicKey}-SIBLING`)).statusCode).toBe(200);
    const entryVersionId = (published.json() as { id: string }).id;

    const batch = await app.inject({
      method: "POST",
      url: "/api/v1/anchor-batches",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });
    expect(batch.statusCode).toBe(200);

    const proof = (
      await app.inject({ method: "GET", url: `/api/v1/public/proofs/${entryVersionId}` })
    ).json() as { leafHash: string; root: string };
    anchored = { entryVersionId, leafHash: proof.leafHash, root: proof.root };

    // 체인 제출은 worker가 한다. 여기서는 제출 기록만 남겨 tx hash 경로를 연다.
    await fx.sql`
      INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, tx_hash)
      SELECT ${randomUUID()}, b.tenant_id, b.id, ${`search-${randomUUID()}`}, 97, ${txHash}
      FROM chain.anchor_batches b
      WHERE b.merkle_root = ${anchored.root}
    `;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function search(q: string) {
    return app.inject({
      method: "GET",
      url: `/api/v1/public/search?q=${encodeURIComponent(q)}`,
    });
  }

  interface Match {
    matchedOn: string;
    publicKey: string;
    entryVersionId: string;
    transactionHash: string | null;
  }

  function matchesOf(response: Awaited<ReturnType<typeof search>>): Match[] {
    expect(response.statusCode).toBe(200);
    return (response.json() as { matches: Match[] }).matches;
  }

  it("registry key 정확 일치를 먼저 낸다", async () => {
    const response = await search(publicKey);
    expect(response.json().kind).toBe("text");
    const [first] = matchesOf(response);
    expect(first).toMatchObject({ matchedOn: "public_key", publicKey });
  });

  it("leaf hash로 그 기록에 닿는다", async () => {
    const matches = matchesOf(await search(anchored.leafHash));
    expect(matches).toContainEqual(
      expect.objectContaining({ matchedOn: "leaf_hash", entryVersionId: anchored.entryVersionId }),
    );
  });

  it("Merkle root로 batch 안의 공개 기록에 닿는다", async () => {
    const matches = matchesOf(await search(anchored.root));
    expect(matches).toContainEqual(
      expect.objectContaining({ matchedOn: "merkle_root", publicKey }),
    );
  });

  it("transaction hash로 닿고, 대문자 hex도 같은 값으로 본다", async () => {
    const matches = matchesOf(await search(txHash.toUpperCase().replace("0X", "0x")));
    expect(matches).toContainEqual(
      expect.objectContaining({ matchedOn: "transaction_hash", publicKey, transactionHash: txHash }),
    );
  });

  it("모르는 hash는 빈 결과다 — 오류가 아니다", async () => {
    const matches = matchesOf(await search(`0x${"ab".repeat(32)}`));
    expect(matches).toEqual([]);
  });

  it("tenant를 내보내지 않는다", async () => {
    const response = await search(anchored.root);
    expect(response.body).not.toContain(fx.tenantA);
    expect(response.body).not.toContain(fx.orgA);
  });

  it("검색어가 없으면 400이다", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/public/search" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_QUERY");
  });
});
