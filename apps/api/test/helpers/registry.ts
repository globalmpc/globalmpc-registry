import { randomUUID } from "node:crypto";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type postgres from "postgres";
import { idempotencyKey } from "./db.js";

/**
 * Registry publication in tests — draft by one person, publish by another (02 §2.8).
 *
 * Many suites publish only to have a public record to read. They go through the same two steps
 * the app does, so none of them can pass through a path the app no longer has.
 */

/** A projection whose identity fields match the project, as the publication screen builds it. */
export async function projectProjection(
  sql: postgres.Sql,
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const [project] = await sql<
    {
      project_key: string;
      name: string;
      host_country_iso3: string;
      minerals: string[];
      lifecycle_state: string;
    }[]
  >`
    SELECT project_key, name, host_country_iso3, minerals, lifecycle_state
    FROM core.projects WHERE id = ${projectId}
  `;
  if (!project) throw new Error(`project ${projectId} not found`);
  return {
    stableId: projectId,
    projectKey: project.project_key,
    projectName: project.name,
    hostCountry: project.host_country_iso3,
    mineral: project.minerals,
    status: project.lifecycle_state,
    version: "1",
    asOf: "2026-08-01T00:00:00.000Z",
    sourceAge: "12",
    staleStatus: "fresh",
    limitations: ["Legal rights verification is outside this review scope"],
    legalEffect: "none",
    disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
    ...overrides,
  };
}

/** The Project Registry key is the project's key. */
export async function projectKeyOf(sql: postgres.Sql, projectId: string): Promise<string> {
  const [row] = await sql<{ project_key: string }[]>`
    SELECT project_key FROM core.projects WHERE id = ${projectId}
  `;
  return row!.project_key;
}

export function draftRegistryEntry(
  app: FastifyInstance,
  token: string,
  payload: Record<string, unknown>,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: "/api/v1/registry-entries",
    headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
    payload,
  });
}

export function publishDraft(
  app: FastifyInstance,
  token: string,
  draft: { id: string; version: number },
  body: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/v1/registry-entries/drafts/${draft.id}/publish`,
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": idempotencyKey(),
      "if-match": `"${draft.version}"`,
    },
    payload: { irreversibilityAcknowledged: true, ...body },
  });
}

/**
 * Drafts a Project Registry entry for `projectId` and publishes it.
 *
 * Returns the draft response when drafting fails, so a test can assert on why.
 */
export async function publishProject(
  app: FastifyInstance,
  sql: postgres.Sql,
  tokens: { drafter: string; publisher: string },
  projectId: string,
  overrides: Record<string, unknown> = {},
): Promise<LightMyRequestResponse> {
  const drafted = await draftRegistryEntry(app, tokens.drafter, {
    registryType: "project",
    subjectId: projectId,
    publicKey: await projectKeyOf(sql, projectId),
    projection: await projectProjection(sql, projectId),
    policyVersion: "mn-core-1.0.0",
    schemaVersion: "project-registry-1",
    ...overrides,
  });
  if (drafted.statusCode !== 200) return drafted;
  return publishDraft(app, tokens.publisher, drafted.json());
}

/**
 * A fresh project whose key is `projectKey`, for suites that publish only to have a public
 * record under a known key. Fresh because a project's key is its registry key: reusing one
 * project would turn separate records into versions of one.
 */
export async function insertProject(
  sql: postgres.Sql,
  scope: { tenantId: string; organizationId: string },
  projectKey: string,
  fields: {
    name?: string | undefined;
    hostCountryIso3?: string | undefined;
    minerals?: string[] | undefined;
  } = {},
): Promise<string> {
  const projectId = randomUUID();
  await sql`
    INSERT INTO core.projects (
      id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
    ) VALUES (
      ${projectId}, ${scope.tenantId}, ${projectKey}, ${fields.name ?? "Registry fixture"},
      ${fields.hostCountryIso3 ?? "MNG"}, ${fields.minerals ?? ["copper"]},
      ${scope.organizationId}
    )
  `;
  return projectId;
}
