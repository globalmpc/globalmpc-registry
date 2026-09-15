import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { admitToStorage } from "@mpc/domain";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";
import {
  canTransitionUpload,
  computeContentHash,
  evidenceKey,
  quarantineKey,
  type ObjectStore,
  type UploadState,
} from "@mpc/storage";

/**
 * File upload — spec 05 §5.2, 06 §6.7.
 *
 * What this route enforces:
 *
 * - **An upload is not evidence.** It lands on the quarantine path first and is promoted
 *   only after passing scanning. If uploads became evidence at once, malware would reach review.
 * - **An infected verdict is irreversible.** The state machine has no
 *   `scanned_infected → promoted` path, and a reachability check verifies that.
 * - **Storage keys contain no file or project names.** Keys travel through logs, URLs,
 *   and error messages.
 * - **No permanent public URLs.** Downloads use presigned URLs capped at 15 minutes.
 * - **The same content is not stored twice.** The content hash is UNIQUE per tenant and
 *   project, so evidence does not fork.
 */

/**
 * Upload cap.
 *
 * The base64 path loads the whole request body into memory, so the cap is low. Large
 * files use the multipart path.
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Multipart cap. It streams to storage, so it can accept more. */
const MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024;

/** States that passed the malware scan. Only these get a download link (Q-033). */
const DOWNLOADABLE_STATES: ReadonlySet<UploadState> = new Set(["scanned_clean", "promoted"]);

/**
 * Accepted content types — 06 §6.7.
 *
 * The uploader sets the value. Without a limit, a file uploaded as `text/html` becomes a
 * document on the storage origin, which bypasses our authorization checks. Download links
 * force `attachment` (`@mpc/storage`), but narrowing what is stored comes first —
 * with a single defense, nothing blocks anything the moment it changes.
 *
 * Only types actually used as evidence are listed. Add a type here when one is needed —
 * widening the list must leave a record.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  "application/pdf",
  "application/json",
  "application/xml",
  "application/zip",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/octet-stream",
  "text/plain",
  "text/csv",
  "image/png",
  "image/jpeg",
  "image/tiff",
]);

/**
 * Values arrive with parameters, as in `text/csv; charset=utf-8`. The check uses the media type.
 */
function normalizeContentType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

function isAllowedContentType(value: string): boolean {
  return ALLOWED_CONTENT_TYPES.has(normalizeContentType(value));
}

const contentTypeSchema = z
  .string()
  .min(1)
  .refine(isAllowedContentType, "Content type is not accepted");

const createUploadSchema = z.object({
  /** Base64-encoded body. Multipart switches to streaming on R2. */
  contentBase64: z.string().min(1),
  contentType: contentTypeSchema,
  originalFilename: z.string().min(1).nullable().default(null),
  sensitivity: z.enum(["public", "restricted", "confidential"]).default("restricted"),
});

const scanResultSchema = z.object({
  result: z.enum(["clean", "infected"]),
  detail: z.string().optional(),
});

interface UploadRow {
  readonly id: string;
  readonly project_id: string;
  readonly object_key: string;
  readonly content_hash: string;
  readonly byte_size: string;
  readonly content_type: string;
  readonly original_filename: string | null;
  readonly sensitivity: string;
  readonly state: UploadState;
  readonly uploaded_at: Date;
  readonly scanned_at: Date | null;
  readonly promoted_artifact_id: string | null;
  readonly rejection_reason: string | null;
  readonly version: number;
}

/**
 * Next actions per state.
 *
 * The server provides them so the UI does not guess. The key point is that
 * `scanned_infected` has no "rescan" — no such path exists.
 */
function nextActions(state: UploadState): string[] {
  switch (state) {
    case "received":
      return ["Record scan result"];
    case "quarantined":
      return ["Record scan result"];
    case "scanned_clean":
      return ["Promote to evidence", "Reject"];
    case "scanned_infected":
      // An infected verdict is irreversible. To try again, upload a new file.
      return ["Reject", "Upload a new file"];
    case "promoted":
      return ["Download"];
    case "rejected":
      return [];
  }
}

function toView(row: UploadRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    contentHash: row.content_hash,
    byteSize: Number(row.byte_size),
    contentType: row.content_type,
    originalFilename: row.original_filename,
    sensitivity: row.sensitivity,
    state: row.state,
    uploadedAt: row.uploaded_at.toISOString(),
    scannedAt: row.scanned_at?.toISOString() ?? null,
    promotedArtifactId: row.promoted_artifact_id,
    rejectionReason: row.rejection_reason,
    nextActions: nextActions(row.state),
    version: row.version,
  };
}

/**
 * The project an upload belongs to.
 *
 * Authorization runs **first, outside the transaction**. An idempotent replay returns the
 * stored response as is, so inside the block a replay of someone else's key skips authorization.
 */
