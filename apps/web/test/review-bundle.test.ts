import { expect,it } from "vitest";
import { generatePrivateKey,privateKeyToAccount } from "viem/accounts";
import { hashProjection } from "@mpc/canonical";
import { ATTESTATION_EIP712_TYPES } from "@mpc/api-contract";
import { verifyReviewExport } from "../src/lib/review-bundle";

it("binds real reviewer signatures to publication, rejects tampering, and labels legacy context",async()=>{
 const account=privateKeyToAccount(generatePrivateKey());
 const id="11111111-1111-4111-8111-111111111111";
 const payload={findings:[],citations:[],limitations:"Synthetic review",claimScope:[id]};
 const snapshot={snapshotVersion:"3",claimIds:[id],artifactIds:[],receiptIds:[],claims:[]};
 const payloadHash=hashProjection(payload), evidenceSnapshotHash=hashProjection(snapshot);
 const typedData={domain:{name:"MPC Verification Attestation",version:"1",chainId:5611},types:ATTESTATION_EIP712_TYPES,primaryType:"Attestation" as const,message:{
  attestationId:`0x${id.replaceAll("-","").padEnd(64,"0")}` as `0x${string}`,
  schemaId:`0x${'1'.repeat(64)}` as `0x${string}`,schemaVersion:"1",evidenceSnapshotHash,
  assignmentId:`0x${'2'.repeat(64)}` as `0x${string}`,credentialId:`0x${'3'.repeat(64)}` as `0x${string}`,
  payloadHash,issuedAt:"1000",expiresAt:"2000",nonce:`0x${'4'.repeat(64)}` as `0x${string}`,
 }};
 const signature=await account.signTypedData(typedData as never);
 const review={attestationId:id,...payload,payloadHash,evidenceSnapshotHash,evidenceSnapshot:snapshot,signer:account.address,signature,signingEnvelope:{typedData:{...typedData,domain:{...typedData.domain,chainId:"5611"}}}};
 const bundle={bundleVersion:"1",documents:[],reviews:[review]};
 const bundleHash=hashProjection(bundle);
 const projection={reviewCommitment:{bundleHash,version:"1",reviewCount:"1",independentlyVerifiableCount:"1"}};
 const leaf={registryType:"project",entryVersionId:id,subjectId:id,version:"1",status:"published",serializationVersion:"2",policyVersion:"1",schemaVersion:"1",contentHash:hashProjection(projection)};
 const exported={bundle,bundleHash,projection,leaf};
 expect((await verifyReviewExport(exported)).verified).toBe(1);
 const legacyBundle={...bundle,reviews:[{...review,signingEnvelope:null}]};
 const legacyHash=hashProjection(legacyBundle);
 const legacyProjection={reviewCommitment:{...projection.reviewCommitment,bundleHash:legacyHash,independentlyVerifiableCount:"0"}};
 const legacy=await verifyReviewExport({bundle:legacyBundle,bundleHash:legacyHash,projection:legacyProjection,leaf:{...leaf,contentHash:hashProjection(legacyProjection)}});
 expect(legacy.verified).toBe(0);expect(legacy.unavailable).toBe(1);
 await expect(verifyReviewExport({...exported,bundle:{...bundle,reviews:[{...review,limitations:"tampered"}]}})).rejects.toThrow();
 const forgedBundle={...bundle,reviews:[{...review,limitations:"tampered"}]};
 const forgedHash=hashProjection(forgedBundle), forgedProjection={reviewCommitment:{...projection.reviewCommitment,bundleHash:forgedHash}};
 await expect(verifyReviewExport({bundle:forgedBundle,bundleHash:forgedHash,projection:forgedProjection,leaf:{...leaf,contentHash:hashProjection(forgedProjection)}})).rejects.toThrow("Signed review content");
});
