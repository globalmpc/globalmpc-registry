import { hashLeaf, hashProjection, canonicalBytes, keccak256, type RegistryLeaf, type CanonicalValue } from "@mpc/canonical";
import { recoverTypedDataAddress } from "viem";
import { ATTESTATION_EIP712_TYPES } from "@mpc/api-contract";

/** Offline verification; chain inclusion is checked separately against the returned leaf hash. */
export async function verifyReviewExport(input: unknown) {
  const data=input as {bundle: {reviews: {signature:`0x${string}`;signer:string;attestationId:string;payloadHash:string;evidenceSnapshotHash:string;evidenceSnapshot:unknown;findings:unknown;citations:unknown;limitations:string;claimScope:string[];signingEnvelope:{typedData:{domain:Record<string,unknown>;message:Record<string,unknown>}}|null}[]}; bundleHash:string;projection:{reviewCommitment?:{bundleHash:string}};leaf:RegistryLeaf};
  if(!data?.bundle || !Array.isArray(data.bundle.reviews)) throw new Error("Invalid review export");
  const bundleHash=keccak256(canonicalBytes(data.bundle as unknown as CanonicalValue));
  if(bundleHash!==data.bundleHash || bundleHash!==data.projection.reviewCommitment?.bundleHash || hashProjection(data.projection as unknown as CanonicalValue)!==data.leaf.contentHash)
    throw new Error("Review bundle does not match the published commitment");
  let verified=0, unavailable=0;
  for(const review of data.bundle.reviews){
    if(!review.signingEnvelope){unavailable++;continue;}
    const typed=review.signingEnvelope.typedData;
    const payloadHash=hashProjection({findings:review.findings,citations:review.citations,limitations:review.limitations,claimScope:[...review.claimScope].sort()} as CanonicalValue);
    if(payloadHash!==review.payloadHash || typed.message["payloadHash"]!==payloadHash || typed.message["evidenceSnapshotHash"]!==review.evidenceSnapshotHash ||
      typed.message["attestationId"]!==`0x${review.attestationId.replaceAll("-", "").padEnd(64,"0")}` ||
      (review.evidenceSnapshot!==null && hashProjection(review.evidenceSnapshot as CanonicalValue)!==review.evidenceSnapshotHash))
      throw new Error("Signed review content does not match its envelope");
    const chainId=typed.domain["chainId"];
    if(typeof chainId!=="string" || !/^[1-9][0-9]*$/.test(chainId))throw new Error("Invalid signing chain ID");
    const signer=await recoverTypedDataAddress({domain:{...typed.domain,chainId:BigInt(chainId)},types:ATTESTATION_EIP712_TYPES,primaryType:"Attestation",message:typed.message as never,signature:review.signature});
    if(signer.toLowerCase()!==review.signer.toLowerCase())throw new Error("Review signature is invalid");
    verified++;
  }
  return {entryVersionId:data.leaf.entryVersionId,bundleHash,leafHash:hashLeaf(data.leaf),verified,unavailable};
}
