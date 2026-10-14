import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  createDocumentRequirementRequest,
  documentListQuery,
  retireDocumentRequirementRequest,
} from "@mpc/api-contract";
import {
  requirementStatus,
  summarizeTiers,
  type DocumentRequirementTier,
} from "@mpc/domain";
import { badRequest, conflict, notFound } from "../errors.js";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { CURSOR_TIME_FORMAT, decodeKeysetCursor, encodeKeysetCursor } from "../list-window.js";
import { requireSubject } from "./documents.js";
import { requireMutationContext, requireReadContext } from "./shared.js";

/**
 * Document status — which document types a project expects, and where its documents stand.
 *
 * What this file holds to:
 *
 * - **Nothing is required by default.** There is no settled catalog of document types (OD-46);
 *   the people who run the project's Data Room declare the types they expect.
 * - **One definition of "expired" and "replaced".** Both the summary and the list read the
 *   `core.document_status` view (migration 0071), so they cannot disagree.
 * - **Nothing stops silently at a fixed size.** A project can hold thousands of documents: the
 *   summary is counted in the database, the list pages with a cursor, and the one capped
 *   section says when it was cut.
 */

/** Undeclared types shown in the summary. The rest are reachable through the list filter. */
const UNDECLARED_TYPE_LIMIT = 200;
/** Current documents closest to expiry shown in the summary. */
const NEXT_EXPIRY_LIMIT = 10;

interface RequirementRow {
  readonly id: string;
  readonly project_id: string;
  readonly document_type: string;
  readonly tier: DocumentRequirementTier;
  readonly note: string | null;
  readonly created_by: string;
  readonly created_at: Date;
  readonly retired_at: Date | null;
  readonly retirement_note: string | null;
}

function toRequirementView(row: RequirementRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    documentType: row.document_type,
    tier: row.tier,
    note: row.note,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    retiredAt: row.retired_at?.toISOString() ?? null,
    retirementNote: row.retirement_note,
  };
}

function parseQuery<T>(
  schema: { safeParse(input: unknown): { success: boolean; data?: T; error?: { issues: unknown[] } } },
  input: unknown,
): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success || parsed.data === undefined) {
    throw badRequest("INVALID_QUERY", "Query parameters do not match the contract", {
      issues: parsed.error?.issues ?? [],
    });
  }
  return parsed.data;
}

/**
 * Plan each status query for the project it is asked about.
 *
 * The driver prepares statements, and after a few runs PostgreSQL may switch a prepared
 * statement to one generic plan that ignores the parameter values. Measured on a
 * 10,000-document project, list pages went from ~7 ms to ~28 ms from the seventh request on;
 * an earlier form of the list query went to ~8 s. `SET LOCAL` keeps the change inside this
 * transaction.
 */
async function planForThisProject(tx: postgres.TransactionSql) {
  await tx`SET LOCAL plan_cache_mode = force_custom_plan`;
}

async function assertProjectExists(tx: postgres.TransactionSql, projectId: string) {
  const [project] = await tx<{ id: string }[]>`
    SELECT id FROM core.projects WHERE id = ${projectId}
  `;
  // An empty summary for a project that does not exist would read as "nothing uploaded yet".
  if (!project) throw notFound("Project not found");
}