async function uploadProjectId(
  sql: postgres.Sql,
  tenantId: string,
  uploadId: string,
): Promise<string> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`
      SELECT project_id FROM core.object_uploads WHERE id = ${uploadId}
    `,
  );
  if (!row) throw notFound("Upload not found");
  return row.project_id;
}

/**
 * Scanner liveness check.
 *
 * Past `SCAN_STALE_SECONDS` the scanner is treated as stopped. It signals every 15 seconds,
 * so 180 seconds is twelve missed cycles — not mistakable for a transient delay.
 */
const SCAN_STALE_SECONDS = 180;

type ScannerState = "running" | "stale" | "never_seen" | "unknown";

async function scannerStatus(
  sql: postgres.Sql,
): Promise<{ state: ScannerState; secondsSinceHeartbeat: number | null; detail: string }> {
  try {
    const [row] = await sql<{ seconds: string | null }[]>`
      SELECT core.seconds_since_worker_heartbeat('scan') AS seconds
    `;
    const seconds = row?.seconds === null || row?.seconds === undefined ? null : Number(row.seconds);

    if (seconds === null) {
      return {
        state: "never_seen",
        secondsSinceHeartbeat: null,
        detail:
          "The scan worker has never reported. Uploads stay in quarantine and are not promoted to evidence.",
      };
    }
    if (seconds > SCAN_STALE_SECONDS) {
      return {
        state: "stale",
        secondsSinceHeartbeat: seconds,
        detail: `The scan worker has not been seen for ${seconds} seconds. Uploads stay in quarantine meanwhile.`,
      };
    }
    return {
      state: "running",
      secondsSinceHeartbeat: seconds,
      detail: "The scan worker is running.",
    };
  } catch {
    // Unknown is a state too. The listing does not fail.
    return {
      state: "unknown",
      secondsSinceHeartbeat: null,
      detail: "Could not check the scan worker state.",
    };
  }
}

