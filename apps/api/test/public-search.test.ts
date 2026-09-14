import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Public unified search.
 *
 * A visitor's clue may be a BscScan transaction hash or a certificate root/leaf
 * rather than a registry key, and it must still reach the public record. That path must
 * not leak unpublished records or the tenant.
 */
describeDb("public unified search", () => {
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
          limitations: ["Legal title verification is outside this review's scope"],
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
    // In a one-leaf batch the root is the leaf hash. A sibling makes the root path tested separately.
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

    // The worker submits on-chain. Here only a submission row is written to open the tx hash path.
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

  it("returns an exact registry key match first", async () => {
    const response = await search(publicKey);
    expect(response.json().kind).toBe("text");
    const [first] = matchesOf(response);
    expect(first).toMatchObject({ matchedOn: "public_key", publicKey });
  });

  it("reaches the record by leaf hash", async () => {
    const matches = matchesOf(await search(anchored.leafHash));
    expect(matches).toContainEqual(
      expect.objectContaining({ matchedOn: "leaf_hash", entryVersionId: anchored.entryVersionId }),
    );
  });

  it("reaches public records in a batch by Merkle root", async () => {
    const matches = matchesOf(await search(anchored.root));
    expect(matches).toContainEqual(
      expect.objectContaining({ matchedOn: "merkle_root", publicKey }),
    );
  });

  it("reaches by transaction hash and treats uppercase hex as the same value", async () => {
    const matches = matchesOf(await search(txHash.toUpperCase().replace("0X", "0x")));
    expect(matches).toContainEqual(
      expect.objectContaining({ matchedOn: "transaction_hash", publicKey, transactionHash: txHash }),
    );
  });

  it("an unknown hash yields empty results, not an error", async () => {
    const matches = matchesOf(await search(`0x${"ab".repeat(32)}`));
    expect(matches).toEqual([]);
  });

  it("does not expose the tenant", async () => {
    const response = await search(anchored.root);
    expect(response.body).not.toContain(fx.tenantA);
    expect(response.body).not.toContain(fx.orgA);
  });

  it("returns 400 without a query", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/public/search" });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("INVALID_QUERY");
  });
});
