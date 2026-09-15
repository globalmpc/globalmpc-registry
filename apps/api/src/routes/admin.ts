import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  ROLE_MINIMUM_ASSURANCE,
  bindWalletRequest,
  createNotificationSinkRequest,
  updateNotificationSinkRequest,
  createRoleGrantRequest,
  createSubjectRequest,
  decideRoleGrantRequest,
  disableWalletRequest,
} from "@mpc/api-contract";
import { ACTION_POLICIES } from "@mpc/api-contract";
import {
  assertEndpointShape,
  isAllowedWebhookSecretReference,
  WEBHOOK_SECRET_ENV_PREFIX,
  WEBHOOK_SECRET_FILE_PREFIX,
} from "@mpc/config";
import { badRequest, conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { assertAuthorized, sessionFacts, tenantResource } from "../plugins/authorize.js";
import { hashRequest, withIdempotency } from "../plugins/idempotency.js";
import { recordAudit } from "../audit.js";
import {
  assertVersionMatches,
  etagOf,
  requireIfMatch,
  requireMutationContext,
  requireReadContext,
} from "./shared.js";

/**
 * Platform administration — spec 11 §11.2 Administration.
 *
 * **This did not exist before.** The only path for granting roles was the CLI in `bootstrap.ts`,
 * which runs on a superuser connection that bypasses RLS. Adding a person to a deployed system
 * meant logging into the server every time.
 *
 * **Two-person rule (decision).** Moving role grants into the API creates "a role that grants
 * roles". If that one role can give itself anything, the whole permission table loses its
 * meaning. The "no operator-only transition" rule of 02 §2.8 applies here too: the proposal and
 * the approval are made by different people. The DB's `role_grant_two_person` blocks the same
 * thing, so adding a route does not leak the rule.
 *
 * **Disabling a wallet takes one person.** Cutting off a lost or compromised key is urgent;
 * requiring two people keeps the key alive while waiting for the second. Instead, the reason
 * code and the actor are recorded (AC-27).
 *
 * **Tenant creation is not here.** A session is always bound to one tenant, and RLS enforces
 * it. A route that creates another tenant must cross that boundary, so it needs a SECURITY
 * DEFINER function, which creates an **HTTP-reachable tenant creation path**. The blast radius
 * of one hijacked operator session widens from one tenant to the whole platform. Tenant
 * creation is a once-per-deployment seed, so it stays in the `bootstrap` CLI. This decision is
 * reversible.
 */

interface WalletRow {
  id: string;
  subject_id: string | null;
  wallet_address: string;
  chain_id: number;
  assurance_level: "wallet_only" | "identity_bound" | "high_assurance";
  bound_at: Date | null;
  disabled_at: Date | null;
  version: number;
}

interface RoleRow {
  id: string;
  subject_id: string;
  role: string;
  project_id: string | null;
  granted_at: Date;
  revoked_at: Date | null;
}

interface SubjectRow {
  id: string;
  display_name: string;
  kind: "person" | "service";
}

interface GrantRow {
  id: string;
  subject_id: string;
  subject_name: string;
  role: string;
  project_id: string | null;
  reason: string;
  requested_by_subject_id: string;
  requested_at: Date;
  state: "pending" | "approved" | "rejected" | "withdrawn";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  version: number;
}

function toGrant(row: GrantRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    role: row.role,
    projectId: row.project_id,
    reason: row.reason,
    requestedBySubjectId: row.requested_by_subject_id,
    requestedAt: row.requested_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    version: row.version,
    requestId,
    asOf,
  };
}

/** Levels a bind may carry. Read from the contract so the route and OpenAPI cannot diverge. */
const ASSURANCE_LEVELS: readonly string[] = bindWalletRequest.shape.assuranceLevel.options;

/** Roles that can approve role grants — their wallets are not bound from the UI. */
const ADMIN_ROLES: readonly string[] = ACTION_POLICIES["admin.role.approve"]?.allowedRoles ?? [];

