import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { lockEvidenceLedgerPublicationInputs } from "../src/services/registry-publication.js";
import { setupFixture, signIn, testEnv, idempotencyKey, type TestFixture } from "./helpers/db.js";
import { draftRegistryEntry, projectProjection, projectKeyOf } from "./helpers/registry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("ledger publication concurrency", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  beforeAll(async () => { fx = await setupFixture(); app = await buildServer(loadConfig(testEnv()), fx.appSql); });
  afterAll(async () => { await app.close(); await fx.close(); });

  it("keeps supporting document writes from committing between the final read and commit", async () => {
    const upload = randomUUID();
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,valid_until)
      VALUES(${upload},${fx.tenantA},${fx.projectA},${upload},${'0x'+'ab'.repeat(32)},10,'application/pdf','restricted','received','2099-01-01')`;
    await withTenant(fx.appSql, { tenantId: fx.tenantA }, async tx => {
      await lockEvidenceLedgerPublicationInputs(tx);
      const [before] = await tx`SELECT valid_until FROM core.object_uploads WHERE id=${upload}`;
      await expect(fx.sql.begin(async writer => {
        await writer`SET LOCAL lock_timeout = '100ms'`;
        await writer`UPDATE core.object_uploads SET valid_until='2000-01-01' WHERE id=${upload}`;
      })).rejects.toMatchObject({code: '55P03'});
      const [after] = await tx`SELECT valid_until FROM core.object_uploads WHERE id=${upload}`;
      expect(after).toEqual(before);
    });
    await fx.sql`UPDATE core.object_uploads SET valid_until='2000-01-01' WHERE id=${upload}`;
    const [changed] = await fx.sql`SELECT valid_until::text FROM core.object_uploads WHERE id=${upload}`;
    expect(changed!.valid_until).toBe('2000-01-01');
  });

  it("fails fast during a writer and permits retry with the original publication idempotency key", async () => {
    const token = await signIn(app, fx.operatorA);
    const publisher = await signIn(app, fx.disclosureApproverA);
    const assessed = await app.inject({method:'POST',url:`/api/v1/projects/${fx.projectA}/evidence-ledger`,headers:{authorization:`Bearer ${token}`,'idempotency-key':idempotencyKey()},payload:{}});
    expect(assessed.statusCode, assessed.body).toBe(200);
    const drafted = await draftRegistryEntry(app, token, {
      registryType:'project',subjectId:fx.projectA,publicKey:await projectKeyOf(fx.sql,fx.projectA),
      projection:await projectProjection(fx.sql,fx.projectA,{evidenceLedger:assessed.json().publicProjection}),
      policyVersion:'mn-core-1.0.0',schemaVersion:'project-registry-1',
    });
    expect(drafted.statusCode,drafted.body).toBe(200);
    const draft = drafted.json();
    const key = idempotencyKey();
    const publish = () => app.inject({method:'POST',url:`/api/v1/registry-entries/drafts/${draft.id}/publish`,headers:{authorization:`Bearer ${publisher}`,'idempotency-key':key,'if-match':`"${draft.version}"`},payload:{irreversibilityAcknowledged:true}});
    await fx.sql.begin(async writer => {
      // The table lock also catches a mutation that has taken its row lock but not written yet.
      await writer`SELECT id FROM core.projects WHERE id=${fx.projectA} FOR UPDATE`;
      const busy = await publish();
      expect(busy.statusCode,busy.body).toBe(503);
      expect(busy.json()).toMatchObject({code:'PUBLICATION_EVIDENCE_BUSY',retryable:true});
      const [pending] = await writer`SELECT state FROM core.registry_publication_drafts WHERE id=${draft.id}`;
      expect(pending!.state).toBe('pending');
    });
    const retried = await publish();
    expect(retried.statusCode,retried.body).toBe(200);
  });
});
