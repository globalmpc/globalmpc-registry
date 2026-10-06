/**
 * Golden vector generator.
 *
 * `test/vectors.json` is the authoritative reference table for the canonical serialization,
 * leaf, and Merkle specs. It catches regressions when another-language implementation appears or this one is refactored.
 *
 * Run: node scripts/generate-vectors.ts
 * Changing the values means the spec changed, so serializationVersion must be bumped.
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
  { name: "non-ascii", input: { mn: "Монгол", ja: "モンゴル", emoji: "\u{1F600}" } },
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
      limitations: ["Legal title verification is outside the scope of this review"],
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
      limitations: ["Sample representativeness was not verified"],
      asOf: "2026-07-20",
    }),
  },
];

const leafHashes = LEAVES.map(hashLeaf);
const tree = buildMerkleTree(leafHashes);

const vectors = {
  serializationVersion: "1",
  note:
    "MPC canonical serialization golden vectors. A changed value means the spec changed; " +
    "bump serializationVersion.",
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
process.stdout.write(`Wrote vectors to ${outPath}\n`);
