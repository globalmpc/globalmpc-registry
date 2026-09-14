import { describe, expect, it } from "vitest";
import { canonicalize, type CanonicalValue } from "../src/jcs.js";
import { keccak256, type Hex } from "../src/hash.js";
import { hashLeaf, type RegistryLeaf } from "../src/leaf.js";
import { buildMerkleTree, getMerkleProof, verifyMerkleProof } from "../src/merkle.js";
import vectors from "./vectors.json" with { type: "json" };

/**
 * Golden vector regression test.
 *
 * Checks that the current implementation matches the values produced by `scripts/generate-vectors.ts`.
 * If this breaks, the canonical spec changed, and already-anchored roots can no longer be
 * reproduced. Bump serializationVersion before updating the values.
 */

const encoder = new TextEncoder();

describe("golden vectors — keccak256", () => {
  it("matches known values", () => {
    expect(keccak256(new Uint8Array(0))).toBe(vectors.keccak256.empty);
    expect(keccak256(encoder.encode("abc"))).toBe(vectors.keccak256.abc);
  });
});

describe("golden vectors — canonicalize", () => {
  for (const testCase of vectors.canonicalize) {
    it(`${testCase.name}`, () => {
      const canonical = canonicalize(testCase.input as CanonicalValue);
      expect(canonical).toBe(testCase.canonical);
      expect(keccak256(encoder.encode(canonical))).toBe(testCase.keccak256);
    });
  }
});

describe("golden vectors — leaf", () => {
  for (const [index, entry] of vectors.leaves.entries()) {
    it(`leaf[${index}] ${entry.leaf.registryType}/${entry.leaf.status}`, () => {
      expect(hashLeaf(entry.leaf as RegistryLeaf)).toBe(entry.leafHash);
    });
  }
});

describe("golden vectors — Merkle", () => {
  const leafHashes = vectors.leaves.map((entry) => entry.leafHash as Hex);

  it("root matches", () => {
    expect(buildMerkleTree(leafHashes).root).toBe(vectors.merkle.root);
  });

  it("sorted leaf array matches", () => {
    expect(buildMerkleTree(leafHashes).layers[0]).toEqual(vectors.merkle.sortedLeaves);
  });

  it("each leaf's proof matches and verifies", () => {
    const tree = buildMerkleTree(leafHashes);
    for (const entry of vectors.merkle.proofs) {
      const proof = getMerkleProof(tree, entry.leafHash as Hex);
      expect(proof).toEqual(entry.proof);
      expect(verifyMerkleProof(entry.leafHash as Hex, proof, vectors.merkle.root as Hex)).toBe(
        true,
      );
    }
  });

  it("serializationVersion is 1", () => {
    expect(vectors.serializationVersion).toBe("1");
    for (const entry of vectors.leaves) {
      expect(entry.leaf.serializationVersion).toBe("1");
    }
  });
});
