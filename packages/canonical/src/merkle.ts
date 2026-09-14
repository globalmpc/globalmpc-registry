import { CanonicalError } from "./errors.js";
import { assertBytes32, hexToBytes, keccak256, type Hex } from "./hash.js";

/**
 * Merkle spec (ADR-T08).
 *
 * - Internal node: keccak256(min(a,b) ++ max(a,b)) — compatible with OpenZeppelin MerkleProof.
 *   Sorted pairs mean proofs need no direction bits.
 * - The leaf array is sorted by ascending leafHash. The same root results regardless of input
 *   order — if batch creation were nondeterministic, AC-11 would not hold.
 * - Duplicate leafHashes are rejected. With the same leaf twice, which inclusion is meant
 *   cannot be told apart.
 * - Empty batches are rejected.
 * - Odd nodes are **promoted, not duplicated**. Duplicating the last node would allow a valid
 *   proof for a leaf that does not exist.
 */

export interface MerkleTree {
  readonly root: Hex;
  /** layers[0] is the sorted leaves; the last layer is [root]. */
  readonly layers: readonly (readonly Hex[])[];
  readonly leafCount: number;
}

export function hashPair(a: Hex, b: Hex): Hex {
  const [left, right] = a <= b ? [a, b] : [b, a];
  const bytes = new Uint8Array(64);
  bytes.set(hexToBytes(left), 0);
  bytes.set(hexToBytes(right), 32);
  return keccak256(bytes);
}

export function buildMerkleTree(leafHashes: readonly Hex[]): MerkleTree {
  if (leafHashes.length === 0) {
    throw new CanonicalError("E_MERKLE_EMPTY_BATCH", "An empty batch cannot be anchored");
  }

  for (const [index, leaf] of leafHashes.entries()) {
    assertBytes32(leaf, `leafHashes[${index}]`);
  }

  const sorted = [...leafHashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      throw new CanonicalError(
        "E_MERKLE_DUPLICATE_LEAF",
        `Duplicate leaf in batch: ${sorted[i]}`,
      );
    }
  }

  const layers: Hex[][] = [sorted];

  while (layers[layers.length - 1]!.length > 1) {
    const current = layers[layers.length - 1]!;
    const next: Hex[] = [];

    for (let i = 0; i < current.length; i += 2) {
      const left = current[i]!;
      const right = current[i + 1];
      // No sibling means promotion. Never duplicate.
      next.push(right === undefined ? left : hashPair(left, right));
    }

    layers.push(next);
  }

  return {
    root: layers[layers.length - 1]![0]!,
    layers,
    leafCount: sorted.length,
  };
}

export function getMerkleProof(tree: MerkleTree, leafHash: Hex): Hex[] {
  let index = tree.layers[0]!.indexOf(leafHash);
  if (index === -1) {
    throw new CanonicalError(
      "E_MERKLE_LEAF_NOT_FOUND",
      `Leaf is not in this batch: ${leafHash}`,
    );
  }

  const proof: Hex[] = [];

  for (let level = 0; level < tree.layers.length - 1; level += 1) {
    const layer = tree.layers[level]!;
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = layer[siblingIndex];
    // No sibling means this node was promoted. Nothing to add to the proof.
    if (sibling !== undefined) {
      proof.push(sibling);
    }
    index = Math.floor(index / 2);
  }

  return proof;
}

/**
 * Inclusion verification.
 *
 * A true from this function means only "this leaf is included in this root's batch".
 * spec 08 §8.11 / AC-23: it does not mean factual accuracy of the source, authority
 * eligibility, legal effect, or investment suitability.
 */
export function verifyMerkleProof(leafHash: Hex, proof: readonly Hex[], root: Hex): boolean {
  let computed = leafHash;
  for (const node of proof) {
    computed = hashPair(computed, node);
  }
  return computed === root;
}
