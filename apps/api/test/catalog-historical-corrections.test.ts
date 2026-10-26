import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { snapshotClaimFingerprint, hashSnapshotInput, type SnapshotClaimRow } from "../src/services/evidence-snapshot.js";
import { resolveCatalogClaim } from "../src/services/catalog-claims.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
describeDb("historical reserved catalog claim corrections", () => {
  let fx: TestFixture, app: FastifyInstance, steward: string;
  const catalogId=randomUUID(), otherCatalogId=randomUUID(), claimId=randomUUID(), uploadId=randomUUID();
  beforeAll(async () => {
    fx=await setupFixture();
    await fx.sql.begin(async tx => {
      await tx`ALTER TABLE core.registry_proposals DISABLE TRIGGER catalog_proposal_reserved_key_guard`;
      await tx`ALTER TABLE core.claim_types DISABLE TRIGGER catalog_type_reserved_key_guard`;
      await tx`ALTER TABLE core.claims DISABLE TRIGGER catalog_claim_reserved_key_guard`;
      for (const [id,version] of [[catalogId,1],[otherCatalogId,2]] as const) {
        const proposal=randomUUID(),payload={claimType:'rights',displayName:'Historical rights',description:null,definition:{fields:[{key:'note',label:'Note',type:'string',required:true}]}};
        await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
          VALUES(${proposal},${fx.tenantA},'claim_type','rights',${version},${tx.json(payload)},'Historical fixture',now(),${fx.operatorSubjectA})`;
        await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
          SELECT ${id},tenant_id,item_key,item_version,'Historical rights',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposal}`;
        await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Historical approval',materialized_id=${id},version=2 WHERE id=${proposal}`;
      }
      await tx`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state)
        VALUES(${uploadId},${fx.tenantA},${fx.projectA},${uploadId},${'0x'+'ab'.repeat(32)},123,'application/pdf','restricted','scanned_clean')`;
      await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,catalog_entry_id,catalog_version,structured_values,document_upload_ids)
        VALUES(${claimId},${fx.tenantA},${fx.projectA},'rights','Original rights','{}',${catalogId},1,'{"note":"original"}',${[uploadId]}::uuid[])`;
      await tx`SET CONSTRAINTS ALL IMMEDIATE`;
      await tx`ALTER TABLE core.registry_proposals ENABLE TRIGGER catalog_proposal_reserved_key_guard`;
      await tx`ALTER TABLE core.claim_types ENABLE TRIGGER catalog_type_reserved_key_guard`;
      await tx`ALTER TABLE core.claims ENABLE TRIGGER catalog_claim_reserved_key_guard`;
    });
    app=await buildServer(loadConfig(testEnv()),fx.appSql);steward=await signIn(app,fx.stewardA);
  });
  afterAll(async()=>{await app?.close();await fx?.close();});
  const headers=()=>({authorization:`Bearer ${steward}`,'idempotency-key':idempotencyKey(),'if-match':'"1"'});

  it("keeps creation closed and rejects mismatched correction parents at API service and DB boundaries",async()=>{
    const fresh=await app.inject({method:'POST',url:`/api/v1/projects/${fx.projectA}/claims`,headers:headers(),payload:{claimType:'rights',valueText:'New rights',sourceCoordinate:{},catalogEntryId:catalogId,structuredValues:{note:'new'},previousClaimId:claimId}});
    expect(fresh.statusCode,fresh.body).toBe(422);expect(fresh.json().code).toBe('CLAIM_TYPE_RESERVED');
    await expect(withTenant(fx.appSql,{tenantId:fx.tenantB},tx=>resolveCatalogClaim(tx,fx.projectA,'rights',{catalogEntryId:catalogId,structuredValues:{note:'new'}},claimId)))
      .rejects.toMatchObject({code:'CLAIM_TYPE_RESERVED'});
    for(const [parent,project,catalog] of [[randomUUID(),fx.projectA,catalogId],[claimId,fx.otherProjectA,catalogId],[claimId,fx.projectA,otherCatalogId]] as const){
      await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>resolveCatalogClaim(tx,project,'rights',{catalogEntryId:catalog,structuredValues:{note:'new'}},parent)))
        .rejects.toMatchObject({code:'CLAIM_TYPE_RESERVED'});
      const version=catalog===catalogId?1:2;
      await expect(withTenant(fx.appSql,{tenantId:fx.tenantA},tx=>tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,catalog_entry_id,catalog_version,structured_values,supersedes_claim_id,correction_reason)
        VALUES(${randomUUID()},${fx.tenantA},${project},'rights','New rights','{}',${catalog},${version},'{"note":"new"}',${parent},'Correction')`)).rejects.toThrow(/reserved/);
    }
  });

  it("corrects existing reserved claims while preserving historical bytes and binding new documents to v2 fingerprints",async()=>{
    const readOld=async()=>(await fx.sql<SnapshotClaimRow[]>`SELECT id,value_text,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids FROM core.claims WHERE id=${claimId}`)[0]!;
    const old=await readOld();
    const response=await app.inject({method:'POST',url:`/api/v1/claims/${claimId}/versions`,headers:headers(),payload:{valueText:'Corrected rights',sourceCoordinate:{},structuredValues:{note:'corrected'},reason:'Correct historical text'}});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json()).toMatchObject({catalogEntryId:catalogId,catalogVersion:1,structuredValues:{note:'corrected'},documentUploadIds:[uploadId]});
    expect(await readOld()).toEqual(old);
    const [corrected]=await fx.sql<SnapshotClaimRow[]>`SELECT id,value_text,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids FROM core.claims WHERE id=${response.json().id}`;
    const hash=(row:SnapshotClaimRow)=>hashSnapshotInput({claimIds:[row.id],artifactIds:[],receiptIds:[],claimFingerprints:[snapshotClaimFingerprint(row)]});
    expect(hash(corrected!)).not.toBe(hash({...corrected!,document_upload_ids:[]}));
    expect(snapshotClaimFingerprint(corrected!)).toHaveProperty('structured.documentUploadIds',[uploadId]);
    const ledger=await app.inject({method:'GET',url:`/api/v1/projects/${fx.projectA}/evidence-ledger`,headers:headers()});
    expect(ledger.statusCode,ledger.body).toBe(200);
    expect(ledger.json().snapshot.items.some((item:{claimType:string})=>item.claimType==='rights')).toBe(false);
    expect(ledger.json().snapshot.inputBasis.claims.some((item:{id:string})=>item.id===response.json().id)).toBe(false);
    const duplicate=await app.inject({method:'POST',url:`/api/v1/claims/${claimId}/versions`,headers:headers(),payload:{valueText:'Another correction',sourceCoordinate:{},structuredValues:{note:'another'},reason:'Cannot fork'}});
    expect(duplicate.statusCode).toBe(412);
  });
});
