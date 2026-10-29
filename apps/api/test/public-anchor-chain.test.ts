import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { insertProject, publishProject } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Public proofs and hash search report the chain an anchor was stored with.
 *
 * A deployment can move chains (the dev deployment from 31337 to opBNB testnet 5611). Anchors
 * made before the move stay on the chain they were sent on; answering with the API's current
 * CHAIN_ID would link their hashes to an explorer where they do not exist. The stored value
 * outranks the configured one in both directions, and only the transaction row the proof or
 * match already references counts.
 */
describeDb("public anchor chain", () => {
  let fx: TestFixture;
  /** The deployment that anchored, on the local chain. */
  let local: FastifyInstance;
  /** The same database after the deployment moved to the opBNB testnet. */
  let testnet: FastifyInstance;
  let entryVersionId: string;
  let batchRowId: string;
  /** What the public saw while the batch's transaction row was `created`, with no hash. */
  let unsubmitted: {
    proof: { chainId: number | null; transactionHash: string | null; confirmationState: string };
    matches: { entryVersionId: string; transactionHash: string | null; chainId?: number | null }[];
  };
  const txHash = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    fx = await setupFixture();
    local = await buildServer(loadConfig({ ...testEnv(), CHAIN_ID: "31337" }), fx.appSql);
    testnet = await buildServer(loadConfig({ ...testEnv(), CHAIN_ID: "5611" }), fx.appSql);

    const operator = await signIn(local, fx.operatorA);
    const approver = await signIn(local, fx.disclosureApproverA);
    const published = await publishProject(
      local,
      fx.sql,
      { drafter: operator, publisher: approver },
      await insertProject(fx.sql, { tenantId: fx.tenantA, organizationId: fx.orgA }, `CHAIN-${randomUUID().slice(0, 8)}`),
    );
    expect(published.statusCode).toBe(200);
    entryVersionId = (published.json() as { id: string }).id;

    const batch = await local.inject({
      method: "POST",
      url: "/api/v1/anchor-batches",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });
    expect(batch.statusCode).toBe(200);

    // Creating the batch writes a `created` row on the deployment's chain. Nothing is sent yet.
    const queued = await local.inject({ method: "GET", url: `/api/v1/public/proofs/${entryVersionId}` });
    const queuedProof = queued.json() as typeof unsubmitted.proof & { leafHash: string };
    const leafSearch = await local.inject({ method: "GET", url: `/api/v1/public/search?q=${queuedProof.leafHash}` });
    unsubmitted = {
      proof: queuedProof,
      matches: (leafSearch.json() as { matches: typeof unsubmitted.matches }).matches,
    };

    // The worker's outcome: the batch's transaction confirmed on the local chain.
    const [row] = await fx.sql<{ batch_id: string; chain_id: number }[]>`
      UPDATE chain.transactions t
      SET state = 'confirmed', tx_hash = ${txHash}, block_number = 42, block_hash = ${`0x${"cd".repeat(32)}`}
      FROM chain.anchor_batch_leaves l
      WHERE l.entry_version_id = ${entryVersionId} AND t.batch_id = l.batch_id
      RETURNING t.batch_id, t.chain_id
    `;
    expect(row?.chain_id).toBe(31337);
    batchRowId = row!.batch_id;
  });

  afterAll(async () => {
    await local.close();
    await testnet.close();
    await fx.close();
  });

  const proofOf = async (app: FastifyInstance) => {
    const response = await app.inject({ method: "GET", url: `/api/v1/public/proofs/${entryVersionId}` });
    expect(response.statusCode).toBe(200);
    return response.json() as { chainId: number | null; transactionHash: string | null; confirmationState: string };
  };

  const searchOf = async (app: FastifyInstance) => {
    const response = await app.inject({ method: "GET", url: `/api/v1/public/search?q=${txHash}` });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      chainId: number;
      matches: { entryVersionId: string; transactionHash: string | null; chainId?: number | null }[];
    };
  };

  it("names no chain before the transaction has a hash, though a chain is queued", async () => {
    expect(unsubmitted.proof).toMatchObject({ chainId: null, transactionHash: null, confirmationState: "created" });
    expect(unsubmitted.matches).toContainEqual(
      expect.objectContaining({ entryVersionId, transactionHash: null, chainId: null }),
    );
  });

  it("a proof states the stored chain after the deployment moved", async () => {
    const proof = await proofOf(testnet);
    expect(proof).toMatchObject({ chainId: 31337, transactionHash: txHash, confirmationState: "confirmed" });
  });

  it("a hash match states the stored chain; the top level stays the deployment's", async () => {
    const result = await searchOf(testnet);
    expect(result.chainId).toBe(5611);
    expect(result.matches).toContainEqual(
      expect.objectContaining({ entryVersionId, transactionHash: txHash, chainId: 31337 }),
    );
  });

  it("an anchor stored on 5611 reads as 5611, whatever the deployment's chain", async () => {
    await fx.sql`UPDATE chain.transactions SET chain_id = 5611 WHERE batch_id = ${batchRowId}`;
    try {
      for (const app of [local, testnet]) {
        expect((await proofOf(app)).chainId).toBe(5611);
        expect((await searchOf(app)).matches).toContainEqual(
          expect.objectContaining({ entryVersionId, chainId: 5611 }),
        );
      }
    } finally {
      await fx.sql`UPDATE chain.transactions SET chain_id = 31337 WHERE batch_id = ${batchRowId}`;
    }
  });

  it("only the latest transaction of the batch decides, the same row as the hash", async () => {
    // A replacement sent later on another chain is what the proof now references.
    const replacement = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await fx.sql`
      INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, tx_hash, created_at)
      SELECT ${randomUUID()}, b.tenant_id, b.id, ${`replace-${randomUUID()}`}, 5611, ${replacement}, now() + interval '1 second'
      FROM chain.anchor_batches b WHERE b.id = ${batchRowId}
    `;
    const proof = await proofOf(testnet);
    expect(proof).toMatchObject({ chainId: 5611, transactionHash: replacement });
  });
});
