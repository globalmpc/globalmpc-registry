import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import {
  buildMerkleTree,
  getMerkleProof,
  hashLeaf,
  keccak256,
  canonicalBytes,
  type Hex,
  type RegistryLeaf,
} from "@mpc/canonical";
import { unprocessable } from "../errors.js";

/**
 * Merkle batch builder — spec 05 §5.8, 08 §8.4.
 *
 * Only published Registry versions enter a batch. Including draft or pre-revocation states puts
 * commitments to unpublished content on chain.
 *
 * Leaf construction, ordering, and duplicate checks are done by `@mpc/canonical`. This only
 * chooses what goes in.
 */

export interface AnchorBatch {
  readonly batchId: Hex;
  readonly root: Hex;
  readonly manifestHash: Hex;
  readonly recordCount: number;
  readonly leaves: readonly { entryVersionId: string; leafHash: Hex }[];
  readonly manifest: unknown;
}

interface PublishedVersionRow {
  id: string;
  registry_type: "project" | "verification" | "asset";
  subject_id: string;
  version: number;
  status: "published" | "revoked" | "superseded";
  content_hash: string;
  policy_version: string;
  schema_version: string;
  serialization_version: string;
}

export function toRegistryLeaf(row: PublishedVersionRow): RegistryLeaf {
  return {
    registryType: row.registry_type,
    entryVersionId: row.id,
    subjectId: row.subject_id,
    // Integer decimal string. Numbers do not go into the canonical payload.
    version: String(row.version),
    status: row.status,
    serializationVersion: "1",
    policyVersion: row.policy_version,
    schemaVersion: row.schema_version,
    contentHash: row.content_hash,
  };
}

/**
 * Builds a batch from published versions not yet anchored.
 *
 * Versions already in a batch are excluded — if the same leaf is in two batches, it is
 * impossible to tell which inclusion it is.
 */
export async function buildAnchorBatch(
  tx: postgres.TransactionSql,
  tenantId: string,
): Promise<AnchorBatch> {
  const rows = await tx<PublishedVersionRow[]>`
    SELECT v.id, e.registry_type, e.subject_id, v.version, v.status,
           v.content_hash, v.policy_version, v.schema_version, v.serialization_version
    FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id = v.entry_id
    WHERE v.status IN ('published', 'revoked', 'superseded')
      AND v.content_hash IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM chain.anchor_batch_leaves l WHERE l.entry_version_id = v.id
      )
    ORDER BY v.created_at
  `;

  if (rows.length === 0) {
    throw unprocessable("ANCHOR_BATCH_EMPTY", "No new version to anchor");
  }

  const leaves = rows.map((row) => ({
    entryVersionId: row.id,
    leaf: toRegistryLeaf(row),
    leafHash: hashLeaf(toRegistryLeaf(row)),
  }));

  const tree = buildMerkleTree(leaves.map((entry) => entry.leafHash));

  // The manifest is kept off-chain. Only its hash goes on chain (08 §8.4).
  const manifest = {
    manifestVersion: "1",
    serializationVersion: "1",
    recordCount: String(leaves.length),
    root: tree.root,
    leaves: [...leaves]
      .sort((a, b) => (a.leafHash < b.leafHash ? -1 : 1))
      .map((entry) => ({ entryVersionId: entry.entryVersionId, leafHash: entry.leafHash })),
  };

  return {
    batchId: keccak256(canonicalBytes({ batch: randomUUID(), root: tree.root })),
    root: tree.root,
    manifestHash: keccak256(canonicalBytes(manifest)),
    recordCount: leaves.length,
    leaves: leaves.map((entry) => ({
      entryVersionId: entry.entryVersionId,
      leafHash: entry.leafHash,
    })),
    manifest,
  };
}

/**
 * Builds an inclusion proof.
 *
 * Also called from the unauthenticated public path, so it uses a SECURITY DEFINER function.
 * That function returns only published versions, so no proof is built for drafts.
 */
export async function buildInclusionProof(
  sql: postgres.Sql,
  entryVersionId: string,
): Promise<{
  readonly leafHash: Hex;
  readonly proof: Hex[];
  readonly root: Hex;
  readonly batchId: string;
  readonly confirmationState: string;
  readonly transactionHash: string | null;
  readonly blockNumber: number | null;
  /**
   * Spec used to rebuild the leaf.
   *
   * All three are names referring to a spec and do not identify a subject. Without them a
   * verifier cannot know which spec to reconstruct with, and the proof becomes "trust me".
   */
  readonly policyVersion: string;
  readonly schemaVersion: string;
  readonly serializationVersion: string;
} | null> {
  const [row] = await sql<
    {
      leaf_hash: string;
      batch_row_id: string;
      merkle_root: string;
      external_batch_id: string;
      transaction_state: string | null;
      transaction_hash: string | null;
      block_number: string | null;
      policy_version: string;
      schema_version: string;
      serialization_version: string;
    }[]
  >`SELECT * FROM core.public_inclusion_proof(${entryVersionId})`;

  if (!row) return null;

  const siblings = await sql<{ leaf_hash: string }[]>`
    SELECT * FROM core.public_batch_leaves(${row.batch_row_id})
  `;

  const tree = buildMerkleTree(siblings.map((sibling) => sibling.leaf_hash as Hex));
  const proof = getMerkleProof(tree, row.leaf_hash as Hex);

  return {
    leafHash: row.leaf_hash as Hex,
    proof,
    root: row.merkle_root as Hex,
    batchId: row.external_batch_id,
    // included is not success. Only confirmed is success (06 §6.8).
    confirmationState: row.transaction_state ?? "created",
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number ? Number(row.block_number) : null,
    policyVersion: row.policy_version,
    schemaVersion: row.schema_version,
    serializationVersion: row.serialization_version,
  };
}