export async function registerDocumentStatusRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/document-requirements",
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

      const rows = await withTenant(sql, { tenantId }, async (tx) => {
        await assertProjectExists(tx, projectId);
        return tx<RequirementRow[]>`
          SELECT * FROM core.document_requirements
          WHERE project_id = ${projectId} AND retired_at IS NULL
          ORDER BY tier, lower(document_type)
        `;
      });

      return { items: rows.map(toRequirementView), requestId, asOf };
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/document-requirements",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = createDocumentRequirementRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      const { projectId } = request.params;

      // The people who run the Data Room decide what it should hold — the same action that
      // lets them link documents.
      const effectiveRole = assertAuthorized(
        session,
        "source.upload",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const subjectId = requireSubject(session);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);
      const { documentType, tier, note } = parsed.data;

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          await assertProjectExists(tx, projectId);

          // Checked before inserting so the answer names the declaration in the way. The unique
          // index still decides a race between two requests.
          const [existing] = await tx<RequirementRow[]>`
            SELECT * FROM core.document_requirements
            WHERE project_id = ${projectId} AND retired_at IS NULL
              AND lower(document_type) = lower(${documentType})
          `;
          if (existing) {
            throw conflict(
              "DOCUMENT_REQUIREMENT_EXISTS",
              "This type is already declared. Retire it first to change its tier",
              { requirementId: existing.id, tier: existing.tier },
            );
          }

          let created: RequirementRow | undefined;
          try {
            [created] = await tx<RequirementRow[]>`
              INSERT INTO core.document_requirements (
                tenant_id, project_id, document_type, tier, note, created_by
              ) VALUES (
                ${tenantId}, ${projectId}, ${documentType}, ${tier}, ${note}, ${subjectId}
              )
              RETURNING *
            `;
          } catch (error) {
            if ((error as { code?: string }).code === "23505") {
              throw conflict(
                "DOCUMENT_REQUIREMENT_EXISTS",
                "This type is already declared. Retire it first to change its tier",
              );
            }
            throw error;
          }

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "document_requirement.declared",
            resourceType: "document_requirement",
            resourceId: created!.id,
            projectId,
            correlationId,
            requestIp: request.clientIp,
            detail: { projectId, documentType: created!.document_type, tier },
          });

          return { ...toRequirementView(created!), requestId, asOf };
        }),
      );
    },
  );

  app.post<{ Params: { requirementId: string } }>(
    "/api/v1/document-requirements/:requirementId/retirement",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = retireDocumentRequirementRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "A reason is required to retire a requirement", {
          issues: parsed.error.issues,
        });
      }
      const { requirementId } = request.params;
      const subjectId = requireSubject(session);
      const { requestId, asOf, correlationId } = request.context;
      const requestHash = hashRequest(request);

      return withTenant(sql, { tenantId }, async (tx) => {
        // Authorized against the requirement's own project, which the path does not carry, and
        // before the idempotency lookup so a replay never answers someone without the permission.
        const [target] = await tx<{ project_id: string }[]>`
          SELECT project_id FROM core.document_requirements WHERE id = ${requirementId}
        `;
        if (!target) throw notFound("Requirement not found");
        const effectiveRole = assertAuthorized(
          session,
          "source.upload",
          projectResource(tenantId, target.project_id),
          sessionFacts(session),
        );

        return withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
          const [current] = await tx<RequirementRow[]>`
            SELECT * FROM core.document_requirements WHERE id = ${requirementId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Requirement not found");

          if (current.retired_at !== null) {
            throw conflict(
              "DOCUMENT_REQUIREMENT_ALREADY_RETIRED",
              "This requirement was already retired",
            );
          }

          const [retired] = await tx<RequirementRow[]>`
            UPDATE core.document_requirements
            SET retired_at = now(), retired_by = ${subjectId},
                retirement_note = ${parsed.data.reason}
            WHERE id = ${current.id}
            RETURNING *
          `;

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            session,
            command: "document_requirement.retired",
            resourceType: "document_requirement",
            resourceId: current.id,
            projectId: current.project_id,
            correlationId,
            requestIp: request.clientIp,
            reason: parsed.data.reason,
            detail: { documentType: current.document_type, tier: current.tier },
          });

          return { ...toRequirementView(retired!), requestId, asOf };
        });
      });
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/document-status",
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

      const summary = await withTenant(sql, { tenantId }, async (tx) => {
        await planForThisProject(tx);
        await assertProjectExists(tx, projectId);

        const [totals] = await tx<
          {
            today: string;
            all: number;
            current: number;
            expired: number;
            superseded: number;
            pending: number;
            unusable: number;
            untyped: number;
            without_valid_until: number;
          }[]
        >`
          SELECT to_char(current_date, 'YYYY-MM-DD') AS today,
                 count(*)::int AS all,
                 count(*) FILTER (WHERE status = 'current')::int AS current,
                 count(*) FILTER (WHERE status = 'expired')::int AS expired,
                 count(*) FILTER (WHERE status = 'superseded')::int AS superseded,
                 count(*) FILTER (WHERE status = 'pending')::int AS pending,
                 count(*) FILTER (WHERE status = 'unusable')::int AS unusable,
                 count(*) FILTER (
                   WHERE status IN ('current', 'expired') AND document_type IS NULL
                 )::int AS untyped,
                 count(*) FILTER (
                   WHERE status = 'current' AND valid_until IS NULL
                 )::int AS without_valid_until
          FROM core.document_status
          WHERE project_id = ${projectId}
        `;

        const [impacts] = await tx<{ open: number }[]>`
          SELECT count(*)::int AS open FROM core.document_impacts
          WHERE project_id = ${projectId} AND resolution = 'open'
        `;

        const requirements = await tx<
          (RequirementRow & {
            current_count: number;
            expired_count: number;
            pending_count: number;
            superseded_count: number;
            nearest_valid_until: string | null;
            days_until_expiry: number | null;
          })[]
        >`
          WITH by_type AS (
            SELECT type_key,
                   count(*) FILTER (WHERE status = 'current')::int AS current_count,
                   count(*) FILTER (WHERE status = 'expired')::int AS expired_count,
                   count(*) FILTER (WHERE status = 'pending')::int AS pending_count,
                   count(*) FILTER (WHERE status = 'superseded')::int AS superseded_count,
                   min(valid_until) FILTER (WHERE status = 'current') AS nearest_valid_until
            FROM core.document_status
            WHERE project_id = ${projectId} AND type_key IS NOT NULL
            GROUP BY type_key
          )
          SELECT r.*,
                 coalesce(b.current_count, 0) AS current_count,
                 coalesce(b.expired_count, 0) AS expired_count,
                 coalesce(b.pending_count, 0) AS pending_count,
                 coalesce(b.superseded_count, 0) AS superseded_count,
                 to_char(b.nearest_valid_until, 'YYYY-MM-DD') AS nearest_valid_until,
                 (b.nearest_valid_until - current_date) AS days_until_expiry
          FROM core.document_requirements r
          LEFT JOIN by_type b ON b.type_key = lower(r.document_type)
          WHERE r.project_id = ${projectId} AND r.retired_at IS NULL
          ORDER BY r.tier, lower(r.document_type)
        `;

        const undeclared = await tx<
          {
            document_type: string;
            current_count: number;
            expired_count: number;
            superseded_count: number;
            pending_count: number;
          }[]
        >`
          SELECT min(d.document_type) AS document_type,
                 count(*) FILTER (WHERE d.status = 'current')::int AS current_count,
                 count(*) FILTER (WHERE d.status = 'expired')::int AS expired_count,
                 count(*) FILTER (WHERE d.status = 'superseded')::int AS superseded_count,
                 count(*) FILTER (WHERE d.status = 'pending')::int AS pending_count
          FROM core.document_status d
          WHERE d.project_id = ${projectId} AND d.type_key IS NOT NULL
            AND d.status <> 'unusable'
            AND NOT EXISTS (
              SELECT 1 FROM core.document_requirements r
              WHERE r.project_id = ${projectId} AND r.retired_at IS NULL
                AND lower(r.document_type) = d.type_key
            )
          GROUP BY d.type_key
          ORDER BY count(*) DESC, d.type_key
          LIMIT ${UNDECLARED_TYPE_LIMIT + 1}
        `;

        const nextExpiries = await tx<
          { upload_id: string; document_type: string | null; valid_until: string; days: number }[]
        >`
          SELECT upload_id, document_type,
                 to_char(valid_until, 'YYYY-MM-DD') AS valid_until,
                 days_until_expiry AS days
          FROM core.document_status
          WHERE project_id = ${projectId} AND status = 'current' AND valid_until IS NOT NULL
          ORDER BY valid_until, upload_id
          LIMIT ${NEXT_EXPIRY_LIMIT}
        `;

        return { totals: totals!, openImpacts: impacts?.open ?? 0, requirements, undeclared, nextExpiries };
      });

      const progress = summary.requirements.map((row) => ({
        requirement: toRequirementView(row),
        status: requirementStatus({
          current: row.current_count,
          expired: row.expired_count,
          pending: row.pending_count,
        }),
        currentCount: row.current_count,
        expiredCount: row.expired_count,
        pendingCount: row.pending_count,
        supersededCount: row.superseded_count,
        nearestValidUntil: row.nearest_valid_until,
        daysUntilExpiry: row.days_until_expiry,
      }));

      const { totals } = summary;
      return {
        projectId,
        today: totals.today,
        totals: {
          all: totals.all,
          current: totals.current,
          expired: totals.expired,
          superseded: totals.superseded,
          pending: totals.pending,
          unusable: totals.unusable,
          untyped: totals.untyped,
          withoutValidUntil: totals.without_valid_until,
          openImpacts: summary.openImpacts,
        },
        tiers: summarizeTiers(
          progress.map((item) => ({ tier: item.requirement.tier, status: item.status })),
        ),
        requirements: progress,
        undeclaredTypes: summary.undeclared.slice(0, UNDECLARED_TYPE_LIMIT).map((row) => ({
          documentType: row.document_type,
          currentCount: row.current_count,
          expiredCount: row.expired_count,
          supersededCount: row.superseded_count,
          pendingCount: row.pending_count,
        })),
        undeclaredTypesTruncated: summary.undeclared.length > UNDECLARED_TYPE_LIMIT,
        nextExpiries: summary.nextExpiries.map((row) => ({
          uploadId: row.upload_id,
          documentType: row.document_type,
          validUntil: row.valid_until,
          daysUntilExpiry: row.days,
        })),
        requestId,
        asOf,
      };
    },
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/documents",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { projectId } = request.params;
      const query = parseQuery(documentListQuery, request.query);
      assertAuthorized(
        session,
        "evidence.read",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const { requestId, asOf } = request.context;
      const after = query.cursor ? decodeKeysetCursor(query.cursor) : null;

      const rows = await withTenant(sql, { tenantId }, async (tx) => {
        await planForThisProject(tx);
        await assertProjectExists(tx, projectId);

        const tierFilter =
          query.tier === undefined
            ? tx``
            : query.tier === "undeclared"
              ? tx`AND r.id IS NULL`
              : tx`AND r.tier = ${query.tier}`;

        return tx<
          {
            upload_id: string;
            original_filename: string | null;
            state: string;
            status: string;
            document_type: string | null;
            tier: DocumentRequirementTier | null;
            valid_until: string | null;
            days_until_expiry: number | null;
            superseded_by: string | null;
            open_impacts: number;
            uploaded_at: Date;
            cursor_at: string;
            version: number;
          }[]
        >`
          SELECT d.upload_id, d.original_filename, d.state::text AS state, d.status,
                 d.document_type, r.tier,
                 to_char(d.valid_until, 'YYYY-MM-DD') AS valid_until,
                 d.days_until_expiry,
                 core.document_successor(d.upload_id) AS superseded_by,
                 (SELECT count(*)::int FROM core.document_impacts i
                   WHERE i.upload_id = d.upload_id AND i.resolution = 'open') AS open_impacts,
                 d.uploaded_at,
                 to_char(d.uploaded_at AT TIME ZONE 'UTC', ${CURSOR_TIME_FORMAT})
                   AS cursor_at,
                 d.version
          FROM core.document_status d
          LEFT JOIN core.document_requirements r
            ON r.project_id = d.project_id AND r.retired_at IS NULL
           AND lower(r.document_type) = d.type_key
          WHERE d.project_id = ${projectId}
            ${query.status === undefined ? tx`` : tx`AND d.status = ${query.status}`}
            ${
              query.documentType === undefined
                ? tx``
                : tx`AND d.type_key = lower(${query.documentType})`
            }
            ${
              query.expiresWithinDays === undefined
                ? tx``
                : tx`AND d.status = 'current'
                     AND d.valid_until <= current_date + ${query.expiresWithinDays}::int`
            }
            ${tierFilter}
            ${
              after === null
                ? tx``
                : // Sent as text and cast here: a parameter typed `timestamptz` is serialized
                  // through a JavaScript Date by the driver, which drops the microseconds.
                  tx`AND (d.uploaded_at, d.upload_id)
                         < (${after.at}::text::timestamptz, ${after.id}::uuid)`
            }
          ORDER BY d.uploaded_at DESC, d.upload_id DESC
          LIMIT ${query.limit + 1}
        `;
      });

      const page = rows.slice(0, query.limit);
      const last = page.at(-1);

      return {
        items: page.map((row) => ({
          uploadId: row.upload_id,
          originalFilename: row.original_filename,
          state: row.state,
          status: row.status,
          documentType: row.document_type,
          tier: row.tier,
          validUntil: row.valid_until,
          daysUntilExpiry: row.days_until_expiry,
          supersededByUploadId: row.superseded_by,
          openImpactCount: row.open_impacts,
          uploadedAt: row.uploaded_at.toISOString(),
          version: row.version,
        })),
        nextCursor:
          rows.length > query.limit && last ? encodeKeysetCursor({ at: last.cursor_at, id: last.upload_id }) : null,
        requestId,
        asOf,
      };
    },
  );
}
