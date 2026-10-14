import { createHash } from "node:crypto";
import type postgres from "postgres";
import {
  buildMerkleTree,
  canonicalize,
  getMerkleProof,
  type CanonicalValue,
  type Hex,
} from "@mpc/canonical";
import type { OutboxHandler, OutboxRow } from "./outbox-publisher.js";

/**
 * Project export package — 07 §7.9.
 *
 * Built by the outbox worker from the `project.export.requested` event, so a large project
 * never holds an HTTP request open and a failed build is retried like any other consumer.
 *
 * **What goes in.** Registry versions with their public projections, attestation metadata,
 * source receipt metadata (source coordinates, hashes, results), gate decisions, and anchor
 * inclusion proofs a verifier can check without asking this system.
 *
 * **What never goes in.** Raw source bytes, object keys, receipt query bases, attestation
 * findings and citations. Those are content, not records about content, and each has its own
 * guarded read path. Fields that are not public (free text a reviewer or decision maker wrote,
 * wallet addresses, source endpoints) are included only when the requester's clearance frozen
 * on the job covers `restricted`; a receipt whose disclosure grade the requester cannot read is
 * reduced to its id.
 *
 * **Numbers are strings.** The manifest hashes use the canonical serialization (JCS profile
 * without numbers), the same one registry leaves use, so a verifier needs one serializer.
 */

export const EXPORT_FORMAT = "mpc.project-export";
export const EXPORT_FORMAT_VERSION = "1";

export interface ExportJob {
  readonly id: string;
  readonly tenant_id: string;
  readonly project_id: string;
  readonly requested_by_subject_id: string;
  readonly requested_by_wallet: string;
  readonly sensitivity_clearance: readonly string[];
  readonly state: "queued" | "succeeded" | "failed";
  readonly requested_at: Date;
}

type Row = Record<string, unknown>;

export interface ExportRecords {
  readonly project: { readonly id: string; readonly projectKey: string };
  readonly registryVersions: readonly Row[];
  readonly attestations: readonly Row[];
  readonly sourceReceipts: readonly Row[];
  readonly gateDecisions: readonly Row[];
  readonly anchorLeaves: readonly Row[];
  /** Every leaf hash of each batch referenced by `anchorLeaves`, keyed by batch row id. */
  readonly batchLeaves: ReadonlyMap<string, readonly Hex[]>;
}

export interface ExportPackage {
  readonly manifest: { readonly [key: string]: CanonicalValue };
  readonly sections: { readonly [key: string]: readonly CanonicalValue[] };
}

/** Statements every package carries, so a reader knows what the package is not. */
export const EXPORT_LIMITATIONS: readonly string[] = [
  "Raw source content, stored objects, attestation findings and citations are not included.",
  "Fields that are not public are included only when the requester's clearance covers them.",
  "Anchor proofs show inclusion in a batch; only a confirmed transaction makes it final.",
  "This package is a snapshot at generatedAt and does not update.",
];

const iso = (value: unknown): string | null =>
  value instanceof Date ? value.toISOString() : value === null || value === undefined ? null : String(value);

const text = (value: unknown): string | null =>
  value === null || value === undefined ? null : String(value);

function sha256Hex(value: CanonicalValue): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/**
 * JSONB read back from the database may hold numbers. The canonical profile has none, so they
 * become decimal strings here — the same rule the registry applies to its projections.
 */
function toCanonical(value: unknown): CanonicalValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toCanonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Row).map(([key, inner]) => [key, toCanonical(inner)]),
    );
  }
  return String(value);
}

