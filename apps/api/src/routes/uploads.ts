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
 * 파일 업로드 — spec 05 §5.2, 06 §6.7.
 *
 * 이 라우트가 지키는 것:
 *
 * - **업로드는 evidence가 아니다.** quarantine 경로로 먼저 들어가고, 검사를
 *   통과해야 승격된다. 업로드 즉시 evidence가 되면 악성 파일이 검토 대상 자료가 된다.
 * - **감염 판정은 되돌릴 수 없다.** 상태기계에 `scanned_infected → promoted`
 *   경로가 없고, 도달성 검사가 그것을 확인한다.
 * - **저장소 키에 파일명·프로젝트명을 넣지 않는다.** 키는 로그·URL·오류 메시지를
 *   타고 흐른다.
 * - **영구 공개 URL을 만들지 않는다.** 다운로드는 15분 상한의 presigned URL이다.
 * - **같은 내용을 두 번 저장하지 않는다.** content hash가 tenant·프로젝트 안에서
 *   UNIQUE라 evidence가 갈라지지 않는다.
 */

/**
 * 업로드 상한.
 *
 * base64 경로는 요청 본문을 통째로 메모리에 올리므로 낮게 잡는다. 큰 파일은
 * multipart 경로를 쓴다.
 */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** multipart 상한. 저장소로 흘려보내므로 더 크게 받을 수 있다. */
const MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * 받을 수 있는 content type — 06 §6.7.
 *
 * 값은 업로더가 정한다. 제한이 없으면 `text/html`로 올린 파일이 저장소 오리진의
 * 문서가 되고, 그 오리진은 우리 권한 검사를 지나지 않는다. 다운로드 링크가
 * `attachment`를 강제하지만(`@mpc/storage`) 저장 자체를 좁히는 것이 먼저다 —
 * 방어가 하나뿐이면 그것이 바뀌는 순간 막는 것이 없다.
 *
 * 증빙으로 실제 쓰이는 것만 둔다. 필요한 형식이 생기면 여기에 추가한다 —
 * 목록을 넓히는 것이 기록에 남아야 한다.
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
 * `text/csv; charset=utf-8`처럼 파라미터가 붙어 온다. 판정은 media type으로 한다.
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
  .refine(isAllowedContentType, "받지 않는 content type이다");

