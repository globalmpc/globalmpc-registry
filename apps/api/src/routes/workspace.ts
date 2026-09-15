import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  assertAuthorized,
  holdsActionRole,
  sessionFacts,
  tenantResource,
  visibleProjectScope,
} from "../plugins/authorize.js";
import { requireMutationContext, requireReadContext } from "./shared.js";
import { notFound } from "../errors.js";
import type { Session } from "../plugins/session.js";

/**
 * Notifications the caller may see — sent to them, or sent to a role they hold on a project
 * they can see.
 *
 * Shared by the list and by mark-read (W-086). Mark-read returns the summary and link, so a
 * filter only on the list left every hidden notification readable by id.
 */
function visibleNotificationFilter(tx: postgres.TransactionSql, session: Session) {
  const roles = session.roleBindings.map((binding) => binding.role);
  // Role notifications too, only for projects the caller can see. Matching on role name alone
  // would carry another company's project stale reasons and links as is.
  const visible = visibleProjectScope(session, "project.read");

  return tx`(
    n.subject_id = ${session.subjectId}
    OR (
      n.audience_role = ANY(${roles})
      AND (
        n.project_id IS NULL
        OR ${visible === "all" ? tx`TRUE` : tx`n.project_id = ANY(${visible as string[]}::uuid[])`}
      )
    )
  )`;
}

