import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import type { z } from "zod";
import { withTenant } from "@mpc/db";
import {
  BREAK_GLASS_INCIDENT_DUE_HOURS,
  BREAK_GLASS_ROLE,
  decideBreakGlassRequest,
  quarantineAccessRequest,
  recordBreakGlassIncidentRequest,
  releaseBreakGlassRequest,
  requestBreakGlassRequest,
} from "@mpc/api-contract";
import { badRequest, conflict, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import { enqueueEvent } from "../outbox.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
  type EnrolledSession,
} from "./shared.js";

/**
 * Break-glass elevation — spec 02 §2.6, 13 §13.6 "admin JIT elevation expiry".
 *
 * A `security_operator` requests an elevation **for themself** with a purpose, a target and an
 * expiry; a different `security_operator` approves it. While it is effective the session carries
 * the `break_glass` role, which holds only `BREAK_GLASS_ACTIONS` — today, access quarantine.
 *
 * **Nothing here extends an elevation.** Expiry is fixed at request time and evaluated on every
 * request by the session resolver. Release ends it early; nothing makes it longer. An elevation
 * that needs more time is a new request, approved again.
 *
 * **Incident record within 24 hours (02 §2.6).** Past that deadline without a record, the
 * elevation stops granting and no new elevation can be requested in the tenant until the record
 * is filed. The requester or any other security operator may file it.
 *
 * Not built here: the "pre-approved security multisig" (OD-12 is pending; the second approver
 * is a second person instead) and the public post-incident disclosure, which belongs to the
 * disclosure workflow.
 */

interface ElevationRow {
  id: string;
  subject_id: string;
  purpose: string;
  target: string;
  requested_at: Date;
  expires_at: Date;
  state: "pending" | "active" | "rejected" | "released";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  incident_reference: string | null;
  incident_summary: string | null;
  incident_recorded_at: Date | null;
  release_cause: string | null;
  release_recovery_verification: string | null;
  released_by_subject_id: string | null;
  released_at: Date | null;
  version: number;
  /** Database clock at read time. Effectiveness is judged against it, not the API host clock. */
  now: Date;
}

const DUE_MS = BREAK_GLASS_INCIDENT_DUE_HOURS * 60 * 60 * 1000;

function incidentDueAt(row: ElevationRow): Date | null {
  return row.decided_at && row.state !== "rejected"
    ? new Date(row.decided_at.getTime() + DUE_MS)
    : null;
}

function isOverdue(row: ElevationRow): boolean {
  const due = incidentDueAt(row);
  return due !== null && row.incident_recorded_at === null && row.now.getTime() >= due.getTime();
}

/** Same rule as the session resolver. The two must agree, or the list would lie about access. */
function isEffective(row: ElevationRow): boolean {
  return row.state === "active" && row.expires_at.getTime() > row.now.getTime() && !isOverdue(row);
}

function toView(row: ElevationRow) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    purpose: row.purpose,
    target: row.target,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    state: row.state,
    effective: isEffective(row),
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    incidentDueAt: incidentDueAt(row)?.toISOString() ?? null,
    incidentOverdue: isOverdue(row),
    incidentReference: row.incident_reference,
    incidentSummary: row.incident_summary,
    incidentRecordedAt: row.incident_recorded_at?.toISOString() ?? null,
    releaseCause: row.release_cause,
    releaseRecoveryVerification: row.release_recovery_verification,
    releasedBySubjectId: row.released_by_subject_id,
    releasedAt: row.released_at?.toISOString() ?? null,
    version: row.version,
  };
}

async function loadElevation(
  tx: postgres.TransactionSql,
  tenantId: string,
  elevationId: string,
  lock: boolean,
): Promise<ElevationRow> {
  const rows = lock
    ? await tx<ElevationRow[]>`
        SELECT e.*, now() AS now FROM core.break_glass_elevations e
        WHERE e.tenant_id = ${tenantId} AND e.id = ${elevationId}
        FOR UPDATE
      `
    : await tx<ElevationRow[]>`
        SELECT e.*, now() AS now FROM core.break_glass_elevations e
        WHERE e.tenant_id = ${tenantId} AND e.id = ${elevationId}
      `;
  const row = rows[0];
  if (!row) throw notFound("Elevation not found");
  return row;
}