const createUploadSchema = z.object({
  /** base64 인코딩된 본문. multipart는 R2에서 스트리밍으로 바꾼다. */
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
 * 상태별 다음 행동.
 *
 * 화면이 추측하지 않게 서버가 알려준다. `scanned_infected`에 "재검사"를 넣지
 * 않는 것이 핵심이다 — 그런 경로는 존재하지 않는다.
 */
function nextActions(state: UploadState): string[] {
  switch (state) {
    case "received":
      return ["검사 결과 기록"];
    case "quarantined":
      return ["검사 결과 기록"];
    case "scanned_clean":
      return ["evidence로 승격", "반려"];
    case "scanned_infected":
      // 감염 판정은 되돌릴 수 없다. 다시 보려면 새로 올린다.
      return ["반려", "새 파일로 다시 업로드"];
    case "promoted":
      return ["다운로드"];
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
 * 업로드가 속한 프로젝트.
 *
 * 권한 판정은 **트랜잭션 밖에서 먼저** 한다. 멱등 replay는 저장된 응답을 그대로
 * 돌려주므로, 인가를 멱등 블록 안에 두면 남의 key로 재생한 요청이 인가를 건너뛴다.
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
  if (!row) throw notFound("업로드를 찾을 수 없다");
  return row.project_id;
}

/**
 * 검사기 생존 판정.
 *
 * `SCAN_STALE_SECONDS`를 넘으면 "멈춘 것으로 본다". 15초마다 신호를 남기므로
 * 180초는 열두 주기를 놓친 것이다 — 일시적인 지연으로 오해할 여지가 없다.
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
          "검사 worker가 한 번도 보고한 적이 없다. 업로드는 quarantine에 머물며 증빙으로 승격되지 않는다.",
      };
    }
    if (seconds > SCAN_STALE_SECONDS) {
      return {
        state: "stale",
        secondsSinceHeartbeat: seconds,
        detail: `검사 worker를 ${seconds}초 동안 보지 못했다. 그동안 업로드는 quarantine에 머문다.`,
      };
    }
    return {
      state: "running",
      secondsSinceHeartbeat: seconds,
      detail: "검사 worker가 돌고 있다.",
    };
  } catch {
    // 알 수 없다는 것도 하나의 상태다. 목록을 실패시키지 않는다.
    return {
      state: "unknown",
      secondsSinceHeartbeat: null,
      detail: "검사 worker 상태를 확인하지 못했다.",
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
       * 검사기가 살아 있는가.
       *
       * `promote`는 `scanned_clean`에서만 전이하므로, scan worker가 없는 배포에서
       * 업로드는 `quarantined`에 영원히 머문다. 그런데 그 정지는 **오류가 아니라
       * 대기처럼 보인다** — 화면이 "검사를 기다리는 중"과 "검사할 사람이 아예
       * 없음"을 구분하지 못했다.
       *
       * 조회 실패를 오류로 올리지 않는다. 목록은 나가야 하고, 알 수 없다는 것도
       * 하나의 상태다 — `unknown`이 그것이다.
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
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
          issues: parsed.error.issues,
        });
      }

      /**
       * 저장 경로 판정 — OD-17·OD-18.
       *
       * 권한 검사보다 **먼저** 본다. 권한이 있는 사람이 올리는 것과 이 저장소가
       * 받아도 되는 자료인가는 다른 질문이고, 뒤에 두면 "권한이 있으니 받는다"가
       * 된다.
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
        throw badRequest("UPLOAD_EMPTY", "빈 파일은 받지 않는다");
      }
      if (bytes.byteLength > MAX_UPLOAD_BYTES) {
        throw unprocessable("UPLOAD_TOO_LARGE", "업로드 상한을 넘었다", {
          maxBytes: String(MAX_UPLOAD_BYTES),
          receivedBytes: String(bytes.byteLength),
        });
      }

      const contentHash = computeContentHash(bytes);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          // 같은 내용이 이미 있으면 그것을 돌려준다. 두 번 저장하면 evidence가
          // 갈라지고 어느 쪽이 검토 대상인지 모르게 된다.
          const [existing] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads
            WHERE project_id = ${request.params.projectId} AND content_hash = ${contentHash}
          `;
          if (existing) return { ...toView(existing), requestId, asOf };

          const uploadId = randomUUID();
          // quarantine 경로다. evidence 경로는 승격될 때 만들어진다.
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
            // 파일명은 남기지 않는다. 감사 로그가 restricted 정보의 통로가 된다.
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
   * 검사 결과 기록.
   *
   * **검사 서비스가 호출하는 경로다.** 기본 구성에서는 `@mpc/worker`의 scan
   * worker가 DB를 직접 갱신하므로 이 route는 쓰이지 않는다. 외부 검사 서비스를
   * 붙일 때를 위해 남긴다.
   *
   * 화면에는 이 버튼이 없다. 운영자가 검사 결과를 만들 수 있으면 quarantine이
   * 형식만 남는다.
   *
   * `upload.scan_result`는 `scan_service` 역할만 갖는다. `source.upload`를
   * 재사용하면 파일을 올린 사람이 자기 파일을 통과시킬 수 있다.
   */
  /**
   * multipart 스트리밍 업로드.
   *
   * base64 경로와 같은 결과를 만들되 **파일을 메모리에 통째로 올리지 않는다.**
   * 대용량 증빙(도면·항공사진·전체 등록부 export)은 base64로 받을 수 없다.
   *
   * 두 경로가 남아 있는 이유: 브라우저 fetch로 JSON을 보내는 것이 단순하고
   * 작은 파일에는 충분하다. 큰 파일만 이쪽으로 온다.
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
      if (!file) throw badRequest("UPLOAD_MISSING_FILE", "multipart 파일 파트가 없다");

      // base64 경로와 같은 제한을 건다. 한쪽만 좁히면 넓은 쪽이 우회로가 된다.
      if (file.mimetype && !isAllowedContentType(file.mimetype)) {
        throw unprocessable("UPLOAD_CONTENT_TYPE_NOT_ALLOWED", "받지 않는 content type이다", {
          contentType: normalizeContentType(file.mimetype),
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      const uploadId = randomUUID();
      const key = quarantineKey(tenantId, uploadId);

      // 저장소에 먼저 쓴다. content hash를 알아야 중복을 판정할 수 있는데
      // 스트리밍에서는 다 읽어야 해시가 나온다.
      const stored = await store.putStream(
        key,
        file.file,
        file.mimetype ? normalizeContentType(file.mimetype) : "application/octet-stream",
      );

      if (file.file.truncated) {
        // 상한에 걸려 잘린 파일을 저장하면 내용이 다른 증빙이 남는다.
        throw unprocessable("UPLOAD_TOO_LARGE", "업로드 상한을 넘었다", {
          maxBytes: String(MAX_STREAM_BYTES),
        });
      }
      if (stored.byteSize === 0) throw badRequest("UPLOAD_EMPTY", "빈 파일은 받지 않는다");

      const requestHash = hashRequest({ contentHash: stored.contentHash });

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [existing] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads
            WHERE project_id = ${request.params.projectId}
              AND content_hash = ${stored.contentHash}
          `;
          // 같은 내용이 이미 있다. 방금 쓴 객체는 남지만 참조되지 않는다 —
          // 지우면 저장소 오류가 업로드 실패로 번진다.
          if (existing) return { ...toView(existing), requestId, asOf };

          const [row] = await tx<UploadRow[]>`
            INSERT INTO core.object_uploads (
              id, tenant_id, project_id, object_key, content_hash, byte_size,
              content_type, original_filename, sensitivity, state, uploaded_by
            ) VALUES (
              ${uploadId}, ${tenantId}, ${request.params.projectId}, ${key},
              ${stored.contentHash}, ${stored.byteSize}, ${stored.contentType},
              -- 스트리밍 경로는 항상 restricted다. 민감 등급을 받으려면
              -- secured route가 필요하고(OD-18), 그 경로는 아직 없다.
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
            // 파일명은 남기지 않는다. 감사 로그가 restricted 정보의 통로가 된다.
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
        throw badRequest("REQUEST_INVALID", "result는 clean 또는 infected여야 한다");
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
          if (!row) throw notFound("업로드를 찾을 수 없다");

          assertVersionMatches(expectedVersion, row.version, "object_upload");

          if (!canTransitionUpload(row.state, toState)) {
            throw conflict("INVALID_STATE_TRANSITION", "이 상태에서는 검사 결과를 기록할 수 없다", {
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
   * evidence 승격.
   *
   * quarantine 객체를 evidence 경로로 복사하고 artifact를 만든다. 원본은 지우지
   * 않는다 — "무엇이 승격됐는가"를 나중에 확인해야 한다.
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
          if (!row) throw notFound("업로드를 찾을 수 없다");

          assertVersionMatches(expectedVersion, row.version, "object_upload");

          // 감염 판정된 것은 여기 오지 않는다. 상태기계에 경로가 없다.
          if (!canTransitionUpload(row.state, "promoted")) {
            throw conflict("INVALID_STATE_TRANSITION", "검사를 통과한 업로드만 승격된다", {
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
   * 단기 다운로드 링크.
   *
   * 영구 URL을 만들지 않는다. 링크를 받은 사람은 우리 권한 검사를 다시 지나지
   * 않으므로, 그 사실을 응답에 함께 담는다 — 링크를 공유해도 된다고 오해하면
   * restricted 자료가 통제 밖으로 나간다.
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
          if (!row) throw notFound("업로드를 찾을 수 없다");

          // 감염 판정된 파일의 링크를 만들지 않는다. 검토자가 열어 볼 이유가 없다.
          if (row.state === "scanned_infected") {
            throw unprocessable("UPLOAD_INFECTED", "감염 판정된 파일은 내려받을 수 없다");
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
              "이 링크를 가진 사람은 로그인 없이 파일을 받을 수 있다. 공유하지 않는다.",
            requestId,
            asOf,
          };
        }),
      );
    },
  );
}