/**
 * Workspace aggregates — spec 11 §11.2.
 *
 * These two screens were missing not for lack of data but because **the structure only showed
 * things once a single project was opened**. "What was published in this tenant" and "what
 * do I need to do now" are not questions to answer by opening projects one by one.
 *
 * Everything here is a read. State-changing paths belong to each domain route — once an
 * aggregate screen gains mutations, authorization checks split into two places.
 */

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  app.get("/api/v1/registry-entries", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "registry.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    // Only records from projects the caller can see. Same reason as the project list.
    const visible = visibleProjectScope(session, "registry.read");

    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => tx<
      {
        entry_id: string;
        registry_type: "project" | "verification" | "asset";
        public_key: string;
        project_id: string | null;
        latest_version: number;
        status: "draft" | "published" | "revoked" | "superseded";
        published_at: Date | null;
        revoked_at: Date | null;
        anchored: boolean;
      }[]
    >`
      SELECT DISTINCT ON (e.id)
             e.id AS entry_id,
             e.registry_type,
             e.public_key,
             p.id AS project_id,
             v.version AS latest_version,
             v.status,
             v.published_at,
             v.revoked_at,
             -- Publishing and anchoring are different events. Merged into one column, it reads as
             -- "published, so it is on chain".
             EXISTS (
               SELECT 1 FROM chain.anchor_batch_leaves l WHERE l.entry_version_id = v.id
             ) AS anchored
      FROM core.registry_entries e
      JOIN core.registry_entry_versions v ON v.entry_id = e.id
      LEFT JOIN core.projects p ON p.id = e.subject_id
      WHERE e.tenant_id = ${tenantId}
        AND ${visible === "all" ? tx`TRUE` : tx`p.id = ANY(${visible as string[]}::uuid[])`}
      ORDER BY e.id, v.version DESC
    `);

    return {
      items: rows.map((row) => ({
        entryId: row.entry_id,
        registryType: row.registry_type,
        publicKey: row.public_key,
        projectId: row.project_id,
        latestVersion: row.latest_version,
        status: row.status,
        publishedAt: row.published_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        anchored: row.anchored,
      })),
      requestId,
      asOf,
    };
  });

  app.get("/api/v1/my-work", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "project.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const { requestId, asOf } = request.context;
    const subjectId = session.subjectId;
    const visible = visibleProjectScope(session, "project.read");

    return withTenant(sql, { tenantId }, async (tx) => {
      /**
       * Reviews assigned to me.
       *
       * Only assignments with `revoked_at IS NULL` — if withdrawn assignments stay in the list,
       * people keep seeing work they no longer need to do.
       */
      const assigned = subjectId
        ? await tx<
            {
              case_id: string;
              project_id: string;
              project_name: string;
              state: string;
              assigned_at: Date;
              conflict_status: string;
            }[]
          >`
            SELECT c.id AS case_id, c.project_id, p.name AS project_name,
                   c.state::text AS state, a.assigned_at, a.conflict_status
            FROM core.assignments a
            JOIN core.verification_cases c ON c.id = a.case_id
            JOIN core.projects p ON p.id = c.project_id
            WHERE a.tenant_id = ${tenantId}
              AND a.subject_id = ${subjectId}
              AND a.revoked_at IS NULL
              -- A finished case is not a to-do. registered/declined/cancelled/
              -- superseded/revoked leave nothing for the reviewer to act on.
              AND c.state IN ('draft', 'assigned', 'in_review', 'changes_requested', 'signed')
            ORDER BY a.assigned_at
          `
        : [];

      /** Started by me and waiting on someone else's decision. Nothing for me to do. */
      const waiting = subjectId
        ? await tx<{ id: string; role: string; subject_name: string; requested_at: Date }[]>`
            SELECT g.id, g.role, s.display_name AS subject_name, g.requested_at
            FROM core.role_grant_requests g
            JOIN core.subjects s ON s.id = g.subject_id
            WHERE g.tenant_id = ${tenantId}
              AND g.state = 'pending'
              AND g.requested_by_subject_id = ${subjectId}
            ORDER BY g.requested_at
          `
        : [];

      /**
       * Open items assigned to no one.
       *
       * Why this is listed separately: if only assigned work is visible, **work nobody has taken**
       * stays invisible forever. This is where neglect happens silently.
       */
      const staleSignals = await tx<
        { id: string; project_id: string | null; reason: string; detected_at: Date }[]
      >`
        SELECT id, project_id, reason, detected_at
        FROM core.evidence_stale_signals
        WHERE tenant_id = ${tenantId} AND resolution = 'open'
          AND ${visible === "all" ? tx`TRUE` : tx`project_id = ANY(${visible as string[]}::uuid[])`}
        ORDER BY detected_at
        LIMIT 50
      `;

      // Pending proposals I did not make = what I can decide.
      // Without a deciding role they are not decidable by me — listing them would only leak who receives which role.
      const decisions = !holdsActionRole(session, "admin.role.approve") ? [] : await tx<
        { id: string; role: string; subject_name: string; requested_at: Date }[]
      >`
        SELECT g.id, g.role, s.display_name AS subject_name, g.requested_at
        FROM core.role_grant_requests g
        JOIN core.subjects s ON s.id = g.subject_id
        WHERE g.tenant_id = ${tenantId}
          AND g.state = 'pending'
          AND (${subjectId}::uuid IS NULL OR g.requested_by_subject_id <> ${subjectId})
        ORDER BY g.requested_at
      `;

      return {
        assignedToMe: assigned.map((row) => ({
          caseId: row.case_id,
          projectId: row.project_id,
          projectName: row.project_name,
          state: row.state,
          assignedAt: row.assigned_at.toISOString(),
          conflictStatus: row.conflict_status,
        })),
        waitingOnOthers: waiting.map((row) => ({
          kind: "role_grant" as const,
          id: row.id,
          summary: `Proposal to grant ${row.role} to ${row.subject_name} — awaiting someone else's decision`,
          since: row.requested_at.toISOString(),
        })),
        unassigned: [
          ...staleSignals.map((row) => ({
            kind: "stale_signal" as const,
            id: row.id,
            projectId: row.project_id,
            summary: row.reason,
            since: row.detected_at.toISOString(),
          })),
          ...decisions.map((row) => ({
            kind: "role_grant_decision" as const,
            id: row.id,
            projectId: null,
            summary: `Proposal to grant ${row.role} to ${row.subject_name} — decision required`,
            since: row.requested_at.toISOString(),
          })),
        ],
        requestId,
        asOf,
      };
    });
  });

  /**
   * Notifications.
   *
   * Returns both those sent to me and **those sent to a role I hold**. Without the latter,
   * events assigned to no one, such as stale signals or revocations, reach no one
   * at all.
   *
   * No delivery channel (email, webhook) has been decided. The in-app read path opens
   * first — without it, there is nothing to send whichever channel is chosen.
   */
  app.get("/api/v1/notifications", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "project.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const { requestId, asOf } = request.context;
    const subjectId = session.subjectId;

    const rows = await withTenant(sql, { tenantId }, (tx) => tx<
      {
        id: string;
        kind: "review_assigned" | "readiness_gap" | "evidence_stale" | "registry_revoked";
        subject_id: string | null;
        audience_role: string | null;
        project_id: string | null;
        summary: string;
        link: string;
        occurred_at: Date;
        read: boolean;
      }[]
    >`
      SELECT n.id, n.kind, n.subject_id, n.audience_role, n.project_id,
             n.summary, n.link, n.occurred_at,
             (r.notification_id IS NOT NULL) AS read
      FROM core.notifications n
      LEFT JOIN core.notification_reads r
        ON r.notification_id = n.id AND r.subject_id = ${subjectId}
      WHERE n.tenant_id = ${tenantId}
        AND ${visibleNotificationFilter(tx, session)}
      ORDER BY n.occurred_at DESC
      LIMIT 100
    `);

    return {
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        audience: row.subject_id === null ? ("role" as const) : ("you" as const),
        audienceRole: row.audience_role,
        projectId: row.project_id,
        summary: row.summary,
        link: row.link,
        occurredAt: row.occurred_at.toISOString(),
        read: row.read,
      })),
      requestId,
      asOf,
    };
  });

  app.post<{ Params: { notificationId: string } }>(
    "/api/v1/notifications/:notificationId/read",
    async (request) => {
      const { session, tenantId } = requireMutationContext(request);
      assertAuthorized(
        session,
        "project.read",
        tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
        sessionFacts(session),
      );

      const { requestId, asOf } = request.context;
      const subjectId = session.subjectId;

      return withTenant(sql, { tenantId }, async (tx) => {
        const [found] = await tx<
          {
            id: string;
            kind: "review_assigned" | "readiness_gap" | "evidence_stale" | "registry_revoked";
            subject_id: string | null;
            audience_role: string | null;
            project_id: string | null;
            summary: string;
            link: string;
            occurred_at: Date;
          }[]
        >`
          SELECT n.id, n.kind, n.subject_id, n.audience_role, n.project_id,
                 n.summary, n.link, n.occurred_at
          FROM core.notifications n
          WHERE n.tenant_id = ${tenantId} AND n.id = ${request.params.notificationId}
            AND ${visibleNotificationFilter(tx, session)}
        `;
        // A hidden notification answers exactly like a missing one — no body, no read row.
        if (!found) throw notFound("Notification not found");

        /**
         * Read status is recorded **only for me**.
         *
         * If my reading a role notification cleared it for others, no one would look again
         * when I did not handle it.
         */
        await tx`
          INSERT INTO core.notification_reads (notification_id, subject_id, tenant_id)
          VALUES (${found.id}, ${subjectId}, ${tenantId})
          ON CONFLICT DO NOTHING
        `;

        return {
          id: found.id,
          kind: found.kind,
          audience: found.subject_id === null ? ("role" as const) : ("you" as const),
          audienceRole: found.audience_role,
          projectId: found.project_id,
          summary: found.summary,
          link: found.link,
          occurredAt: found.occurred_at.toISOString(),
          read: true,
          requestId,
          asOf,
        };
      });
    },
  );
}
