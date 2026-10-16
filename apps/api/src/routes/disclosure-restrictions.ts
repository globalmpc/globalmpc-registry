import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  canTransition,
  disclosureRestrictionMachine,
  type DisclosureRestrictionState,
} from "@mpc/domain";
import {
  disclosureRestrictionActivateRequest,
  disclosureRestrictionCreateRequest,
  disclosureRestrictionReleaseRequest,
  disclosureRestrictionSupersedeRequest,
} from "@mpc/api-contract";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, projectResource, sessionFacts } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import { lockProjectRestrictions } from "../restrictions.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
  type EnrolledSession,
} from "./shared.js";

/**
 * Material-information blackout API — spec 07 §7.14, 03 J-22, AC-30.
 *
 * A restriction is created as `draft` and blocks nothing until someone activates it. Once
 * active, the actions it names are refused by `assertActionNotRestricted` in the routes that
 * perform them, with this restriction's ID.
 *
 * **Nothing releases a blackout on its own.** `expectedReleaseAt` is shown to users; it is not a
 * timer. Release requires a person holding `disclosure.restrict` to record the disclosure
 * reference and the legal condition (J-22 step 4). Publication and trading restriction are
 * separate states (§7.14): publishing does not release a blackout, and a blackout does not
 * block publication unless it names `registry.publish`.
 */

type TransitionKind = "activate" | "release" | "supersede";

interface RestrictionRow {
  readonly id: string;
  readonly project_id: string;
  readonly state: DisclosureRestrictionState;
  readonly subject_scope: string[];
  readonly restricted_action_types: string[];
  readonly material_info_ref: string | null;
  readonly reason: string | null;
  readonly legal_basis: string;
  readonly authority: string;
  readonly effective_at: Date | null;
  readonly expected_next_update_at: Date | null;
  readonly expected_release_at: Date | null;
  readonly released_at: Date | null;
  readonly release_record: Record<string, unknown> | null;
  readonly superseded_by_id: string | null;
  readonly version: number;
}

interface EventRow {
  readonly restriction_id: string;
  readonly event_kind: "created" | "activated" | "blocked_attempt" | "released" | "superseded";
  readonly action_type: string | null;
  readonly actor_subject_id: string | null;
  readonly reason: string | null;
  readonly occurred_at: Date;
}

const SELECT_COLUMNS = `
  id, project_id, state, subject_scope::text[] AS subject_scope, restricted_action_types,
  material_info_ref, reason, legal_basis, authority, effective_at, expected_next_update_at,
  expected_release_at, released_at, release_record, superseded_by_id, version
`;

function toView(row: RestrictionRow, events: readonly EventRow[]) {
  return {
    restrictionId: row.id,
    projectId: row.project_id,
    state: row.state,
    subjectScope: row.subject_scope,
    restrictedActionTypes: row.restricted_action_types,
    materialInfoRef: row.material_info_ref,
    reason: row.reason,
    legalBasis: row.legal_basis,
    authority: row.authority,
    effectiveAt: row.effective_at?.toISOString() ?? null,
    expectedNextUpdateAt: row.expected_next_update_at?.toISOString() ?? null,
    expectedReleaseAt: row.expected_release_at?.toISOString() ?? null,
    releasedAt: row.released_at?.toISOString() ?? null,
    releaseRecord: row.release_record,
    supersededById: row.superseded_by_id,
    version: row.version,
    history: events
      .filter((event) => event.restriction_id === row.id)
      .map((event) => ({
        eventKind: event.event_kind,
        actionType: event.action_type,
        actorSubjectId: event.actor_subject_id,
        reason: event.reason,
        occurredAt: event.occurred_at.toISOString(),
      })),
  };
}

async function readEvents(
  tx: postgres.TransactionSql,
  restrictionIds: readonly string[],
): Promise<EventRow[]> {
  if (restrictionIds.length === 0) return [];
  return tx<EventRow[]>`
    SELECT restriction_id, event_kind, action_type, actor_subject_id, reason, occurred_at
    FROM core.disclosure_restriction_events
    WHERE restriction_id = ANY(${restrictionIds as string[]}::uuid[])
    ORDER BY occurred_at, id
  `;
}

async function recordEvent(
  tx: postgres.TransactionSql,
  tenantId: string,
  row: RestrictionRow,
  kind: EventRow["event_kind"],
  session: EnrolledSession,
  reason: string,
  correlationId: string,
): Promise<void> {
  await tx`
    INSERT INTO core.disclosure_restriction_events (
      tenant_id, restriction_id, project_id, event_kind, actor_subject_id, reason, correlation_id
    ) VALUES (
      ${tenantId}, ${row.id}, ${row.project_id}, ${kind}, ${session.subjectId}, ${reason},
      ${correlationId}
    )
  `;
}

