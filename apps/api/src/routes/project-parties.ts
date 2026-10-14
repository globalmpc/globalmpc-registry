import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  createProjectPartyRequest,
  createRegistrationRequest,
  createStakeholderEventRequest,
  recordConfirmationRequest,
} from "@mpc/api-contract";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";
import {
  assertEvidenceUsable,
  isProjectFactKey,
  listProjectItems,
  readFacts,
  readParties,
  readRegistrationRequests,
  readStakeholderEvents,
} from "../services/project-registry.js";

/**
 * Project Registry content — spec 04 §4.2, 05 §5.6, 07 §7.2, 11 §11.3/§11.5, 12 §12.7.
 *
 * Parties, the confirmed/pending matrix, registration requests and the stakeholder/obligation
 * history, plus the Project Overview read model.
 *
 * **Nothing here is inferred.** A fact or party is `confirmed` only when a steward records it with
 * evidence that exists in this project and may carry that status. A Reference label, a published
 * registry entry, an anchored root or a signed attestation elsewhere in the project never flips a
 * row to confirmed (04 invariants 9·10).
 */

const MATRIX_NOT_MEANING =
  "A Reference label does not confirm rights, consent, issuer, or SPV status. Each row is confirmed only by its own recorded evidence.";

/**
 * What an overview limitation list always carries. The rest come from the data (pending rows,
 * never-assessed gates, open stale signals).
 */
const STANDING_LIMITATIONS = [
  "A registry record or an anchored proof shows that a record exists and was not altered. It does not show that the record is true or legally effective.",
];

