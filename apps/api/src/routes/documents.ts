import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  createDocumentLinkRequest,
  createDocumentLinkRuleRequest,
  removeDocumentLinkRequest,
  resolveDocumentImpactsRequest,
  retireDocumentLinkRuleRequest,
  updateDocumentProfileRequest,
} from "@mpc/api-contract";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
} from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import {
  assertVersionMatches,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
  type EnrolledSession,
} from "./shared.js";
import { calendarDay, toUploadView, uploadProjectId, type UploadRow } from "./uploads.js";

/**
 * Document relations — declared links between documents and the impacts that travel along them.
 *
 * What this file holds to:
 *
 * - **An impact asks for a second look; it changes nothing.** No route here edits, rejects, or
 *   takes down a document. Closing an impact is a person's judgment and carries a reason.
 * - **Links are declared, not inferred.** There is no document type list to infer from, so a
 *   person links two documents or an operator declares a type rule.
 * - **Propagation lives in the database.** Promoting a new version and passing a validity date
 *   raise impacts through triggers and one sweep function (migration 0045), so no route can
 *   skip them. The routes here only call the per-document check right after they change
 *   something that could make a document count as expired.
 */

/** Files nobody relies on: they failed scanning or were rejected. */
const UNUSABLE_STATES: ReadonlySet<string> = new Set(["scanned_infected", "rejected"]);

interface LinkRow {
  readonly id: string;
  readonly project_id: string;
  readonly upstream_upload_id: string;
  readonly downstream_upload_id: string;
  readonly kind: string;
  readonly origin: string;
  readonly rule_id: string | null;
  readonly note: string | null;
  readonly created_by: string | null;
  readonly created_at: Date;
  readonly removed_at: Date | null;
  readonly removal_reason: string | null;
}

function toLinkView(row: LinkRow) {
  return {
    id: row.id,
    upstreamUploadId: row.upstream_upload_id,
    downstreamUploadId: row.downstream_upload_id,
    kind: row.kind,
    origin: row.origin,
    ruleId: row.rule_id,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    removedAt: row.removed_at?.toISOString() ?? null,
    removalReason: row.removal_reason,
  };
}

interface NodeRow {
  readonly id: string;
  readonly original_filename: string | null;
  readonly state: string;
  readonly document_type: string | null;
  readonly valid_until: string | null;
  readonly expired: boolean;
  readonly days_until_expiry: number | null;
  readonly supersedes_upload_id: string | null;
  readonly superseded_by: string | null;
  readonly open_impacts: number;
  readonly version: number;
}

function toNodeView(row: NodeRow) {
  return {
    uploadId: row.id,
    originalFilename: row.original_filename,
    state: row.state,
    documentType: row.document_type,
    validUntil: row.valid_until,
    expired: row.expired,
    daysUntilExpiry: row.days_until_expiry,
    supersedesUploadId: row.supersedes_upload_id,
    supersededByUploadId: row.superseded_by,
    openImpactCount: row.open_impacts,
    version: row.version,
  };
}

interface ImpactRow {
  readonly id: string;
  readonly project_id: string;
  readonly upload_id: string;
  readonly origin_upload_id: string;
  readonly successor_upload_id: string | null;
  readonly cause: string;
  readonly depth: number;
  readonly via_upload_id: string | null;
  readonly via_kind: string | null;
  readonly detected_at: Date;
  readonly resolution: string;
  readonly resolved_at: Date | null;
  readonly resolved_by: string | null;
  readonly revised_by_upload_id: string | null;
  readonly resolution_note: string | null;
}

/**
 * What can be done with an impact.
 *
 * The server says it so screens do not each guess from the state string. The expired document
 * itself (depth 0) has no link to call "not applicable".
 */
function impactNextActions(row: ImpactRow): string[] {
  if (row.resolution !== "open") return [];

  if (row.depth === 0) {
    return [
      "Upload a renewed version of this document",
      "Mark as no change needed — the reason is recorded",
    ];
  }

  return [
    "Upload a revised version of this document",
    "Mark as no change needed — the reason is recorded",
    "Mark as not applicable — then fix the link",
  ];
}