/** Assembles the package. Pure, so redaction and hashing are testable without a database. */
export function assembleExportPackage(
  job: ExportJob,
  records: ExportRecords,
  generatedAt: Date,
): { readonly pkg: ExportPackage; readonly manifestHash: string } {
  const restricted = job.sensitivity_clearance.includes("restricted");
  const gated = (value: unknown): CanonicalValue => (restricted ? toCanonical(value) : null);

  const registryVersions = records.registryVersions.map((row) => ({
    entryId: text(row["entry_id"]),
    registryType: text(row["registry_type"]),
    publicKey: text(row["public_key"]),
    versionId: text(row["id"]),
    version: text(row["version"]),
    status: text(row["status"]),
    contentHash: text(row["content_hash"]),
    sourceSnapshotHash: text(row["source_snapshot_hash"]),
    policyVersion: text(row["policy_version"]),
    schemaVersion: text(row["schema_version"]),
    serializationVersion: text(row["serialization_version"]),
    // A draft's projection has not passed publication; only what was published is public.
    publicProjection:
      row["status"] === "draft" ? null : toCanonical(row["public_projection"] ?? null),
    publishedAt: iso(row["published_at"]),
    revokedAt: iso(row["revoked_at"]),
    supersededById: text(row["superseded_by_id"]),
  }));

  const attestations = records.attestations.map((row) => ({
    id: text(row["id"]),
    caseId: text(row["case_id"]),
    attestationType: text(row["attestation_type"]),
    schemaId: text(row["schema_id"]),
    state: text(row["state"]),
    payloadHash: text(row["payload_hash"]),
    evidenceSnapshotHash: text(row["evidence_snapshot_hash"]),
    methodVersion: text(row["method_version"]),
    policyVersion: text(row["policy_version"]),
    signedAt: iso(row["signed_at"]),
    validUntil: iso(row["valid_until"]),
    supersedesId: text(row["supersedes_id"]),
    revokesId: text(row["revokes_id"]),
    signerWalletAddress: gated(row["signer_wallet_address"]),
    limitations: gated(row["limitations"]),
  }));

  const sourceReceipts = records.sourceReceipts.map((row) => {
    const grade = String(row["disclosure_permission"]);
    if (!job.sensitivity_clearance.includes(grade)) {
      return { id: text(row["id"]), disclosurePermission: grade, redacted: true };
    }
    return {
      id: text(row["id"]),
      disclosurePermission: grade,
      redacted: false,
      authorityId: text(row["authority_id"]),
      collectionMethod: text(row["collection_method"]),
      result: text(row["result"]),
      rawHash: text(row["raw_hash"]),
      endpointOrDocumentRef: gated(row["endpoint_or_document_ref"]),
      sourceSchemaVersion: text(row["source_schema_version"]),
      adapterVersion: text(row["adapter_version"]),
      normalizationVersion: text(row["normalization_version"]),
      termsLicense: text(row["terms_license"]),
      commercialReuse: text(row["commercial_reuse"]),
      receivedAt: iso(row["received_at"]),
      asOf: iso(row["as_of"]),
      effectiveAt: iso(row["effective_at"]),
      freshnessStatus: text(row["freshness_status"]),
      limitations: toCanonical(row["limitations"] ?? []),
    };
  });

  const gateDecisions = records.gateDecisions.map((row) => ({
    id: text(row["id"]),
    gateId: text(row["gate_id"]),
    decision: text(row["decision"]),
    inputAssessmentId: text(row["input_assessment_id"]),
    evidenceSnapshotHash: text(row["evidence_snapshot_hash"]),
    decisionAuthority: text(row["decision_authority"]),
    signedAt: iso(row["signed_at"]),
    decisionMakerSubjectId: gated(row["decision_maker_subject_id"]),
    rationale: gated(row["rationale"]),
    assumptions: gated(row["assumptions"]),
    conditions: gated(row["conditions"]),
  }));

  const anchorProofs = records.anchorLeaves.map((row) => {
    const batchRowId = String(row["batch_row_id"]);
    const leafHash = String(row["leaf_hash"]) as Hex;
    const leaves = records.batchLeaves.get(batchRowId) ?? [];
    const tree = buildMerkleTree(leaves);
    return {
      entryVersionId: text(row["entry_version_id"]),
      batchId: text(row["external_batch_id"]),
      merkleRoot: text(row["merkle_root"]),
      computedRoot: tree.root,
      leafHash,
      proof: getMerkleProof(tree, leafHash),
      chainId: text(row["chain_id"]),
      transactionState: text(row["transaction_state"]) ?? "created",
      transactionHash: text(row["tx_hash"]),
      blockNumber: text(row["block_number"]),
    };
  });

  const sections: Record<string, CanonicalValue[]> = {
    registryVersions,
    attestations,
    sourceReceipts,
    gateDecisions,
    anchorProofs,
  };

  const manifest = {
    format: EXPORT_FORMAT,
    formatVersion: EXPORT_FORMAT_VERSION,
    exportId: job.id,
    projectId: records.project.id,
    projectKey: records.project.projectKey,
    requestedBySubjectId: job.requested_by_subject_id,
    requestedByWallet: job.requested_by_wallet,
    requestedAt: job.requested_at.toISOString(),
    generatedAt: generatedAt.toISOString(),
    sensitivityClearance: [...job.sensitivity_clearance],
    canonicalization: "RFC8785-JCS, numbers as decimal strings",
    hashAlgorithm: "sha256",
    sections: Object.entries(sections).map(([name, items]) => ({
      name,
      count: String(items.length),
      redacted: String(
        items.filter(
          (item) => typeof item === "object" && item !== null && (item as Row)["redacted"] === true,
        ).length,
      ),
      sha256: sha256Hex(items),
    })),
    limitations: [...EXPORT_LIMITATIONS],
  };

  return { pkg: { manifest, sections }, manifestHash: sha256Hex(manifest) };
}

