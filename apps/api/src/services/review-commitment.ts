import { unavailable,unprocessable } from "../errors.js";
import type postgres from "postgres";
import { canonicalBytes, keccak256, type CanonicalValue } from "@mpc/canonical";

/** Publication-time selection only. Never rebuild a historical bundle from live rows. */
export async function freezeReviewBundle(
  tx: postgres.TransactionSql, projectId: string,
  registryType: string, subjectId: string, projection: Record<string, unknown>,
) {
 try {
  const ledger = projection["evidenceLedger"] as {items?: {claimType:string;status?:string}[]} | undefined;
  const types = ledger?.items?.filter(item=>item.status!=="not_applicable").map(item => item.claimType) ?? [];
  const rows = await tx<{id:string;signature:string;signer_wallet_address:string;payload_hash:string;
    evidence_snapshot_hash:string;claim_scope:string[];findings:unknown;citations:unknown;limitations:string;
    credential_status_snapshot:unknown;signing_envelope:unknown;evidence_snapshot:unknown}[]>`
    SELECT a.id,a.signature,a.signer_wallet_address,a.payload_hash,a.evidence_snapshot_hash,a.claim_scope,
      a.findings,a.citations,a.limitations,a.credential_status_snapshot,a.signing_envelope,c.evidence_snapshot
    FROM core.verification_attestations a
    JOIN core.verification_cases c ON c.id=a.case_id
    WHERE c.project_id=${projectId}
      AND a.state IN ('signed','active') AND a.signature IS NOT NULL
      AND (${registryType}='verification' AND a.id=${subjectId}::uuid OR
        ${registryType}='project' AND EXISTS (
          SELECT 1 FROM core.claims cl WHERE cl.project_id=${projectId}
            AND cl.id=ANY(a.claim_scope) AND cl.claim_type=ANY(${types}::text[])))
    ORDER BY a.id
    FOR SHARE OF a,c NOWAIT`;
  if(registryType === "verification" && (rows.length !== 1 || rows[0]!.id !== subjectId))
    throw unprocessable("REVIEW_SUBJECT_NOT_SIGNED","Verification publication requires its signed subject review");
  const documents = await tx<{id:string;content_hash:string}[]>`
    SELECT id,content_hash FROM core.artifacts
    WHERE project_id=${projectId}
      AND id::text IN (SELECT jsonb_array_elements_text(c.evidence_snapshot->'artifactIds')
        FROM core.verification_cases c WHERE c.project_id=${projectId}
          AND c.id IN (SELECT case_id FROM core.verification_attestations WHERE id=ANY(${rows.map(row=>row.id)}::uuid[])))
    ORDER BY id FOR SHARE NOWAIT`;
  const receiptIds=[...new Set(rows.flatMap(row=>(row.evidence_snapshot as {receiptIds?:string[]}|null)?.receiptIds ?? []))].sort();
  const receipts=receiptIds.length ? await tx<{id:string;raw_hash:string|null;channel_evidence:{documentUploadId?:string;documentHash?:string}}[]>`
    SELECT id,raw_hash,channel_evidence FROM core.source_receipts WHERE (project_id=${projectId} OR project_id IS NULL)
      AND id=ANY(${receiptIds}::uuid[]) ORDER BY id FOR SHARE NOWAIT` : [];
  if(receipts.length!==receiptIds.length)throw unprocessable("REVIEW_RECEIPT_MISSING","Frozen review receipt references are incomplete");
  const uploadIds=[...new Set(rows.flatMap(row=>{
    const snapshot=row.evidence_snapshot as {claims?:{structured?:{documentUploadIds?:string[]}}[]}|null;
    return snapshot?.claims?.flatMap(claim=>claim.structured?.documentUploadIds ?? []) ?? [];
  }).concat(receipts.flatMap(receipt=>receipt.channel_evidence.documentUploadId ? [receipt.channel_evidence.documentUploadId] : [])))].sort();
  const uploads=uploadIds.length ? await tx<{id:string;content_hash:string}[]>`
    SELECT id,content_hash FROM core.object_uploads WHERE project_id=${projectId}
      AND id=ANY(${uploadIds}::uuid[]) ORDER BY id FOR SHARE NOWAIT` : [];
  if(uploads.length!==uploadIds.length)throw unprocessable("REVIEW_DOCUMENT_MISSING","Frozen review document references are incomplete");
  const rawBundle = {receipts:receipts.map(receipt=>({receiptId:receipt.id,rawHash:receipt.raw_hash,documentUploadId:receipt.channel_evidence.documentUploadId ?? null,documentHash:receipt.channel_evidence.documentHash ?? null})),uploads:uploads.map(row=>({uploadId:row.id,contentHash:row.content_hash})),documents:documents.map(row=>({artifactId:row.id,contentHash:row.content_hash})),bundleVersion:"1", reviews:rows.map(row => ({
    attestationId:row.id,signature:row.signature,signer:row.signer_wallet_address,
    payloadHash:row.payload_hash,evidenceSnapshotHash:row.evidence_snapshot_hash,
    claimScope:[...row.claim_scope].sort(),findings:row.findings,citations:row.citations,
    limitations:row.limitations,credentialAtSigning:row.credential_status_snapshot,
    signingEnvelope:row.signing_envelope ?? null,evidenceSnapshot:row.evidence_snapshot,
  }))};
  const bundle=JSON.parse(JSON.stringify(rawBundle,(_key,value)=>typeof value === "number" ? String(value) : value)) as typeof rawBundle;
  const bundleHash=keccak256(canonicalBytes(bundle as unknown as CanonicalValue));
  return {bundle,bundleHash,commitment:{version:"1" as const,bundleHash,reviewCount:String(rows.length),
    independentlyVerifiableCount:String(rows.filter(row=>row.signing_envelope !== null).length)}};
 } catch(error) {
   if((error as {code?:string}).code === "55P03")throw unavailable("PUBLICATION_REVIEW_BUSY","Review evidence is changing; retry publication");
   throw error;
 }
}
