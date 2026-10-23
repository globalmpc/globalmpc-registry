import { describe, expect, it } from "vitest";
import { evaluateRequirement, type Requirement } from '@mpc/policy';
import { deriveLedgerItemStatus, ledgerRequirementEvidence, stageEvidenceCoverage, evidenceLedgerSemantic, publicLedgerProjection, type LedgerClaim, type LedgerAttestation, type LedgerSnapshot } from "../src/evidence-ledger.js";

const claim:LedgerClaim={id:'claim',claim_type:'licence',catalog_entry_id:'catalog',catalog_version:1,grade:'verified',as_of:null,value_text:'secret',stale:false,has_evidence:true,conflict_ids:[],conflict_types:[],upload_ids:['document'],signal_ids:[],excluded_by_rule:false};
const attestation:LedgerAttestation={id:'review',claim_scope:['claim'],attestation_type:'document_review',state:'signed',limitations:'Only the licence number was reviewed.',valid:true,credential_id:'credential',valid_until:null};
describe('computed ledger evidence standing',()=>{
  it('does not confirm missing evidence or a grade without an actual scoped review',()=>{
    expect(deriveLedgerItemStatus([],[]).status).toBe('missing');
    expect(deriveLedgerItemStatus([claim],[]).status).toBe('unreviewed');
    expect(deriveLedgerItemStatus([{...claim,has_evidence:false}],[attestation]).status).toBe('unreviewed');
    expect(deriveLedgerItemStatus([claim],[{...attestation,claim_scope:['unrelated']}]).status).toBe('unreviewed');
  });
  it('requires every claim in an item to have a current scoped review',()=>{
    expect(deriveLedgerItemStatus([claim],[attestation])).toMatchObject({status:'reviewed',limitations:[attestation.limitations]});
    expect(deriveLedgerItemStatus([claim,{...claim,id:'second'}],[attestation]).status).toBe('unreviewed');
  });
  it('conflict and stale evidence override passing reviews and explicit not applicable',()=>{
    expect(deriveLedgerItemStatus([{...claim,conflict_ids:['conflict'],stale:true}],[attestation],true).status).toBe('conflicting');
    expect(deriveLedgerItemStatus([{...claim,stale:true}],[attestation],true).status).toBe('needs_re_review');
    expect(deriveLedgerItemStatus([claim],[{...attestation,valid:false}],true).status).toBe('needs_re_review');
    expect(deriveLedgerItemStatus([{...claim,grade:'rejected'}],[attestation],true).status).toBe('rejected');
  });
  it('preserves superseded reviews as history without putting them in the live warning basis',()=>{
    const result=deriveLedgerItemStatus([claim],[attestation,{...attestation,id:'old',state:'superseded',valid:false}]);
    expect(result).toMatchObject({status:'reviewed',attestationIds:['review']});
  });
  it('only records not applicable from explicit manual input and never substitutes it for a conflict',()=>{
    expect(deriveLedgerItemStatus([],[],true).status).toBe('not_applicable');
    expect(deriveLedgerItemStatus([claim],[{...attestation,state:'disputed',valid:false}],true).status).toBe('conflicting');
  });
});
const snapshot:LedgerSnapshot & {id:string}={id:'snapshot',projectId:'project',evaluatedAt:'2026-10-23T00:00:00.000Z',inputSnapshotHash:'hash',evaluatorVersion:'1',inputBasis:{},items:[{claimType:'licence',catalogVersion:1,displayName:'Licence',status:'reviewed',grade:'verified',reviewScope:['licence'],reviews:[],claimIds:['claim'],attestationIds:['review'],reasons:['CURRENT_SCOPED_REVIEW'],limitations:[attestation.limitations]}],stages:[],currentStage:null,limitations:[]};
describe('ledger publication basis',()=>{
  it('publishes actual consciously approved limitations without private evidence identifiers',()=>{
    const projection=publicLedgerProjection(snapshot);
    expect(projection.items[0]?.limitations).toEqual([attestation.limitations]);
    expect(JSON.stringify(projection)).not.toContain('claimIds');
    expect(JSON.stringify(projection)).not.toContain('attestationIds');
  });
  it('ignores only evaluation metadata in freshness comparisons',()=>{
    expect(evidenceLedgerSemantic(snapshot)).toEqual(evidenceLedgerSemantic({...snapshot,id:'new',evaluatedAt:'later',inputSnapshotHash:'other'}));
    expect(evidenceLedgerSemantic(snapshot)).not.toEqual(evidenceLedgerSemantic({...snapshot,items:[{...snapshot.items[0]!,claimIds:['corrected']}]}));
    expect(evidenceLedgerSemantic(snapshot)).not.toEqual(evidenceLedgerSemantic({...snapshot,items:[{...snapshot.items[0]!,attestationIds:['new-review']}]}));
  });
});

