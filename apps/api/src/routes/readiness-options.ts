import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { z } from "zod";
import { withTenant } from "@mpc/db";
import { badRequest, notFound } from "../errors.js";
import {
  assertAuthorized,
  projectResource,
  sessionFacts,
} from "../plugins/authorize.js";
import { requireReadContext } from "./shared.js";

export async function registerReadinessOptionRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get<{ Params: { projectId: string }; Querystring: { gateId?: string } }>(
    "/api/v1/projects/:projectId/readiness-policy-options",
    async (request) => {
      const { session, tenantId } = requireReadContext(request);
      const { projectId } = request.params;
      assertAuthorized(
        session,
        "readiness.recompute",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );
      const query = z
        .object({ gateId: z.string().min(1).max(200).optional() })
        .safeParse(request.query);
      if (!query.success)
        throw badRequest("REQUEST_INVALID", "Invalid gate filter");
      return withTenant(sql, { tenantId }, async (tx) => {
        const [project] = await tx<
          { host_country_iso3: string }[]
        >`SELECT host_country_iso3 FROM core.projects WHERE tenant_id=${tenantId} AND id=${projectId}`;
        if (!project) throw notFound("Project not found");
        const rows = await tx<
          {
            id: string;
            rule_set_id: string;
            rule_set_version: string;
            gate_id: string;
            jurisdiction_profile: string;
            effective_from: Date;
          }[]
        >`
          SELECT id, rule_set_id, rule_set_version, gate_id, jurisdiction_profile, effective_from
          FROM core.compliance_policy_sets
          WHERE tenant_id=${tenantId} AND state='effective' AND effective_from <= now()
            AND jurisdiction_profile=${project.host_country_iso3}
            AND (${query.data.gateId ?? null}::text IS NULL OR gate_id=${query.data.gateId ?? null})
          ORDER BY gate_id, jurisdiction_profile, rule_set_id, effective_from DESC, id
        `;
        return {
          items: rows.map((row) => ({
            id: row.id,
            ruleSetId: row.rule_set_id,
            version: row.rule_set_version,
            gateId: row.gate_id,
            jurisdictionProfile: row.jurisdiction_profile,
            effectiveFrom: row.effective_from.toISOString(),
          })),
          requestId: request.context.requestId,
          asOf: request.context.asOf,
        };
      });
    },
  );
}