function toImpactView(row: ImpactRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    uploadId: row.upload_id,
    originUploadId: row.origin_upload_id,
    successorUploadId: row.successor_upload_id,
    cause: row.cause,
    depth: row.depth,
    viaUploadId: row.via_upload_id,
    viaKind: row.via_kind,
    detectedAt: row.detected_at.toISOString(),
    resolution: row.resolution,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolvedBy: row.resolved_by,
    revisedByUploadId: row.revised_by_upload_id,
    resolutionNote: row.resolution_note,
    nextActions: impactNextActions(row),
  };
}

interface RuleRow {
  readonly id: string;
  readonly upstream_type: string;
  readonly downstream_type: string;
  readonly kind: string;
  readonly note: string | null;
  readonly created_by: string;
  readonly created_at: Date;
  readonly retired_at: Date | null;
  readonly retirement_note: string | null;
}

function toRuleView(row: RuleRow) {
  return {
    id: row.id,
    upstreamType: row.upstream_type,
    downstreamType: row.downstream_type,
    kind: row.kind,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    retiredAt: row.retired_at?.toISOString() ?? null,
    retirementNote: row.retirement_note,
  };
}

/**
 * The person acting.
 *
 * Links, judgments, and rules record who made them. A session without a subject would store an
 * anonymous judgment, which is worse than refusing it.
 */
function requireSubject(session: EnrolledSession): string {
  if (!session.subjectId) {
    throw forbidden(
      "SUBJECT_REQUIRED",
      "This action records who took it, and this session has no person attached",
    );
  }
  return session.subjectId;
}

/** `2026-02-30` matches the pattern but is not a day. */
function isCalendarDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function pgError(error: unknown): { readonly code?: string; readonly constraint_name?: string } {
  return (error ?? {}) as { code?: string; constraint_name?: string };
}

/**
 * A link the database refused, in the terms the screen can act on.
 *
 * The route checks both cases before inserting; these are for the race where another request
 * got there first.
 */
function translateLinkError(error: unknown): unknown {
  const { code, constraint_name: constraint } = pgError(error);
  if (code === "23505") {
    return conflict("DOCUMENT_LINK_EXISTS", "These documents are already linked");
  }
  if (code === "23514" && constraint === "document_link_no_cycle") {
    return conflict(
      "DOCUMENT_LINK_CYCLE",
      "This link would make a document rest on itself through other documents",
    );
  }
  return error;
}

/** A profile change the database refused, in the same terms the route's own checks use. */
function translateProfileError(error: unknown): unknown {
  const { code, constraint_name: constraint } = pgError(error);
  if (code === "23505" && constraint === "object_uploads_one_live_successor") {
    return conflict(
      "DOCUMENT_ALREADY_REPLACED",
      "Another upload already replaces this document. Replace that one instead",
    );
  }
  if (code === "23514" && constraint === "upload_supersedes_no_loop") {
    return conflict("VERSION_LOOP", "That document is already a later version of this one");
  }
  return error;
}

async function linkProjectId(
  sql: postgres.Sql,
  tenantId: string,
  linkId: string,
): Promise<string> {
  const [row] = await withTenant(sql, { tenantId }, (tx) =>
    tx<{ project_id: string }[]>`
      SELECT project_id FROM core.document_links WHERE id = ${linkId}
    `,
  );
  if (!row) throw notFound("Link not found");
  return row.project_id;
}

/**
 * Can `row` be marked as the new version of `targetId`?
 *
 * Same project, a usable file, not already replaced by another live upload, and not a later
 * version of `row` itself — a version chain that loops has no latest version.
 */
