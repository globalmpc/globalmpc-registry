import { CanonicalError } from "./errors.js";
import { assertBytes32, hexToBytes, keccak256, type Hex } from "./hash.js";

/**
 * Merkle 규격 (ADR-T08).
 *
 * - 내부 노드: keccak256(min(a,b) ++ max(a,b)) — OpenZeppelin MerkleProof 호환.
 *   정렬쌍이므로 proof에 방향 비트가 필요 없다.
 * - leaf 배열은 leafHash 오름차순으로 정렬한다. 입력 순서와 무관하게 같은 root가
 *   나온다 — batch 생성이 비결정적이면 AC-11이 성립하지 않는다.
 * - 중복 leafHash는 거절한다. 같은 leaf가 두 번 들어가면 어느 쪽 inclusion인지
 *   구분할 수 없다.
 * - 빈 batch는 거절한다.
 * - 홀수 노드는 **복제하지 않고 승격**한다. 마지막 노드를 복제하면 존재하지 않는
 *   leaf에 대한 유효 proof를 만들 수 있다.
 */

export interface MerkleTree {
  readonly root: Hex;
  /** layers[0]이 정렬된 leaf, 마지막 layer가 [root]다. */
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
    throw new CanonicalError("E_MERKLE_EMPTY_BATCH", "빈 batch는 anchor할 수 없다");
  }

  for (const [index, leaf] of leafHashes.entries()) {
    assertBytes32(leaf, `leafHashes[${index}]`);
  }

  const sorted = [...leafHashes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i] === sorted[i - 1]) {
      throw new CanonicalError(
        "E_MERKLE_DUPLICATE_LEAF",
        `batch에 중복 leaf가 있다: ${sorted[i]}`,
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
      // 형제가 없으면 승격한다. 복제하지 않는다.
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
      `leaf가 이 batch에 없다: ${leafHash}`,
    );
  }

  const proof: Hex[] = [];

  for (let level = 0; level < tree.layers.length - 1; level += 1) {
    const layer = tree.layers[level]!;
    const siblingIndex = index % 2 === 0 ? index + 1 : index - 1;
    const sibling = layer[siblingIndex];
    // sibling이 없으면 이 노드는 승격됐다. proof에 추가할 것이 없다.
    if (sibling !== undefined) {
      proof.push(sibling);
    }
    index = Math.floor(index / 2);
  }

  return proof;
}

/**
 * inclusion 검증.
 *
 * 이 함수의 true는 "이 leaf가 이 root의 batch에 포함됐다"만 뜻한다.
 * spec 08 §8.11 / AC-23: 원문의 사실성·authority 적격성·법률 효력·투자
 * 적합성을 뜻하지 않는다.
 */
export function verifyMerkleProof(leafHash: Hex, proof: readonly Hex[], root: Hex): boolean {
  let computed = leafHash;
  for (const node of proof) {
    computed = hashPair(computed, node);
  }
  return computed === root;
}
