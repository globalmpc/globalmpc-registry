import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { revokeDocumentRequest } from "@mpc/api-contract";
import { badRequest, conflict, notFound } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  visibleProjectScope,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
  type EnrolledSession,
} from "./shared.js";
import { requireSubject } from "./documents.js";
import { toUploadView, uploadProjectId, type UploadRow } from "./uploads.js";

/**
 * Document revocation — the correction and revocation journey of spec 03.
 *
 * What this route holds to:
 *
 * - **Kept, marked, never deleted.** The upload stays with its hash and history; revocation sets
 *   who, when and why once (migration 0072 refuses to unset or edit it). A mistake is corrected
 *   by uploading a new version of the revoked document, not by undoing the revocation.
 * - **Propagation lives in the database.** Setting the revocation raises `revoked` impacts on
 *   what rests on the document and marks the claims verified against it stale, through a trigger,
 *   so no path can revoke without it. The route reads back how many were raised.
 * - **Only a promoted document is revoked.** An unscanned, infected or rejected file was never
 *   something anyone relied on.
 * - **Same permission as a new version.** Replacing and revoking are the two ways spec 03 takes a
 *   document out of use, and replacing already rides on `source.upload`. A separate, narrower
 *   permission would push the people who hold a wrong document towards replacing it with any
 *   file instead of saying why it is wrong.
 * - **Not found means not visible.** Someone who cannot read the project gets the same 404 as for
 *   an id that does not exist, so a revoke attempt does not confirm that a document exists.
 */

/** Same answer for "no such id", "another tenant" and "a project you cannot read". */
const NOT_FOUND_MESSAGE = "Upload not found";

/**
 * Whether the session can read documents of `projectId` at all.
 *
 * Checked before the revoke permission: a 403 there would carry the project's access-request
 * path and so confirm that the document exists in a project the caller cannot see.
 */
function canSeeProject(session: EnrolledSession, projectId: string): boolean {
  const scope = visibleProjectScope(session, "evidence.read");
  return scope === "all" || scope.includes(projectId);
}

export async function registerDocumentRevocationRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.post<{ Params: { uploadId: string } }>("/api/v1/uploads/:uploadId/revoke", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const expectedVersion = requireIfMatch(request);

    const parsed = revokeDocumentRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "A reason is required to revoke a document", {
        issues: parsed.error.issues,
      });
    }
    const { reason } = parsed.data;

    // Authorization runs outside the transaction: an idempotent replay returns the stored
    // response as is, so inside it a replay of someone else's key would skip the check.
    const projectId = await uploadProjectId(sql, tenantId, request.params.uploadId);
    if (!canSeeProject(session, projectId)) throw notFound(NOT_FOUND_MESSAGE);

    const effectiveRole = assertAuthorized(
      session,
      "source.upload",
      projectResource(tenantId, projectId),
      sessionFacts(session),
    );
    const subjectId = requireSubject(session);
    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request);

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        // Locked so a concurrent revocation or replacement naming this document waits for it.
        // `assertReplaceable` takes the same row lock before marking a new version.
        const [row] = await tx<UploadRow[]>`
          SELECT * FROM core.object_uploads WHERE id = ${request.params.uploadId}
          FOR UPDATE
        `;
        if (!row) throw notFound(NOT_FOUND_MESSAGE);

        // Checked before the version: a second revocation bumps nothing, and "already revoked"
        // tells the caller more than "stale version".
        if (row.revoked_at !== null) {
          throw conflict("DOCUMENT_ALREADY_REVOKED", "This document was already revoked", {
            uploadId: row.id,
            revokedAt: row.revoked_at.toISOString(),
          });
        }
        if (row.state !== "promoted") {
          throw conflict(
            "DOCUMENT_NOT_REVOCABLE",
            "Only a promoted document can be revoked. A file that has not been promoted is rejected, not revoked",
            { uploadId: row.id, state: row.state },
          );
        }

        assertVersionMatches(expectedVersion, row.version, "object_upload");

        // The update itself raises the impacts (trigger `object_uploads_apply_revocation`).
        const [updated] = await tx<UploadRow[]>`
          UPDATE core.object_uploads
          SET revoked_at = now(), revoked_by = ${subjectId}, revocation_reason = ${reason},
              version = version + 1
          WHERE id = ${row.id}
          RETURNING *
        `;

        const [raised] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM core.document_impacts
          WHERE origin_upload_id = ${row.id} AND cause = 'revoked'
        `;
        const impactsRecorded = raised?.count ?? 0;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          projectId: row.project_id,
          session,
          command: "upload.revoked",
          resourceType: "object_upload",
          resourceId: row.id,
          beforeVersion: row.version,
          afterVersion: row.version + 1,
          correlationId,
          requestIp: request.clientIp,
          reason,
          detail: {
            impactsRecorded,
            supersedesUploadId: row.supersedes_upload_id,
          },
        });

        // 07 §7.4 `evidence.version.revoked`. The reason stays in the audit log; the event
        // carries identifiers only.
        await enqueueEvent(tx, {
          tenantId,
          eventType: "evidence.version.revoked",
          aggregateId: row.id,
          aggregateVersion: row.version + 1,
          projectId: row.project_id,
          payload: { contentHash: row.content_hash, impactsRecorded },
          correlationId,
        });

        return { ...toUploadView(updated!), impactsRecorded, requestId, asOf };
      }),
    );
  });
}
