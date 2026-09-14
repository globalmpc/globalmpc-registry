import { describe, expect, it } from "vitest";
import { keccak256, type Hex } from "../src/hash.js";
import {
  buildMerkleTree,
  getMerkleProof,
  hashPair,
  verifyMerkleProof,
} from "../src/merkle.js";

function leaf(label: string): Hex {
  return keccak256(new TextEncoder().encode(label));
}

describe("keccak256 — known vectors", () => {
  it("empty input", () => {
    expect(keccak256(new Uint8Array(0))).toBe(
      "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it('"abc"', () => {
    expect(keccak256(new TextEncoder().encode("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });
});

describe("buildMerkleTree — determinism", () => {
  it("produces the same root regardless of input order", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c"), leaf("d"), leaf("e")];
    const forward = buildMerkleTree(leaves).root;
    const reversed = buildMerkleTree([...leaves].reverse()).root;
    const shuffled = buildMerkleTree([leaves[2]!, leaves[0]!, leaves[4]!, leaves[1]!, leaves[3]!]).root;

    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("with one leaf the root is that leaf", () => {
    const single = leaf("only");
    expect(buildMerkleTree([single]).root).toBe(single);
  });

  it("with two leaves the root is the sorted-pair hash", () => {
    const a = leaf("a");
    const b = leaf("b");
    expect(buildMerkleTree([a, b]).root).toBe(hashPair(a, b));
  });
});

describe("buildMerkleTree — rejection conditions", () => {
  it("rejects an empty batch", () => {
    expect(() => buildMerkleTree([])).toThrowError(/empty batch/);
  });

  it("rejects duplicate leaves", () => {
    const a = leaf("a");
    expect(() => buildMerkleTree([a, leaf("b"), a])).toThrowError(/Duplicate leaf/);
  });

  it("rejects values that are not 32 bytes", () => {
    expect(() => buildMerkleTree(["0xdeadbeef" as Hex])).toThrowError(/32-byte/);
  });

  it("rejects uppercase hex — a different representation means a different sort", () => {
    const upper = leaf("a").toUpperCase().replace("0X", "0x") as Hex;
    expect(() => buildMerkleTree([upper])).toThrowError(/lowercase/);
  });
});

describe("hashPair — sorted pair", () => {
  it("is independent of argument order", () => {
    const a = leaf("a");
    const b = leaf("b");
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });
});

describe("proof — generation and verification", () => {
  for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33]) {
    it(`inclusion proofs verify for all ${size} leaves`, () => {
      const leaves = Array.from({ length: size }, (_, i) => leaf(`leaf-${i}`));
      const tree = buildMerkleTree(leaves);

      for (const leafHash of leaves) {
        const proof = getMerkleProof(tree, leafHash);
        expect(verifyMerkleProof(leafHash, proof, tree.root)).toBe(true);
      }
    });
  }

  it("cannot build a proof for a leaf not in the batch", () => {
    const tree = buildMerkleTree([leaf("a"), leaf("b")]);
    expect(() => getMerkleProof(tree, leaf("z"))).toThrowError(/not in this batch/);
  });

  it("does not verify against another batch's root", () => {
    const treeA = buildMerkleTree([leaf("a"), leaf("b"), leaf("c")]);
    const treeB = buildMerkleTree([leaf("x"), leaf("y"), leaf("z")]);
    const proof = getMerkleProof(treeA, leaf("a"));
    expect(verifyMerkleProof(leaf("a"), proof, treeB.root)).toBe(false);
  });

  it("fails verification when a proof entry is tampered with", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
    const tree = buildMerkleTree(leaves);
    const proof = getMerkleProof(tree, leaf("a"));
    const tampered = [...proof];
    tampered[0] = leaf("tampered");
    expect(verifyMerkleProof(leaf("a"), tampered, tree.root)).toBe(false);
  });

  it("an empty proof passes only when the leaf is the root", () => {
    const single = leaf("only");
    expect(verifyMerkleProof(single, [], single)).toBe(true);

    const tree = buildMerkleTree([leaf("a"), leaf("b")]);
    expect(verifyMerkleProof(leaf("a"), [], tree.root)).toBe(false);
  });
});

describe("odd nodes — promoted, not duplicated", () => {
  it("in a 3-leaf tree the last node is promoted", () => {
    const [a, b, c] = [leaf("a"), leaf("b"), leaf("c")];
    const tree = buildMerkleTree([a, b, c]);
    const sorted = tree.layers[0]!;

    // level 1 = [hashPair(sorted0, sorted1), sorted2 (promoted)]
    expect(tree.layers[1]).toEqual([hashPair(sorted[0]!, sorted[1]!), sorted[2]!]);
    expect(tree.root).toBe(hashPair(hashPair(sorted[0]!, sorted[1]!), sorted[2]!));
  });

  it("a 4-leaf tree duplicating the last leaf has a different root from the 3-leaf tree", () => {
    const [a, b, c] = [leaf("a"), leaf("b"), leaf("c")];
    const three = buildMerkleTree([a, b, c]);
    const sorted = three.layers[0]!;
    const duplicatedRoot = hashPair(
      hashPair(sorted[0]!, sorted[1]!),
      hashPair(sorted[2]!, sorted[2]!),
    );
    expect(three.root).not.toBe(duplicatedRoot);
  });
});
