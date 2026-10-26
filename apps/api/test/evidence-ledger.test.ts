import postgres from "postgres";
import { ROUTES } from "@mpc/api-contract";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type {FastifyInstance} from "fastify";
import { buildServer } from "../src/server.js";
import {loadConfig} from "../src/config.js";
import { setupFixture, signIn, testEnv, idempotencyKey, type TestFixture } from "./helpers/db.js";
import { publishProject, projectProjection, draftRegistryEntry, projectKeyOf } from "./helpers/registry.js";
import { computeEvidenceLedger, publicLedgerProjection, withTenant, type LedgerSnapshot } from "@mpc/db";
const describeDb=process.env['DATABASE_URL']?describe:describe.skip;

describeDb('computed ledger API and approved public boundary',()=>{
  let fx:TestFixture;let app:FastifyInstance;let token:string;let other:string;let scoped:string;let publisher:string;
  let catalogId:string;let claimType:string;
  beforeAll(async()=>{
    fx=await setupFixture();app=await buildServer(loadConfig(testEnv()),fx.appSql);
    token=await signIn(app,fx.operatorA);other=await signIn(app,fx.operatorB);
    scoped=await signIn(app,fx.scopedStewardA);publisher=await signIn(app,fx.disclosureApproverA);
    catalogId=randomUUID();claimType=`ledger_${randomUUID().replaceAll('-','')}`;
    const proposal=randomUUID();const payload={claimType,displayName:'Synthetic licence',description:null,definition:{fields:[{key:'number',label:'Number',type:'string',required:true}]}};
    await fx.sql.begin(async tx=>{
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${proposal},${fx.tenantA},'claim_type',${claimType},1,${tx.json(payload)},'Synthetic test',now(),${fx.operatorSubjectA})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        SELECT ${catalogId},tenant_id,item_key,1,'Synthetic licence',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposal}`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Synthetic test only',materialized_id=${catalogId},version=2 WHERE id=${proposal}`;
    });
  });
  afterAll(async()=>{await app.close();await fx.close();});
  const get=(projectId:string,auth=token)=>app.inject({method:'GET',url:`/api/v1/projects/${projectId}/evidence-ledger`,headers:{authorization:`Bearer ${auth}`}});
  const assess=(projectId=fx.projectA,payload:Record<string,unknown>={})=>app.inject({method:'POST',url:`/api/v1/projects/${projectId}/evidence-ledger`,headers:{authorization:`Bearer ${token}`,'idempotency-key':idempotencyKey()},payload});
  it('GET is read only, unrecorded evidence is missing and stage is unknown without rules',async()=>{
    const response=await get(fx.projectA);expect(response.statusCode,response.body).toBe(200);
    expect(response.json().snapshot).toMatchObject({id:null,currentStage:null,stages:[]});
    expect(response.json().snapshot.items.find((i:{claimType:string})=>i.claimType===claimType)).toMatchObject({status:'missing'});
    const [row]=await fx.sql`SELECT count(*)::int n FROM core.evidence_ledger_snapshots WHERE project_id=${fx.projectA}`;
    expect(row!.n).toBe(0);
  });
  it('rejects other tenants, out of scope projects and client supplied outcomes',async()=>{
    expect((await get(fx.projectA,other)).statusCode).toBe(404);
    expect([403,404]).toContain((await get(fx.otherProjectA,scoped)).statusCode);
    expect((await assess(fx.projectA,{currentStage:'stage.production'})).statusCode).toBe(400);
  });
  it('records immutable snapshots separately and never alters manual project facts',async()=>{
    const before=await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${fx.projectA}`;
    const response=await assess();expect(response.statusCode,response.body).toBe(200);
    const snapshot=response.json().snapshot as LedgerSnapshot;
    expect(snapshot.id).not.toBeNull();expect(response.json().publicProjection).toEqual(publicLedgerProjection({...snapshot,id:snapshot.id!}));
    expect(snapshot.inputBasis).toHaveProperty('catalog');
    expect(await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${fx.projectA}`).toEqual(before);
    await expect(fx.sql`UPDATE core.evidence_ledger_snapshots SET snapshot='{}' WHERE id=${snapshot.id!}`).rejects.toThrow();
    const otherRows=await withTenant(fx.appSql,{tenantId:fx.tenantB},tx=>tx`SELECT id FROM core.evidence_ledger_snapshots WHERE id=${snapshot.id!}`);
    expect(otherRows).toHaveLength(0);
  });
  it('rejects forged and cross-project ledger publication even with a real recorded snapshot',async()=>{
    const assessed=await assess();expect(assessed.statusCode,assessed.body).toBe(200);
    const ledger=assessed.json().publicProjection;
    const draft=async(projectId:string,evidenceLedger:Record<string,unknown>)=>draftRegistryEntry(app,token,{
      registryType:'project',subjectId:projectId,publicKey:await projectKeyOf(fx.sql,projectId),
      projection:await projectProjection(fx.sql,projectId,{evidenceLedger}),policyVersion:'1',schemaVersion:'1',
    });
    const forged=await draft(fx.projectA,{...ledger,currentStage:'stage.production'});
    expect(forged.statusCode,forged.body).toBe(422);expect(forged.json().code).toBe('PUBLICATION_LEDGER_MISMATCH');
    const wrongProject=await draft(fx.otherProjectA,ledger);
    expect(wrongProject.statusCode,wrongProject.body).toBe(422);expect(wrongProject.json().code).toBe('PUBLICATION_LEDGER_MISMATCH');
  });
  it('derives an approved stage from scoped reviewed evidence and warns on expiry without rewriting its public snapshot',async()=>{
    const projectId=randomUUID(),documentId=randomUUID(),artifactId=randomUUID(),claimId=randomUUID();
    const caseId=randomUUID(),assignmentId=randomUUID(),attestationId=randomUUID(),policyId=randomUUID();
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id,reference_status)
      VALUES(${projectId},${fx.tenantA},${'LED-'+projectId.slice(0,8)},'Synthetic ledger','MNG',ARRAY['copper'],${fx.orgA},'synthetic_test_project')`;
    const hash='0x'+'ab'.repeat(32);
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
      VALUES(${artifactId},${fx.tenantA},${projectId},'raw_source',${hash},'restricted')`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,promoted_artifact_id,valid_until)
      VALUES(${documentId},${fx.tenantA},${projectId},${documentId},${hash},123,'application/pdf','restricted','promoted',${artifactId},current_date)`;
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of)
      VALUES(${claimId},${fx.tenantA},${projectId},${claimType},'Private licence number','{}','verified',${catalogId},1,'{"number":"private-123"}',${[documentId]}::uuid[],current_date)`;
    await fx.sql`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state)
      VALUES(${caseId},${fx.tenantA},${projectId},${fx.schemaA},'signed')`;
    await fx.sql`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id)
      VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA})`;
    await fx.sql`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
      evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
      VALUES(${attestationId},${fx.tenantA},${caseId},${assignmentId},${fx.credentialA},${fx.schemaA},'professional_signoff',${[claimId]}::uuid[],
      ${hash},'Licence number only; no legal validity opinion','{"status":"valid"}','1','1',${hash},${'0x'+'12'.repeat(65)},${fx.reviewerA.address},now(),'signed')`;
    const definition={ruleSetId:'synthetic-ledger',version:'1.0.0',effectiveFrom:'2020-01-01T00:00:00Z',supersededBy:null,jurisdictionProfile:'MNG',gateId:'stage.exploration',retroactive:false,
      requirements:[{requirementId:'synthetic-licence',label:'Synthetic licence',appliesWhen:{op:'eq',path:'referenceStatus',value:'synthetic_test_project'},requiredClaimTypes:[claimType],minimumGrade:'verified',freshnessThresholdDays:null,requiredAttestations:['professional_signoff'],blockingConflictTypes:['contradiction'],notEvaluableWhen:{op:'never'},watchWhen:null},
        {requirementId:'inapplicable-licence',label:'Inapplicable synthetic licence',appliesWhen:{op:'never'},requiredClaimTypes:[claimType],minimumGrade:'verified',freshnessThresholdDays:null,requiredAttestations:[],blockingConflictTypes:[],notEvaluableWhen:{op:'never'},watchWhen:null}]};
    await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
      VALUES(${policyId},${fx.tenantA},'synthetic-ledger','1.0.0','stage.exploration','MNG',now(),${fx.sql.json(definition)},'effective')`;
    const assessed=await assess(projectId);expect(assessed.statusCode,assessed.body).toBe(200);
    const snapshot=assessed.json().snapshot;
    expect(snapshot.stages[0]).toMatchObject({reviewedItems:'1',requiredItems:'1'});
    expect(snapshot.currentStage).toBe('stage.exploration');expect(snapshot.items[0].status).toBe('reviewed');
    const projection=assessed.json().publicProjection;
    expect(projection.items[0].limitations).toEqual(['Licence number only; no legal validity opinion']);
    const publication=await publishProject(app,fx.sql,{drafter:token,publisher},projectId,{projection:await projectProjection(fx.sql,projectId,{evidenceLedger:projection})});
    expect(publication.statusCode,publication.body).toBe(200);
    const [before]=await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    // A current scoped signature does not raise the grade of newly added evidence.
    // Exercise both a passing addition and a weak addition without changing frozen bytes.
    const gradeRollback=new Error('Rollback synthetic grade evidence');
    for(const grade of ['verified','self_reported']){
      await expect(fx.sql.begin(async tx=>{
        const addedId=randomUUID();
        await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of)
          SELECT ${addedId},tenant_id,project_id,claim_type,value_text,source_coordinate,${grade},catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of
          FROM core.claims WHERE id=${claimId}`;
        await tx`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
          evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
          SELECT ${randomUUID()},tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,${[addedId]}::uuid[],
            evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state
          FROM core.verification_attestations WHERE id=${attestationId}`;
        const current=await computeEvidenceLedger(tx,fx.tenantA,projectId,new Date());
        expect(current!.items[0]!.status).toBe('reviewed');
        expect(current!.currentStage).toBe(grade==='verified'?'stage.exploration':null);
        expect(current!.stages[0]!.status).toBe(grade==='verified'?'ok':'gap');
        const [live]=await tx`SELECT core.public_evidence_ledger_current(${publication.json().id}) AS current`;
        expect(live!.current.warnings).toEqual(grade==='verified'?[]:[{claimType,catalogVersion:'1',status:'needs_re_review',reasons:['EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT']}]);
        const [stillApproved]=await tx`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
        expect(stillApproved).toEqual(before);
        throw gradeRollback;
      })).rejects.toBe(gradeRollback);
    }
    // A signed future-dated claim cannot establish a freshness-limited stage.
    const rollback=new Error('Rollback synthetic future evidence');
    await expect(fx.sql.begin(async tx=>{
      const freshnessDefinition={...definition,requirements:definition.requirements.map(requirement=>({...requirement,freshnessThresholdDays:'180'}))};
      await tx`UPDATE core.compliance_policy_sets SET definition=${tx.json(freshnessDefinition)} WHERE id=${policyId}`;
      const presentEvidence=await computeEvidenceLedger(tx,fx.tenantA,projectId,new Date());
      expect(presentEvidence!.currentStage,JSON.stringify(presentEvidence)).toBe('stage.exploration');
      const futureClaimId=randomUUID();
      await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of)
        SELECT ${futureClaimId},tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,'2099-01-01'
        FROM core.claims WHERE id=${claimId}`;
      await tx`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
        evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
        SELECT ${randomUUID()},tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,${[futureClaimId]}::uuid[],
          evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state
        FROM core.verification_attestations WHERE id=${attestationId}`;
      const futureEvidence=await computeEvidenceLedger(tx,fx.tenantA,projectId,new Date());
      expect(futureEvidence!.currentStage).toBeNull();
      expect(futureEvidence!.items[0]!.status).toBe('needs_re_review');
      const [live]=await tx`SELECT core.public_evidence_ledger_current(${publication.json().id}) AS current`;
      expect(live!.current.warnings).toEqual([{claimType,catalogVersion:'1',status:'needs_re_review',reasons:['EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT']}]);
      const [stillApproved]=await tx`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
      expect(stillApproved).toEqual(before);
      throw rollback;
    })).rejects.toBe(rollback);
    // Stage rules use the actual conflict type, rather than converting every open conflict
    // into each policy's configured blocking type. The item still truthfully shows conflict.
    const conflictId=randomUUID();
    await fx.sql`INSERT INTO core.claim_conflicts(id,tenant_id,claim_id,conflict_type)
      VALUES(${conflictId},${fx.tenantA},${claimId},'administrative_note')`;
    const nonblocking=await get(projectId);
    expect(nonblocking.json().snapshot.items[0].status).toBe('conflicting');
    expect(nonblocking.json().snapshot.currentStage).toBe('stage.exploration');
    await fx.sql`UPDATE core.claim_conflicts SET conflict_type='contradiction' WHERE id=${conflictId}`;
    expect((await get(projectId)).json().snapshot.currentStage).toBeNull();
    await fx.sql`UPDATE core.claim_conflicts SET resolved_at=now() WHERE id=${conflictId}`;
    // A post-approval exclusion removes evidence for the approved stage and must
    // warn publicly without changing the approved projection or its content hash.
    const exclusionRollback=new Error('Rollback synthetic manual exclusion');
    await expect(fx.sql.begin(async tx=>{
      await tx`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
        VALUES(${randomUUID()},${fx.tenantA},${projectId},${claimType},1,'not_applicable','Synthetic manual exclusion',${fx.operatorSubjectA})`;
      const excluded=await computeEvidenceLedger(tx,fx.tenantA,projectId,new Date());
      expect(excluded!.items[0]!.status).toBe('not_applicable');
      expect(excluded!.currentStage).toBeNull();
      expect(excluded!.stages[0]).toMatchObject({status:'gap',reviewedItems:'0',requiredItems:'0'});
      const [live]=await tx`SELECT core.public_evidence_ledger_current(${publication.json().id}) AS current`;
      expect(live!.current.warnings).toEqual([{claimType,catalogVersion:'1',status:'needs_re_review',reasons:['EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT']}]);
      const [stillApproved]=await tx`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
      expect(stillApproved).toEqual(before);
      throw exclusionRollback;
    })).rejects.toBe(exclusionRollback);
    // The approved v1 policy remains effective. A newer effective v2 is nevertheless selected
    // by the evaluator, so Explorer must warn without altering the frozen approval/hash.
    for(const ignored of [
      {tenantId:fx.tenantB,jurisdiction:'MNG',version:'90.0.0',effectiveFrom:'2020-01-01T00:00:00Z'},
      {tenantId:fx.tenantA,jurisdiction:'AUS',version:'91.0.0',effectiveFrom:'2020-01-01T00:00:00Z'},
      {tenantId:fx.tenantA,jurisdiction:'MNG',version:'92.0.0',effectiveFrom:'2099-01-01T00:00:00Z'},
    ]){
      const ignoredDefinition={...definition,version:ignored.version,jurisdictionProfile:ignored.jurisdiction,effectiveFrom:ignored.effectiveFrom};
      await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
        VALUES(${randomUUID()},${ignored.tenantId},'synthetic-ledger',${ignored.version},'stage.exploration',${ignored.jurisdiction},${ignored.effectiveFrom},${fx.sql.json(ignoredDefinition)},'effective')`;
    }
    expect((await get(projectId)).json().snapshot.currentStage).toBe('stage.exploration');
    const ignoredPublic=await app.inject({method:'GET',url:`/api/v1/public/registries/project/LED-${projectId.slice(0,8)}`});
    expect(ignoredPublic.json().evidenceLedgerCurrent.warnings).toEqual([]);
    const nextPolicy=randomUUID();
    const nextDefinition={...definition,version:'2.0.0',requirements:definition.requirements.map(requirement=>({...requirement,requiredAttestations:['professional_signoff','legal_notarization']}))};
    await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
      VALUES(${nextPolicy},${fx.tenantA},'synthetic-ledger','2.0.0','stage.exploration','MNG',now(),${fx.sql.json(nextDefinition)},'effective')`;
    const changedPolicy=await get(projectId);
    expect(changedPolicy.json().snapshot.currentStage).toBeNull();
    expect(changedPolicy.json().snapshot.stages[0].policySetId).toBe(nextPolicy);
    const policyPublic=await app.inject({method:'GET',url:`/api/v1/public/registries/project/LED-${projectId.slice(0,8)}`});
    expect(policyPublic.json().evidenceLedgerCurrent.warnings).toEqual([{claimType,catalogVersion:'1',status:'needs_re_review',reasons:['EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT']}]);
    expect(policyPublic.json().evidenceLedger).toEqual(projection);
    expect(policyPublic.body).not.toContain(nextPolicy);
    const [afterPolicy]=await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    expect(afterPolicy).toEqual(before);
    // A newly submitted claim under an approved item changes live standing, not frozen disclosure.
    const addedClaim=randomUUID();
    await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids)
      VALUES(${addedClaim},${fx.tenantA},${projectId},${claimType},'New private number','{}','unverified',${catalogId},1,'{"number":"private-added"}',${[documentId]}::uuid[])`;
    const [undatedHealth]=await fx.sql`SELECT as_of,stale FROM core.ledger_claim_health(${projectId},now()) WHERE id=${addedClaim}`;
    expect(undatedHealth).toMatchObject({as_of:null,stale:false});
    const addedCurrent=await get(projectId);
    expect(addedCurrent.json().snapshot.items[0].status).toBe('unreviewed');
    const addedPublic=await app.inject({method:'GET',url:`/api/v1/public/registries/project/LED-${projectId.slice(0,8)}`});
    expect(addedPublic.statusCode,addedPublic.body).toBe(200);
    expect(addedPublic.json().evidenceLedgerCurrent.warnings).toEqual([{claimType,catalogVersion:'1',status:'needs_re_review',reasons:['EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT']}]);
    expect(addedPublic.json().evidenceLedger).toEqual(projection);
    expect(addedPublic.body).not.toContain(addedClaim);expect(addedPublic.body).not.toContain('private-added');
    const [afterAddition]=await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    expect(afterAddition).toEqual(before);
    // Passage of time alone must reach the persisted worker result, without editing a document.
    const originalDocument=await fx.sql`SELECT valid_until,state FROM core.object_uploads WHERE id=${documentId}`;
    const manualBefore=await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${projectId}`;
    const [originalSnapshot]=await fx.sql`SELECT snapshot FROM core.evidence_ledger_snapshots WHERE id=${snapshot.id}`;
    const {createLedgerSweep}=await import(new URL('../../jobs-worker/src/evidence-ledger.ts',import.meta.url).href);
    const futureTimestamp=Date.now()+2*24*60*60*1000;
    const futureWorker=postgres(process.env['DATABASE_URL']!,{max:1,connection:{options:'-c role=mpc_worker'},onnotice:()=>{}});
    try{
      const result=await createLedgerSweep(futureWorker,1000,()=>futureTimestamp)();
      expect(result.ran).toBe(true);expect(result.recorded).toBeGreaterThan(0);
    }finally{await futureWorker.end();}
    const [futureSnapshot]=await fx.sql`SELECT id,snapshot FROM core.evidence_ledger_snapshots
      WHERE project_id=${projectId} ORDER BY created_at DESC,id DESC LIMIT 1`;
    expect(futureSnapshot!.id).not.toBe(snapshot.id);
    expect(futureSnapshot!.snapshot.evaluatedAt).toBe(new Date(futureTimestamp).toISOString());
    expect(futureSnapshot!.snapshot.items[0].status).toBe('needs_re_review');
    expect(futureSnapshot!.snapshot.currentStage).toBeNull();
    expect(futureSnapshot!.snapshot.stages[0]).toMatchObject({reviewedItems:'0',requiredItems:'1'});
    expect(await fx.sql`SELECT valid_until,state FROM core.object_uploads WHERE id=${documentId}`).toEqual(originalDocument);
    expect(await fx.sql`SELECT * FROM core.project_facts WHERE project_id=${projectId}`).toEqual(manualBefore);
    const [unchangedSnapshot]=await fx.sql`SELECT snapshot FROM core.evidence_ledger_snapshots WHERE id=${snapshot.id}`;
    expect(unchangedSnapshot).toEqual(originalSnapshot);
    await fx.sql`UPDATE core.object_uploads SET valid_until=current_date-1 WHERE id=${documentId}`;
    const fresh=await get(projectId);expect(fresh.json().snapshot.items[0].status).toBe('needs_re_review');
    expect(fresh.json().snapshot.currentStage).toBeNull();
    expect(fresh.json().snapshot.stages[0]).toMatchObject({reviewedItems:'0',requiredItems:'1'});
    const publicResponse=await app.inject({method:'GET',url:`/api/v1/public/registries/project/LED-${projectId.slice(0,8)}`});
    expect(publicResponse.statusCode,publicResponse.body).toBe(200);
    const responseSchema=ROUTES.find(route=>route.operationId==='getPublicRegistryEntry')!.responseSchema!;
    const parsedPublicResponse=responseSchema.safeParse(publicResponse.json());
    expect(parsedPublicResponse.success,JSON.stringify(parsedPublicResponse)).toBe(true);
    expect(responseSchema.safeParse({...publicResponse.json<Record<string,unknown>>(),unapprovedPrivateField:'must reject'}).success).toBe(false);
    expect(publicResponse.json().evidenceLedger).toEqual(projection);
    expect(publicResponse.json().evidenceLedgerCurrent.warnings).toEqual([{claimType,catalogVersion:'1',status:'needs_re_review',reasons:['EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT']}]);
    expect(publicResponse.body).not.toContain('private-123');expect(publicResponse.body).not.toContain(documentId);expect(publicResponse.body).not.toContain(attestationId);
    const staleDraft=await draftRegistryEntry(app,token,{registryType:'project',subjectId:projectId,
      publicKey:await projectKeyOf(fx.sql,projectId),projection:await projectProjection(fx.sql,projectId,{evidenceLedger:projection}),policyVersion:'1',schemaVersion:'1'});
    expect(staleDraft.statusCode,staleDraft.body).toBe(422);expect(staleDraft.json().code).toBe('PUBLICATION_LEDGER_STALE');
    const [after]=await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    expect(after).toEqual(before);
    // A valid review must not hide a second, disputed review on a newly added claim.
    for (const state of ['signed','disputed']) {
      await fx.sql`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
        evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
        SELECT ${randomUUID()},tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,${[addedClaim]}::uuid[],
          evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,${state}
        FROM core.verification_attestations WHERE id=${attestationId}`;
    }
    expect((await get(projectId)).json().snapshot.items[0].status).toBe('conflicting');
    const disputedPublic=await app.inject({method:'GET',url:`/api/v1/public/registries/project/LED-${projectId.slice(0,8)}`});
    expect(disputedPublic.json().evidenceLedgerCurrent.warnings).toEqual([{claimType,catalogVersion:'1',status:'conflicting',reasons:['UNRESOLVED_CONFLICT']}]);
    expect(disputedPublic.json().evidenceLedger).toEqual(projection);
  });
  it('warns when an approved exclusion is withdrawn without claims, preserving the approved snapshot',async()=>{
    await fx.sql`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},${claimType},1,'not_applicable','Excluded before approval',${fx.operatorSubjectA})`;
    const assessed=await assess(fx.projectA);expect(assessed.statusCode,assessed.body).toBe(200);
    expect(assessed.json().snapshot.items.find((item:{claimType:string})=>item.claimType===claimType)).toMatchObject({status:'not_applicable',claimIds:[]});
    const publication=await publishProject(app,fx.sql,{drafter:token,publisher},fx.projectA,{projection:await projectProjection(fx.sql,fx.projectA,{evidenceLedger:assessed.json().publicProjection})});
    expect(publication.statusCode,publication.body).toBe(200);
    const [before]=await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    const response=await app.inject({method:'GET',url:`/api/v1/public/registries/project/${await projectKeyOf(fx.sql,fx.projectA)}`});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().evidenceLedgerCurrent.warnings).toEqual([]);
    // An unchanged exclusion decision must remain quiet, even when recorded again.
    await fx.sql`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},${claimType},2,'not_applicable','Exclusion reconfirmed',${fx.operatorSubjectA})`;
    await fx.sql`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
      VALUES(${randomUUID()},${fx.tenantA},${fx.otherProjectA},${claimType},1,'pending','Another project must not affect this exclusion',${fx.operatorSubjectA})`;
    const unchanged=await app.inject({method:'GET',url:`/api/v1/public/registries/project/${await projectKeyOf(fx.sql,fx.projectA)}`});
    expect(unchanged.json().evidenceLedgerCurrent.warnings).toEqual([]);
    await fx.sql`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
      VALUES(${randomUUID()},${fx.tenantA},${fx.projectA},${claimType},3,'pending','Exclusion withdrawn',${fx.operatorSubjectA})`;
    const current=await get(fx.projectA);
    expect(current.json().snapshot.items.find((item:{claimType:string})=>item.claimType===claimType)).toMatchObject({status:'missing',claimIds:[]});
    const withdrawn=await app.inject({method:'GET',url:`/api/v1/public/registries/project/${await projectKeyOf(fx.sql,fx.projectA)}`});
    expect(withdrawn.statusCode,withdrawn.body).toBe(200);
    expect(withdrawn.json().evidenceLedgerCurrent.warnings).toEqual([{claimType,catalogVersion:'1',status:'needs_re_review',reasons:['EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT']}]);
    expect(withdrawn.json().evidenceLedger).toEqual(assessed.json().publicProjection);
    const [after]=await fx.sql`SELECT content_hash,public_projection FROM core.registry_entry_versions WHERE id=${publication.json().id}`;
    expect(after).toEqual(before);
  });
  it('does not apply an inapplicable minimum grade to an independently reviewed public item',async()=>{
    const projectId=fx.otherProjectA,otherCatalog=randomUUID(),otherType=`extra_${randomUUID().replaceAll('-','')}`;
    const proposal=randomUUID(),payload={claimType:otherType,displayName:'Unrelated synthetic evidence',description:null,definition:{fields:[]}};
    await fx.sql.begin(async tx=>{
      await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
        VALUES(${proposal},${fx.tenantA},'claim_type',${otherType},1,${tx.json(payload)},'Synthetic test',now(),${fx.operatorSubjectA})`;
      await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
        SELECT ${otherCatalog},tenant_id,item_key,1,payload->>'displayName',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposal}`;
      await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Synthetic test only',materialized_id=${otherCatalog},version=2 WHERE id=${proposal}`;
    });
    const documentId=randomUUID(),artifactId=randomUUID(),hash='0x'+'cd'.repeat(32),claimIds=[randomUUID(),randomUUID()];
    await fx.sql`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,sensitivity)
      VALUES(${artifactId},${fx.tenantA},${projectId},'raw_source',${hash},'restricted')`;
    await fx.sql`INSERT INTO core.object_uploads(id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state,promoted_artifact_id)
      VALUES(${documentId},${fx.tenantA},${projectId},${documentId},${hash},123,'application/pdf','restricted','promoted',${artifactId})`;
    for(const [index,entry] of [{type:claimType,catalog:catalogId,grade:'verified',values:{number:'private-primary'}},{type:otherType,catalog:otherCatalog,grade:'self_reported',values:{}}].entries()){
      await fx.sql`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,grade,catalog_entry_id,catalog_version,structured_values,document_upload_ids,as_of)
        VALUES(${claimIds[index]!},${fx.tenantA},${projectId},${entry.type},'Private synthetic input','{}',${entry.grade},${entry.catalog},1,${fx.sql.json(entry.values)},${[documentId]}::uuid[],current_date)`;
    }
    // PostgreSQL now() has microseconds; an immediate JS evaluation can still be at
    // the start of that millisecond. Eligibility is not the boundary under test here.
    const eligibleAt=new Date(Date.now()-1000);
    const caseId=randomUUID(),assignmentId=randomUUID();
    await fx.sql`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state)
      VALUES(${caseId},${fx.tenantA},${projectId},${fx.schemaA},'signed')`;
    await fx.sql`INSERT INTO core.assignments(id,tenant_id,case_id,subject_id,credential_id)
      VALUES(${assignmentId},${fx.tenantA},${caseId},${fx.reviewerSubjectA},${fx.credentialA})`;
    await fx.sql`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,
      evidence_snapshot_hash,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
      VALUES(${randomUUID()},${fx.tenantA},${caseId},${assignmentId},${fx.credentialA},${fx.schemaA},'professional_signoff',${claimIds}::uuid[],
      ${hash},'Synthetic scope only','{"status":"valid"}','1','1',${hash},${'0x'+'12'.repeat(65)},${fx.reviewerA.address},${eligibleAt},'signed')`;
    const definition={ruleSetId:'synthetic-unrelated',version:'1.0.0',effectiveFrom:'2020-01-01T00:00:00Z',supersededBy:null,jurisdictionProfile:'MNG',gateId:'stage.production',retroactive:false,
      requirements:[{requirementId:'primary',label:'Primary',appliesWhen:{op:'always'},requiredClaimTypes:[claimType],minimumGrade:'verified',freshnessThresholdDays:null,requiredAttestations:['professional_signoff'],blockingConflictTypes:[],notEvaluableWhen:{op:'never'},watchWhen:null},
        {requirementId:'unrelated',label:'Not applicable',appliesWhen:{op:'eq',path:'referenceStatus',value:'not_this_project'},requiredClaimTypes:[otherType],minimumGrade:'verified',freshnessThresholdDays:null,requiredAttestations:[],blockingConflictTypes:[],notEvaluableWhen:{op:'never'},watchWhen:null}]};
    await fx.sql`INSERT INTO core.compliance_policy_sets(id,tenant_id,rule_set_id,rule_set_version,gate_id,jurisdiction_profile,effective_from,definition,state)
      VALUES(${randomUUID()},${fx.tenantA},'synthetic-unrelated','1.0.0','stage.production','MNG',${eligibleAt},${fx.sql.json(definition)},'effective')`;
    const assessed=await assess(projectId);expect(assessed.statusCode,assessed.body).toBe(200);
    expect(assessed.json().snapshot.currentStage).toBe('stage.production');
    expect(assessed.json().snapshot.items.find((item:{claimType:string})=>item.claimType===otherType)).toMatchObject({status:'reviewed',grade:'self_reported'});
    const publication=await publishProject(app,fx.sql,{drafter:token,publisher},projectId,{projection:await projectProjection(fx.sql,projectId,{evidenceLedger:assessed.json().publicProjection})});
    expect(publication.statusCode,publication.body).toBe(200);
    const response=await app.inject({method:'GET',url:`/api/v1/public/registries/project/${await projectKeyOf(fx.sql,projectId)}`});
    expect(response.statusCode,response.body).toBe(200);
    expect(response.json().evidenceLedgerCurrent.warnings).toEqual([]);
    const exclusionRollback=new Error('Rollback unrelated manual exclusion');
    await expect(fx.sql.begin(async tx=>{
      await tx`INSERT INTO core.project_fact_versions(id,tenant_id,project_id,fact_key,version,status,reason,recorded_by_subject_id)
        VALUES(${randomUUID()},${fx.tenantA},${projectId},${otherType},1,'not_applicable','Unrelated synthetic exclusion',${fx.operatorSubjectA})`;
      expect((await computeEvidenceLedger(tx,fx.tenantA,projectId,new Date()))!.currentStage).toBe('stage.production');
      const [live]=await tx`SELECT core.public_evidence_ledger_current(${publication.json().id}) AS current`;
      expect(live!.current.warnings).toEqual([]);
      throw exclusionRollback;
    })).rejects.toBe(exclusionRollback);
  });
  it('worker persists changed outcomes with its restricted database role and reuses stable outcomes',async()=>{
    // Runtime import exercises the deployed worker without adding it to the API build graph.
    const {createLedgerSweep}=await import(new URL('../../jobs-worker/src/evidence-ledger.ts',import.meta.url).href);
    await fx.sql`INSERT INTO core.jurisdiction_profiles(id,tenant_id,jurisdiction,profile_version,state,environmental_requirement_basis,effective_from)
      VALUES(${randomUUID()},${fx.tenantA},'MNG',1,'approved','Own tenant basis','2020-01-01')`;
    await fx.sql`INSERT INTO core.jurisdiction_profiles(id,tenant_id,jurisdiction,profile_version,state,environmental_requirement_basis,effective_from)
      VALUES(${randomUUID()},${fx.tenantB},'MNG',1,'approved','Other tenant private basis','2020-01-01')`;
    await fx.sql`INSERT INTO core.jurisdiction_profiles(id,tenant_id,jurisdiction,profile_version,state,environmental_requirement_basis,effective_from)
      VALUES(${randomUUID()},${fx.tenantB},'MNG',2,'suspended','Other tenant private basis','2020-01-01')`;
    let now=Date.now();
    const worker=postgres(process.env['DATABASE_URL']!,{max:1,connection:{options:'-c role=mpc_worker'},onnotice:()=>{}});
    try{
      const sweep=createLedgerSweep(worker,1000,()=>now);
      const first=await sweep();expect(first.ran).toBe(true);
      expect(await sweep()).toEqual({ran:false,recorded:0});
      now+=1001;
      const again=await sweep();expect(again).toEqual({ran:true,recorded:0});
      const events=await fx.sql`SELECT id FROM audit.events WHERE tenant_id=${fx.tenantA} AND command='evidence_ledger.assessed' AND detail->>'actor'='jobs_worker'`;
      expect(events.length).toBeGreaterThan(0);
      const [latest]=await fx.sql`SELECT snapshot FROM core.evidence_ledger_snapshots WHERE tenant_id=${fx.tenantA}
        ORDER BY created_at DESC,id DESC LIMIT 1`;
      expect(latest!.snapshot.inputBasis.profile).toEqual([{state:'approved',environmental_requirement_basis:'Own tenant basis',profile_version:'1'}]);
      expect(JSON.stringify(latest!.snapshot)).not.toContain('Other tenant private basis');
    }finally{await worker.end();}
  });
  it('worker revisits recorded projects without structured claims after catalog changes',async()=>{
    const projectId=randomUUID();
    await fx.sql`INSERT INTO core.projects(id,tenant_id,project_key,name,host_country_iso3,minerals,owner_organization_id)
      VALUES(${projectId},${fx.tenantA},${'EMPTY-'+projectId.slice(0,8)},'Empty assessed project','MNG',ARRAY['copper'],${fx.orgA})`;
    const initial=await assess(projectId);expect(initial.statusCode,initial.body).toBe(200);
    const proposal=randomUUID(),catalog=randomUUID(),newType='new_'+randomUUID().replaceAll('-','');
    const payload={claimType:newType,displayName:'New catalog requirement',description:null,definition:{fields:[]}};
    await fx.sql.begin(async tx=>{
    await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
      VALUES(${proposal},${fx.tenantA},'claim_type',${newType},1,${tx.json(payload)},'Synthetic test',now(),${fx.operatorSubjectA})`;
    await tx`INSERT INTO core.claim_types(id,tenant_id,claim_type,catalog_version,display_name,definition,effective_from)
      SELECT ${catalog},tenant_id,item_key,1,'New catalog requirement',payload->'definition',effective_from FROM core.registry_proposals WHERE id=${proposal}`;
    await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${fx.reviewerSubjectA},decided_at=now(),decision_reason='Synthetic test only',materialized_id=${catalog},version=2 WHERE id=${proposal}`;
    });
    const {createLedgerSweep}=await import(new URL('../../jobs-worker/src/evidence-ledger.ts',import.meta.url).href);
    const worker=postgres(process.env['DATABASE_URL']!,{max:1,connection:{options:'-c role=mpc_worker'},onnotice:()=>{}});
    try {expect((await createLedgerSweep(worker,1000)()).recorded).toBeGreaterThan(0);}finally{await worker.end();}
    const [latest]=await fx.sql`SELECT id,snapshot FROM core.evidence_ledger_snapshots WHERE project_id=${projectId} ORDER BY created_at DESC,id DESC LIMIT 1`;
    expect(latest!.id).not.toBe(initial.json().snapshot.id);
    expect(latest!.snapshot.items).toContainEqual(expect.objectContaining({claimType:newType,status:'missing'}));
    const [claims]=await fx.sql`SELECT count(*)::int n FROM core.claims WHERE project_id=${projectId}`;
    expect(claims!.n).toBe(0);
  });
  it('freezes independently approved summary, exposes no private basis and only warns on published item scope',async()=>{
    const response=await assess();expect(response.statusCode,response.body).toBe(200);
    const projection=response.json().publicProjection;
    const publication=await publishProject(app,fx.sql,{drafter:token,publisher},fx.projectA,{projection:await projectProjection(fx.sql,fx.projectA,{evidenceLedger:projection})});
    expect(publication.statusCode,publication.body).toBe(200);
    const [project]=await fx.sql`SELECT project_key FROM core.projects WHERE id=${fx.projectA}`;
    const publicResponse=await app.inject({method:'GET',url:`/api/v1/public/registries/project/${project!.project_key}`});
    expect(publicResponse.statusCode,publicResponse.body).toBe(200);
    const responseSchema=ROUTES.find(route=>route.operationId==='getPublicRegistryEntry')!.responseSchema!;
    const parsedPublicResponse=responseSchema.safeParse(publicResponse.json());
    expect(parsedPublicResponse.success,JSON.stringify(parsedPublicResponse)).toBe(true);
    expect(responseSchema.safeParse({...publicResponse.json<Record<string,unknown>>(),unapprovedPrivateField:'must reject'}).success).toBe(false);
    expect(publicResponse.json().evidenceLedger).toEqual(projection);
    expect(publicResponse.json().evidenceLedgerCurrent.warnings).toEqual([]);
    expect(publicResponse.body).not.toContain('inputBasis');expect(publicResponse.body).not.toContain('claimIds');
    expect(publicResponse.body).not.toContain('attestationIds');
  });
});