function parse<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw badRequest("REQUEST_INVALID", "Request format is invalid", {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function registerBreakGlassRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/admin/break-glass", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(session, "break_glass.read", tenantResource(tenantId), sessionFacts(session));

    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => tx<ElevationRow[]>`
      SELECT e.*, now() AS now FROM core.break_glass_elevations e
      WHERE e.tenant_id = ${tenantId}
      ORDER BY e.requested_at DESC
    `);
    return { items: rows.map(toView), requestId, asOf };
  });

  app.post("/api/v1/admin/break-glass", async (request, reply) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "break_glass.request",
      tenantResource(tenantId),
      sessionFacts(session),
    );
    const data = parse(requestBreakGlassRequest, request.body);

    const { requestId, asOf, correlationId } = request.context;
    const result = await withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
        const [clock] = await tx<{ now: Date }[]>`SELECT now() AS now`;
        if (new Date(data.expiresAt).getTime() <= clock!.now.getTime()) {
          throw unprocessable("BREAK_GLASS_EXPIRY_IN_PAST", "Expiry must be in the future");
        }

        /**
         * An unaccounted-for use blocks the next one — 02 §2.6.
         *
         * Checked tenant-wide, not per person: the record is owed by the security function, and
         * letting a colleague open a fresh elevation would let the overdue one be forgotten.
         */
        const [overdue] = await tx<{ id: string }[]>`
          SELECT id FROM core.break_glass_elevations
          WHERE tenant_id = ${tenantId}
            AND state IN ('active', 'released')
            AND incident_recorded_at IS NULL
            AND decided_at + make_interval(hours => ${BREAK_GLASS_INCIDENT_DUE_HOURS}) <= now()
          LIMIT 1
        `;
        if (overdue) {
          throw unprocessable(
            "BREAK_GLASS_INCIDENT_OVERDUE",
            "An earlier elevation has no incident record past its 24-hour deadline",
            { elevationId: overdue.id, hint: "Record that incident first" },
          );
        }

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.break_glass_elevations (id, tenant_id, subject_id, purpose, target, expires_at)
            VALUES (${id}, ${tenantId}, ${session.subjectId}, ${data.purpose}, ${data.target},
                    ${data.expiresAt})
          `;
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes("break_glass_elevations_one_open")) {
            throw conflict("BREAK_GLASS_ALREADY_OPEN", "You already have a pending or active elevation");
          }
          throw caught;
        }

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "break_glass.requested",
          resourceType: "break_glass_elevation",
          resourceId: id,
          afterVersion: 1,
          reason: data.purpose,
          correlationId,
          requestIp: request.clientIp,
          detail: { target: data.target, expiresAt: data.expiresAt },
        });

        return toView(await loadElevation(tx, tenantId, id, false));
      }),
    );
    return reply.code(201).send({ ...result, requestId, asOf });
  });

  app.post<{ Params: { elevationId: string } }>(
    "/api/v1/admin/break-glass/:elevationId/decision",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // A missing If-Match is reported before authorization, like every versioned route.
      const expected = requireIfMatch(request);
      const effectiveRole = assertAuthorized(
        session,
        "break_glass.approve",
        tenantResource(tenantId),
        sessionFacts(session),
      );
      const data = parse(decideBreakGlassRequest, request.body);

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const current = await loadElevation(tx, tenantId, request.params.elevationId, true);
          assertVersionMatches(expected, current.version, "break_glass_elevation");

          if (current.state !== "pending") {
            throw unprocessable("BREAK_GLASS_ALREADY_DECIDED", "Elevation is already decided", {
              state: current.state,
            });
          }
          // The DB CHECK blocks the same; this says why.
          if (current.subject_id === session.subjectId) {
            throw unprocessable(
              "BREAK_GLASS_SELF_APPROVAL",
              "The person elevated cannot approve their own elevation",
              { hint: "Another security operator decides" },
            );
          }
          if (data.decision === "approve" && current.expires_at.getTime() <= current.now.getTime()) {
            throw unprocessable("BREAK_GLASS_EXPIRED", "The requested expiry has already passed");
          }

          const approved = data.decision === "approve";
          await tx`
            UPDATE core.break_glass_elevations
            SET state = ${approved ? "active" : "rejected"},
                decided_by_subject_id = ${session.subjectId},
                decided_at = now(),
                decision_reason = ${data.reason},
                version = version + 1
            WHERE id = ${current.id}
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: approved ? "break_glass.approved" : "break_glass.rejected",
            resourceType: "break_glass_elevation",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            reason: data.reason,
            correlationId,
            requestIp: request.clientIp,
            detail: { elevatedSubjectId: current.subject_id },
          });

          reply.header("etag", etagOf(current.version + 1));
          return { ...toView(await loadElevation(tx, tenantId, current.id, false)), requestId, asOf };
        }),
      );
    },
  );

  app.post<{ Params: { elevationId: string } }>(
    "/api/v1/admin/break-glass/:elevationId/incident",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // A missing If-Match is reported before authorization, like every versioned route.
      const expected = requireIfMatch(request);
      const effectiveRole = assertAuthorized(
        session,
        "break_glass.incident",
        tenantResource(tenantId),
        sessionFacts(session),
      );
      const data = parse(recordBreakGlassIncidentRequest, request.body);

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const current = await loadElevation(tx, tenantId, request.params.elevationId, true);
          assertVersionMatches(expected, current.version, "break_glass_elevation");

          if (current.state === "pending" || current.state === "rejected") {
            throw unprocessable(
              "BREAK_GLASS_NOT_USED",
              "Only an approved elevation has an incident to record",
              { state: current.state },
            );
          }
          if (current.incident_recorded_at !== null) {
            throw unprocessable("BREAK_GLASS_INCIDENT_RECORDED", "The incident is already recorded");
          }

          await tx`
            UPDATE core.break_glass_elevations
            SET incident_reference = ${data.incidentReference},
                incident_summary = ${data.summary},
                incident_recorded_by_subject_id = ${session.subjectId},
                incident_recorded_at = now(),
                version = version + 1
            WHERE id = ${current.id}
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "break_glass.incident_recorded",
            resourceType: "break_glass_elevation",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            correlationId,
            requestIp: request.clientIp,
            // Late filing is kept as a fact, not hidden by the record now existing.
            detail: { incidentReference: data.incidentReference, late: isOverdue(current) },
          });

          // 07 §7.4 `incident.opened`. The summary stays internal; the event carries references.
          await enqueueEvent(tx, {
            tenantId,
            eventType: "incident.opened",
            aggregateId: current.id,
            aggregateVersion: current.version + 1,
            correlationId,
            payload: { source: "break_glass", incidentReference: data.incidentReference },
          });

          reply.header("etag", etagOf(current.version + 1));
          return { ...toView(await loadElevation(tx, tenantId, current.id, false)), requestId, asOf };
        }),
      );
    },
  );

  app.post<{ Params: { elevationId: string } }>(
    "/api/v1/admin/break-glass/:elevationId/release",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      // A missing If-Match is reported before authorization, like every versioned route.
      const expected = requireIfMatch(request);
      const effectiveRole = assertAuthorized(
        session,
        "break_glass.release",
        tenantResource(tenantId),
        sessionFacts(session),
      );
      const data = parse(releaseBreakGlassRequest, request.body);

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const current = await loadElevation(tx, tenantId, request.params.elevationId, true);
          assertVersionMatches(expected, current.version, "break_glass_elevation");

          if (current.state !== "active") {
            throw unprocessable("BREAK_GLASS_NOT_ACTIVE", "Only an approved elevation is released", {
              state: current.state,
            });
          }
          if (current.subject_id === session.subjectId) {
            throw unprocessable(
              "BREAK_GLASS_SELF_RELEASE",
              "The person elevated cannot approve their own release",
              { hint: "Another security operator releases it; it also ends by itself at expiry" },
            );
          }

          await tx`
            UPDATE core.break_glass_elevations
            SET state = 'released',
                release_cause = ${data.cause},
                release_recovery_verification = ${data.recoveryVerification},
                released_by_subject_id = ${session.subjectId},
                released_at = now(),
                version = version + 1
            WHERE id = ${current.id}
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "break_glass.released",
            resourceType: "break_glass_elevation",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            reason: data.cause,
            correlationId,
            requestIp: request.clientIp,
          });

          reply.header("etag", etagOf(current.version + 1));
          return { ...toView(await loadElevation(tx, tenantId, current.id, false)), requestId, asOf };
        }),
      );
    },
  );

  /**
   * Access quarantine — 02 §2.6.
   *
   * Ends every active role binding of the subject at once, by one person, under an effective
   * elevation. Getting access back is an ordinary two-person grant, so the fast path only ever
   * removes. Evidence, attestations, readiness, votes and entitlements are untouched: this writes
   * `role_bindings.revoked_at` and nothing else.
   */
  app.post("/api/v1/admin/break-glass/quarantine", async (request, reply) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "break_glass.quarantine",
      tenantResource(tenantId),
      sessionFacts(session),
    );
    const data = parse(quarantineAccessRequest, request.body);
    const elevationId = elevationOf(session);

    const { requestId, asOf, correlationId } = request.context;
    const result = await withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
        if (data.subjectId === session.subjectId) {
          throw unprocessable(
            "BREAK_GLASS_SELF_QUARANTINE",
            "Quarantining yourself would end your own elevation mid-incident",
          );
        }
        const [subject] = await tx<{ id: string }[]>`
          SELECT id FROM core.subjects WHERE tenant_id = ${tenantId} AND id = ${data.subjectId}
        `;
        if (!subject) throw notFound("Subject not found");

        const revoked = await tx<{ id: string }[]>`
          UPDATE core.role_bindings SET revoked_at = now(), version = version + 1
          WHERE tenant_id = ${tenantId} AND subject_id = ${data.subjectId} AND revoked_at IS NULL
          RETURNING id
        `;

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "break_glass.access_quarantined",
          resourceType: "subject",
          resourceId: data.subjectId,
          reason: data.reason,
          correlationId,
          requestIp: request.clientIp,
          detail: { elevationId, revokedBindingIds: revoked.map((row) => row.id) },
        });

        return {
          subjectId: data.subjectId,
          elevationId,
          revokedBindingIds: revoked.map((row) => row.id),
        };
      }),
    );
    return reply.code(200).send({ ...result, requestId, asOf });
  });
}

/** The elevation behind the session's `break_glass` binding. Authorization already required it. */
function elevationOf(session: EnrolledSession): string {
  const binding = session.roleBindings.find((candidate) => candidate.role === BREAK_GLASS_ROLE);
  if (!binding?.elevationId) {
    throw new Error("break_glass binding without an elevation id");
  }
  return binding.elevationId;
}
