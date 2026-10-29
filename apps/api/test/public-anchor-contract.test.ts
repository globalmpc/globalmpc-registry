import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { insertProject, publishProject } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Public proofs and hash search name the contract the anchor was sent to.
 *
 * An anchor is (chain, contract, batch id). A new contract version is deployed at a new address,
 * so after one a verifier holding only the chain and hash would ask the wrong contract. The
 * address is the one the worker stored with the transaction's hash: null until there is a hash,
 * null for an anchor stored without one, and never this deployment's configured contract.
 */
describeDb("public anchor contract", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let entryVersionId: string;
  let batchRowId: string;
  /** The contract the transaction was sent to. */
  const SENT_TO = `0x${"a1".repeat(20)}`;
  /** What this deployment is configured with now — a later version at a new address. */
  const CONFIGURED = `0x${"b2".repeat(20)}`;
  const hash = () => `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const txHash = hash();
  let leafHash: string;

  let previousEnv: string | undefined;

  beforeAll(async () => {
    // The API has no contract setting of its own. The worker's variable is set in the process
    // and the config anyway, so code that reached for "the current contract" would surface here.
    previousEnv = process.env["ANCHOR_CONTRACT_ADDRESS"];
    process.env["ANCHOR_CONTRACT_ADDRESS"] = CONFIGURED;
    fx = await setupFixture();
    app = await buildServer(
      loadConfig({ ...testEnv(), ANCHOR_CONTRACT_ADDRESS: CONFIGURED }),
      fx.appSql,
    );

    const operator = await signIn(app, fx.operatorA);
    const approver = await signIn(app, fx.disclosureApproverA);
    const published = await publishProject(
      app,
      fx.sql,
      { drafter: operator, publisher: approver },
      await insertProject(fx.sql, { tenantId: fx.tenantA, organizationId: fx.orgA }, `CTR-${randomUUID().slice(0, 8)}`),
    );
    expect(published.statusCode).toBe(200);
    entryVersionId = (published.json() as { id: string }).id;

    const batch = await app.inject({
      method: "POST",
      url: "/api/v1/anchor-batches",
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });
    expect(batch.statusCode).toBe(200);

    // The worker records the contract before or with the hash. Here: before — a row that names
    // a contract (from an earlier attempt, or a Safe proposal awaiting signatures) but has no hash.
    const [row] = await fx.sql<{ batch_id: string; contract_address: string }[]>`
      UPDATE chain.transactions t SET contract_address = ${SENT_TO}
      FROM chain.anchor_batch_leaves l
      WHERE l.entry_version_id = ${entryVersionId} AND t.batch_id = l.batch_id
      RETURNING t.batch_id, t.contract_address
    `;
    batchRowId = row!.batch_id;
    leafHash = (await proofOf()).leafHash;
  });

  afterAll(async () => {
    if (previousEnv === undefined) delete process.env["ANCHOR_CONTRACT_ADDRESS"];
    else process.env["ANCHOR_CONTRACT_ADDRESS"] = previousEnv;
    await app.close();
    await fx.close();
  });

  type Proof = {
    leafHash: string;
    chainId: number | null;
    contractAddress: string | null;
    transactionHash: string | null;
  };
  type Match = { entryVersionId: string; publicKey: string; transactionHash: string | null; chainId?: number | null; contractAddress?: string | null };

  async function proofOf(): Promise<Proof> {
    const response = await app.inject({ method: "GET", url: `/api/v1/public/proofs/${entryVersionId}` });
    expect(response.statusCode).toBe(200);
    return response.json() as Proof;
  }

  async function matchFor(q: string): Promise<Match> {
    const response = await app.inject({ method: "GET", url: `/api/v1/public/search?q=${q}` });
    expect(response.statusCode).toBe(200);
    const match = (response.json() as { matches: Match[] }).matches.find((m) => m.entryVersionId === entryVersionId);
    expect(match).toBeDefined();
    return match!;
  }

  it("names no contract before the transaction has a hash, though the row names one", async () => {
    expect(await proofOf()).toMatchObject({ chainId: null, contractAddress: null, transactionHash: null });
    expect(await matchFor(leafHash)).toMatchObject({ chainId: null, contractAddress: null, transactionHash: null });
  });

  it("returns the stored contract with the hash, not the deployment's configured one", async () => {
    await fx.sql`
      UPDATE chain.transactions
      SET state = 'confirmed', tx_hash = ${txHash}, block_number = 42, block_hash = ${`0x${"cd".repeat(32)}`}
      WHERE batch_id = ${batchRowId}
    `;
    expect(await proofOf()).toMatchObject({ chainId: 31337, contractAddress: SENT_TO, transactionHash: txHash });
    for (const q of [txHash, leafHash, txHash.toUpperCase().replace("0X", "0x")]) {
      expect(await matchFor(q)).toMatchObject({ chainId: 31337, contractAddress: SENT_TO, transactionHash: txHash });
    }
  });

  it("text matches carry no contract", async () => {
    const { publicKey } = await matchFor(leafHash);
    const response = await app.inject({ method: "GET", url: `/api/v1/public/search?q=${encodeURIComponent(publicKey)}` });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { kind: string; matches: Match[] };
    expect(body.kind).toBe("text");
    expect(body.matches.map((m) => m.entryVersionId)).toContain(entryVersionId);
    for (const match of body.matches) {
      expect(match).not.toHaveProperty("contractAddress");
    }
  });

  it("names no contract for an anchor stored without one, and only the latest row decides", async () => {
    // A later transaction row for the batch, written before the worker stored the contract.
    const legacyHash = hash();
    await fx.sql`
      INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, tx_hash, created_at)
      SELECT ${randomUUID()}, b.tenant_id, b.id, ${`legacy-${randomUUID()}`}, 31337, ${legacyHash}, now() + interval '1 second'
      FROM chain.anchor_batches b WHERE b.id = ${batchRowId}
    `;
    expect(await proofOf()).toMatchObject({ chainId: 31337, contractAddress: null, transactionHash: legacyHash });
    expect(await matchFor(legacyHash)).toMatchObject({ contractAddress: null, transactionHash: legacyHash });
    // A lookup by the earlier hash reaches the same batch and reports the latest row as a whole:
    // never its hash with the earlier row's contract.
    expect(await matchFor(txHash)).toMatchObject({ contractAddress: null, transactionHash: legacyHash });
  });
});
