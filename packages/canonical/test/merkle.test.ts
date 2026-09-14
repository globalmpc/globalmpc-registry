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

describe("keccak256 — 알려진 벡터", () => {
  it("빈 입력", () => {
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

describe("buildMerkleTree — 결정성", () => {
  it("입력 순서와 무관하게 같은 root를 만든다", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c"), leaf("d"), leaf("e")];
    const forward = buildMerkleTree(leaves).root;
    const reversed = buildMerkleTree([...leaves].reverse()).root;
    const shuffled = buildMerkleTree([leaves[2]!, leaves[0]!, leaves[4]!, leaves[1]!, leaves[3]!]).root;

    expect(reversed).toBe(forward);
    expect(shuffled).toBe(forward);
  });

  it("leaf 하나면 root가 그 leaf다", () => {
    const single = leaf("only");
    expect(buildMerkleTree([single]).root).toBe(single);
  });

  it("leaf 둘이면 root가 정렬쌍 해시다", () => {
    const a = leaf("a");
    const b = leaf("b");
    expect(buildMerkleTree([a, b]).root).toBe(hashPair(a, b));
  });
});

describe("buildMerkleTree — 거절 조건", () => {
  it("빈 batch를 거절한다", () => {
    expect(() => buildMerkleTree([])).toThrowError(/빈 batch/);
  });

  it("중복 leaf를 거절한다", () => {
    const a = leaf("a");
    expect(() => buildMerkleTree([a, leaf("b"), a])).toThrowError(/중복 leaf/);
  });

  it("32바이트가 아닌 값을 거절한다", () => {
    expect(() => buildMerkleTree(["0xdeadbeef" as Hex])).toThrowError(/32바이트/);
  });

  it("대문자 hex를 거절한다 — 표현이 갈리면 정렬이 갈린다", () => {
    const upper = leaf("a").toUpperCase().replace("0X", "0x") as Hex;
    expect(() => buildMerkleTree([upper])).toThrowError(/소문자/);
  });
});

describe("hashPair — 정렬쌍", () => {
  it("인자 순서와 무관하다", () => {
    const a = leaf("a");
    const b = leaf("b");
    expect(hashPair(a, b)).toBe(hashPair(b, a));
  });
});

describe("proof — 생성과 검증", () => {
  for (const size of [1, 2, 3, 4, 5, 7, 8, 9, 16, 17, 33]) {
    it(`leaf ${size}개 전체에 대해 inclusion proof가 검증된다`, () => {
      const leaves = Array.from({ length: size }, (_, i) => leaf(`leaf-${i}`));
      const tree = buildMerkleTree(leaves);

      for (const leafHash of leaves) {
        const proof = getMerkleProof(tree, leafHash);
        expect(verifyMerkleProof(leafHash, proof, tree.root)).toBe(true);
      }
    });
  }

  it("batch에 없는 leaf는 proof를 만들 수 없다", () => {
    const tree = buildMerkleTree([leaf("a"), leaf("b")]);
    expect(() => getMerkleProof(tree, leaf("z"))).toThrowError(/batch에 없다/);
  });

  it("다른 batch의 root로는 검증되지 않는다", () => {
    const treeA = buildMerkleTree([leaf("a"), leaf("b"), leaf("c")]);
    const treeB = buildMerkleTree([leaf("x"), leaf("y"), leaf("z")]);
    const proof = getMerkleProof(treeA, leaf("a"));
    expect(verifyMerkleProof(leaf("a"), proof, treeB.root)).toBe(false);
  });

  it("proof 항목이 조작되면 검증에 실패한다", () => {
    const leaves = [leaf("a"), leaf("b"), leaf("c"), leaf("d")];
    const tree = buildMerkleTree(leaves);
    const proof = getMerkleProof(tree, leaf("a"));
    const tampered = [...proof];
    tampered[0] = leaf("tampered");
    expect(verifyMerkleProof(leaf("a"), tampered, tree.root)).toBe(false);
  });

  it("proof가 비면 leaf가 root인 경우에만 통과한다", () => {
    const single = leaf("only");
    expect(verifyMerkleProof(single, [], single)).toBe(true);

    const tree = buildMerkleTree([leaf("a"), leaf("b")]);
    expect(verifyMerkleProof(leaf("a"), [], tree.root)).toBe(false);
  });
});

describe("홀수 노드 — 복제가 아니라 승격", () => {
  it("leaf 3개 트리에서 마지막 노드는 승격된다", () => {
    const [a, b, c] = [leaf("a"), leaf("b"), leaf("c")];
    const tree = buildMerkleTree([a, b, c]);
    const sorted = tree.layers[0]!;

    // 레벨 1 = [hashPair(sorted0, sorted1), sorted2(승격)]
    expect(tree.layers[1]).toEqual([hashPair(sorted[0]!, sorted[1]!), sorted[2]!]);
    expect(tree.root).toBe(hashPair(hashPair(sorted[0]!, sorted[1]!), sorted[2]!));
  });

  it("마지막 leaf를 복제한 4-leaf 트리와 3-leaf 트리의 root가 다르다", () => {
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