function parseBody<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: unknown[] } } },
  request: FastifyRequest,
): T {
  const parsed = schema.safeParse(request.body);
  if (!parsed.success) {
    throw badRequest("REQUEST_INVALID", "Request format is invalid", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function registerProjectPartyRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  function readAuthorized(request: FastifyRequest<{ Params: { projectId: string } }>) {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "project.read",
      projectResource(tenantId, request.params.projectId),
      sessionFacts(session),
    );
    return { session, tenantId };
  }

  async function assertProjectExists(tx: postgres.TransactionSql, tenantId: string, projectId: string) {
    const [row] = await tx<{ id: string }[]>`
      SELECT id FROM core.projects WHERE tenant_id = ${tenantId} AND id = ${projectId}
    `;
    if (!row) throw notFound("Project not found");
  }

  // --- Confirmed/Pending Matrix -------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/facts",
    async (request) => {
      const { tenantId } = readAuthorized(request);
      const { requestId, asOf } = request.context;
      return withTenant(sql, { tenantId }, async (tx) => {
        await assertProjectExists(tx, tenantId, request.params.projectId);
        return {
          projectId: request.params.projectId,
          items: await readFacts(tx, tenantId, request.params.projectId),
          notMeaning: MATRIX_NOT_MEANING,
          requestId,
          asOf,
        };
      });
    },
  );

  /**
   * Record the next version of one matrix row.
   *
   * If-Match is the row's version (`"0"` for a row never recorded), so two stewards recording the
   * same row at once cannot both win silently. `project_facts` is kept in step because the
   * offering gate reads it.
   */
  app.post<{ Params: { projectId: string; factKey: string } }>(
    "/api/v1/projects/:projectId/facts/:factKey/confirmations",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expected = requireIfMatch(request);
      const { projectId, factKey } = request.params;
      if (!isProjectFactKey(factKey)) {
        throw badRequest("FACT_KEY_UNKNOWN", "Unknown matrix fact", { factKey });
      }
      const data = parseBody(recordConfirmationRequest, request);

      const effectiveRole = assertAuthorized(
        session,
        "project.fact.record",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          await assertProjectExists(tx, tenantId, projectId);
          // Serialize writers of this row; the version check below is the conflict answer.
          await tx`SELECT pg_advisory_xact_lock(hashtext(${`${projectId}:${factKey}`}))`;
          const [latest] = await tx<{ version: number }[]>`
            SELECT version FROM core.project_fact_versions
            WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND fact_key = ${factKey}
            ORDER BY version DESC LIMIT 1
          `;
          const currentVersion = latest?.version ?? 0;
          assertVersionMatches(expected, currentVersion, "project_fact");

          if (data.evidence) {
            await assertEvidenceUsable(tx, tenantId, projectId, data.evidence, data.status);
          }

          const version = currentVersion + 1;
          await tx`
            INSERT INTO core.project_fact_versions (
              id, tenant_id, project_id, fact_key, version, status, evidence_kind, evidence_ref,
              as_of, reason, recorded_by_subject_id
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${projectId}, ${factKey}, ${version}, ${data.status},
              ${data.evidence?.kind ?? null}, ${data.evidence?.id ?? null}, ${data.asOf},
              ${data.reason}, ${session.subjectId}
            )
          `;
          await tx`
            INSERT INTO core.project_facts (
              id, tenant_id, project_id, fact_key, status, evidence_ref, evidence_kind, as_of,
              note, version, recorded_by_subject_id, recorded_at
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${projectId}, ${factKey}, ${data.status},
              ${data.evidence?.id ?? null}, ${data.evidence?.kind ?? null}, ${data.asOf},
              ${data.reason}, ${version}, ${session.subjectId}, now()
            )
            ON CONFLICT (project_id, fact_key) DO UPDATE
            SET status = EXCLUDED.status, evidence_ref = EXCLUDED.evidence_ref,
                evidence_kind = EXCLUDED.evidence_kind, as_of = EXCLUDED.as_of,
                note = EXCLUDED.note, version = EXCLUDED.version,
                recorded_by_subject_id = EXCLUDED.recorded_by_subject_id,
                recorded_at = EXCLUDED.recorded_at
          `;

          await recordAudit(tx, {
            tenantId,
            projectId,
            session,
            effectiveRole,
            command: "project.fact.recorded",
            resourceType: "project_fact",
            beforeVersion: currentVersion,
            afterVersion: version,
            reason: data.reason,
            correlationId,
            requestIp: request.clientIp,
            detail: { factKey, status: data.status, evidence: data.evidence },
          });
          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.fact.recorded",
            aggregateId: projectId,
            aggregateVersion: version,
            projectId,
            payload: { factKey, status: data.status },
            correlationId,
          });

          const fact = (await readFacts(tx, tenantId, projectId)).find(
            (item) => item.factKey === factKey,
          )!;
          reply.header("etag", etagOf(version));
          return { ...fact, requestId, responseAsOf: asOf };
        }),
      );
    },
  );

  // --- Parties --------------------------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/parties",
    async (request) => {
      const { tenantId } = readAuthorized(request);
      const { requestId, asOf } = request.context;
      return withTenant(sql, { tenantId }, async (tx) => {
        await assertProjectExists(tx, tenantId, request.params.projectId);
        return {
          items: await readParties(tx, tenantId, request.params.projectId),
          requestId,
          asOf,
        };
      });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/parties",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const data = parseBody(createProjectPartyRequest, request);
      const { projectId } = request.params;

      const effectiveRole = assertAuthorized(
        session,
        "project.party.submit",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          await assertProjectExists(tx, tenantId, projectId);
          if (data.organizationId !== null) {
            const [org] = await tx<{ id: string }[]>`
              SELECT id FROM core.organizations
              WHERE tenant_id = ${tenantId} AND id = ${data.organizationId}
            `;
            if (!org) {
              throw unprocessable("ORGANIZATION_NOT_FOUND", "No such organization in this tenant");
            }
          }

          const id = randomUUID();
          // Always pending. Submitting a party is a self-statement, not a confirmation (05 §5.11).
          await tx`
            INSERT INTO core.project_parties (
              id, tenant_id, project_id, party_role, legal_name, organization_id, jurisdiction,
              status, submitted_by_subject_id
            ) VALUES (
              ${id}, ${tenantId}, ${projectId}, ${data.partyRole}, ${data.legalName},
              ${data.organizationId}, ${data.jurisdiction?.toUpperCase() ?? null}, 'pending',
              ${session.subjectId}
            )
          `;

          await recordAudit(tx, {
            tenantId,
            projectId,
            session,
            effectiveRole,
            command: "project.party.submitted",
            resourceType: "project_party",
            resourceId: id,
            afterVersion: 1,
            correlationId,
            requestIp: request.clientIp,
            detail: { partyRole: data.partyRole },
          });
          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.party.submitted",
            aggregateId: id,
            aggregateVersion: 1,
            projectId,
            payload: { partyRole: data.partyRole },
            correlationId,
          });

          const [party] = await readParties(tx, tenantId, projectId, id);
          return { ...party!, requestId, responseAsOf: asOf };
        }),
      );
    },
  );

  app.post<{ Params: { projectId: string; partyId: string } }>(
    "/api/v1/projects/:projectId/parties/:partyId/confirmations",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const expected = requireIfMatch(request);
      const data = parseBody(recordConfirmationRequest, request);
      const { projectId, partyId } = request.params;

      const effectiveRole = assertAuthorized(
        session,
        "project.fact.record",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [party] = await tx<{ id: string; version: number }[]>`
            SELECT id, version FROM core.project_parties
            WHERE tenant_id = ${tenantId} AND project_id = ${projectId} AND id = ${partyId}
            FOR UPDATE
          `;
          if (!party) throw notFound("Party not found");
          assertVersionMatches(expected, party.version, "project_party");

          if (data.evidence) {
            await assertEvidenceUsable(tx, tenantId, projectId, data.evidence, data.status);
          }

          const version = party.version + 1;
          await tx`
            UPDATE core.project_parties
            SET status = ${data.status}, evidence_kind = ${data.evidence?.kind ?? null},
                evidence_ref = ${data.evidence?.id ?? null}, as_of = ${data.asOf},
                version = ${version}, updated_at = now()
            WHERE tenant_id = ${tenantId} AND id = ${party.id}
          `;
          await tx`
            INSERT INTO core.project_party_versions (
              id, tenant_id, party_id, version, status, evidence_kind, evidence_ref, as_of,
              reason, recorded_by_subject_id
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${party.id}, ${version}, ${data.status},
              ${data.evidence?.kind ?? null}, ${data.evidence?.id ?? null}, ${data.asOf},
              ${data.reason}, ${session.subjectId}
            )
          `;

          await recordAudit(tx, {
            tenantId,
            projectId,
            session,
            effectiveRole,
            command: "project.party.confirmation_recorded",
            resourceType: "project_party",
            resourceId: party.id,
            beforeVersion: party.version,
            afterVersion: version,
            reason: data.reason,
            correlationId,
            requestIp: request.clientIp,
            detail: { status: data.status, evidence: data.evidence },
          });
          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.party.confirmation_recorded",
            aggregateId: party.id,
            aggregateVersion: version,
            projectId,
            payload: { status: data.status },
            correlationId,
          });

          const [view] = await readParties(tx, tenantId, projectId, party.id);
          reply.header("etag", etagOf(version));
          return { ...view!, requestId, responseAsOf: asOf };
        }),
      );
    },
  );

  // --- Registration requests ----------------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/registration-requests",
    async (request) => {
      const { tenantId } = readAuthorized(request);
      const { requestId, asOf } = request.context;
      return withTenant(sql, { tenantId }, async (tx) => {
        await assertProjectExists(tx, tenantId, request.params.projectId);
        return {
          items: await readRegistrationRequests(tx, tenantId, request.params.projectId),
          requestId,
          asOf,
        };
      });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/registration-requests",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const data = parseBody(createRegistrationRequest, request);
      const { projectId } = request.params;

      const effectiveRole = assertAuthorized(
        session,
        "project.registration.request",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          await assertProjectExists(tx, tenantId, projectId);
          const id = randomUUID();
          await tx`
            INSERT INTO core.project_registration_requests (
              id, tenant_id, project_id, note, requested_by_subject_id
            ) VALUES (${id}, ${tenantId}, ${projectId}, ${data.note}, ${session.subjectId})
          `;
          await recordAudit(tx, {
            tenantId,
            projectId,
            session,
            effectiveRole,
            command: "project.registration.requested",
            resourceType: "project_registration_request",
            resourceId: id,
            correlationId,
            requestIp: request.clientIp,
          });
          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.registration.requested",
            aggregateId: id,
            aggregateVersion: 1,
            projectId,
            payload: {},
            correlationId,
          });
          const view = (await readRegistrationRequests(tx, tenantId, projectId)).find(
            (item) => item.id === id,
          )!;
          return { ...view, requestId, asOf };
        }),
      );
    },
  );

  // --- Stakeholder / obligation history ------------------------------------

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/stakeholder-events",
    async (request) => {
      const { tenantId } = readAuthorized(request);
      const { requestId, asOf } = request.context;
      return withTenant(sql, { tenantId }, async (tx) => {
        await assertProjectExists(tx, tenantId, request.params.projectId);
        return {
          items: await readStakeholderEvents(tx, tenantId, request.params.projectId),
          requestId,
          asOf,
        };
      });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/stakeholder-events",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const data = parseBody(createStakeholderEventRequest, request);
      const { projectId } = request.params;

      const effectiveRole = assertAuthorized(
        session,
        "project.stakeholder.record",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      /**
       * A sponsor may record what happened; only a steward may record it as confirmed.
       *
       * Without this, the party the event is about could mark its own consent or obligation as
       * confirmed — the same self-confirmation the matrix refuses.
       */
      if (data.status === "confirmed") {
        assertAuthorized(
          session,
          "project.fact.record",
          projectResource(tenantId, projectId),
          sessionFacts(session),
        );
      }

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          await assertProjectExists(tx, tenantId, projectId);
          if (data.evidence) {
            await assertEvidenceUsable(tx, tenantId, projectId, data.evidence, data.status);
          }
          if (data.supersedesId !== null) {
            const [previous] = await tx<{ id: string; successor: string | null }[]>`
              SELECT e.id, s.id AS successor
              FROM core.project_stakeholder_events e
              LEFT JOIN core.project_stakeholder_events s ON s.supersedes_id = e.id
              WHERE e.tenant_id = ${tenantId} AND e.project_id = ${projectId}
                AND e.id = ${data.supersedesId}
            `;
            if (!previous) throw unprocessable("EVENT_NOT_FOUND", "No such event in this project");
            if (previous.successor !== null) {
              throw unprocessable("EVENT_ALREADY_SUPERSEDED", "Correct the latest version instead", {
                latestId: previous.successor,
              });
            }
          }

          const id = randomUUID();
          try {
            await tx`
              INSERT INTO core.project_stakeholder_events (
                id, tenant_id, project_id, category, summary, occurred_on, status, evidence_kind,
                evidence_ref, supersedes_id, recorded_by_subject_id
              ) VALUES (
                ${id}, ${tenantId}, ${projectId}, ${data.category}, ${data.summary},
                ${data.occurredOn}, ${data.status}, ${data.evidence?.kind ?? null},
                ${data.evidence?.id ?? null}, ${data.supersedesId}, ${session.subjectId}
              )
            `;
          } catch (caught) {
            // A concurrent correction of the same event got there first. The check above could
            // not see it; the unique index did.
            if (
              (caught as { code?: string }).code === "23505" &&
              String((caught as Error).message).includes("project_stakeholder_events_single_successor")
            ) {
              throw unprocessable("EVENT_ALREADY_SUPERSEDED", "Correct the latest version instead");
            }
            throw caught;
          }
          await recordAudit(tx, {
            tenantId,
            projectId,
            session,
            effectiveRole,
            command: "project.stakeholder_event.recorded",
            resourceType: "project_stakeholder_event",
            resourceId: id,
            correlationId,
            requestIp: request.clientIp,
            detail: { category: data.category, status: data.status, supersedesId: data.supersedesId },
          });
          await enqueueEvent(tx, {
            tenantId,
            eventType: "project.stakeholder_event.recorded",
            aggregateId: id,
            aggregateVersion: 1,
            projectId,
            payload: { category: data.category, status: data.status },
            correlationId,
          });
          const view = (await readStakeholderEvents(tx, tenantId, projectId)).find(
            (item) => item.id === id,
          )!;
          return { ...view, requestId, asOf };
        }),
      );
    },
  );

  // --- Overview ------------------------------------------------------------

  /**
   * Project Overview — 11 §11.3.
   *
   * Readiness and the latest human decision are separate arrays: shown as one value, a `go`
   * reads as a readiness result and an `ok` reads as a decision. The three registries are listed
   * even when empty — "no asset registry entry" is the answer, not a missing card.
   */
  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/overview",
    async (request) => {
      const { session, tenantId } = readAuthorized(request);
      const { projectId } = request.params;
      const { requestId, asOf } = request.context;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [item] = await listProjectItems(tx, tenantId, "all", {}, session.subjectId, projectId);
        if (!item) throw notFound("Project not found");

        const facts = await readFacts(tx, tenantId, projectId);
        const parties = await readParties(tx, tenantId, projectId);
        const lifecycle = await tx<
          { from_state: string; to_state: string; reason: string; occurred_at: Date }[]
        >`
          SELECT from_state, to_state, reason, occurred_at
          FROM core.project_lifecycle_transitions
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          ORDER BY occurred_at
        `;
        const registries = await tx<
          {
            registry_type: "project" | "verification" | "asset";
            status: "draft" | "published" | "revoked" | "superseded";
            version: number;
            published_at: Date | null;
            anchored: boolean;
          }[]
        >`
          SELECT DISTINCT ON (e.registry_type)
                 e.registry_type, v.status, v.version, v.published_at,
                 EXISTS (
                   SELECT 1 FROM chain.anchor_batch_leaves l WHERE l.entry_version_id = v.id
                 ) AS anchored
          FROM core.registry_entries e
          JOIN core.registry_entry_versions v ON v.entry_id = e.id
          WHERE e.tenant_id = ${tenantId} AND e.subject_id = ${projectId}
          ORDER BY e.registry_type, v.created_at DESC, v.version DESC
        `;
        const assessments = await tx<
          {
            gate_id: string;
            status: "ok" | "watch" | "gap" | "not_evaluable";
            generated_at: Date;
            requirement_results: { requirementId?: string; status?: string; reasonCode?: string }[];
          }[]
        >`
          SELECT DISTINCT ON (gate_id) gate_id, status, generated_at, requirement_results
          FROM core.compliance_assessments
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          ORDER BY gate_id, generated_at DESC
        `;
        const decisions = await tx<
          {
            gate_id: string;
            decision: "go" | "hold" | "rework" | "stop";
            decision_authority: string;
            signed_at: Date;
          }[]
        >`
          SELECT DISTINCT ON (gate_id) gate_id, decision, decision_authority, signed_at
          FROM core.gate_decisions
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          ORDER BY gate_id, signed_at DESC
        `;
        const [sources] = await tx<{ newest: Date | null; oldest: Date | null; count: number }[]>`
          SELECT max(as_of) AS newest, min(as_of) AS oldest, count(*)::int AS count
          FROM core.source_receipts
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
        `;
        const registrationRequests = await readRegistrationRequests(tx, tenantId, projectId);
        const [events] = await tx<{ count: number }[]>`
          SELECT count(*)::int AS count FROM core.project_stakeholder_events
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
        `;
        const activity = await tx<
          { command: string; effective_role: string | null; occurred_at: Date }[]
        >`
          SELECT command, effective_role, occurred_at FROM audit.events
          WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          ORDER BY occurred_at DESC, id DESC
          LIMIT 10
        `;

        const limitations = [...STANDING_LIMITATIONS];
        const unconfirmed = facts.filter((fact) => fact.status !== "confirmed" && fact.status !== "not_applicable");
        if (unconfirmed.length > 0) {
          limitations.push(
            `Not confirmed: ${unconfirmed.map((fact) => fact.factKey).join(", ")}. These rows are not established by this record.`,
          );
        }
        if (assessments.length === 0) {
          limitations.push("No readiness assessment has run. That is not a pass.");
        }
        if (item.openStaleSignals > 0) {
          limitations.push(
            `${item.openStaleSignals} open stale signal(s): evidence under some results has changed since they were produced.`,
          );
        }

        return {
          projectId: item.id,
          projectKey: item.projectKey,
          name: item.name,
          hostCountryIso3: item.hostCountryIso3,
          minerals: item.minerals,
          referenceStatus: item.referenceStatus,
          relationshipStatus: item.relationshipStatus,
          lifecycleState: item.lifecycleState,
          ownerOrganizationId: item.ownerOrganizationId,
          ownerOrganizationName: item.ownerOrganizationName,
          version: item.version,
          facts,
          parties,
          lifecycle: lifecycle.map((row) => ({
            fromState: row.from_state,
            toState: row.to_state,
            reason: row.reason,
            occurredAt: row.occurred_at.toISOString(),
          })),
          registries: (["project", "verification", "asset"] as const).map((registryType) => {
            const row = registries.find((entry) => entry.registry_type === registryType);
            return {
              registryType,
              status: row?.status ?? ("none" as const),
              latestVersion: row?.version ?? null,
              publishedAt: row?.published_at?.toISOString() ?? null,
              anchored: row?.anchored ?? false,
            };
          }),
          readiness: assessments.map((row) => ({
            gateId: row.gate_id,
            status: row.status,
            generatedAt: row.generated_at.toISOString(),
            openGaps: (Array.isArray(row.requirement_results) ? row.requirement_results : [])
              .filter((result) => result.status === "gap" || result.status === "not_evaluable")
              .map((result) => ({
                requirementId: String(result.requirementId ?? ""),
                status: String(result.status),
                reasonCode: String(result.reasonCode ?? ""),
              })),
          })),
          decisions: decisions.map((row) => ({
            gateId: row.gate_id,
            decision: row.decision,
            decisionAuthority: row.decision_authority,
            signedAt: row.signed_at.toISOString(),
          })),
          dataAge: {
            newestSourceAsOf: sources?.newest?.toISOString() ?? null,
            oldestSourceAsOf: sources?.oldest?.toISOString() ?? null,
            sourceCount: sources?.count ?? 0,
            openStaleSignals: item.openStaleSignals,
          },
          limitations,
          registrationRequests,
          stakeholderEventCount: events?.count ?? 0,
          activity: activity.map((row) => ({
            command: row.command,
            effectiveRole: row.effective_role,
            occurredAt: row.occurred_at.toISOString(),
          })),
          requestId,
          asOf,
        };
      });
    },
  );
}
