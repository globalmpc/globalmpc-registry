import { CanonicalError } from "./errors.js";
import { assertBytes32, hexToBytes, keccak256, type Hex } from "./hash.js";
import { canonicalBytes, type CanonicalValue } from "./jcs.js";

/**
 * anchor batch의 leaf.
 *
 * spec 08 §8.11: leaf는 공개 승인된 registry version의 식별자와 content
 * commitment만 결합한다. Authority record, Source Receipt, credential,
 * attestation 원문, PII·계약·좌표·API response는 chain storage에도 event에도
 * 넣지 않는다(OD-41, AC-22).
 *
 * `contentHash`는 disclosure allowlist를 통과한 public projection의
 * keccak256(canonicalBytes(projection))이다. 즉 원문이 아니라 커밋먼트다.
 */
export interface RegistryLeaf {
  readonly registryType: "project" | "verification" | "asset";
  readonly entryVersionId: string;
  readonly subjectId: string;
  /** 정수 version의 decimal string. number를 쓰지 않는다. */
  readonly version: string;
  readonly status: "published" | "revoked" | "superseded";
  readonly serializationVersion: "1";
  readonly policyVersion: string;
  readonly schemaVersion: string;
  readonly contentHash: string;
}

const REGISTRY_TYPES = new Set(["project", "verification", "asset"]);
const LEAF_STATUSES = new Set(["published", "revoked", "superseded"]);

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `leaf.${field}는 비어 있을 수 없다`,
      `/${field}`,
    );
  }
}

export function assertValidLeaf(leaf: RegistryLeaf): void {
  if (!REGISTRY_TYPES.has(leaf.registryType)) {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `알 수 없는 registryType: ${leaf.registryType}`,
      "/registryType",
    );
  }
  if (!LEAF_STATUSES.has(leaf.status)) {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `알 수 없는 status: ${leaf.status}`,
      "/status",
    );
  }
  if (leaf.serializationVersion !== "1") {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `지원하지 않는 serializationVersion: ${leaf.serializationVersion}`,
      "/serializationVersion",
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(leaf.version)) {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `leaf.version은 선행 0이 없는 decimal string이어야 한다: ${leaf.version}`,
      "/version",
    );
  }
  requireNonEmpty(leaf.entryVersionId, "entryVersionId");
  requireNonEmpty(leaf.subjectId, "subjectId");
  requireNonEmpty(leaf.policyVersion, "policyVersion");
  requireNonEmpty(leaf.schemaVersion, "schemaVersion");
  assertBytes32(leaf.contentHash, "leaf.contentHash");
}

/**
 * leaf 해시 — **이중 keccak256**.
 *
 * 내부 노드는 단일 keccak256이므로, leaf를 이중 해시하면 leaf 하나가 내부 노드로
 * 위장하는 second-preimage 경로가 닫힌다(OpenZeppelin MerkleProof 권장 패턴).
 */
export function hashLeaf(leaf: RegistryLeaf): Hex {
  assertValidLeaf(leaf);
  const inner = keccak256(canonicalBytes(leaf as unknown as CanonicalValue));
  return keccak256(hexToBytes(inner));
}

/** public projection의 content commitment. leaf.contentHash에 넣는 값이다. */
export function hashProjection(projection: CanonicalValue): Hex {
  return keccak256(canonicalBytes(projection));
}
