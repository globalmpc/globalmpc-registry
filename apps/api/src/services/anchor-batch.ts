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
 * Merkle batch 빌더 — spec 05 §5.8, 08 §8.4.
 *
 * 게시된 Registry version만 batch에 들어간다. draft·revoked 이전 상태를 넣으면
 * 공개되지 않은 내용의 커밋먼트가 체인에 올라간다.
 *
 * leaf 구성·정렬·중복 검사는 `@mpc/canonical`이 한다. 여기서는 무엇을 넣을지만
 * 고른다.
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
    // 정수 decimal string. number를 canonical payload에 넣지 않는다.
    version: String(row.version),
    status: row.status,
    serializationVersion: "1",
    policyVersion: row.policy_version,
    schemaVersion: row.schema_version,
    contentHash: row.content_hash,
  };
}

/**
 * 아직 anchor되지 않은 게시 version으로 batch를 만든다.
 *
 * 이미 batch에 들어간 version은 제외한다 — 같은 leaf가 두 batch에 들어가면
 * 어느 쪽 inclusion인지 구분할 수 없다.
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
    throw unprocessable("ANCHOR_BATCH_EMPTY", "anchor할 새 version이 없다");
  }

  const leaves = rows.map((row) => ({
    entryVersionId: row.id,
    leaf: toRegistryLeaf(row),
    leafHash: hashLeaf(toRegistryLeaf(row)),
  }));

  const tree = buildMerkleTree(leaves.map((entry) => entry.leafHash));

  // manifest는 오프체인에 보존한다. chain에는 그 해시만 올라간다(08 §8.4).
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
 * inclusion proof를 만든다.
 *
 * 무인증 공개 경로에서도 호출되므로 SECURITY DEFINER 함수를 쓴다. 그 함수는
 * 게시된 version만 반환하므로 draft의 proof는 만들어지지 않는다.
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
   * leaf를 다시 만들 때 쓸 규격.
   *
   * 셋 다 규격을 가리키는 이름이며 주체를 식별하지 않는다. 이것이 없으면
   * 검증자가 어떤 규격으로 재구성해야 하는지 알 수 없고, proof는 "믿어라"가 된다.
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
    // included는 성공이 아니다. confirmed만 성공이다(06 §6.8).
    confirmationState: row.transaction_state ?? "created",
    transactionHash: row.transaction_hash,
    blockNumber: row.block_number ? Number(row.block_number) : null,
    policyVersion: row.policy_version,
    schemaVersion: row.schema_version,
    serializationVersion: row.serialization_version,
  };
}