export async function registerAdminRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * Reads one subject **together** with its wallets and roles.
   *
   * Queried separately, the state "has roles but every bound wallet is disabled" is split
   * across two screens — that state is an account that cannot log in, and it is the first
   * thing the admin screen must show.
   */
  async function readSubjects(
    tx: postgres.Sql | postgres.TransactionSql,
    tenantId: string,
    subjectId?: string,
  ): Promise<ReturnType<typeof shapeSubject>[]> {
    const subjects = subjectId
      ? await tx<SubjectRow[]>`
          SELECT id, display_name, kind FROM core.subjects
          WHERE tenant_id = ${tenantId} AND id = ${subjectId}
        `
      : await tx<SubjectRow[]>`
          SELECT id, display_name, kind FROM core.subjects
          WHERE tenant_id = ${tenantId} ORDER BY display_name
        `;
    if (subjects.length === 0) return [];

    const ids = subjects.map((subject) => subject.id);
    const wallets = await tx<WalletRow[]>`
      SELECT id, subject_id, wallet_address, chain_id, assurance_level,
             bound_at, disabled_at, version
      FROM core.wallet_identities
      WHERE tenant_id = ${tenantId} AND subject_id = ANY(${ids})
      ORDER BY created_at
    `;
    const roles = await tx<RoleRow[]>`
      SELECT id, subject_id, role, project_id, granted_at, revoked_at
      FROM core.role_bindings
      WHERE tenant_id = ${tenantId} AND subject_id = ANY(${ids})
      ORDER BY granted_at
    `;

    return subjects.map((subject) =>
      shapeSubject(
        subject,
        wallets.filter((wallet) => wallet.subject_id === subject.id),
        roles.filter((role) => role.subject_id === subject.id),
      ),
    );
  }

  function shapeSubject(
    subject: SubjectRow,
    wallets: readonly WalletRow[],
    roles: readonly RoleRow[],
  ) {
    return {
      id: subject.id,
      displayName: subject.display_name,
      kind: subject.kind,
      wallets: wallets.map((wallet) => ({
        id: wallet.id,
        walletAddress: wallet.wallet_address,
        chainId: wallet.chain_id,
        assuranceLevel: wallet.assurance_level,
        boundAt: wallet.bound_at?.toISOString() ?? null,
        disabledAt: wallet.disabled_at?.toISOString() ?? null,
        version: wallet.version,
      })),
      roles: roles.map((role) => ({
        id: role.id,
        role: role.role,
        projectId: role.project_id,
        grantedAt: role.granted_at.toISOString(),
        revokedAt: role.revoked_at?.toISOString() ?? null,
      })),
      // Session resolution only sees wallets with `disabled_at IS NULL` (0005). Without one,
      // the subject cannot log in whatever its roles.
      locked: wallets.every((wallet) => wallet.disabled_at !== null),
    };
  }

  app.get("/api/v1/admin/subjects", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "admin.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const { requestId, asOf } = request.context;
    return withTenant(sql, { tenantId }, async (tx) => ({
      items: (await readSubjects(tx, tenantId)).map((subject) => ({
        ...subject,
        requestId,
        asOf,
      })),
      requestId,
      asOf,
    }));
  });

  app.post("/api/v1/admin/subjects", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.subject.manage",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const parsed = createSubjectRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    const { requestId, asOf, correlationId } = request.context;
    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
        const id = randomUUID();
        await tx`
          INSERT INTO core.subjects (id, tenant_id, kind, display_name)
          VALUES (${id}, ${tenantId}, ${parsed.data.kind}, ${parsed.data.displayName})
        `;

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "admin.subject.registered",
          resourceType: "subject",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.ip,
        });

        const [created] = await readSubjects(tx, tenantId, id);
        return { ...created!, requestId, asOf };
      }),
    );
  });

  app.post<{ Params: { subjectId: string } }>(
    "/api/v1/admin/subjects/:subjectId/wallets",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.wallet.manage",
        tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
        sessionFacts(session),
      );

      const parsed = bindWalletRequest.safeParse(request.body);
      if (!parsed.success) {
        /**
         * A level outside the table is a value problem, not a format problem — same as
         * `ROLE_UNKNOWN`. Answering 400 would send the client to fix the body shape.
         */
        if (parsed.error.issues.some((issue) => issue.path[0] === "assuranceLevel")) {
          throw unprocessable("ASSURANCE_LEVEL_INVALID", "Assurance level is not in the assurance table", {
            allowed: ASSURANCE_LEVELS,
          });
        }
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      const address = parsed.data.walletAddress.toLowerCase();

      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
          const [subject] = await tx<{ id: string }[]>`
            SELECT id FROM core.subjects WHERE tenant_id = ${tenantId} AND id = ${request.params.subjectId}
          `;
          if (!subject) throw notFound("Subject not found");

          /**
           * Wallets are not bound from the UI to subjects with admin authority.
           *
           * Binding a wallet is a one-person act. If operator A binds their wallet to operator B,
           * A logs in as B and approves their own proposal — the two-person rule for role grants
           * collapses into one person. An operator key rotation creates a new subject through
           * bootstrap (infrastructure access) and disables the old wallet.
           * Recovery for people without roles (AC-27) still works.
           */
          const [adminBinding] = await tx<{ role: string }[]>`
            SELECT role FROM core.role_bindings
            WHERE tenant_id = ${tenantId} AND subject_id = ${request.params.subjectId}
              AND revoked_at IS NULL AND role = ANY(${[...ADMIN_ROLES]})
            LIMIT 1
          `;
          if (adminBinding) {
            throw forbidden(
              "WALLET_BIND_ADMIN_SUBJECT",
              "A wallet cannot be bound from the UI to a subject with admin authority",
              { hint: "Operator key rotation creates a new subject via bootstrap and disables the old wallet" },
            );
          }

          /**
           * An address is bound to only one subject per chain (`UNIQUE (wallet_address,
           * chain_id)`). If already bound, it is not silently moved — moving it would make the
           * address's past signatures read as someone else's.
           */
          const [existing] = await tx<{ subject_id: string | null; disabled_at: Date | null }[]>`
            SELECT subject_id, disabled_at FROM core.wallet_identities
            WHERE wallet_address = ${address} AND chain_id = ${parsed.data.chainId}
          `;
          if (existing) {
            throw conflict(
              "WALLET_ALREADY_BOUND",
              "This address is already bound. It is not moved to another subject.",
              { hint: "To recover with a new key, bind a new address and disable the old one" },
            );
          }

          const id = randomUUID();
          await tx`
            INSERT INTO core.wallet_identities (
              id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
            ) VALUES (
              ${id}, ${tenantId}, ${request.params.subjectId}, ${address},
              ${parsed.data.chainId}, ${parsed.data.assuranceLevel}, now()
            )
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "admin.wallet.bound",
            resourceType: "wallet_identity",
            resourceId: id,
            afterVersion: 1,
            correlationId,
            requestIp: request.ip,
            // The level decides which roles this wallet can exercise. Without the stated basis
            // the record shows who granted it but not why.
            detail: {
              subjectId: request.params.subjectId,
              chainId: parsed.data.chainId,
              assuranceLevel: parsed.data.assuranceLevel,
              justification: parsed.data.justification,
            },
          });

          const [updated] = await readSubjects(tx, tenantId, request.params.subjectId);
          return { ...updated!, requestId, asOf };
        }),
      );
    },
  );

  app.post<{ Params: { walletId: string } }>(
    "/api/v1/admin/wallets/:walletId/disable",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.wallet.manage",
        tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
        sessionFacts(session),
      );

      /**
       * Checks If-Match **before** the body.
       *
       * In the reverse order, a request missing the header gets a 400 (body error). The client
       * keeps fixing the body in a loop, and the missing header never surfaces.
       */
      const expected = requireIfMatch(request);

      const parsed = disableWalletRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
          const [wallet] = await tx<WalletRow[]>`
            SELECT id, subject_id, wallet_address, chain_id, assurance_level,
                   bound_at, disabled_at, version
            FROM core.wallet_identities
            WHERE tenant_id = ${tenantId} AND id = ${request.params.walletId}
            FOR UPDATE
          `;
          if (!wallet) throw notFound("Wallet not found");
          assertVersionMatches(expected, wallet.version, "wallet_identity");

          /**
           * A caller does not disable their own wallet.
           *
           * The caller always has admin authority, so this also prevents "the last operator
           * disappearing". There is no screen to undo it; a misclick is recoverable only via
           * bootstrap. If your own key is compromised, another operator disables it.
           */
          if (wallet.subject_id === session.subjectId) {
            throw unprocessable(
              "WALLET_DISABLE_SELF",
              "You cannot disable your own wallet",
              { hint: "If your own key is compromised, another operator disables it" },
            );
          }

          if (wallet.disabled_at !== null) {
            throw unprocessable(
              "WALLET_ALREADY_DISABLED",
              "Wallet is already disabled",
              { disabledAt: wallet.disabled_at.toISOString() },
            );
          }

          await tx`
            UPDATE core.wallet_identities
            SET disabled_at = now(), version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${wallet.id}
          `;

          /**
           * Records why it was cut off. Loss, compromise, rotation, and departure have the same
           * effect but **differ in how past signatures should be read.**
           */
          await tx`
            INSERT INTO core.wallet_disable_events (
              id, tenant_id, wallet_identity_id, reason_code, detail, disabled_by_subject_id
            ) VALUES (
              ${randomUUID()}, ${tenantId}, ${wallet.id}, ${parsed.data.reasonCode},
              ${parsed.data.detail}, ${session.subjectId}
            )
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "admin.wallet.disabled",
            resourceType: "wallet_identity",
            resourceId: wallet.id,
            beforeVersion: wallet.version,
            afterVersion: wallet.version + 1,
            correlationId,
            requestIp: request.ip,
          });

          reply.header("etag", etagOf(wallet.version + 1));
          const [updated] = await readSubjects(tx, tenantId, wallet.subject_id!);
          return { ...updated!, requestId, asOf };
        }),
      );
    },
  );

  app.get("/api/v1/admin/role-grants", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "admin.read",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => tx<GrantRow[]>`
      SELECT g.*, s.display_name AS subject_name
      FROM core.role_grant_requests g
      JOIN core.subjects s ON s.id = g.subject_id
      WHERE g.tenant_id = ${tenantId}
      ORDER BY g.requested_at DESC
    `);

    return { items: rows.map((row) => toGrant(row, requestId, asOf)), requestId, asOf };
  });

  app.post("/api/v1/admin/role-grants", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.role.propose",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const parsed = createRoleGrantRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    // A nonexistent role cannot be proposed. If it failed at approval time, the approver could not
    // tell what went wrong.
    if (ROLE_MINIMUM_ASSURANCE[parsed.data.role] === undefined) {
      throw unprocessable("ROLE_UNKNOWN", "Role is not in the permission table", {
        role: parsed.data.role,
      });
    }

    const { requestId, asOf, correlationId } = request.context;
    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
        const [subject] = await tx<{ id: string }[]>`
          SELECT id FROM core.subjects WHERE tenant_id = ${tenantId} AND id = ${parsed.data.subjectId}
        `;
        if (!subject) throw notFound("Subject not found");

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.role_grant_requests (
              id, tenant_id, subject_id, organization_id, project_id, role, reason,
              requested_by_subject_id
            ) VALUES (
              ${id}, ${tenantId}, ${parsed.data.subjectId},
              ${parsed.data.organizationId ?? null}, ${parsed.data.projectId ?? null},
              ${parsed.data.role}, ${parsed.data.reason}, ${session.subjectId}
            )
          `;
        } catch (caught) {
          // Two pending proposals for the same target blur which one the approver approved in the
          // history. A partial UNIQUE in the DB blocks it.
          if (caught instanceof Error && caught.message.includes("role_grant_requests_one_pending")) {
            throw conflict("ROLE_GRANT_ALREADY_PENDING", "A pending proposal already exists for this target");
          }
          throw caught;
        }

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "admin.role_grant.proposed",
          resourceType: "role_grant_request",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.ip,
        });

        const [row] = await tx<GrantRow[]>`
          SELECT g.*, s.display_name AS subject_name
          FROM core.role_grant_requests g
          JOIN core.subjects s ON s.id = g.subject_id
          WHERE g.id = ${id}
        `;
        return toGrant(row!, requestId, asOf);
      }),
    );
  });

  app.post<{ Params: { grantId: string } }>(
    "/api/v1/admin/role-grants/:grantId/decision",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.role.approve",
        tenantResource(tenantId, { state: "pending", statesAllowingAction: ["pending"] }),
        sessionFacts(session),
      );

      // Checks If-Match before the body — same reason as above.
      const expected = requireIfMatch(request);

      const parsed = decideRoleGrantRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
          const [grant] = await tx<(GrantRow & { organization_id: string | null })[]>`
            SELECT g.*, s.display_name AS subject_name
            FROM core.role_grant_requests g
            JOIN core.subjects s ON s.id = g.subject_id
            WHERE g.tenant_id = ${tenantId} AND g.id = ${request.params.grantId}
            FOR UPDATE OF g
          `;
          if (!grant) throw notFound("Proposal not found");
          assertVersionMatches(expected, grant.version, "role_grant_request");

          if (grant.state !== "pending") {
            throw unprocessable("ROLE_GRANT_ALREADY_DECIDED", "Proposal is already decided", {
              state: grant.state,
            });
          }

          /**
           * Two-person rule — 02 §2.8.
           *
           * The DB CHECK blocks the same thing, but filtering here first says **why it was
           * rejected**. A constraint violation message does not tell the user what to do next.
           */
          if (grant.requested_by_subject_id === session.subjectId) {
            throw unprocessable(
              "ROLE_GRANT_SELF_APPROVAL",
              "The proposer cannot approve their own proposal",
              { hint: "Another admin holder decides" },
            );
          }

          const approved = parsed.data.decision === "approve";
          let bindingId: string | null = null;

          if (approved) {
            bindingId = randomUUID();
            await tx`
              INSERT INTO core.role_bindings (
                id, tenant_id, subject_id, organization_id, project_id, role
              ) VALUES (
                ${bindingId}, ${tenantId}, ${grant.subject_id}, ${grant.organization_id},
                ${grant.project_id}, ${grant.role}
              )
            `;
          }

          await tx`
            UPDATE core.role_grant_requests
            SET state = ${approved ? "approved" : "rejected"},
                decided_by_subject_id = ${session.subjectId},
                decided_at = now(),
                decision_reason = ${parsed.data.reason},
                role_binding_id = ${bindingId},
                version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${grant.id}
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: approved ? "admin.role_grant.approved" : "admin.role_grant.rejected",
            resourceType: "role_grant_request",
            resourceId: grant.id,
            beforeVersion: grant.version,
            afterVersion: grant.version + 1,
            correlationId,
            requestIp: request.ip,
          });

          reply.header("etag", etagOf(grant.version + 1));
          const [row] = await tx<GrantRow[]>`
            SELECT g.*, s.display_name AS subject_name
            FROM core.role_grant_requests g
            JOIN core.subjects s ON s.id = g.subject_id
            WHERE g.id = ${grant.id}
          `;
          return toGrant(row!, requestId, asOf);
        }),
      );
    },
  );

  // --- Alert sinks ------------------------------------------
  //
  // **Secrets are not returned.** `secret_reference` is not the value, but it is not returned
  // either — a path like `file:/run/secrets/x` is itself information about the deployment
  // layout. Only whether it is set is returned.

  interface SinkRow {
    id: string;
    url: string;
    state: "active" | "paused";
    has_secret: boolean;
    created_at: Date;
    version: number;
    pending: string;
    delivered: string;
    failed: string;
    last_error: string | null;
  }

  function toSink(row: SinkRow, requestId: string, asOf: string) {
    return {
      id: row.id,
      url: row.url,
      state: row.state,
      hasSecret: row.has_secret,
      createdAt: row.created_at.toISOString(),
      version: row.version,
      delivery: {
        pending: Number(row.pending),
        delivered: Number(row.delivered),
        failed: Number(row.failed),
        lastError: row.last_error,
      },
      requestId,
      asOf,
    };
  }

  /**
   * Reads delivery state alongside.
   *
   * A bare sink list does not separate "registered" from "actually delivering". Configured
   * but sending nothing is the worst state — everyone believes it is sending.
   */
  async function readSinks(
    tx: postgres.Sql | postgres.TransactionSql,
    tenantId: string,
    sinkId?: string,
  ): Promise<SinkRow[]> {
    return tx<SinkRow[]>`
      SELECT s.id, s.url, s.state, (s.secret_reference <> '') AS has_secret,
             s.created_at, s.version,
             COALESCE(d.pending, 0)   AS pending,
             COALESCE(d.delivered, 0) AS delivered,
             COALESCE(d.failed, 0)    AS failed,
             d.last_error
      FROM core.notification_sinks s
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE state = 'pending')   AS pending,
               count(*) FILTER (WHERE state = 'delivered') AS delivered,
               count(*) FILTER (WHERE state = 'failed')    AS failed,
               (ARRAY_AGG(last_error ORDER BY attempts DESC)
                  FILTER (WHERE last_error IS NOT NULL))[1] AS last_error
        FROM core.notification_deliveries
        WHERE sink_id = s.id
      ) d ON true
      WHERE s.tenant_id = ${tenantId}
        AND (${sinkId ?? null}::uuid IS NULL OR s.id = ${sinkId ?? null})
      ORDER BY s.created_at
    `;
  }

  app.get("/api/v1/admin/notification-sinks", async (request) => {
    const { session, tenantId } = requireReadContext(request);
    assertAuthorized(
      session,
      "admin.notification.manage",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const { requestId, asOf } = request.context;
    const rows = await withTenant(sql, { tenantId }, (tx) => readSinks(tx, tenantId));
    return { items: rows.map((row) => toSink(row, requestId, asOf)), requestId, asOf };
  });

  app.post("/api/v1/admin/notification-sinks", async (request) => {
    const { session, tenantId, idempotencyKey } = requireMutationContext(request);
    const effectiveRole = assertAuthorized(
      session,
      "admin.notification.manage",
      tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
      sessionFacts(session),
    );

    const parsed = createNotificationSinkRequest.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("REQUEST_INVALID", "Request format is invalid", {
        issues: parsed.error.issues,
      });
    }

    /**
     * Where the worker will send, and which secret it will read, are checked on save (W-087).
     *
     * The worker checks both again at send time, with the name resolved — this is the rejection
     * the operator sees on the spot. The reference is not echoed back in the error.
     */
    try {
      assertEndpointShape(parsed.data.url);
    } catch (error) {
      throw badRequest("SINK_URL_NOT_ALLOWED", "This webhook URL is not allowed", {
        reason: error instanceof Error ? error.message : "Endpoint cannot be used",
      });
    }
    if (!isAllowedWebhookSecretReference(parsed.data.secretReference)) {
      throw badRequest(
        "SINK_SECRET_REFERENCE_NOT_ALLOWED",
        `Secret reference must be env:${WEBHOOK_SECRET_ENV_PREFIX}<NAME> or file:${WEBHOOK_SECRET_FILE_PREFIX}<name>`,
      );
    }

    const { requestId, asOf, correlationId } = request.context;
    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.notification_sinks (id, tenant_id, url, secret_reference)
            VALUES (${id}, ${tenantId}, ${parsed.data.url}, ${parsed.data.secretReference})
          `;
        } catch (caught) {
          if (caught instanceof Error && caught.message.includes("notification_sinks_tenant_id_url_key")) {
            throw conflict("SINK_ALREADY_REGISTERED", "This address is already registered");
          }
          throw caught;
        }

        await recordAudit(tx, {
          tenantId,
          session,
          effectiveRole,
          command: "admin.notification_sink.registered",
          resourceType: "notification_sink",
          resourceId: id,
          afterVersion: 1,
          correlationId,
          requestIp: request.ip,
        });

        const [created] = await readSinks(tx, tenantId, id);
        return toSink(created!, requestId, asOf);
      }),
    );
  });

  app.post<{ Params: { sinkId: string } }>(
    "/api/v1/admin/notification-sinks/:sinkId/state",
    async (request, reply) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.notification.manage",
        tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
        sessionFacts(session),
      );
      const expected = requireIfMatch(request);

      const parsed = updateNotificationSinkRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
          const [current] = await tx<{ id: string; version: number }[]>`
            SELECT id, version FROM core.notification_sinks
            WHERE tenant_id = ${tenantId} AND id = ${request.params.sinkId}
            FOR UPDATE
          `;
          if (!current) throw notFound("Alert sink not found");
          assertVersionMatches(expected, current.version, "notification_sink");

          /**
           * Pauses instead of deleting.
           *
           * Deleting breaks the delivery history FK, and with it the evidence for answering "why
           * did alerts stop". A paused sink receives no new deliveries (the trigger only looks at
           * `active`).
           */
          await tx`
            UPDATE core.notification_sinks
            SET state = ${parsed.data.state}, version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${current.id}
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: `admin.notification_sink.${parsed.data.state}`,
            resourceType: "notification_sink",
            resourceId: current.id,
            beforeVersion: current.version,
            afterVersion: current.version + 1,
            correlationId,
            requestIp: request.ip,
          });

          reply.header("etag", etagOf(current.version + 1));
          const [updated] = await readSinks(tx, tenantId, current.id);
          return toSink(updated!, requestId, asOf);
        }),
      );
    },
  );
}
