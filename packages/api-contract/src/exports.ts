import { z } from "zod";
import { isoDateTime } from "./common.js";

/**
 * Exports — spec 07 §7.9, 12 §12.4 ("notification · audit export").
 *
 * Two different things share the word.
 *
 * - **Audit export** — the append-only audit trail for a tenant, optionally narrowed to a
 *   project and a time range, as JSON Lines with a hash manifest. Read by auditors and security
 *   operators; the export itself is recorded in the same trail.
 * - **Project export package** — an asynchronous job that assembles what an outside reviewer
 *   needs to check a project's records without this system: registry versions, attestation and
 *   receipt metadata, decisions and anchor proofs. Redacted by the requester's clearance.
 */

/** Page cap for one audit export. A larger range is read in pages with `afterId`. */
export const AUDIT_EXPORT_MAX_LIMIT = 5000;

export const auditExportQuery = z
  .object({
    projectId: z.string().uuid().optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    /** Keyset cursor: the last `id` of the previous page. */
    afterId: z.string().regex(/^\d+$/).optional(),
    limit: z.coerce.number().int().min(1).max(AUDIT_EXPORT_MAX_LIMIT).default(1000),
  })
  .strict();

/**
 * One exported audit record — one line of the JSONL body.
 *
 * `detail` and `request_ip` are left out, as on the audit read route: the trail says who did
 * what, and those two columns are where a broken no-PII promise would surface first.
 */
export const auditExportRecord = z.object({
  id: z.string(),
  occurredAt: isoDateTime,
  projectId: z.string().nullable(),
  actorSubjectId: z.string().nullable(),
  actorWallet: z.string().nullable(),
  effectiveRole: z.string().nullable(),
  command: z.string(),
  resourceType: z.string(),
  resourceId: z.string().nullable(),
  beforeVersion: z.number().int().nullable(),
  afterVersion: z.number().int().nullable(),
  reason: z.string().nullable(),
  correlationId: z.string(),
  signatureOrTx: z.string().nullable(),
});

export const auditExportManifest = z.object({
  format: z.literal("mpc.audit-export"),
  formatVersion: z.literal("1"),
  encoding: z.literal("application/x-ndjson"),
  hashAlgorithm: z.literal("sha256"),
  /** sha256 of the exact `jsonl` string, UTF-8 encoded. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  lineCount: z.number().int(),
  firstId: z.string().nullable(),
  lastId: z.string().nullable(),
  /** Pass as `afterId` to read the next page. Null when this page reached the end. */
  nextAfterId: z.string().nullable(),
  filters: z.object({
    projectId: z.string().nullable(),
    from: isoDateTime.nullable(),
    to: isoDateTime.nullable(),
    afterId: z.string().nullable(),
  }),
  generatedAt: isoDateTime,
  generatedBy: z.string(),
});

export const auditExport = z.object({
  manifest: auditExportManifest,
  /** One `auditExportRecord` per line, `\n`-terminated, ascending `id`. */
  jsonl: z.string(),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const projectExportState = z.enum(["queued", "succeeded", "failed"]);

export const projectExportJob = z.object({
  id: z.string(),
  projectId: z.string(),
  state: projectExportState,
  requestedAt: isoDateTime,
  completedAt: isoDateTime.nullable(),
  /** The clearance the package is redacted to, frozen at request time. */
  sensitivityClearance: z.array(z.string()),
  /** sha256 of the canonical manifest. Present once built. */
  manifestHash: z.string().nullable(),
  failureReason: z.string().nullable(),
  /**
   * `{ manifest, sections }` once built. Numbers are decimal strings (canonical profile);
   * section hashes in the manifest are over the canonical form of each section.
   */
  package: z.record(z.unknown()).nullable(),
  requestId: z.string(),
  asOf: isoDateTime,
});
