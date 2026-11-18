import {expect,it} from "vitest";
import type postgres from "postgres";
import {freezeReviewBundle} from "../src/services/review-commitment.js";

it("commits receipt-only document uploads and refuses missing referenced bytes",async()=>{
 const receiptId=crypto.randomUUID(),uploadId=crypto.randomUUID(),attestationId=crypto.randomUUID();
 const hash=`0x${'a'.repeat(64)}`;
 let uploadPresent=true;
 const tx=(async(parts:TemplateStringsArray)=>{
  const sql=parts.join("?");
  if(sql.includes('FROM core.verification_attestations a'))return [{id:attestationId,signature:'0x1234',signer_wallet_address:'0x1',payload_hash:hash,evidence_snapshot_hash:hash,claim_scope:[],findings:[],citations:[],limitations:'Legacy fixture',credential_status_snapshot:{},signing_envelope:null,evidence_snapshot:{receiptIds:[receiptId],artifactIds:[],claims:[]}}];
  if(sql.includes('FROM core.artifacts'))return [];
  if(sql.includes('FROM core.source_receipts'))return [{id:receiptId,raw_hash:hash,channel_evidence:{documentUploadId:uploadId,documentHash:hash}}];
  if(sql.includes('FROM core.object_uploads'))return uploadPresent?[{id:uploadId,content_hash:hash}]:[];
  throw new Error('Unexpected query');
 }) as unknown as postgres.TransactionSql;
 const result=await freezeReviewBundle(tx,crypto.randomUUID(),crypto.randomUUID(),'verification',attestationId,{});
 expect(result.bundle.uploads).toEqual([{uploadId,contentHash:hash}]);
 expect(result.bundle.receipts).toEqual([{receiptId,rawHash:hash,documentUploadId:uploadId,documentHash:hash}]);
 uploadPresent=false;
 await expect(freezeReviewBundle(tx,crypto.randomUUID(),crypto.randomUUID(),'verification',attestationId,{})).rejects.toMatchObject({code:'REVIEW_DOCUMENT_MISSING'});
});