/** Reads the records a package is built from. Every query is pinned to the job's tenant. */
export async function loadExportRecords(
  sql: postgres.Sql,
  job: ExportJob,
): Promise<ExportRecords> {
  const tenant = job.tenant_id;
  const project = job.project_id;

  const [projectRow] = await sql<{ id: string; project_key: string }[]>`
    SELECT id, project_key FROM core.projects WHERE tenant_id = ${tenant} AND id = ${project}
  `;
  if (!projectRow) throw new Error("EXPORT_PROJECT_NOT_FOUND");

  const attestations = await sql<Row[]>`
    SELECT a.* FROM core.verification_attestations a
    JOIN core.verification_cases c ON c.id = a.case_id
    WHERE a.tenant_id = ${tenant} AND c.tenant_id = ${tenant} AND c.project_id = ${project}
    ORDER BY a.signed_at, a.id
  `;

  // Registry entries are keyed by subject: the project itself, or one of its attestations
  // or verification cases.
  const registryVersions = await sql<Row[]>`
    SELECT v.*, e.registry_type, e.public_key
    FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id = v.entry_id
    WHERE v.tenant_id = ${tenant} AND e.tenant_id = ${tenant}
      AND (
        e.subject_id = ${project}
        OR e.subject_id IN (
          SELECT id FROM core.verification_cases WHERE tenant_id = ${tenant} AND project_id = ${project}
        )
        OR e.subject_id IN (
          SELECT a.id FROM core.verification_attestations a
          JOIN core.verification_cases c ON c.id = a.case_id
          WHERE c.tenant_id = ${tenant} AND c.project_id = ${project}
        )
      )
    ORDER BY e.id, v.version
  `;

  const sourceReceipts = await sql<Row[]>`
    SELECT * FROM core.source_receipts
    WHERE tenant_id = ${tenant} AND project_id = ${project}
    ORDER BY received_at, id
  `;

  const gateDecisions = await sql<Row[]>`
    SELECT * FROM core.gate_decisions
    WHERE tenant_id = ${tenant} AND project_id = ${project}
    ORDER BY signed_at, id
  `;

  const versionIds = registryVersions.map((row) => String(row["id"]));
  const anchorLeaves =
    versionIds.length === 0
      ? []
      : await sql<Row[]>`
          SELECT l.entry_version_id, l.leaf_hash, l.batch_id AS batch_row_id,
                 b.batch_id AS external_batch_id, b.merkle_root,
                 t.state AS transaction_state, t.tx_hash, t.block_number, t.chain_id
          FROM chain.anchor_batch_leaves l
          JOIN chain.anchor_batches b ON b.id = l.batch_id
          LEFT JOIN LATERAL (
            SELECT state::text, tx_hash, block_number, chain_id FROM chain.transactions
            WHERE batch_id = b.id ORDER BY created_at DESC LIMIT 1
          ) t ON true
          WHERE b.tenant_id = ${tenant} AND l.entry_version_id = ANY(${versionIds}::uuid[])
          ORDER BY l.entry_version_id, b.created_at
        `;

  const batchIds = [...new Set(anchorLeaves.map((row) => String(row["batch_row_id"])))];
  const batchLeaves = new Map<string, Hex[]>();
  if (batchIds.length > 0) {
    const leaves = await sql<{ batch_id: string; leaf_hash: string }[]>`
      SELECT batch_id, leaf_hash FROM chain.anchor_batch_leaves
      WHERE batch_id = ANY(${batchIds}::uuid[])
    `;
    for (const leaf of leaves) {
      batchLeaves.set(leaf.batch_id, [...(batchLeaves.get(leaf.batch_id) ?? []), leaf.leaf_hash as Hex]);
    }
  }

  return {
    project: { id: projectRow.id, projectKey: projectRow.project_key },
    registryVersions,
    attestations,
    sourceReceipts,
    gateDecisions,
    anchorLeaves,
    batchLeaves,
  };
}

/** Builds and stores the package for one job. A job already built is left as it is. */
export async function buildProjectExport(
  sql: postgres.Sql,
  exportId: string,
  now: () => Date = () => new Date(),
): Promise<"built" | "already_built" | "missing"> {
  const [job] = await sql<ExportJob[]>`
    SELECT id, tenant_id, project_id, requested_by_subject_id, requested_by_wallet,
           sensitivity_clearance, state, requested_at
    FROM core.project_exports WHERE id = ${exportId}
  `;
  if (!job) return "missing";
  // At-least-once delivery can bring the same request twice. The first package stands.
  if (job.state === "succeeded") return "already_built";

  const records = await loadExportRecords(sql, job);
  const { pkg, manifestHash } = assembleExportPackage(job, records, now());

  await sql`
    UPDATE core.project_exports
    SET state = 'succeeded', package = ${sql.json(pkg as never)},
        manifest_hash = ${manifestHash}, failure_reason = NULL, completed_at = now()
    WHERE id = ${job.id} AND state <> 'succeeded'
  `;
  return "built";
}

/**
 * The export consumer.
 *
 * On dead-letter the job is marked `failed` with a fixed reason. The requester then sees a
 * result instead of a job that looks queued forever; a replay rebuilds it.
 */
export function projectExportHandler(sql: postgres.Sql): OutboxHandler {
  const exportIdOf = (event: OutboxRow): string => {
    const id = event.payload["exportId"];
    if (typeof id !== "string") throw new Error("EXPORT_EVENT_WITHOUT_ID");
    return id;
  };

  return {
    name: "project_export",
    version: "1",
    accepts: (eventType) => eventType === "project.export.requested",
    handle: async (event) => {
      await buildProjectExport(sql, exportIdOf(event));
    },
    onDeadLetter: async (event) => {
      await sql`
        UPDATE core.project_exports
        SET state = 'failed', failure_reason = 'EXPORT_BUILD_FAILED', completed_at = now()
        WHERE id = ${exportIdOf(event)} AND state = 'queued'
      `;
    },
  };
}