async function assertReplaceable(
  tx: postgres.TransactionSql,
  row: UploadRow,
  targetId: string,
): Promise<void> {
  if (targetId === row.id) {
    throw unprocessable("SUPERSEDES_SELF", "A document cannot replace itself");
  }

  // Locked so two uploads naming the same document are decided one after the other: the
  // second then sees the first as the live successor instead of racing it to the unique index.
  const [target] = await tx<{ id: string; project_id: string; state: string }[]>`
    SELECT id, project_id, state FROM core.object_uploads WHERE id = ${targetId}
    FOR UPDATE
  `;
  if (!target || target.project_id !== row.project_id) {
    throw notFound("The document to replace was not found in this project");
  }
  if (UNUSABLE_STATES.has(target.state)) {
    throw conflict(
      "DOCUMENT_NOT_USABLE",
      "A file that failed scanning or was rejected is not a document anyone relies on",
      { uploadId: target.id, state: target.state },
    );
  }

  const [live] = await tx<{ id: string }[]>`
    SELECT id FROM core.object_uploads
    WHERE supersedes_upload_id = ${targetId}
      AND state NOT IN ('scanned_infected', 'rejected')
      AND id <> ${row.id}
  `;
  if (live) {
    throw conflict(
      "DOCUMENT_ALREADY_REPLACED",
      "Another upload already replaces this document. Replace that one instead",
      { replacedByUploadId: live.id },
    );
  }

  const [loop] = await tx<{ found: boolean }[]>`
    WITH RECURSIVE chain(id) AS (
      SELECT supersedes_upload_id FROM core.object_uploads WHERE id = ${targetId}
      UNION
      SELECT u.supersedes_upload_id
      FROM core.object_uploads u JOIN chain c ON u.id = c.id
      WHERE u.supersedes_upload_id IS NOT NULL
    )
    SELECT EXISTS (SELECT 1 FROM chain WHERE id = ${row.id}) AS found
  `;
  if (loop?.found) {
    throw conflict("VERSION_LOOP", "That document is already a later version of this one");
  }
}

/**
 * Expiry check for a document and for everything above it.
 *
 * After a link is added or a validity date changes, an expired document may now have something
 * resting on it — possibly several links down. The sweep would find it within the hour; checking
 * here makes it visible at once. Checking an ancestor that turns out not to reach this document
 * costs a query and records nothing: the per-document check walks its own links.
 */
async function checkExpiryAround(tx: postgres.TransactionSql, uploadId: string): Promise<void> {
  await tx`
    WITH RECURSIVE above(upload_id, depth) AS (
      SELECT ${uploadId}::uuid, 0
      UNION
      SELECT l.upstream_upload_id, a.depth + 1
      FROM core.document_links l
      JOIN above a ON l.downstream_upload_id = a.upload_id
      WHERE l.removed_at IS NULL AND a.depth < 64
    )
    SELECT core.detect_document_expiry(d.upload_id, current_date)
    FROM (SELECT DISTINCT upload_id FROM above) d
  `;
}

