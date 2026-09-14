import { describe, expect, it } from "vitest";
import { canonicalize, type CanonicalValue } from "../src/jcs.js";
import { keccak256, type Hex } from "../src/hash.js";
import { hashLeaf, type RegistryLeaf } from "../src/leaf.js";
import { buildMerkleTree, getMerkleProof, verifyMerkleProof } from "../src/merkle.js";
import vectors from "./vectors.json" with { type: "json" };

/**
 * 골든 벡터 회귀 테스트.
 *
 * `scripts/generate-vectors.ts`가 만든 값과 현재 구현이 일치하는지 확인한다.
 * 여기가 깨지면 canonical 규격이 바뀐 것이고, 그러면 이미 anchor된 root를
 * 재현할 수 없다. 값을 갱신하기 전에 serializationVersion을 올려야 한다.
 */

const encoder = new TextEncoder();

describe("골든 벡터 — keccak256", () => {
  it("알려진 값과 일치한다", () => {
    expect(keccak256(new Uint8Array(0))).toBe(vectors.keccak256.empty);
    expect(keccak256(encoder.encode("abc"))).toBe(vectors.keccak256.abc);
  });
});

describe("골든 벡터 — canonicalize", () => {
  for (const testCase of vectors.canonicalize) {
    it(`${testCase.name}`, () => {
      const canonical = canonicalize(testCase.input as CanonicalValue);
      expect(canonical).toBe(testCase.canonical);
      expect(keccak256(encoder.encode(canonical))).toBe(testCase.keccak256);
    });
  }
});

describe("골든 벡터 — leaf", () => {
  for (const [index, entry] of vectors.leaves.entries()) {
    it(`leaf[${index}] ${entry.leaf.registryType}/${entry.leaf.status}`, () => {
      expect(hashLeaf(entry.leaf as RegistryLeaf)).toBe(entry.leafHash);
    });
  }
});

describe("골든 벡터 — Merkle", () => {
  const leafHashes = vectors.leaves.map((entry) => entry.leafHash as Hex);

  it("root가 일치한다", () => {
    expect(buildMerkleTree(leafHashes).root).toBe(vectors.merkle.root);
  });

  it("정렬된 leaf 배열이 일치한다", () => {
    expect(buildMerkleTree(leafHashes).layers[0]).toEqual(vectors.merkle.sortedLeaves);
  });

  it("각 leaf의 proof가 일치하고 검증된다", () => {
    const tree = buildMerkleTree(leafHashes);
    for (const entry of vectors.merkle.proofs) {
      const proof = getMerkleProof(tree, entry.leafHash as Hex);
      expect(proof).toEqual(entry.proof);
      expect(verifyMerkleProof(entry.leafHash as Hex, proof, vectors.merkle.root as Hex)).toBe(
        true,
      );
    }
  });

  it("serializationVersion이 1이다", () => {
    expect(vectors.serializationVersion).toBe("1");
    for (const entry of vectors.leaves) {
      expect(entry.leaf.serializationVersion).toBe("1");
    }
  });
});
