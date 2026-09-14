import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { createProjectRequest } from "@mpc/api-contract";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import {
  canActForOrganization,
  assertAuthorized,
  projectResource,
  sessionFacts,
  tenantResource,
  visibleProjectScope,
} from "../plugins/authorize.js";
import { etagOf, requireEnrolledSession, requireReadContext } from "./shared.js";
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
    lifecycleState: project.lifecycle_state,
    readinessSummary: null,
    version: project.version,
    updatedAt: project.updated_at.toISOString(),
    requestId,
    asOf,
  };
}

export async function registerProjectRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.post("/api/v1/projects", async (request) => {
    // 401(모름)과 403(묶이지 않은 지갑)을 가르는 판정은 한 곳에 있다.
    const { session } = requireEnrolledSession(request);

    const idempotencyKey = request.headers["idempotency-key"];
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 16) {
      throw badRequest(
        "IDEMPOTENCY_KEY_REQUIRED",
        "mutation에는 16자 이상의 Idempotency-Key가 필요하다",
      );
    }

    const parsed = createProjectRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
        issues: parsed.error.issues,
      });
    }

    // 프로젝트 생성은 아직 프로젝트가 없으므로 project scope 검사를 하지 않는다.
    // tenant·역할·assurance만 검사한다.
    const effectiveRole = assertAuthorized(
      session,
      "project.create",
      tenantResource(session.tenantId, { state: "new", statesAllowingAction: ["new"] }),
      sessionFacts(session),
    );

    // 역할은 통과해도 소유 조직은 따로 본다.
    if (!canActForOrganization(session, "project.create", parsed.data.ownerOrganizationId)) {
      throw forbidden(
        "OWNER_ORGANIZATION_NOT_ALLOWED",
        "자기 조직이 소유하는 프로젝트만 만들 수 있다",
      );
    }

    const tenantId = session.tenantId;
    const requestHash = hashRequest(request.body);
    const { requestId, asOf, correlationId } = request.context;

    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, requestHash, async () => {
        const id = randomUUID();

        const [project] = await tx<ProjectRow[]>`
          INSERT INTO core.projects (
            id, tenant_id, project_key, name, host_country_iso3, minerals,
            owner_organization_id
          ) VALUES (
            ${id}, ${tenantId}, ${parsed.data.projectKey}, ${parsed.data.name},
            ${parsed.data.hostCountryIso3}, ${parsed.data.minerals},
            ${parsed.data.ownerOrganizationId}
          )
          RETURNING *
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
          requestIp: request.ip,
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
                 reference_status, lifecycle_state, version, updated_at
          FROM core.projects WHERE id = ${request.params.projectId}
        `,
      );

      const project = rows[0];
      if (!project) {
        // RLS가 걸러낸 것과 존재하지 않는 것을 구분해 알려주지 않는다.
        // 다른 tenant의 ID 존재 여부가 새어 나가면 안 된다.
        return reply.status(404).send({
          code: "NOT_FOUND",
          message: "프로젝트를 찾을 수 없다",
          retryable: false,
          correlationId: request.context.correlationId,
        });
      }

      // 본문의 version과 같은 값이다. If-Match에 그대로 넣을 수 있다.
      reply.header("etag", etagOf(project.version));
      return toSummary(project, request.context.requestId, request.context.asOf);
    },
  );

  app.get("/api/v1/projects", async (request) => {
    const { session, tenantId } = requireReadContext(request);

    /**
     * 목록은 tenant 전체가 아니라 **볼 수 있는 프로젝트만** 담는다.
     *
     * 조직 수준 바인딩이면 tenant의 프로젝트 전부, 프로젝트 수준 바인딩이면 그
     * 목록만이다. 목록에서 거르지 않고 단건 조회에서만 막으면 프로젝트 이름과
     * ID가 그대로 새어 나간다.
     */
    assertAuthorized(
      session,
      "project.read",
      tenantResource(tenantId),
      sessionFacts(session),
    );

    const visible = visibleProjectScope(session, "project.read");

    const rows = await withTenant(sql, { tenantId }, (tx) =>
      tx<ProjectRow[]>`
        SELECT id, project_key, name, host_country_iso3, minerals,
               reference_status, lifecycle_state, version, updated_at
        FROM core.projects
        WHERE ${visible === "all" ? tx`TRUE` : tx`id = ANY(${visible as string[]}::uuid[])`}
        ORDER BY updated_at DESC LIMIT 50
      `,
    );

    return {
      items: rows.map((row) => toSummary(row, request.context.requestId, request.context.asOf)),
      requestId: request.context.requestId,
      asOf: request.context.asOf,
    };
  });
}