/** The outbox event names of 07 §7.12. `created` has none — a draft blocks nothing. */
const OUTBOX_EVENT: Partial<Record<EventRow["event_kind"], string>> = {
  activated: "disclosure.blackout.opened",
  released: "disclosure.blackout.lifted",
  superseded: "disclosure.blackout.superseded",
};

export async function registerDisclosureRestrictionRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  // --- Create (draft) -----------------------------------------------------------

  app.post<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/disclosure-restrictions",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);

      const parsed = disclosureRestrictionCreateRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { projectId } = request.params;
      const effectiveRole = assertAuthorized(
        session,
        "disclosure.restrict",
        projectResource(tenantId, projectId),
        sessionFacts(session),
      );

      const { requestId, asOf, correlationId } = request.context;
      const data = parsed.data;

      const result = await withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [project] = await tx<{ id: string }[]>`
            SELECT id FROM core.projects WHERE tenant_id = ${tenantId} AND id = ${projectId}
          `;
          if (!project) throw notFound("Project not found");

          const id = randomUUID();
          const [row] = await tx<RestrictionRow[]>`
            INSERT INTO core.disclosure_restrictions (
              id, tenant_id, project_id, subject_scope, restricted_action_types,
              material_info_ref, reason, legal_basis, authority,
              expected_next_update_at, expected_release_at, created_by
            ) VALUES (
              ${id}, ${tenantId}, ${projectId}, ${data.subjectScope}::uuid[],
              ${[...new Set(data.restrictedActionTypes)]}, ${data.materialInfoRef},
              ${data.reason}, ${data.legalBasis}, ${data.authority},
              ${data.expectedNextUpdateAt ?? null}, ${data.expectedReleaseAt ?? null},
              ${session.subjectId}
            )
            RETURNING ${tx.unsafe(SELECT_COLUMNS)}
          `;

          await recordEvent(tx, tenantId, row!, "created", session, data.reason, correlationId);

          await recordAudit(tx, {
            effectiveRole,
            tenantId,
            projectId,
            session,
            command: "disclosure_restriction.created",
            resourceType: "disclosure_restriction",
            resourceId: id,
            correlationId,
            requestIp: request.clientIp,
            reason: data.reason,
            afterVersion: row!.version,
            // The legal basis and material-information reference stay out of the audit detail;
            // the row holds them. The audit records what was restricted.
            detail: { restrictedActionTypes: row!.restricted_action_types },
          });

          return toView(row!, await readEvents(tx, [id]));
        }),
      );

      reply.header("etag", etagOf(result.version));
      return reply.code(201).send({ ...result, requestId, asOf });
    },
  );

  // --- Read -------------------------------------------------------------------

  async function list(request: Parameters<typeof requireReadContext>[0], onlyActive: boolean) {
    const { session, tenantId } = requireReadContext(request);
    const projectId = (request.params as { projectId: string }).projectId;

    assertAuthorized(session, "project.read", projectResource(tenantId, projectId), sessionFacts(session));

    const { requestId, asOf } = request.context;
    const items = await withTenant(sql, { tenantId }, async (tx) => {
      const rows = await tx<RestrictionRow[]>`
        SELECT ${tx.unsafe(SELECT_COLUMNS)}
        FROM core.disclosure_restrictions
        WHERE tenant_id = ${tenantId} AND project_id = ${projectId}
          AND (${!onlyActive} OR state = 'active')
        ORDER BY created_at DESC, id
      `;
      const events = await readEvents(tx, rows.map((row) => row.id));
      return rows.map((row) => toView(row, events));
    });

    return { items, requestId, asOf };
  }

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/disclosure-restrictions",
    async (request) => list(request, false),
  );

  app.get<{ Params: { projectId: string } }>(
    "/api/v1/projects/:projectId/disclosure-restrictions/active",
    async (request) => list(request, true),
  );

  // --- Transitions --------------------------------------------------------------

  const TARGET: Record<TransitionKind, DisclosureRestrictionState> = {
    activate: "active",
    release: "released",
    supersede: "superseded",
  };

  const SCHEMA = {
    activate: disclosureRestrictionActivateRequest,
    release: disclosureRestrictionReleaseRequest,
    supersede: disclosureRestrictionSupersedeRequest,
  } as const;

  for (const kind of ["activate", "release", "supersede"] as const) {
    app.post<{ Params: { restrictionId: string } }>(
      `/api/v1/disclosure-restrictions/:restrictionId/${kind}`,
      async (request, reply) => {
        const { session, tenantId, idempotencyKey } = requireMutationContext(request);
        const expected = requireIfMatch(request);

        const parsed = SCHEMA[kind].safeParse(request.body);
        if (!parsed.success) {
          throw badRequest("REQUEST_INVALID", "Request format is invalid", {
            issues: parsed.error.issues,
          });
        }
        const body = parsed.data as {
          reason: string;
          disclosureReference?: string;
          legalCondition?: string;
          supersededById?: string | null;
        };

        const { requestId, asOf, correlationId } = request.context;
        const to = TARGET[kind];

        const result = await withTenant(sql, { tenantId }, async (tx) => {
          // Authorized before the idempotency lookup: a replayed key must not hand a stored
          // response to someone who could not have made the request.
          const [target] = await tx<{ project_id: string }[]>`
            SELECT project_id FROM core.disclosure_restrictions
            WHERE tenant_id = ${tenantId} AND id = ${request.params.restrictionId}
          `;
          if (!target) throw notFound("Disclosure restriction not found");
          const effectiveRole = assertAuthorized(
            session,
            "disclosure.restrict",
            projectResource(tenantId, target.project_id),
            sessionFacts(session),
          );

          return withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
            await lockProjectRestrictions(tx, tenantId, target.project_id);
            const [current] = await tx<RestrictionRow[]>`
              SELECT ${tx.unsafe(SELECT_COLUMNS)}
              FROM core.disclosure_restrictions
              WHERE tenant_id = ${tenantId} AND id = ${request.params.restrictionId}
              FOR UPDATE
            `;
            if (!current) throw notFound("Disclosure restriction not found");

            assertVersionMatches(expected, current.version, "disclosure_restriction");

            if (!canTransition(disclosureRestrictionMachine, current.state, to)) {
              throw unprocessable(
                "RESTRICTION_TRANSITION_NOT_ALLOWED",
                `A ${current.state} restriction cannot be moved to ${to}`,
                {
                  from: current.state,
                  to,
                  allowed: [...disclosureRestrictionMachine.transitions[current.state]],
                },
              );
            }

            const supersededById = await resolveReplacement(tx, tenantId, current, kind, body.supersededById);

            const releaseRecord =
              kind === "release"
                ? {
                    disclosureReference: body.disclosureReference,
                    legalCondition: body.legalCondition,
                    reason: body.reason,
                    recordedBy: session.subjectId,
                    recordedAt: new Date().toISOString(),
                  }
                : null;

            const [row] = await tx<RestrictionRow[]>`
              UPDATE core.disclosure_restrictions SET
                state = ${to},
                effective_at = ${kind === "activate" ? tx`now()` : tx`effective_at`},
                activated_by = ${kind === "activate" ? session.subjectId : tx`activated_by`},
                released_at = ${kind === "release" ? tx`now()` : tx`released_at`},
                released_by = ${kind === "release" ? session.subjectId : tx`released_by`},
                release_record = ${releaseRecord ? tx.json(releaseRecord as never) : tx`release_record`},
                superseded_by_id = ${kind === "supersede" ? supersededById : tx`superseded_by_id`},
                version = version + 1
              WHERE id = ${current.id}
              RETURNING ${tx.unsafe(SELECT_COLUMNS)}
            `;

            const eventKind =
              kind === "activate" ? "activated" : kind === "release" ? "released" : "superseded";
            await recordEvent(tx, tenantId, row!, eventKind, session, body.reason, correlationId);

            await recordAudit(tx, {
              effectiveRole,
              tenantId,
              projectId: current.project_id,
              session,
              command: `disclosure_restriction.${eventKind}`,
              resourceType: "disclosure_restriction",
              resourceId: current.id,
              correlationId,
              requestIp: request.clientIp,
              reason: body.reason,
              beforeVersion: current.version,
              afterVersion: row!.version,
              detail: { fromState: current.state, toState: to },
            });

            const outboxEvent = OUTBOX_EVENT[eventKind];
            if (outboxEvent) {
              await enqueueEvent(tx, {
                tenantId,
                eventType: outboxEvent,
                aggregateId: current.id,
                aggregateVersion: row!.version,
                projectId: current.project_id,
                correlationId,
                // Only the scope of what is blocked. The legal basis and the material
                // information reference are not event payload.
                payload: {
                  fromState: current.state,
                  toState: to,
                  restrictedActionTypes: row!.restricted_action_types,
                },
              });
            }

            return toView(row!, await readEvents(tx, [current.id]));
          });
        });

        reply.header("etag", etagOf(result.version));
        return { ...result, requestId, asOf };
      },
    );
  }
}

async function resolveReplacement(
  tx: postgres.TransactionSql,
  tenantId: string,
  current: RestrictionRow,
  kind: TransitionKind,
  supersededBy: string | null | undefined,
): Promise<string | null> {
  const supersededById = kind === "supersede" ? (supersededBy ?? null) : null;
  if (supersededById) {
    const [replacement] = await tx<{ project_id: string }[]>`
      SELECT project_id FROM core.disclosure_restrictions
      WHERE tenant_id = ${tenantId} AND id = ${supersededById}
    `;
    // A replacement on another project would leave this project's scope unrestricted
    // while the history says it moved.
    if (
      !replacement ||
      replacement.project_id !== current.project_id ||
      supersededById === current.id
    ) {
      throw unprocessable(
        "RESTRICTION_REPLACEMENT_INVALID",
        "The replacing restriction must be another restriction on the same project",
      );
    }
  }
  return supersededById;
}