export async function registerDocumentRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.patch<{ Params: { uploadId: string } }>(
    "/api/v1/uploads/:uploadId/document-profile",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expectedVersion = requireIfMatch(request);

      const parsed = updateDocumentProfileRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const changes = parsed.data;
      if (Object.keys(changes).length === 0) {
        throw badRequest(
          "REQUEST_INVALID",
          "Send at least one of documentType, validUntil, supersedesUploadId",
        );
      }
      if (changes.validUntil && !isCalendarDate(changes.validUntil)) {
        throw badRequest("REQUEST_INVALID", "validUntil is not a calendar day", {
          validUntil: changes.validUntil,
        });
      }

      const projectId = await uploadProjectId(sql, tenantId, request.params.uploadId);
      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const subjectId = requireSubject(session);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [row] = await tx<UploadRow[]>`
            SELECT * FROM core.object_uploads WHERE id = ${request.params.uploadId}
            FOR UPDATE
          `;
          if (!row) throw notFound("Upload not found");

          assertVersionMatches(expectedVersion, row.version, "object_upload");

          if (UNUSABLE_STATES.has(row.state)) {
            throw conflict(
              "DOCUMENT_NOT_USABLE",
              "A file that failed scanning or was rejected is not a document anyone relies on",
              { uploadId: row.id, state: row.state },
            );
          }

          const nextType =
            changes.documentType !== undefined ? changes.documentType : row.document_type;
          const nextValidUntil =
            changes.validUntil !== undefined ? changes.validUntil : calendarDay(row.valid_until);
          let nextSupersedes = row.supersedes_upload_id;

          if (
            changes.supersedesUploadId !== undefined &&
            changes.supersedesUploadId !== row.supersedes_upload_id
          ) {
            if (row.supersedes_upload_id !== null) {
              throw conflict(
                "SUPERSEDES_ALREADY_SET",
                "Which document this upload replaces is already set. Upload a new version instead",
                { supersedesUploadId: row.supersedes_upload_id },
              );
            }
            await assertReplaceable(tx, row, changes.supersedesUploadId);
            nextSupersedes = changes.supersedesUploadId;
          }

          // When this upload is already promoted and now names what it replaces, the update
          // itself makes the new version take effect (trigger `object_uploads_apply_supersede`).
          let updated: UploadRow | undefined;
          try {
            [updated] = await tx<UploadRow[]>`
              UPDATE core.object_uploads
              SET document_type = ${nextType},
                  valid_until = ${nextValidUntil}::date,
                  supersedes_upload_id = ${nextSupersedes},
                  version = version + 1
              WHERE id = ${row.id}
              RETURNING *
            `;
          } catch (error) {
            throw translateProfileError(error);
          }

          let linksFromRules = 0;
          if (updated!.document_type !== null && updated!.document_type !== row.document_type) {
            const [applied] = await tx<{ created: number }[]>`
              SELECT core.apply_document_link_rules_for(${row.id}, ${subjectId}) AS created
            `;
            linksFromRules = applied?.created ?? 0;
          }

          await checkExpiryAround(tx, row.id);

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId: row.project_id,
            session,
            command: "upload.document_profile_updated",
            resourceType: "object_upload",
            resourceId: row.id,
            beforeVersion: row.version,
            afterVersion: row.version + 1,
            correlationId,
            requestIp: request.ip,
            // Which fields changed, not their values: the type is the uploader's own words, and
            // the audit log is not a place for document descriptions.
            detail: {
              fields: Object.keys(changes),
              supersedesUploadId: nextSupersedes,
              linksFromRules,
            },
          });

          return { ...toUploadView(updated!), requestId, asOf };
        }),
      );
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/document-graph",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { projectId } = request.params;

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const { requestId, asOf } = request.context;

      const { nodes, links } = await withTenant(sql, { tenantId }, async (tx) => {
        const nodeRows = await tx<NodeRow[]>`
          SELECT u.id, u.original_filename, u.state::text AS state, u.document_type,
                 to_char(u.valid_until, 'YYYY-MM-DD') AS valid_until,
                 coalesce(u.valid_until < current_date, false) AS expired,
                 (u.valid_until - current_date) AS days_until_expiry,
                 u.supersedes_upload_id,
                 core.document_successor(u.id) AS superseded_by,
                 (SELECT count(*)::int FROM core.document_impacts i
                   WHERE i.upload_id = u.id AND i.resolution = 'open') AS open_impacts,
                 u.version
          FROM core.object_uploads u
          WHERE u.project_id = ${projectId}
          ORDER BY u.uploaded_at DESC
          LIMIT 500
        `;
        const linkRows = await tx<LinkRow[]>`
          SELECT * FROM core.document_links
          WHERE project_id = ${projectId} AND removed_at IS NULL
          ORDER BY created_at
        `;
        return { nodes: nodeRows, links: linkRows };
      });

      return {
        nodes: nodes.map(toNodeView),
        links: links.map(toLinkView),
        requestId,
        asOf,
      };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/document-links",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createDocumentLinkRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const { upstreamUploadId, downstreamUploadId, kind, note } = parsed.data;
      const { projectId } = request.params;

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const subjectId = requireSubject(session);

      if (upstreamUploadId === downstreamUploadId) {
        throw unprocessable("DOCUMENT_LINK_SELF", "A document cannot rest on itself");
      }

      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const ends = await tx<
            { id: string; project_id: string; state: string; successor: string | null }[]
          >`
            SELECT id, project_id, state::text AS state, core.document_successor(id) AS successor
            FROM core.object_uploads
            WHERE id IN (${upstreamUploadId}, ${downstreamUploadId})
          `;

          for (const uploadId of [upstreamUploadId, downstreamUploadId]) {
            const end = ends.find((candidate) => candidate.id === uploadId);
            if (!end || end.project_id !== projectId) {
              throw notFound("Document not found in this project");
            }
            if (UNUSABLE_STATES.has(end.state)) {
              throw conflict(
                "DOCUMENT_NOT_USABLE",
                "A file that failed scanning or was rejected is not a document anyone relies on",
                { uploadId, state: end.state },
              );
            }
            // Links on a replaced version would move nowhere; the current version is the one
            // people rely on.
            if (end.successor) {
              throw conflict(
                "DOCUMENT_REPLACED",
                "This document was replaced by a newer version. Link the current version instead",
                { uploadId, currentUploadId: end.successor },
              );
            }
          }

          const [existing] = await tx<LinkRow[]>`
            SELECT * FROM core.document_links
            WHERE upstream_upload_id = ${upstreamUploadId}
              AND downstream_upload_id = ${downstreamUploadId}
              AND removed_at IS NULL
          `;
          if (existing) {
            throw conflict(
              "DOCUMENT_LINK_EXISTS",
              "These documents are already linked. Remove the link first to change its kind",
              { linkId: existing.id, kind: existing.kind },
            );
          }

          if (kind === "depends_on") {
            const [cycle] = await tx<{ found: boolean }[]>`
              SELECT core.document_link_would_cycle(${upstreamUploadId}, ${downstreamUploadId})
                AS found
            `;
            if (cycle?.found) {
              throw conflict(
                "DOCUMENT_LINK_CYCLE",
                "This link would make a document rest on itself through other documents",
              );
            }
          }

          let created: LinkRow | undefined;
          try {
            [created] = await tx<LinkRow[]>`
              INSERT INTO core.document_links (
                tenant_id, project_id, upstream_upload_id, downstream_upload_id, kind, origin,
                note, created_by
              ) VALUES (
                ${tenantId}, ${projectId}, ${upstreamUploadId}, ${downstreamUploadId}, ${kind},
                'user', ${note}, ${subjectId}
              )
              RETURNING *
            `;
          } catch (error) {
            throw translateLinkError(error);
          }

          await checkExpiryAround(tx, downstreamUploadId);

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "document_link.created",
            resourceType: "document_link",
            resourceId: created!.id,
            correlationId,
            requestIp: request.ip,
            detail: { kind, upstreamUploadId, downstreamUploadId },
          });

          return { ...toLinkView(created!), requestId, asOf };
        }),
      );
    },
  );

  app.post<{ Params: { linkId: string } }>(
    "/api/v1/document-links/:linkId/removal",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = removeDocumentLinkRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "A reason is required to remove a link", {
          issues: parsed.error.issues,
        });
      }

      const projectId = await linkProjectId(sql, tenantId, request.params.linkId);
      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const subjectId = requireSubject(session);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [current] = await tx<LinkRow[]>`
            SELECT * FROM core.document_links WHERE id = ${request.params.linkId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Link not found");
          if (current.removed_at !== null) {
            throw conflict("DOCUMENT_LINK_ALREADY_REMOVED", "This link was already removed", {
              removedAt: current.removed_at.toISOString(),
            });
          }

          const [removed] = await tx<LinkRow[]>`
            UPDATE core.document_links
            SET removed_at = now(), removed_by = ${subjectId},
                removal_reason = ${parsed.data.reason}
            WHERE id = ${current.id}
            RETURNING *
          `;

          /**
           * Impacts already raised through this link stay open. They were right when raised;
           * removing the link says it should not carry the next change, not that the last one
           * never happened.
           */
          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "document_link.removed",
            resourceType: "document_link",
            resourceId: current.id,
            correlationId,
            requestIp: request.ip,
            reason: parsed.data.reason,
            detail: {
              kind: current.kind,
              upstreamUploadId: current.upstream_upload_id,
              downstreamUploadId: current.downstream_upload_id,
            },
          });

          return { ...toLinkView(removed!), requestId, asOf };
        }),
      );
    },
  );

  app.get<{ Params: { uploadId: string } }>(
    "/api/v1/uploads/:uploadId/impact-preview",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const projectId = await uploadProjectId(sql, tenantId, request.params.uploadId);

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const { requestId, asOf } = request.context;

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<{ upload_id: string; depth: number; via_upload_id: string; via_kind: string }[]>`
          SELECT t.upload_id, t.depth, t.via_upload_id, t.via_kind::text AS via_kind
          FROM core.document_impact_targets(${request.params.uploadId}) t
          JOIN core.object_uploads target ON target.id = t.upload_id
          WHERE target.state NOT IN ('scanned_infected', 'rejected')
          ORDER BY t.depth, t.upload_id
        `,
      );

      return {
        uploadId: request.params.uploadId,
        items: rows.map((row) => ({
          uploadId: row.upload_id,
          depth: row.depth,
          viaUploadId: row.via_upload_id,
          viaKind: row.via_kind,
        })),
        requestId,
        asOf,
      };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/document-impacts",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { projectId } = request.params;

      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const { requestId, asOf } = request.context;

      const { rows, openCount } = await withTenant(sql, { tenantId }, async (tx) => {
        const impactRows = await tx<ImpactRow[]>`
          SELECT * FROM core.document_impacts
          WHERE project_id = ${projectId}
          -- Open ones first. Judged ones stay listed: how the last change was judged is the
          -- best guide to judging the next one.
          ORDER BY (resolution = 'open') DESC, detected_at DESC, depth
          LIMIT 500
        `;
        const [count] = await tx<{ open: number }[]>`
          SELECT count(*)::int AS open FROM core.document_impacts
          WHERE project_id = ${projectId} AND resolution = 'open'
        `;
        return { rows: impactRows, openCount: count?.open ?? 0 };
      });

      return { items: rows.map(toImpactView), openCount, requestId, asOf };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/document-impacts/resolutions",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = resolveDocumentImpactsRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const { projectId } = request.params;

      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const subjectId = requireSubject(session);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);
      const ids = [...new Set(parsed.data.impactIds)];

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const rows = await tx<ImpactRow[]>`
            SELECT * FROM core.document_impacts
            WHERE id = ANY(${ids}::uuid[]) AND project_id = ${projectId}
            ORDER BY id
            FOR UPDATE
          `;

          // All or nothing. A partial success would leave the screen unsure which were judged.
          if (rows.length !== ids.length) {
            const found = new Set(rows.map((row) => row.id));
            throw unprocessable(
              "DOCUMENT_IMPACT_NOT_FOUND",
              "Some impacts were not found in this project. Nothing was changed",
              { missing: ids.filter((id) => !found.has(id)) },
            );
          }

          const closed = rows.filter((row) => row.resolution !== "open");
          if (closed.length > 0) {
            throw conflict(
              "DOCUMENT_IMPACT_ALREADY_RESOLVED",
              "Some impacts are already closed, and a closed judgment is not reopened. Nothing was changed",
              { impactIds: closed.map((row) => row.id) },
            );
          }

          if (parsed.data.resolution === "not_applicable") {
            const selfRows = rows.filter((row) => row.depth === 0);
            if (selfRows.length > 0) {
              throw unprocessable(
                "NO_LINK_TO_JUDGE",
                "An expired document itself has no link to call not applicable. Nothing was changed",
                { impactIds: selfRows.map((row) => row.id) },
              );
            }
          }

          const updated = await tx<ImpactRow[]>`
            UPDATE core.document_impacts
            SET resolution = ${parsed.data.resolution},
                resolved_at = now(),
                resolved_by = ${subjectId},
                resolution_note = ${parsed.data.note}
            WHERE id = ANY(${ids}::uuid[])
            RETURNING *
          `;

          for (const row of updated) {
            await recordAudit(tx, {
              effectiveRole,
              tenantId,
              projectId,
              session,
              command: "document_impact.resolved",
              resourceType: "document_impact",
              resourceId: row.id,
              correlationId,
              requestIp: request.ip,
              reason: parsed.data.note,
              detail: {
                resolution: parsed.data.resolution,
                cause: row.cause,
                uploadId: row.upload_id,
              },
            });
          }

          return { items: updated.map(toImpactView), requestId, asOf };
        }),
      );
    },
  );

  app.get("/api/v1/document-link-rules", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    // Rules are configuration, not evidence; anyone who works in the Data Room may see which
    // links arrive on their own.
    assertAuthorized(
      session,
      "evidence.read",
      tenantResource(tenantId, { sensitivity: "public" }),
      sessionFacts(session),
    );
    const { requestId, asOf } = request.context;

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<RuleRow[]>`
        SELECT * FROM core.document_link_rules
        ORDER BY (retired_at IS NULL) DESC, created_at DESC
      `,
    );

    return { items: rows.map(toRuleView), requestId, asOf };
  });

  app.post("/api/v1/document-link-rules", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);

    const parsed = createDocumentLinkRuleRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    const effectiveRole = assertAuthorized(
      session,
      "document.rule.manage",
      tenantResource(tenantId, { sensitivity: "public" }),
      sessionFacts(session),
    );
    const subjectId = requireSubject(session);
    const { requestId, asOf, correlationId } = request.context;
    const requestHash = hashRequest(request.body);
    const { upstreamType, downstreamType, kind, note } = parsed.data;

    if (upstreamType.toLowerCase() === downstreamType.toLowerCase()) {
      throw unprocessable(
        "DOCUMENT_LINK_RULE_SAME_TYPE",
        "A type cannot rest on itself; the rule would have no direction",
      );
    }

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        let rule: RuleRow | undefined;
        try {
          [rule] = await tx<RuleRow[]>`
            INSERT INTO core.document_link_rules (
              tenant_id, upstream_type, downstream_type, kind, note, created_by
            ) VALUES (
              ${tenantId}, ${upstreamType}, ${downstreamType}, ${kind}, ${note}, ${subjectId}
            )
            RETURNING *
          `;
        } catch (error) {
          if (pgError(error).code === "23505") {
            throw conflict(
              "DOCUMENT_LINK_RULE_EXISTS",
              "An active rule already links these two types. Retire it first to change its kind",
            );
          }
          throw error;
        }

        // The rule takes effect now, on the documents already typed. Waiting for the next upload
        // would leave the operator unable to see what the rule does.
        const [applied] = await tx<{ created: number }[]>`
          SELECT core.apply_document_link_rule(${rule!.id}, ${subjectId}, NULL) AS created
        `;
        const linksCreated = applied?.created ?? 0;

        // Walk above each new link's upstream end, as `checkExpiryAround` does: an expired
        // ancestor further up now reaches the new downstream document too.
        await tx`
          WITH RECURSIVE above(upload_id, depth) AS (
            SELECT DISTINCT upstream_upload_id, 0 FROM core.document_links
            WHERE rule_id = ${rule!.id} AND removed_at IS NULL
            UNION
            SELECT l.upstream_upload_id, a.depth + 1
            FROM core.document_links l
            JOIN above a ON l.downstream_upload_id = a.upload_id
            WHERE l.removed_at IS NULL AND a.depth < 64
          )
          SELECT core.detect_document_expiry(d.upload_id, current_date)
          FROM (SELECT DISTINCT upload_id FROM above) d
        `;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          session,
          command: "document_link_rule.created",
          resourceType: "document_link_rule",
          resourceId: rule!.id,
          correlationId,
          requestIp: request.ip,
          detail: { kind, linksCreated },
        });

        return { ...toRuleView(rule!), linksCreated, requestId, asOf };
      }),
    );
  });

  app.post<{ Params: { ruleId: string } }>(
    "/api/v1/document-link-rules/:ruleId/retirement",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = retireDocumentLinkRuleRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "A note is required to retire a rule", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "document.rule.manage",
        tenantResource(tenantId, { sensitivity: "public" }),
        sessionFacts(session),
      );
      const subjectId = requireSubject(session);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request.body);

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [current] = await tx<RuleRow[]>`
            SELECT * FROM core.document_link_rules WHERE id = ${request.params.ruleId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Rule not found");
          if (current.retired_at !== null) {
            throw conflict("DOCUMENT_LINK_RULE_ALREADY_RETIRED", "This rule was already retired");
          }

          const [retired] = await tx<RuleRow[]>`
            UPDATE core.document_link_rules
            SET retired_at = now(), retired_by = ${subjectId},
                retirement_note = ${parsed.data.note}
            WHERE id = ${current.id}
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "document_link_rule.retired",
            resourceType: "document_link_rule",
            resourceId: current.id,
            correlationId,
            requestIp: request.ip,
            reason: parsed.data.note,
          });

          return { ...toRuleView(retired!), requestId, asOf };
        }),
      );
    },
  );
}
