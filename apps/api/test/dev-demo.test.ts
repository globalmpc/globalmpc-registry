import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createMemoryObjectStore, computeContentHash } from "@mpc/storage";
import postgres from "postgres";
import { withTenant, computeEvidenceLedger } from "@mpc/db";
import type { Hex } from "viem";
import { assertDemoEnvironment, DEMO_LIMITATION, seedDevDemo } from "../src/dev-demo.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { recoverAttestationSigner, uuidToBytes32 } from "../src/services/attestation-signing.js";
import { setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

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
    expect(publicResponse.json().evidenceLedger.stages).toEqual(expect.arrayContaining([
      expect.objectContaining({gateId:"stage.exploration",reviewedItems:"1",requiredItems:"1"}),
    ]));
    expect(publicResponse.json().evidenceLedger.items[0]).not.toHaveProperty("claimIds");
    const [review] = await fx.sql`SELECT a.signature,a.limitations,asn.independence_reviewed FROM core.verification_attestations a
      JOIN core.assignments asn ON asn.id=a.assignment_id WHERE a.tenant_id=${fx.tenantA} AND a.limitations=${DEMO_LIMITATION} LIMIT 1`;
    expect(review?.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(review?.independence_reviewed).toBe(true);
    const seededEpochs=await fx.sql`SELECT a.id,a.schema_activation_epoch,COALESCE(clock.epoch,0)::text AS current_epoch
      FROM core.verification_attestations a JOIN core.attestation_schemas s ON s.id=a.schema_id
      LEFT JOIN core.schema_activation_clocks clock ON clock.tenant_id=s.tenant_id AND clock.schema_key=s.schema_key
      WHERE a.tenant_id=${fx.tenantA} AND a.limitations=${DEMO_LIMITATION} ORDER BY a.id`;
    expect(seededEpochs).toHaveLength(2);
    for(const row of seededEpochs) expect(row.schema_activation_epoch).toBe(row.current_epoch);
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
    expect(await seedDevDemo(fx.sql, store, options)).toEqual({ created: [], skipped: [key("INPUT"), key("REVIEW"), key("PUBLIC")], assessed: [] });
    const [edited] = await fx.sql`SELECT name FROM core.projects WHERE tenant_id=${fx.tenantA} AND project_key=${key("REVIEW")}`;
    expect(edited?.name).toBe("User edited demo");
    expect(await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`).toEqual(versionBefore);
    expect(await fx.sql`SELECT * FROM core.role_bindings WHERE tenant_id=${fx.tenantA} ORDER BY id`).toEqual(bindingsBefore);
    expect(await fx.sql`SELECT id,email FROM core.subjects WHERE tenant_id=${fx.tenantA} AND id=ANY(${peopleBefore.map(row => row.id)}::uuid[]) ORDER BY id`).toEqual(peopleBefore);
    expect(await fx.sql`SELECT * FROM core.projects WHERE tenant_id=${fx.tenantB} ORDER BY id`).toEqual(otherBefore);
    const [countRow] = await fx.sql<{ count: string }[]>`SELECT count(*) FROM chain.anchor_batches WHERE tenant_id=${fx.tenantA}`;
    expect(countRow?.count).toBe("0");
  }, 15_000);

  it("computes numeric coverage and confines every demo definition to its own project", async () => {
    const projects = await fx.sql<{id:string;project_key:string}[]>`SELECT id,project_key FROM core.projects WHERE tenant_id=${fx.tenantA} AND project_key LIKE 'DEMO-V1-%'`;
    const operator = await signIn(app, fx.operatorA);
    for (const project of projects) {
      const snapshot = await withTenant(fx.appSql, { tenantId: fx.tenantA }, tx => computeEvidenceLedger(tx,fx.tenantA,project.id,new Date()));
      const scenario = project.project_key.split("-")[2]!;
      expect(snapshot!.stages).toHaveLength(1);
      expect(snapshot!.stages[0]).toMatchObject({gateId:"stage.exploration",requiredItems:"1",reviewedItems:scenario === "INPUT" ? "0" : "1",status:scenario === "INPUT" ? "gap" : "ok"});
      const ownType = `synthetic_dev_demo_${scenario.toLowerCase()}_licence`;
      expect(snapshot!.items.filter(i=>i.claimType.startsWith("synthetic_dev_demo_")).map(i=>i.claimType)).toEqual([ownType]);
      expect(snapshot!.stages[0]!.itemClaimTypes).toEqual([ownType]);
      const catalog = await app.inject({url:`/api/v1/claim-types?projectId=${project.id}`,headers:{authorization:`Bearer ${operator}`}});
      expect(catalog.statusCode).toBe(200);
      expect(catalog.json().items.filter((i:{claimType:string})=>i.claimType.startsWith("synthetic_dev_demo_")).map((i:{claimType:string})=>i.claimType)).toEqual([ownType]);
      const wrongProject = await app.inject({method:"POST",url:`/api/v1/projects/${fx.projectA}/readiness-assessments`,
        headers:{authorization:`Bearer ${operator}`,"idempotency-key":crypto.randomUUID()},payload:{policySetId:snapshot!.stages[0]!.policySetId}});
      expect(wrongProject.statusCode).toBe(404);
    }
    const scopedReviewer = await signIn(app,fx.scopedStewardA);
    expect((await app.inject({url:`/api/v1/claim-types?projectId=${fx.projectA}`,headers:{authorization:`Bearer ${scopedReviewer}`}})).statusCode).toBe(200);
    expect((await app.inject({url:`/api/v1/claim-types?projectId=${projects[0]!.id}`,headers:{authorization:`Bearer ${scopedReviewer}`}})).statusCode).toBe(403);
    const foreignOperator = await signIn(app,fx.operatorB);
    expect((await app.inject({url:`/api/v1/claim-types?projectId=${projects[0]!.id}`,headers:{authorization:`Bearer ${foreignOperator}`}})).statusCode).toBe(404);
    const normal = await withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>computeEvidenceLedger(tx,fx.tenantA,fx.projectA,new Date()));
    expect(normal!.stages).toEqual([]);
    expect(normal!.items.some(i=>i.claimType.startsWith("synthetic_dev_demo_"))).toBe(false);
    const globalCatalog = await app.inject({url:"/api/v1/claim-types",headers:{authorization:`Bearer ${operator}`}});
    expect(globalCatalog.json().items.some((i:{claimType:string})=>i.claimType.startsWith("synthetic_dev_demo_"))).toBe(false);
    const [catalog] = await fx.sql`SELECT id,claim_type FROM core.claim_types WHERE project_id=${projects[0]!.id}`;
    await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,catalog_entry_id,catalog_version,structured_values)
      VALUES(${crypto.randomUUID()},${fx.tenantA},${fx.projectA},${catalog!.claim_type},'Bad cross-project binding','{}',${catalog!.id},1,'{"reference":"bad"}')`)).rejects.toThrow("Catalog entry belongs to another project");
    const [policy] = await fx.sql`SELECT id FROM core.compliance_policy_sets WHERE project_id=${projects[0]!.id}`;
    const hash = `0x${"ab".repeat(32)}`;
    await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>tx`INSERT INTO core.compliance_assessments(id,tenant_id,project_id,gate_id,policy_set_id,input_snapshot_hash,evaluated_as_of,status,requirement_results,canonical_result_hash)
      VALUES(${crypto.randomUUID()},${fx.tenantA},${fx.projectA},'stage.exploration',${policy!.id},${hash},now(),'gap','[]',${hash})`)).rejects.toThrow("Policy belongs to another project");
    await expect(fx.sql`UPDATE core.compliance_policy_sets SET project_id=NULL WHERE id=${policy!.id}`).rejects.toThrow("Policy project scope is immutable");
    expect(await withTenant(fx.appSql,{tenantId:fx.tenantB},tx=>tx`SELECT id FROM core.effective_stage_policy_sets(${projects[0]!.id},now())`)).toEqual([]);
  });

  it("backfills completed legacy demos additively without upgrading old unpinned evidence", async () => {
    const tenant = crypto.randomUUID(), org = crypto.randomUUID();
    await fx.sql`INSERT INTO core.tenants(id,slug,display_name) VALUES(${tenant},${tenant},'Legacy demo upgrade')`;
    await fx.sql`INSERT INTO core.organizations(id,tenant_id,legal_name,jurisdiction) VALUES(${org},${tenant},'Legacy demo owner','MNG')`;
    const ids: string[] = [];
    for (const scenario of ["INPUT","REVIEW","PUBLIC"]) {
      // Freeze the deployed v1 identity namespace, independent of the new coverage definitions.
      const hex = createHash("sha256").update(`registry-dev-demo-v1:${tenant}:${scenario}`).digest("hex");
      const project = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
      ids.push(project);
      await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,reference_status,owner_organization_id)
        VALUES(${project},${tenant},${`DEMO-V1-${scenario}-${tenant}`},'User edited legacy demo','MNG',ARRAY['copper'],'synthetic_test_project',${org})`;
      for (const command of ["dev_demo.started","dev_demo.completed"]) await fx.sql`
        INSERT INTO audit.events(tenant_id,project_id,command,resource_type,resource_id,reason,correlation_id)
        VALUES(${tenant},${project},${command},'project',${project},${DEMO_LIMITATION},${crypto.randomUUID()})`;
    }
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate)
      VALUES(${crypto.randomUUID()},${tenant},${ids[1]!},'synthetic_dev_demo_licence','Original legacy claim','{}')`;
    const claimsBefore = await fx.sql`SELECT * FROM core.claims WHERE tenant_id=${tenant}`;
    const projectsBefore = await fx.sql`SELECT * FROM core.projects WHERE tenant_id=${tenant} ORDER BY id`;
    const legacyOptions = {...options,tenantSlug:tenant,ownerOrganizationName:'Legacy demo owner'};
    const first = await seedDevDemo(ownerSql,store,legacyOptions);
    expect(first.created).toEqual([]);
    expect(first.skipped).toHaveLength(3);
    expect(first.assessed).toHaveLength(3);
    const snapshots = await fx.sql`SELECT * FROM core.evidence_ledger_snapshots WHERE tenant_id=${tenant} ORDER BY id`;
    expect(snapshots).toHaveLength(3);
    for (const row of snapshots) expect(row.snapshot.stages[0]).toMatchObject({requiredItems:"1",reviewedItems:"0"});
    await seedDevDemo(ownerSql,store,legacyOptions);
    expect(await fx.sql`SELECT * FROM core.evidence_ledger_snapshots WHERE tenant_id=${tenant} ORDER BY id`).toEqual(snapshots);
    expect(await fx.sql`SELECT * FROM core.claims WHERE tenant_id=${tenant}`).toEqual(claimsBefore);
    expect(await fx.sql`SELECT * FROM core.projects WHERE tenant_id=${tenant} ORDER BY id`).toEqual(projectsBefore);
    // Reclassifying a demo cannot turn its synthetic requirements into real project authority.
    await expect(fx.sql`UPDATE core.projects SET reference_status='none' WHERE id=${ids[0]!}`).rejects.toThrow("synthetic_test_project is fixed at creation");

  });

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
  it("adds five public stage examples without rewriting existing publications, and retries safely", async () => {
    const before = await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`;
    let stopped = false;
    const scanner = (async () => {
      while (!stopped) {
        const uploads = await fx.sql`SELECT id,version FROM core.object_uploads WHERE tenant_id=${fx.tenantA} AND state='quarantined'`;
        for (const upload of uploads) {
          const r = await app.inject({method:"POST",url:`/api/v1/uploads/${upload.id}/scan-result`,
            headers:{authorization:`Bearer ${fx.scanServiceToken}`,"idempotency-key":crypto.randomUUID(),"if-match":`"${upload.version}"`},payload:{result:"clean"}});
          expect(r.statusCode,r.body).toBe(200);
        }
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    })();
    try {
      const seeded = await seedDevDemo(ownerSql,store,{...options,includeStageProjects:true});
      expect(seeded.created).toHaveLength(5);
    } finally { stopped=true; await scanner; }
    const gates=["exploration","resource_defined","feasibility","permitted","production"];
    for (const [index,gate] of gates.entries()) {
      const r=await app.inject(`/api/v1/public/registries/project/${key(`STAGE-${index+1}`)}`);
      expect(r.statusCode,r.body).toBe(200);
      expect(r.json().evidenceLedger.currentStage).toBe(`stage.${gate}`);
      expect(r.json().evidenceLedger.stages).toHaveLength(5);
      for (const stage of r.json().evidenceLedger.stages) expect(stage.itemClaimTypes).toEqual([`synthetic_dev_demo_stage_${index+1}_licence`]);
      expect(r.json().evidenceLedger.stages.filter((x:{status:string})=>x.status==="ok")).toHaveLength(index+1);
      expect(r.json().limitations).toContain(DEMO_LIMITATION);
    }
    const versions=await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`;
    expect(versions.filter(v=>before.some(old=>old.id===v.id))).toEqual(before);
    expect((await seedDevDemo(ownerSql,store,{...options,includeStageProjects:true})).created).toEqual([]);
    expect(await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`).toEqual(versions);
  });

  it("adds rich document projects through scanning, preserving publications and repeated runs", async () => {
    const before = await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`;
    let puts = 0;
    const interruptedStore = {...store, put: async (...args: Parameters<typeof store.put>) => {
      if (++puts === 5) throw new Error("synthetic interrupted upload");
      return store.put(...args);
    }};
    await expect(seedDevDemo(ownerSql,interruptedStore,{...options,includeDocumentProjects:true})).rejects.toThrow("synthetic interrupted upload");
    const partialUploads=await fx.sql`SELECT u.id FROM core.object_uploads u JOIN core.projects p ON p.id=u.project_id WHERE p.project_key=${key("DOCUMENTS-1")}`;
    expect(partialUploads).toHaveLength(4);
    await expect(seedDevDemo(ownerSql,store,{...options,includeDocumentProjects:true,scanTimeoutMs:0})).rejects.toThrow("scan timeout");
    const [partial] = await fx.sql<{id:string}[]>`SELECT id FROM core.projects WHERE project_key=${key("DOCUMENTS-1")}`;
    const uploadsBefore = await fx.sql`SELECT id,state FROM core.object_uploads WHERE project_id=${partial!.id} ORDER BY id`;
    expect(uploadsBefore).toHaveLength(20);
    expect(uploadsBefore.every(upload=>upload.state==='quarantined')).toBe(true);
    let stopped = false;
    const scanner = (async () => {
      while (!stopped) {
        const uploads = await fx.sql<{id:string;version:number}[]>`SELECT id,version FROM core.object_uploads WHERE tenant_id=${fx.tenantA} AND state='quarantined'`;
        for (const upload of uploads) {
          const response = await app.inject({method:"POST",url:`/api/v1/uploads/${upload.id}/scan-result`,headers:{authorization:`Bearer ${fx.scanServiceToken}`,"idempotency-key":crypto.randomUUID(),"if-match":`"${upload.version}"`},payload:{result:"clean"}});
          expect(response.statusCode,response.body).toBe(200);
        }
        await new Promise(resolve=>setTimeout(resolve,5));
      }
    })();
    try {
      const result = await seedDevDemo(ownerSql,store,{...options,includeDocumentProjects:true});
      expect(result.created).toHaveLength(3);
    } finally { stopped=true; await scanner; }
    for (const stage of [1,3,5]) {
      const response=await app.inject(`/api/v1/public/registries/project/${key(`DOCUMENTS-${stage}`)}`);
      expect(response.statusCode,response.body).toBe(200);
      const ledger=response.json().evidenceLedger;
      expect(ledger.items).toHaveLength(20);
      for (const [index, assessed] of ledger.stages.entries()) {
        expect(assessed.status).toBe(index < stage ? "ok" : "gap");
        expect(String(assessed.requiredItems)).toBe("4");
        expect(String(assessed.reviewedItems)).toBe(index < stage ? "4" : "0");
      }
      const [project] = await fx.sql<{id:string}[]>`SELECT id FROM core.projects WHERE project_key=${key(`DOCUMENTS-${stage}`)}`;
      const coordinates=await fx.sql`SELECT source_coordinate FROM core.claims WHERE project_id=${project!.id}`;
      expect(coordinates).toHaveLength(20);
      expect(coordinates.every(row=>typeof row.source_coordinate === 'object' && typeof row.source_coordinate.reference === 'string')).toBe(true);
      const attestations=await fx.sql`SELECT a.id FROM core.verification_attestations a JOIN core.verification_cases c ON c.id=a.case_id WHERE c.project_id=${project!.id}`;
      expect(attestations).toHaveLength(stage*4);
      const catalogs=await fx.sql`SELECT project_id FROM core.claim_types WHERE tenant_id=${fx.tenantA} AND claim_type LIKE ${`synthetic_dev_demo_documents_${stage}_licence%`}`;
      expect(catalogs).toHaveLength(20);
      expect(catalogs.every(row=>row.project_id===project!.id)).toBe(true);
      const policies=await fx.sql`SELECT project_id,definition FROM core.compliance_policy_sets WHERE project_id=${project!.id}`;
      expect(policies).toHaveLength(5);
      const labels=policies.flatMap(row=>row.definition.requirements.map((requirement:{label:string})=>requirement.label));
      expect(new Set(labels).size).toBe(20);

      expect(ledger.currentStage).toBe(`stage.${["exploration","resource_defined","feasibility","permitted","production"][stage-1]}`);
      expect(ledger.items.filter((item:{status:string})=>item.status==="reviewed")).toHaveLength(stage*4);
      const uploads=await fx.sql`SELECT u.state FROM core.object_uploads u JOIN core.projects p ON p.id=u.project_id WHERE p.project_key=${key(`DOCUMENTS-${stage}`)}`;
      expect(uploads).toHaveLength(20);
      expect(uploads.every(upload=>upload.state==='promoted')).toBe(true);
      expect(JSON.stringify(ledger)).not.toContain('object_key');
    }
    const after=await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`;
    expect(after.filter(row=>before.some(old=>old.id===row.id))).toEqual(before);
    expect((await seedDevDemo(ownerSql,store,{...options,includeDocumentProjects:true})).created).toEqual([]);
    expect(await fx.sql`SELECT * FROM core.registry_entry_versions WHERE tenant_id=${fx.tenantA} ORDER BY id`).toEqual(after);
  }, 30_000);

  it("rejects an unexpected upload on a partial document project without deleting it", async () => {
    const other = await setupFixture();
    const objects = createMemoryObjectStore();
    const [tenant] = await other.sql<{slug:string}[]>`SELECT slug FROM core.tenants WHERE id=${other.tenantA}`;
    const opts={...options,tenantSlug:tenant!.slug,scanTimeoutMs:0,includeDocumentProjects:true};
    const seedOwner=postgres(process.env["DATABASE_URL"]!,{connection:{role:ownerRole},onnotice:()=>{}});
    try {
      // Complete the original fixtures first using the same scanner transition as the existing fixture tests.
      const server=await buildServer(loadConfig(testEnv()),other.appSql);
      let stopped=false;
      const scanner=(async()=>{while(!stopped){
        for(const upload of await other.sql`SELECT id,version FROM core.object_uploads WHERE tenant_id=${other.tenantA} AND state='quarantined'`){
          const response=await server.inject({method:"POST",url:`/api/v1/uploads/${upload.id}/scan-result`,headers:{authorization:`Bearer ${other.scanServiceToken}`,"idempotency-key":crypto.randomUUID(),"if-match":`"${upload.version}"`},payload:{result:"clean"}});
          expect(response.statusCode,response.body).toBe(200);
        }
        await new Promise(resolve=>setTimeout(resolve,5));
      }})();
      try{await seedDevDemo(seedOwner,objects,{...opts,includeDocumentProjects:false,scanTimeoutMs:3000});}
      finally{stopped=true;await scanner;await server.close();}
      await expect(seedDevDemo(seedOwner,objects,opts)).rejects.toThrow("scan timeout");
      const [project]=await other.sql<{id:string}[]>`SELECT id FROM core.projects WHERE tenant_id=${other.tenantA} AND project_key LIKE 'DEMO-V1-DOCUMENTS-1-%'`;
      const unexpected=crypto.randomUUID();
      await other.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,original_filename,sensitivity,state)
        VALUES(${unexpected},${other.tenantA},${project!.id},'synthetic-user-upload',${computeContentHash(Buffer.from('user fixture'))},1,'text/plain','user.txt','public','quarantined')`;
      await expect(seedDevDemo(seedOwner,objects,opts)).rejects.toThrow("user activity");
      expect(await other.sql`SELECT id FROM core.object_uploads WHERE id=${unexpected}`).toHaveLength(1);
    } finally {await seedOwner.end();await other.close();}
  },30_000);

});
