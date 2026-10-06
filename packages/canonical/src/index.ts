export { CanonicalError, type CanonicalErrorCode } from "./errors.js";
export { canonicalize, canonicalBytes, type CanonicalValue } from "./jcs.js";
export {
  keccak256,
  bytesToHex,
  hexToBytes,
  isBytes32,
  assertBytes32,
  type Hex,
} from "./hash.js";
export { hashLeaf, hashProjection, assertValidLeaf, type RegistryLeaf } from "./leaf.js";
export {
  buildMerkleTree,
  getMerkleProof,
  verifyMerkleProof,
  hashPair,
  type MerkleTree,
} from "./merkle.js";
