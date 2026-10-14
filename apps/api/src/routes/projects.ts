import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { createProjectRequest, projectListQuery, updateProjectRequest } from "@mpc/api-contract";
import { badRequest, forbidden, notFound } from "../errors.js";
import { capRows } from "../list-window.js";
import {
  actableOrganizations,
  canActForOrganization,
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
  visibleProjectScope,
} from "../plugins/authorize.js";
import {
  assertVersionMatches,
  etagOf,
  requireEnrolledSession,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";
import { listProjectItems } from "../services/project-registry.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";

interface ProjectRow {
  id: string;
  project_key: string;
  name: string;
  host_country_iso3: string;
  minerals: string[];
  reference_status: string;
  relationship_status: string;
  lifecycle_state: string;
  version: number;
  updated_at: Date;
}

function toSummary(project: ProjectRow, requestId: string, asOf: string) {
  return {
    id: project.id,
    projectKey: project.project_key,
    name: project.name,
    hostCountryIso3: project.host_country_iso3,
    minerals: project.minerals,
    referenceStatus: project.reference_status,
    relationshipStatus: project.relationship_status,
    lifecycleState: project.lifecycle_state,
    readinessSummary: null,
    version: project.version,
    updatedAt: project.updated_at.toISOString(),
    requestId,
    asOf,
  };
}

/**
 * Cap on the project list, most recently updated first.
 *
 * A flag rather than pages: a tenant holds few projects. Past the cap the response says
 * `truncated`, so a project that was not updated lately is not read as missing.
 */
const PROJECT_LIST_LIMIT = 50;

export async function registerProjectRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.post("/api/v1/projects", async (request) => {
    // The 401 (unknown) vs 403 (unbound wallet) decision lives in one place.
    const { session } = requireEnrolledSession(request);

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16) {
      throw badRequest(
        "IDEMPOTENCY_KEY_REQUIRED",
        "Mutations require an Idempotency-Key of at least 16 characters",
      );
    }

    const parsed = createProjectRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    // Project creation skips the project scope check because no project exists yet.
    // Only tenant, role, and assurance are checked.
    const effectiveRole = assertAuthorized(
      session,
      "project.create",
      tenantResource(session.tenantId, { state: "new", statesAllowingAction: ["new"] }),
      sessionFacts(session),
    );

    // Passing the role check does not settle the owner organization; it is checked separately.
    if (!canActForOrganization(session, "project.create", parsed.data.ownerOrganizationId)) {
      throw forbidden(
        "OWNER_ORGANIZATION_NOT_ALLOWED",
        "Only projects owned by your own organization can be created",
      );
    }

    const tenantId = session.tenantId;
    const requestHash = hashRequest(request);
    const { requestId, asOf, correlationId } = request.context;

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const id = randomUUID();

        const [project] = await tx<ProjectRow[]>`
          INSERT INTO core.projects (
            id, tenant_id, project_key, name, host_country_iso3, minerals,
            owner_organization_id, reference_status
          ) VALUES (
            ${id}, ${tenantId}, ${parsed.data.projectKey}, ${parsed.data.name},
            ${parsed.data.hostCountryIso3}, ${parsed.data.minerals},
            ${parsed.data.ownerOrganizationId}, ${parsed.data.referenceStatus}
          )
          RETURNING *, 'pending' AS relationship_status
        `;

        await recordAudit(tx, {
          effectiveRole,
          tenantId,
          projectId: id,
          session,
          command: "project.registered",
          resourceType: "project",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.clientIp,
        });

        await enqueueEvent(tx, {
          tenantId,
          eventType: "project.registered",
          aggregateId: id,
          aggregateVersion: 1,
          projectId: id,
          payload: {
            projectKey: parsed.data.projectKey,
            hostCountryIso3: parsed.data.hostCountryIso3,
          },
          correlationId,
        });

        return toSummary(project!, requestId, asOf);
      }),
    );
  });

  /**
   * Organizations this session may name as a project's owner.
   *
   * The registration form used to look the organization up in a table of demo tenant ids, so on
   * any other tenant it had nothing to submit. The list follows the same rule as the create check
   * above (`actableOrganizations`); a wider list would offer choices the server then refuses.
   *
   * Authorized with `project.create` itself: someone who cannot register a project has no reason
   * to read the tenant's organizations, and the denial tells them which role they would need.
   */
  app.get("/api/v1/organizations", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "project.create",
      tenantResource(tenantId, { state: "new", statesAllowingAction: ["new"] }),
      sessionFacts(session),
    );

    const scope = actableOrganizations(session, "project.create");
    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<{ id: string; legal_name: string; jurisdiction: string }[]>`
        SELECT id, legal_name, jurisdiction
        FROM core.organizations
        WHERE tenant_id = ${tenantId}
          AND ${scope === "all" ? tx`TRUE` : tx`id = ANY(${scope as string[]}::uuid[])`}
        ORDER BY legal_name, id
      `,
    );

    return {
      items: rows.map((row) => ({
        id: row.id,
        legalName: row.legal_name,
        jurisdiction: row.jurisdiction,
      })),
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) => {
      const { session, tenantId } = requireReadContext(request);

      assertAuthorized(
        session,
        "project.read",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const rows = await withTenant(sql, { tenantId }, (tx) =>
        tx<ProjectRow[]>`
          SELECT id, project_key, name, host_country_iso3, minerals,
                 reference_status, COALESCE(
                   (SELECT v.status::text FROM core.project_fact_versions v
                    WHERE v.project_id = core.projects.id AND v.fact_key = 'relationship'
                    ORDER BY v.version DESC LIMIT 1),
                   'pending'
                 ) AS relationship_status,
                 lifecycle_state, version, updated_at
          FROM core.projects WHERE id = ${request.params.projectId}
        `,
      );

      const project = rows[0];
      if (!project) {
        // Filtered-by-RLS and nonexistent are not distinguished in the response.
        // Whether an ID exists in another tenant must not leak.
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "Project not found",
          retryable: false,
          correlationId: request.context.correlationId,
        });
      }

      // Same value as the body's version; it can be passed to If-Match as-is.
      reply.header("etag", etagOf(project.version));
      return toSummary(project, request.context.requestId, request.context.asOf);
    },
  );

  app.get("/api/v1/projects", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    /**
     * The list holds **only visible projects**, not the whole tenant.
     *
     * An organization-level binding sees every project in the tenant; a project-level binding
     * sees only its listed projects. Blocking only single lookups without filtering the list
     * leaks project names and IDs.
     */
    assertAuthorized(
      session,
      "project.read",
      tenantResource(tenantId, { filteredByProjectScope: true }),
      sessionFacts(session),
    );

    // Filters narrow inside the visible set (11 §11.3). An unknown filter is refused rather
    // than ignored — an ignored filter shows an unfiltered list that looks filtered.
    const query = projectListQuery.safeParse(request.query ?? {});
    if (!query.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: query.error.issues,
      });
    }

    const visible = visibleProjectScope(session, "project.read");
    const filteredAfterAggregation =
      query.data.grade !== undefined || query.data.gap !== undefined || query.data.stale !== undefined;
    const items = await withTenant(sql, { tenantId }, (tx) =>
      listProjectItems(
        tx,
        tenantId,
        visible,
        query.data,
        session.subjectId,
        undefined,
        filteredAfterAggregation ? undefined : PROJECT_LIST_LIMIT + 1,
      ),
    );
    const window = capRows(items, PROJECT_LIST_LIMIT);

    return {
      // Capped after the filters, most recently updated first: a filtered list that stops at the
      // cap says so instead of reading as complete.
      items: window.items,
      truncated: window.truncated,
      limit: window.limit,
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });

  /**
   * Project identity edits — 07 §7.2 `PATCH /projects/{id}`.
   *
   * Only name and minerals. The owner organization decides who reaches the project, and the
   * reference label is fixed (05 §5.10), so neither changes here. Host country is also left out:
   * it selects the jurisdiction profile every assessment was made under.
   */
  app.patch<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expected = requireIfMatch(request);

      const parsed = updateProjectRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const effectiveRole = assertAuthorized(
        session,
        "project.update",
        projectResource(tenantId, request.params.projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [current] = await tx<{ id: string; name: string; minerals: string[]; version: number }[]>`
            SELECT id, name, minerals, version FROM core.projects
            WHERE tenant_id = ${tenantId} AND id = ${request.params.projectId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Project not found");
          assertVersionMatches(expected, current.version, "project");

          const name = parsed.data.name ?? current.name;
          const minerals = parsed.data.minerals ?? current.minerals;
          const [updated] = await tx<{ version: number }[]>`
            UPDATE core.projects
            SET name = ${name}, minerals = ${minerals}, version = version + 1, updated_at = now()
            WHERE tenant_id = ${tenantId} AND id = ${current.id}
            RETURNING version
          `;

          await recordAudit(tx, {
            tenantId,
            projectId: current.id,
            session,
            effectiveRole,
            command: "project.updated",
            resourceType: "project",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: updated!.version,
            reason: parsed.data.reason,
            correlationId,
            requestIp: request.clientIp,
            detail: {
              before: { name: current.name, minerals: current.minerals },
              after: { name, minerals },
            },
          });

          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.updated",
            aggregateId: current.id,
            aggregateVersion: updated!.version,
            projectId: current.id,
            payload: { changed: Object.keys(parsed.data).filter((key) => key !== "reason") },
            correlationId,
          });

          const [item] = await listProjectItems(
            tx,
            tenantId,
            "all",
            {},
            session.subjectId,
            current.id,
          );
          reply.header("etag", etagOf(updated!.version));
          return { ...item!, requestId, asOf };
        }),
      );
    },
  );
}
