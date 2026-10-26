import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
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
      await lockEvidenceLedgerPublicationInputs(tx, fx.projectA);
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
      // Catch a lifecycle mutation that has taken its row lock but not written yet.
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

// Exercise the SQL barrier directly: API-only locking misses workers and direct SQL writers.
describeDb("project-scoped publication barrier", () => {
  let fx: TestFixture;
  beforeAll(async () => { fx = await setupFixture(); });
  afterAll(async () => { await fx.close(); });

  async function insertUpload(tx: postgres.TransactionSql, tenant: string, project: string): Promise<void> {
    const id = randomUUID();
    await tx`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state)
      VALUES(${id},${tenant},${project},${id},${'0x'+'cd'.repeat(32)},10,'application/pdf','restricted','received')`;
  }

  it("allows unrelated evidence writes and publications in both tenants", async () => {
    const [other] = await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,owner_organization_id)
      VALUES(${randomUUID()},${fx.tenantB},${randomUUID()},'Other tenant','MNG',${fx.orgB}) RETURNING id`;
    await withTenant(fx.appSql, {tenantId:fx.tenantA}, async tx => {
      await lockEvidenceLedgerPublicationInputs(tx,fx.projectA);
      await fx.sql.begin(async writer => {
        await writer`SET LOCAL lock_timeout='200ms'`;
        await insertUpload(writer,fx.tenantA,fx.otherProjectA);
        await insertUpload(writer,fx.tenantB,other!.id);
      });
      await withTenant(fx.appSql,{tenantId:fx.tenantB},async otherTx => {
        await lockEvidenceLedgerPublicationInputs(otherTx,other!.id);
      });
      await withTenant(fx.appSql,{tenantId:fx.tenantA},async otherTx => {
        await lockEvidenceLedgerPublicationInputs(otherTx,fx.otherProjectA);
      });
    });
  });

  it("blocks a new document, claim and manual applicability row in the published project", async () => {
    await withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
      await lockEvidenceLedgerPublicationInputs(tx,fx.projectA);
      for (const kind of ['document','claim','manual']) {
        await expect(fx.sql.begin(async writer => {
          await writer`SET LOCAL lock_timeout='100ms'`;
          if(kind==='document') await insertUpload(writer,fx.tenantA,fx.projectA);
          if(kind==='claim') await writer`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate)
            VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},'publication_race','new','{}'::jsonb)`;
          if(kind==='manual') await writer`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
            VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},'publication_race',1,'pending','Race regression',${fx.operatorSubjectA})`;
        })).rejects.toMatchObject({code:'55P03'});
      }
    });
  });

  it("protects indirect claim conflicts while unrelated claims can commit", async () => {
    const claim = randomUUID();
    const conflict = randomUUID();
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate)
      VALUES(${claim},${fx.tenantA},${fx.projectA},'publication_conflict','original','{}'::jsonb)`;
    await withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
      await lockEvidenceLedgerPublicationInputs(tx,fx.projectA);
      await expect(fx.sql.begin(async writer => {
        await writer`SET LOCAL lock_timeout='100ms'`;
        await writer`INSERT INTO core.claim_conflicts(id,tenant_id,claim_id,conflict_type)
          VALUES(${conflict},${fx.tenantA},${claim},'publication_conflict')`;
      })).rejects.toMatchObject({code:'55P03'});
      await fx.sql.begin(async writer => {
        await writer`SET LOCAL lock_timeout='200ms'`;
        await writer`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate)
          VALUES(${randomUUID()},${fx.tenantA},${fx.otherProjectA},'publication_conflict','unrelated','{}'::jsonb)`;
      });
    });
    await fx.sql`INSERT INTO core.claim_conflicts(id,tenant_id,claim_id,conflict_type)
      VALUES(${conflict},${fx.tenantA},${claim},'publication_conflict')`;
    const [recorded] = await fx.sql`SELECT id FROM core.claim_conflicts WHERE id=${conflict}`;
    expect(recorded?.id).toBe(conflict);
  });

  it("fails fast when an uncommitted insert already owns the project barrier", async () => {
    await fx.sql.begin(async writer => {
      await insertUpload(writer,fx.tenantA,fx.projectA);
      await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
        await lockEvidenceLedgerPublicationInputs(tx,fx.projectA);
      })).rejects.toMatchObject({code:'PUBLICATION_EVIDENCE_BUSY'});
    });
  });

  it("coordinates tenant definitions without blocking another tenant's configuration", async () => {
    const schemaB = randomUUID();
    await fx.sql`INSERT INTO core.attestation_schemas(id,tenant_id,schema_key,schema_version,attestation_type,jurisdiction_profile,state)
      VALUES(${schemaB},${fx.tenantB},'publication-barrier','1','professional_signoff','MNG','active')`;
    await withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
      await lockEvidenceLedgerPublicationInputs(tx,fx.projectA);
      await expect(fx.sql.begin(async writer => {
        await writer`SET LOCAL lock_timeout='100ms'`;
        await writer`UPDATE core.attestation_schemas SET state=state WHERE id=${fx.schemaA}`;
      })).rejects.toMatchObject({code:'55P03'});
      await fx.sql.begin(async writer => {
        await writer`SET LOCAL lock_timeout='200ms'`;
        await writer`UPDATE core.attestation_schemas SET state=state WHERE id=${schemaB}`;
      });
    });
    await fx.sql.begin(async writer => {
      await writer`UPDATE core.attestation_schemas SET state=state WHERE id=${fx.schemaA}`;
      await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
        await lockEvidenceLedgerPublicationInputs(tx,fx.projectA);
      })).rejects.toMatchObject({code:'PUBLICATION_EVIDENCE_BUSY'});
    });
  });

  it("rejects foreign and missing projects and denies the legacy global lock", async () => {
    await expect(withTenant(fx.appSql,{tenantId:fx.tenantB},async tx => {
      await tx`SELECT core.lock_ledger_publication_inputs(${fx.projectA})`;
    })).rejects.toMatchObject({code:'42501'});
    await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
      await tx`SELECT core.lock_ledger_publication_inputs(${randomUUID()})`;
    })).rejects.toMatchObject({code:'42501'});
    await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},async tx => {
      await tx`SELECT core.lock_ledger_publication_inputs()`;
    })).rejects.toMatchObject({code:'42501'});
  });
});
