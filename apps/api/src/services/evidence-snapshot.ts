import type postgres from "postgres";
import { canonicalBytes, keccak256, type Hex } from "@mpc/canonical";
import { badRequest } from "../errors.js";

/**
 * Evidence snapshot — spec 04 §4.2, 05 §5.12.
 *
 * What a reviewer signs is "the evidence set at that moment". Without pinning the moment, the
 * signature still looks valid after the evidence changes.
 *
 * Two rules:
 *
 * 1. **Sort artifact IDs before serializing.** The same set must yield the same hash regardless
 *    of order — if the snapshot changed with query order, it could not be reproduced.
 * 2. **An empty snapshot cannot be created.** A review without evidence does not exist.
 */

export interface EvidenceSnapshot {
  readonly hash: Hex;
  readonly claimIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly receiptIds: readonly string[];
}

export interface SnapshotClaimRow {
  id: string; value_text: string; grade: string;
  catalog_entry_id: string | null; catalog_version: number | null;
  structured_values: Record<string, string | boolean> | null; document_upload_ids: string[];
}
export function snapshotClaimFingerprint(claim: SnapshotClaimRow) {
  return { id: claim.id, valueText: claim.value_text, grade: claim.grade,
    ...(claim.catalog_entry_id === null ? {} : { structured: {
      catalogEntryId: claim.catalog_entry_id, catalogVersion: claim.catalog_version,
      values: claim.structured_values, documentUploadIds: [...claim.document_upload_ids].sort(),
    } }),
  };
}
interface SnapshotInput {
  readonly claimIds: readonly string[];
  readonly artifactIds: readonly string[];
  readonly receiptIds: readonly string[];
  /** The claim's current content must be included to detect changed values. */
  readonly claimFingerprints: readonly { id: string; valueText: string; grade: string; structured?: { catalogEntryId: string; catalogVersion: number | null; values: Record<string, string | boolean> | null; documentUploadIds: string[] } }[];
}

function canonicalForm(input: SnapshotInput) {
  const sorted = <T>(values: readonly T[], key: (value: T) => string) =>
    [...values].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));

  return {
    snapshotVersion: input.claimFingerprints.some((claim) => claim.structured !== undefined) ? "2" : "1",
    claimIds: [...input.claimIds].sort(),
    artifactIds: [...input.artifactIds].sort(),
    receiptIds: [...input.receiptIds].sort(),
    claims: sorted(input.claimFingerprints, (claim) => claim.id).map((claim) => ({
      id: claim.id,
      valueText: claim.valueText,
      grade: claim.grade,
      ...(claim.structured === undefined ? {} : { structured: { ...claim.structured, catalogVersion: claim.structured.catalogVersion === null ? null : String(claim.structured.catalogVersion), documentUploadIds: [...claim.structured.documentUploadIds].sort() } }),
    })),
  };
}

export function hashSnapshotInput(input: SnapshotInput): Hex {
  return keccak256(canonicalBytes(canonicalForm(input)));
}

/**
 * Builds a snapshot from the verification case's current evidence.
 *
 * Collects the claims linked to the case and the artifacts and receipts those claims rely on.
 */
export async function buildEvidenceSnapshot(
  tx: postgres.TransactionSql,
  projectId: string,
  claimIds: readonly string[],
): Promise<EvidenceSnapshot> {
  if (claimIds.length === 0) {
    throw badRequest(
      "EVIDENCE_SNAPSHOT_EMPTY",
      "A review without evidence cannot be created. Specify at least one claim",
    );
  }

  const claims = await tx<SnapshotClaimRow[]>`
    SELECT id, value_text, grade, catalog_entry_id, catalog_version, structured_values, document_upload_ids FROM core.claims
    WHERE project_id = ${projectId} AND id = ANY(${claimIds as string[]}::uuid[])
  `;

  if (claims.length !== claimIds.length) {
    throw badRequest(
      "EVIDENCE_SNAPSHOT_CLAIM_MISSING",
      "Some of the specified claims are not in this project",
      { requested: claimIds.length, found: claims.length },
    );
  }

  const artifacts = await tx<{ id: string }[]>`
    SELECT id FROM core.artifacts
    WHERE project_id = ${projectId} AND revoked_at IS NULL
  `;

  const receipts = await tx<{ id: string }[]>`
    SELECT id FROM core.source_receipts WHERE project_id = ${projectId}
  `;

  const input: SnapshotInput = {
    claimIds: claims.map((claim) => claim.id),
    artifactIds: artifacts.map((artifact) => artifact.id),
    receiptIds: receipts.map((receipt) => receipt.id),
    claimFingerprints: claims.map(snapshotClaimFingerprint),
  };

  return {
    hash: hashSnapshotInput(input),
    claimIds: input.claimIds,
    artifactIds: input.artifactIds,
    receiptIds: input.receiptIds,
  };
}
