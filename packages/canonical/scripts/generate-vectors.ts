/**
 * 골든 벡터 생성기.
 *
 * `test/vectors.json`은 canonical serialization·leaf·Merkle 규격의 정본 대조표다.
 * 다른 언어로 구현이 나오거나 이 구현을 리팩터링할 때 이 파일이 회귀를 잡는다.
 *
 * 실행: node scripts/generate-vectors.ts
 * 값을 바꾸려면 규격이 바뀐 것이므로 serializationVersion을 올려야 한다.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { canonicalize } from "../src/jcs.js";
import { keccak256, type Hex } from "../src/hash.js";
import { hashLeaf, hashProjection, type RegistryLeaf } from "../src/leaf.js";
import { buildMerkleTree, getMerkleProof } from "../src/merkle.js";
import type { CanonicalValue } from "../src/jcs.js";

const encoder = new TextEncoder();

const CANONICAL_CASES: { name: string; input: CanonicalValue }[] = [
  { name: "empty-object", input: {} },
  { name: "empty-array", input: [] },
  { name: "key-ordering", input: { b: "1", a: "2", C: "3", "": "4" } },
  { name: "nested", input: { z: { y: ["1", "2"], x: null }, a: true } },
  { name: "escapes", input: { s: 'line\nbreak\ttab"quote\\slash' } },
  { name: "non-ascii", input: { mn: "Монгол", ko: "몽골", emoji: "\u{1F600}" } },
  { name: "decimal-strings", input: { amount: "10000000000", unit: "MPC", asOf: "2026-08-01" } },
];

const LEAVES: RegistryLeaf[] = [
  {
    registryType: "project",
    entryVersionId: "01JZPROJECT0000000000000AA",
    subjectId: "01JZSUBJECT0000000000000AA",
    version: "1",
    status: "published",
    serializationVersion: "1",
    policyVersion: "mn-core-1.0.0",
    schemaVersion: "project-registry-1",
    contentHash: hashProjection({
      projectKey: "SYNTH-PROJECT-001",
      hostCountry: "MNG",
      lifecycleStage: "registered",
      asOf: "2026-08-01",
    }),
  },
  {
    registryType: "verification",
    entryVersionId: "01JZVERIFY00000000000000AA",
    subjectId: "01JZSUBJECT0000000000000AA",
    version: "2",
    status: "published",
    serializationVersion: "1",
    policyVersion: "mn-core-1.0.0",
    schemaVersion: "verification-registry-1",
    contentHash: hashProjection({
      attestationType: "professional_signoff",
      grade: "partially_verified",
      limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
      asOf: "2026-08-02",
    }),
  },
  {
    registryType: "verification",
    entryVersionId: "01JZVERIFY00000000000000BB",
    subjectId: "01JZSUBJECT0000000000000BB",
    version: "1",
    status: "superseded",
    serializationVersion: "1",
    policyVersion: "mn-core-1.0.0",
    schemaVersion: "verification-registry-1",
    contentHash: hashProjection({
      attestationType: "laboratory_accreditation",
      grade: "self_reported",
      limitations: ["시료 대표성은 확인하지 않았다"],
      asOf: "2026-07-20",
    }),
  },
];

const leafHashes = LEAVES.map(hashLeaf);
const tree = buildMerkleTree(leafHashes);

const vectors = {
  serializationVersion: "1",
  note:
    "MPC canonical serialization 골든 벡터. 값이 바뀌면 규격이 바뀐 것이며 " +
    "serializationVersion을 올려야 한다.",
  keccak256: {
    empty: keccak256(new Uint8Array(0)),
    abc: keccak256(encoder.encode("abc")),
  },
  canonicalize: CANONICAL_CASES.map(({ name, input }) => ({
    name,
    input,
    canonical: canonicalize(input),
    keccak256: keccak256(encoder.encode(canonicalize(input))),
  })),
  leaves: LEAVES.map((leaf, index) => ({
    leaf,
    leafHash: leafHashes[index]!,
  })),
  merkle: {
    root: tree.root,
    leafCount: tree.leafCount,
    sortedLeaves: tree.layers[0]!,
    proofs: leafHashes.map((leafHash) => ({
      leafHash,
      proof: getMerkleProof(tree, leafHash) as Hex[],
    })),
  },
};

const outPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "vectors.json",
);

writeFileSync(outPath, `${JSON.stringify(vectors, null, 2)}\n`, "utf8");
process.stdout.write(`벡터 ${outPath}에 기록\n`);
