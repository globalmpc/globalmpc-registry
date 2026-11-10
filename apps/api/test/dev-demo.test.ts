import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMemoryObjectStore, computeContentHash } from "@mpc/storage";
import postgres from "postgres";
import type { Hex } from "viem";
import { assertDemoEnvironment, DEMO_LIMITATION, seedDevDemo } from "../src/dev-demo.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { recoverAttestationSigner, uuidToBytes32 } from "../src/services/attestation-signing.js";
import { setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

describe("dev demo environment boundary", () => {
  it("accepts only an explicit development testnet deployment", () => {
    expect(() => assertDemoEnvironment("develop", "5611")).not.toThrow();
    for (const [environment, chain] of [["production", "5611"], ["staging", "5611"], ["develop", "56"], ["", "5611"], ["develop", "31337"]]) {
      expect(() => assertDemoEnvironment(environment!, chain!)).toThrow();
    }
  });
});

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("additive development fixtures", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let ownerSql: postgres.Sql;
  const key = (scenario: string) => `DEMO-V1-${scenario}-${fx.tenantA}`;
  const ownerRole = `demo_owner_${crypto.randomUUID().replaceAll("-", "")}`;
  const store = createMemoryObjectStore();
  let options: Parameters<typeof seedDevDemo>[2];
  beforeAll(async () => {
    fx = await setupFixture();
    // Table ownership must work without superuser/BYPASSRLS, as on managed Aurora.
    await fx.sql.unsafe(`CREATE ROLE ${ownerRole} NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE postgres`);
    ownerSql = postgres(process.env["DATABASE_URL"]!, { connection: { role: ownerRole }, onnotice: () => {} });
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    const [tenant] = await fx.sql<{ slug: string }[]>`SELECT slug FROM core.tenants WHERE id=${fx.tenantA}`;
    options = { environment: "develop", chainId: "5611", tenantSlug: tenant!.slug, pollIntervalMs: 5, scanTimeoutMs: 3000 };
  }, 30_000);
  afterAll(async () => {
    await app?.close(); await ownerSql?.end();
    if (fx) await fx.sql.unsafe(`DROP ROLE IF EXISTS ${ownerRole}`);
    await fx?.close();
  });

  it("refuses application credentials without adding objects or records", async () => {
    await expect(seedDevDemo(fx.appSql, store, options)).rejects.toThrow("migration table owner");
    const worker = postgres(process.env["DATABASE_URL"]!, { connection: { role: "mpc_worker" }, onnotice: () => {} });
    try { await expect(seedDevDemo(worker, store, options)).rejects.toThrow("migration table owner"); }
    finally { await worker.end(); }
    expect(store.size()).toBe(0);
  });

  it("commits quarantined input, stops on a missing scanner, then resumes without resetting it", async () => {
    await expect(seedDevDemo(ownerSql, store, { ...options, scanTimeoutMs: 0 })).rejects.toThrow("scan timeout");
    const rows = await fx.sql`SELECT project_key FROM core.projects WHERE tenant_id=${fx.tenantA} AND project_key LIKE 'DEMO-V1-%' ORDER BY project_key`;
    expect(rows.map(row => row.project_key)).toEqual([key("INPUT"), key("REVIEW")]);
    const [upload] = await fx.sql`SELECT state FROM core.object_uploads WHERE tenant_id=${fx.tenantA}`;
    expect(upload?.state).toBe("quarantined");
    const [countRow] = await fx.sql<{ count: string }[]>`SELECT count(*) FROM core.registry_entries WHERE tenant_id=${fx.tenantA}`;
    expect(countRow?.count).toBe("0");
  });

  it("creates signed demo evidence and a public record once, preserving edits and unrelated data", async () => {
    const peopleBefore = await fx.sql`SELECT id,email FROM core.subjects WHERE tenant_id=${fx.tenantA} ORDER BY id`;
    const bindingsBefore = await fx.sql`SELECT * FROM core.role_bindings WHERE tenant_id=${fx.tenantA} ORDER BY id`;
    const otherBefore = await fx.sql`SELECT * FROM core.projects WHERE tenant_id=${fx.tenantB} ORDER BY id`;
    let stopped = false;
    let scannerError: unknown;
    const scanner = (async () => {
      while (!stopped) {
        const uploads = await fx.sql<{ id: string; version: number }[]>`SELECT id,version FROM core.object_uploads WHERE tenant_id=${fx.tenantA} AND state='quarantined'`;
        for (const upload of uploads) {
          const response = await app.inject({ method: "POST", url: `/api/v1/uploads/${upload.id}/scan-result`,
            headers: { authorization: `Bearer ${fx.scanServiceToken}`, "idempotency-key": crypto.randomUUID(), "if-match": `"${upload.version}"` }, payload: { result: "clean" } });
          expect(response.statusCode, response.body).toBe(200);
        }
        await new Promise(resolve => setTimeout(resolve, 5));
      }
    })().catch(error => { scannerError = error; });
    try {
      const results = await Promise.all([seedDevDemo(ownerSql, store, options), seedDevDemo(ownerSql, store, options)]);
      expect(results.flatMap(result => result.created).sort()).toEqual([key("PUBLIC"), key("REVIEW")]);
      expect(results.some(result => result.skipped.length === 3)).toBe(true);
    } finally { stopped = true; await scanner; }
    if (scannerError) throw scannerError;
    const publicResponse = await app.inject(`/api/v1/public/registries/project/${key("PUBLIC")}`);
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.json().limitations).toContain(DEMO_LIMITATION);
    const [review] = await fx.sql`SELECT a.signature,a.limitations,asn.independence_reviewed FROM core.verification_attestations a
      JOIN core.assignments asn ON asn.id=a.assignment_id WHERE a.tenant_id=${fx.tenantA} AND a.limitations=${DEMO_LIMITATION} LIMIT 1`;
    expect(review?.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(review?.independence_reviewed).toBe(true);
    const [artifact] = await fx.sql`SELECT a.object_key,a.content_hash FROM core.artifacts a JOIN core.projects p ON p.id=a.project_id
      WHERE a.tenant_id=${fx.tenantA} AND p.project_key=${key("PUBLIC")}`;
    const bytes = await store.get(artifact!.object_key);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString()).toContain(DEMO_LIMITATION);
    expect(computeContentHash(bytes!)).toBe(artifact!.content_hash);
    const [signer] = await fx.sql`SELECT w.subject_id,asn.subject_id AS reviewer FROM core.verification_attestations a
      JOIN core.assignments asn ON asn.id=a.assignment_id
      JOIN core.wallet_identities w ON w.wallet_address=a.signer_wallet_address AND w.chain_id=5611 AND w.tenant_id=a.tenant_id
      WHERE a.tenant_id=${fx.tenantA} AND a.limitations=${DEMO_LIMITATION} LIMIT 1`;
    expect(signer?.subject_id).toBe(signer?.reviewer);
    expect(signer?.subject_id).toBeTruthy();
    const [signed] = await fx.sql`SELECT a.*,r.nonce,r.issued_at,r.expires_at FROM core.verification_attestations a
      JOIN core.attestation_signature_requests r ON r.attestation_id=a.id
      WHERE a.tenant_id=${fx.tenantA} AND a.limitations=${DEMO_LIMITATION} LIMIT 1`;
    const recovered = await recoverAttestationSigner(loadConfig(testEnv({ CHAIN_ID: "5611" })), {
      attestationId: uuidToBytes32(signed!.id), schemaId: uuidToBytes32(signed!.schema_id), schemaVersion: 1,
      assignmentId: uuidToBytes32(signed!.assignment_id), credentialId: uuidToBytes32(signed!.credential_id),
      evidenceSnapshotHash: signed!.evidence_snapshot_hash as Hex, payloadHash: signed!.payload_hash as Hex,
      nonce: signed!.nonce as Hex, issuedAt: BigInt(signed!.issued_at.getTime()/1000), expiresAt: BigInt(signed!.expires_at.getTime()/1000),
    }, signed!.signature as Hex);
    expect(recovered.toLowerCase()).toBe(signed!.signer_wallet_address);
    const versionBefore = await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`;
    await fx.sql`UPDATE core.projects SET name='User edited demo' WHERE tenant_id=${fx.tenantA} AND project_key=${key("REVIEW")}`;
    expect(await seedDevDemo(fx.sql, store, options)).toEqual({ created: [], skipped: [key("INPUT"), key("REVIEW"), key("PUBLIC")] });
    const [edited] = await fx.sql`SELECT name FROM core.projects WHERE tenant_id=${fx.tenantA} AND project_key=${key("REVIEW")}`;
    expect(edited?.name).toBe("User edited demo");
    expect(await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`).toEqual(versionBefore);
    expect(await fx.sql`SELECT * FROM core.role_bindings WHERE tenant_id=${fx.tenantA} ORDER BY id`).toEqual(bindingsBefore);
    expect(await fx.sql`SELECT id,email FROM core.subjects WHERE tenant_id=${fx.tenantA} AND id=ANY(${peopleBefore.map(row => row.id)}::uuid[]) ORDER BY id`).toEqual(peopleBefore);
    expect(await fx.sql`SELECT * FROM core.projects WHERE tenant_id=${fx.tenantB} ORDER BY id`).toEqual(otherBefore);
    const [countRow] = await fx.sql<{ count: string }[]>`SELECT count(*) FROM chain.anchor_batches WHERE tenant_id=${fx.tenantA}`;
    expect(countRow?.count).toBe("0");
  }, 15_000);

  it("does not finish a partial scenario after user edits or new user evidence", async () => {
    const [tenant] = await fx.sql<{ slug: string }[]>`SELECT slug FROM core.tenants WHERE id=${fx.tenantB}`;
    const otherOptions = { ...options, tenantSlug: tenant!.slug, scanTimeoutMs: 0 };
    await expect(seedDevDemo(ownerSql, store, otherOptions)).rejects.toThrow("scan timeout");
    const [project] = await fx.sql<{ id: string }[]>`SELECT id FROM core.projects WHERE tenant_id=${fx.tenantB} AND project_key=${`DEMO-V1-REVIEW-${fx.tenantB}`}`;
    await fx.sql`UPDATE core.projects SET name='User changed partial demo' WHERE id=${project!.id}`;
    await expect(seedDevDemo(ownerSql, store, otherOptions)).rejects.toThrow("was edited");
    const [preserved] = await fx.sql`SELECT name FROM core.projects WHERE id=${project!.id}`;
    expect(preserved?.name).toBe("User changed partial demo");
    // Start the second counterexample with the original untouched project metadata.
    await fx.sql`UPDATE core.projects SET name='SYNTHETIC DEMO — review' WHERE id=${project!.id}`;
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate)
      VALUES (${crypto.randomUUID()},${fx.tenantB},${project!.id},'mining_right_registration','User evidence','{}')`;
    await expect(seedDevDemo(ownerSql, store, otherOptions)).rejects.toThrow("user activity");
    const [count] = await fx.sql<{ count: string }[]>`SELECT count(*) FROM core.verification_attestations a
      JOIN core.verification_cases c ON c.id=a.case_id WHERE c.project_id=${project!.id}`;
    expect(count?.count).toBe("0");
  });
});