describe('stage evidence coverage',()=>{
  const requirements=[{requirementId:'applicable',requiredClaimTypes:['licence','licence','permit']},{requirementId:'excluded',requiredClaimTypes:['future']}];
  const results=[{requirementId:'applicable',applicable:true},{requirementId:'excluded',applicable:false}];
  it('counts applicable logical types once and requires every pinned version to be reviewed',()=>{
    const licence=snapshot.items[0]!;
    expect(stageEvidenceCoverage(requirements,results,[licence,{...licence,catalogVersion:2,claimIds:['v2'],status:'unreviewed'}])).toEqual({reviewedItems:'0',requiredItems:'2'});
    expect(stageEvidenceCoverage(requirements,results,[licence,{...licence,catalogVersion:2,claimIds:['v2']}])).toEqual({reviewedItems:'1',requiredItems:'2'});
  });
  it('excludes explicit not applicable items and leaves evidence-free requirements unreviewed',()=>{
    expect(stageEvidenceCoverage(requirements,results,[{...snapshot.items[0]!,status:'not_applicable'}])).toEqual({reviewedItems:'0',requiredItems:'1'});
    expect(stageEvidenceCoverage(requirements,results,[])).toEqual({reviewedItems:'0',requiredItems:'2'});
  });
});


describe('stage policy evidence inputs',()=>{
  const now = new Date('2026-10-23T00:00:00Z');
  const stageAttestation={...attestation,attestation_type:'professional_signoff'};
  const requirement:Requirement={requirementId:'licence',label:'Licence',appliesWhen:{op:'always'},
    requiredClaimTypes:['licence'],minimumGrade:'verified',freshnessThresholdDays:'0',
    requiredAttestations:['professional_signoff'],blockingConflictTypes:[],notEvaluableWhen:{op:'never'},watchWhen:null};
  it.each(['0',null])('rejects future evidence before stage policy evaluation with freshness threshold %s',(threshold)=>{
    const future={...claim,as_of:new Date('2099-01-01T00:00:00Z')};
    const current={...claim,id:'current',as_of:now};
    // A current claim must not hide the future claim when their maximum age is calculated.
    for(const claims of [[future],[current,future]]){
      const facts=ledgerRequirementEvidence(['licence'],claims,[{...stageAttestation,claim_scope:claims.map(c=>c.id)}],[],now);
      expect(facts).toMatchObject({evidenceAgeDays:null,staleEvidence:['licence']});
      expect(evaluateRequirement({...requirement,freshnessThresholdDays:threshold},{...facts,context:{}}))
        .toMatchObject({status:'gap',reasonCode:'EVIDENCE_STALE'});
    }
  });
  it('uses UTC calendar days at same-day and next-day boundaries',()=>{
    const lateToday=new Date('2026-10-23T23:59:59.999Z');
    const factsFor=(asOf:Date,evaluatedAt:Date)=>ledgerRequirementEvidence(['licence'],[{...claim,as_of:asOf}],[stageAttestation],[],evaluatedAt);
    expect(factsFor(lateToday,now)).toMatchObject({evidenceAgeDays:'0',staleEvidence:[]});
    expect(evaluateRequirement(requirement,{...factsFor(now,lateToday),context:{}}).status).toBe('ok');
    expect(factsFor(new Date('2026-10-24T00:00:00Z'),lateToday)).toMatchObject({evidenceAgeDays:null,staleEvidence:['licence']});
    expect(factsFor(lateToday,new Date('2026-10-24T00:00:00Z')).evidenceAgeDays).toBe('1');
  });
  it('preserves missing-date behavior for policies with and without freshness requirements',()=>{
    const facts={...ledgerRequirementEvidence(['licence'],[claim],[stageAttestation],[],now),context:{}};
    expect(facts).toMatchObject({evidenceAgeDays:null,staleEvidence:[]});
    expect(evaluateRequirement(requirement,facts).status).toBe('not_evaluable');
    expect(evaluateRequirement({...requirement,freshnessThresholdDays:null},facts).status).toBe('ok');
  });
  it('does not let explicitly excluded evidence satisfy presence, grade, attestation or freshness',()=>{
    const excluded = {...snapshot.items[0]!,status:'not_applicable' as const};
    expect(ledgerRequirementEvidence(['licence'],[claim],[attestation],[excluded],now)).toEqual({
      presentClaimTypes:[],grade:null,presentAttestations:[],evidenceAgeDays:null,
      unresolvedConflictTypes:[],staleEvidence:[],
    });
    const other={...claim,id:'permit',claim_type:'permit',catalog_entry_id:'permit-catalog'};
    expect(ledgerRequirementEvidence(['licence','permit'],[claim,other],[attestation],[excluded],now))
      .toMatchObject({presentClaimTypes:['permit'],grade:'verified',presentAttestations:[],staleEvidence:['permit']});
  });
  it('passes actual conflict types without misclassifying a current nonblocking conflict as stale',()=>{
    const conflicted={...claim,conflict_ids:['conflict'],conflict_types:['administrative_note']};
    const item={...snapshot.items[0]!,status:'conflicting' as const};
    expect(deriveLedgerItemStatus([conflicted],[attestation]).status).toBe('conflicting');
    expect(ledgerRequirementEvidence(['licence'],[conflicted],[attestation],[item],now))
      .toMatchObject({presentClaimTypes:['licence'],grade:'verified',presentAttestations:['document_review'],unresolvedConflictTypes:['administrative_note'],staleEvidence:[]});
    expect(ledgerRequirementEvidence(['licence'],[{...conflicted,stale:true}],[attestation],[item],now).staleEvidence).toEqual(['licence']);
    expect(ledgerRequirementEvidence(['licence'],[conflicted],[{...attestation,valid:false}],[item],now).staleEvidence).toEqual(['licence']);
  });
});