export async function registerUploadRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
  store: ObjectStore,
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/uploads",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { requestId, asOf } = request.context;

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<UploadRow[]>`
          SELECT * FROM core.object_uploads
          WHERE project_id = ${request.params.projectId}
          ORDER BY uploaded_at DESC LIMIT 100
        `,
      );

      /**
       * Is the scanner alive.
       *
       * `promote` transitions only from `scanned_clean`, so in a deployment without a scan worker
       * uploads stay `quarantined` forever. That stall **looks like waiting, not an
       * error** — the UI could not tell "waiting for a scan" from "nothing is there to
       * scan at all".
       *
       * A lookup failure is not raised as an error. The listing must go out, and unknown is
       * a state too — that is `unknown`.
       */
      const scanner = await scannerStatus(sql);

      return { items: rows.map(toView), scanner, requestId, asOf };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/uploads",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createUploadSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      /**
       * Storage path decision — OD-17·OD-18.
       *
       * Checked **before** authorization. Whether the uploader has permission and whether this
       * store may accept the material are different questions; checking later turns it into
       * "accepted because permitted".
       */
      const admission = admitToStorage(parsed.data.sensitivity);
      if (!admission.admitted) {
        throw unprocessable("SECURED_ROUTE_REQUIRED", admission.reason, {
          requiredTier: admission.requiredTier,
          nextAction: admission.nextAction,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, request.params.projectId, {
          sensitivity: parsed.data.sensitivity,
        }),
        sessionFacts(session),
      );

      const bytes = new Uint8Array(Buffer.from(parsed.data.contentBase64, "base64"));
      if (bytes.byteLength === 0) {
        throw badRequest("UPLOAD_EMPTY", "Empty files are not accepted");
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw unprocessable("UPLOAD_TOO_LARGE", "Upload exceeds the cap", {
          maxBytes: String(MAX_UPLOAD_BYTES),
          receivedBytes: String(bytes.byteLength),
        });
      }

      const contentHash = computeContentHash(bytes);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          // If the same content exists, return it. Storing it twice forks evidence and
          // leaves it unclear which copy is under review.
          const [existing] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads
            WHERE project_id = ${request.params.projectId} AND content_hash = ${contentHash}
          `;
          if (existing) return { ...toView(existing), requestId, asOf };

          const uploadId = randomUUID();
          // Quarantine path. The evidence path is created on promotion.
          const key = quarantineKey(tenantId, uploadId);

          await store.put(key, bytes, normalizeContentType(parsed.data.contentType));

          const [row] = await tx<UploadRow[]>`
            INSERT INTO core.object_uploads (
              id, tenant_id, project_id, object_key, content_hash, byte_size,
              content_type, original_filename, sensitivity, state, uploaded_by
            ) VALUES (
              ${uploadId}, ${tenantId}, ${request.params.projectId}, ${key},
              ${contentHash}, ${bytes.byteLength},
              ${normalizeContentType(parsed.data.contentType)},
              ${parsed.data.originalFilename}, ${parsed.data.sensitivity},
              'quarantined', ${session.subjectId ?? null}
            )
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "upload.received",
            resourceType: "object_upload",
            resourceId: uploadId,
            correlationId,
            requestIp: request.ip,
            // File names are not recorded. The audit log would become a channel for restricted data.
            detail: {
              byteSize: bytes.byteLength,
              contentType: normalizeContentType(parsed.data.contentType),
            },
          });

          return { ...toView(row!), requestId, asOf };
        }),
      );
    },
  );

  /**
   * Record scan result.
   *
   * **This path is called by the scan service.** In the default setup the `@mpc/worker` scan
   * worker updates the DB directly, so this route is unused. It is kept for attaching an
   * external scan service.
   *
   * The UI has no button for this. If an operator could produce scan results, quarantine
   * would be a formality.
   *
   * Only the `scan_service` role holds `upload.scan_result`. Reusing `source.upload` would
   * let an uploader pass their own file.
   */
  /**
   * Multipart streaming upload.
   *
   * Produces the same result as the base64 path **without loading the whole file into memory.**
   * Large evidence (drawings, aerial photos, full registry exports) cannot go through base64.
   *
   * Why both paths remain: sending JSON via browser fetch is simple and enough for small
   * files. Only large files come here.
   */
  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/uploads/stream",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const file = await request.file({ limits: { fileSize: MAX_STREAM_BYTES } });
      if (!file) throw badRequest("UPLOAD_MISSING_FILE", "Multipart file part is missing");

      // Apply the same limits as the base64 path. Narrowing only one makes the other a bypass.
      if (file.mimetype && !isAllowedContentType(file.mimetype)) {
        throw unprocessable("UPLOAD_CONTENT_TYPE_NOT_ALLOWED", "Content type is not accepted", {
          contentType: normalizeContentType(file.mimetype),
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      const uploadId = randomUUID();
      const key = quarantineKey(tenantId, uploadId);

      // Write to storage first. Deduplication needs the content hash, and when streaming
      // the hash exists only after reading everything.
      const stored = await store.putStream(
        key,
        file.file,
        file.mimetype ? normalizeContentType(file.mimetype) : "application/octet-stream",
      );

      if (file.file.truncated) {
        // Storing a file truncated at the cap would leave evidence with different content.
        throw unprocessable("UPLOAD_TOO_LARGE", "Upload exceeds the cap", {
          maxBytes: String(MAX_STREAM_BYTES),
        });
      }
      if (stored.byteSize === 0) throw badRequest("UPLOAD_EMPTY", "Empty files are not accepted");

      const requestHash = hashRequest({ contentHash: stored.contentHash });

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [existing] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads
            WHERE project_id = ${request.params.projectId}
              AND content_hash = ${stored.contentHash}
          `;
          // The same content already exists. The object just written stays but is unreferenced —
          // deleting it would let a storage error turn into an upload failure.
          if (existing) return { ...toView(existing), requestId, asOf };

          const [row] = await tx<UploadRow[]>`
            INSERT INTO core.object_uploads (
              id, tenant_id, project_id, object_key, content_hash, byte_size,
              content_type, original_filename, sensitivity, state, uploaded_by
            ) VALUES (
              ${uploadId}, ${tenantId}, ${request.params.projectId}, ${key},
              ${stored.contentHash}, ${stored.byteSize}, ${stored.contentType},
              -- The streaming path is always restricted. Accepting the sensitive tier
              -- needs a secured route (OD-18), which does not exist yet.
              ${file.filename ?? null}, 'restricted', 'quarantined',
              ${session.subjectId ?? null}
            )
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: request.params.projectId,
            session,
            command: "upload.received",
            resourceType: "object_upload",
            resourceId: uploadId,
            correlationId,
            requestIp: request.ip,
            // File names are not recorded. The audit log would become a channel for restricted data.
            detail: { byteSize: stored.byteSize, contentType: stored.contentType, via: "multipart" },
          });

          return { ...toView(row!), requestId, asOf };
        }),
      );
    },
  );

  app.post<{ Params: { uploadId: string } }>(
    "/api/v1/uploads/:uploadId/scan-result",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = scanResultSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "result must be clean or infected");
      }

      const effectiveRole = assertAuthorized(
        session,
        "upload.scan_result",
        projectResource(
          tenantId,
          await uploadProjectId(sql, tenantId, request.params.uploadId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);
      const toState: UploadState =
        parsed.data.result === "clean" ? "scanned_clean" : "scanned_infected";

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [row] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads WHERE id = ${request.params.uploadId}
            FOR UPDATE
          `;
          if (!row) throw notFound("Upload not found");

          assertVersionMatches(expectedVersion, row.version, "object_upload");

          if (!canTransitionUpload(row.state, toState)) {
            throw conflict("INVALID_STATE_TRANSITION", "A scan result cannot be recorded in this state", {
              fromState: row.state,
              toState,
            });
          }

          const [updated] = await tx<UploadRow[]>`
            UPDATE core.object_uploads
            SET state = ${toState}, scanned_at = now(), version = version + 1,
                rejection_reason = ${parsed.data.detail ?? null}
            WHERE id = ${row.id}
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: row.project_id,
            session,
            command: `upload.${toState}`,
            resourceType: "object_upload",
            resourceId: row.id,
            beforeVersion: row.version,
            afterVersion: row.version + 1,
            correlationId,
            requestIp: request.ip,
          });

          return { ...toView(updated!), requestId, asOf };
        }),
      );
    },
  );

  /**
   * Promotion to evidence.
   *
   * Copies the quarantine object to the evidence path and creates an artifact. The original
   * is kept — "what was promoted" must be verifiable later.
   */
  app.post<{ Params: { uploadId: string } }>(
    "/api/v1/uploads/:uploadId/promote",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(
          tenantId,
          await uploadProjectId(sql, tenantId, request.params.uploadId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body ?? {});

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [row] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads WHERE id = ${request.params.uploadId}
            FOR UPDATE
          `;
          if (!row) throw notFound("Upload not found");

          assertVersionMatches(expectedVersion, row.version, "object_upload");

          // Infected uploads never get here. The state machine has no path for it.
          if (!canTransitionUpload(row.state, "promoted")) {
            throw conflict("INVALID_STATE_TRANSITION", "Only uploads that passed scanning can be promoted", {
              fromState: row.state,
              toState: "promoted",
            });
          }

          const artifactId = randomUUID();
          const target = evidenceKey(tenantId, artifactId);
          await store.copy(row.object_key, target);

          await tx`
            INSERT INTO core.artifacts (
              id, tenant_id, project_id, kind, content_hash, object_key, sensitivity
            ) VALUES (
              ${artifactId}, ${tenantId}, ${row.project_id}, 'raw_source',
              ${row.content_hash}, ${target}, ${row.sensitivity}
            )
          `;

          const [updated] = await tx<UploadRow[]>`
            UPDATE core.object_uploads
            SET state = 'promoted', promoted_artifact_id = ${artifactId},
                version = version + 1
            WHERE id = ${row.id}
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: row.project_id,
            session,
            command: "upload.promoted",
            resourceType: "object_upload",
            resourceId: row.id,
            beforeVersion: row.version,
            afterVersion: row.version + 1,
            correlationId,
            requestIp: request.ip,
            detail: { artifactId },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "evidence.artifact.created",
            aggregateId: artifactId,
            aggregateVersion: 1,
            projectId: row.project_id,
            payload: { contentHash: row.content_hash },
            correlationId,
          });

          return { ...toView(updated!), requestId, asOf };
        }),
      );
    },
  );

  /**
   * Short-lived download link.
   *
   * No permanent URL is created. Whoever receives the link skips our authorization checks,
   * so the response says so — if the link were mistaken as shareable, restricted
   * material would leave our control.
   */
  app.post<{ Params: { uploadId: string } }>(
    "/api/v1/uploads/:uploadId/download-link",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(
          tenantId,
          await uploadProjectId(sql, tenantId, request.params.uploadId),
        ),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body ?? {});
      const ttlSeconds = 300;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [row] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads WHERE id = ${request.params.uploadId}
          `;
          if (!row) throw notFound("Upload not found");

          // No link is issued for an infected file. A reviewer has no reason to open it.
          if (row.state === "scanned_infected") {
            throw unprocessable("UPLOAD_INFECTED", "An infected file cannot be downloaded");
          }

          /**
           * Allowlist, not blocklist (Q-033, option 1).
           *
           * Blocking only `scanned_infected` handed out links for quarantined files the scanner
           * had not seen yet — a malicious file reached the project's users before the scan.
           * Only states that passed the scan get a link; every other state waits.
           */
          if (!DOWNLOADABLE_STATES.has(row.state)) {
            throw conflict(
              "UPLOAD_NOT_SCANNED",
              "This file has not passed the malware scan yet and cannot be downloaded",
              { requiredAction: "Wait for the scan result" },
            );
          }

          const url = await store.presignGet(row.object_key, ttlSeconds);

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: row.project_id,
            session,
            command: "upload.download_link_issued",
            resourceType: "object_upload",
            resourceId: row.id,
            correlationId,
            requestIp: request.ip,
          });

          return {
            url,
            expiresInSeconds: ttlSeconds,
            warning:
              "Anyone with this link can download the file without signing in. Do not share it.",
            requestId,
            asOf,
          };
        }),
      );
    },
  );
}
