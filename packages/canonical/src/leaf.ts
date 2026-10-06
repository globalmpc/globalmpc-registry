import { CanonicalError } from "./errors.js";
import { assertBytes32, hexToBytes, keccak256, type Hex } from "./hash.js";
import { canonicalBytes, type CanonicalValue } from "./jcs.js";

/**
 * A leaf of an anchor batch.
 *
 * spec 08 §8.11: a leaf combines only the identifier of a publicly approved registry version and
 * a content commitment. Authority records, Source Receipts, credentials, raw attestations, PII,
 * contracts, coordinates, and API responses go neither into chain storage nor into events
 * (OD-41, AC-22).
 *
 * `contentHash` is keccak256(canonicalBytes(projection)) of the public projection that passed
 * the disclosure allowlist — a commitment, not the raw content.
 */
export interface RegistryLeaf {
  readonly registryType: "project" | "verification" | "asset";
  readonly entryVersionId: string;
  readonly subjectId: string;
  /** Decimal string of an integer version. Never a number. */
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
      `leaf.${field} must not be empty`,
      `/${field}`,
    );
  }
}

export function assertValidLeaf(leaf: RegistryLeaf): void {
  if (!REGISTRY_TYPES.has(leaf.registryType)) {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `Unknown registryType: ${leaf.registryType}`,
      "/registryType",
    );
  }
  if (!LEAF_STATUSES.has(leaf.status)) {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `Unknown status: ${leaf.status}`,
      "/status",
    );
  }
  if (leaf.serializationVersion !== "1") {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `Unsupported serializationVersion: ${leaf.serializationVersion}`,
      "/serializationVersion",
    );
  }
  if (!/^(0|[1-9][0-9]*)$/.test(leaf.version)) {
    throw new CanonicalError(
      "E_LEAF_INVALID_FIELD",
      `leaf.version must be a decimal string without leading zeros: ${leaf.version}`,
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
 * Leaf hash — **double keccak256**.
 *
 * Internal nodes are single keccak256, so double-hashing leaves closes the second-preimage path
 * where a leaf masquerades as an internal node (OpenZeppelin MerkleProof recommended pattern).
 */
export function hashLeaf(leaf: RegistryLeaf): Hex {
  assertValidLeaf(leaf);
  const inner = keccak256(canonicalBytes(leaf as unknown as CanonicalValue));
  return keccak256(hexToBytes(inner));
}

/** Content commitment of a public projection. The value placed in leaf.contentHash. */
export function hashProjection(projection: CanonicalValue): Hex {
  return keccak256(canonicalBytes(projection));
}
