import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import {
  ROLE_MINIMUM_ASSURANCE,
  createNotificationSinkRequest,
  updateNotificationSinkRequest,
  createRoleGrantRequest,
  createSubjectRequest,
  decideRoleGrantRequest,
  disableWalletRequest,
  setSubjectAssuranceRequest,
} from "@mpc/api-contract";
import { SECOND_PERSON_ROLES } from "@mpc/api-contract";
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
import { revokeSubjectSessions } from "../plugins/session-token.js";
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
 * **Admins do not bind wallets (WP5).** A wallet is bound only by its holder, who signs a
 * challenge from their own account session (`routes/wallets.ts`); the application role cannot
 * insert one at all (0122). An admin typing an address could attach a key they hold to someone
 * else's account (plan §5, acceptance 9). What the bind used to carry — the identity assurance
 * level and its basis — is set on the subject instead (`…/assurance`).
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
  bound_via: "operator" | "proof";
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
  assurance_level: "wallet_only" | "identity_bound" | "high_assurance";
  has_email: boolean;
  suspended_at: Date | null;
}

interface GrantRow {
  id: string;
  subject_id: string;
  subject_name: string;
  role: string;
  project_id: string | null;
  jurisdiction: string[] | null;
  reason: string;
  requested_by_subject_id: string;
  requested_at: Date;
  state: "pending" | "approved" | "rejected" | "withdrawn";
  decided_by_subject_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  closed_reason: "proposer_suspended" | null;
  version: number;
}

function toGrant(row: GrantRow, requestId: string, asOf: string) {
  return {
    id: row.id,
    subjectId: row.subject_id,
    subjectName: row.subject_name,
    role: row.role,
    projectId: row.project_id,
    jurisdiction: row.jurisdiction,
    reason: row.reason,
    requestedBySubjectId: row.requested_by_subject_id,
    requestedAt: row.requested_at.toISOString(),
    state: row.state,
    decidedBySubjectId: row.decided_by_subject_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
    closedReason: row.closed_reason,
    version: row.version,
    requestId,
    asOf,
  };
}

/** Levels an admin may set. Read from the contract so the route and OpenAPI cannot diverge. */
const ASSURANCE_LEVELS: readonly string[] = setSubjectAssuranceRequest.shape.assuranceLevel.options;

/**
 * Identity assurance is the subject's (0108). Before WP5 it was stated at each admin bind, so the
 * subject held the level of its strongest **active** wallet — the rule the 0108 backfill applied.
 * Disabling an operator-bound wallet still recomputes it that way; disabling a proof-bound wallet
 * (WP5) does not, because a proof never carried a level.
 */
async function syncSubjectAssurance(
  tx: postgres.TransactionSql,
  tenantId: string,
  subjectId: string,
): Promise<{ previous: string | null; current: string | null }> {
  const [row] = await tx<{ previous: string; current: string }[]>`
    WITH before AS (
      SELECT assurance_level FROM core.subjects
      WHERE tenant_id = ${tenantId} AND id = ${subjectId}
      FOR UPDATE
    )
    UPDATE core.subjects s
    SET assurance_level = COALESCE(
          (
            SELECT max(w.assurance_level) FROM core.wallet_identities w
            WHERE w.tenant_id = s.tenant_id AND w.subject_id = s.id AND w.disabled_at IS NULL
          ),
          'wallet_only'
        ),
        version = s.version + 1
    FROM before
    WHERE s.tenant_id = ${tenantId} AND s.id = ${subjectId}
    RETURNING before.assurance_level::text AS previous, s.assurance_level::text AS current
  `;
  return { previous: row?.previous ?? null, current: row?.current ?? null };
}

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
          SELECT id, display_name, kind, assurance_level, email IS NOT NULL AS has_email, suspended_at
          FROM core.subjects
          WHERE tenant_id = ${tenantId} AND id = ${subjectId}
        `
      : await tx<SubjectRow[]>`
          SELECT id, display_name, kind, assurance_level, email IS NOT NULL AS has_email, suspended_at
          FROM core.subjects
          WHERE tenant_id = ${tenantId} ORDER BY display_name
        `;
    if (subjects.length === 0) return [];

    const ids = subjects.map((subject) => subject.id);
    const wallets = await tx<WalletRow[]>`
      SELECT id, subject_id, wallet_address, chain_id, assurance_level, bound_via,
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
    // Provider names only (0124): the application role reads no identity row itself.
    const providers = await tx<{ subject_id: string; provider: "google" | "microsoft" }[]>`
      SELECT subject_id, provider FROM core.subject_sign_in_providers(${ids}::uuid[])
    `;

    return subjects.map((subject) =>
      shapeSubject(
        subject,
        wallets.filter((wallet) => wallet.subject_id === subject.id),
        roles.filter((role) => role.subject_id === subject.id),
        providers.filter((row) => row.subject_id === subject.id).map((row) => row.provider),
      ),
    );
  }

  function shapeSubject(
    subject: SubjectRow,
    wallets: readonly WalletRow[],
    roles: readonly RoleRow[],
    providers: readonly ("google" | "microsoft")[],
  ) {
    /**
     * How the person can sign in (WP6): the address and live Google / Microsoft identities. A
     * wallet is a signing key and never a way in (D3; wallet sign-in removed in WP7).
     */
    const signInMethods = [...(subject.has_email ? (["email"] as const) : []), ...providers];
    return {
      id: subject.id,
      displayName: subject.display_name,
      kind: subject.kind,
      assuranceLevel: subject.assurance_level,
      wallets: wallets.map((wallet) => ({
        id: wallet.id,
        walletAddress: wallet.wallet_address,
        chainId: wallet.chain_id,
        assuranceLevel: wallet.assurance_level,
        boundVia: wallet.bound_via,
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
      signInMethods,
      // No way in at all: whatever its roles, the person cannot sign in until an invitation or a
      // bootstrap re-run gives them an address.
      locked: signInMethods.length === 0,
      suspendedAt: subject.suspended_at?.toISOString() ?? null,
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
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
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
          requestIp: request.clientIp,
        });

        const [created] = await readSubjects(tx, tenantId, id);
        return { ...created!, requestId, asOf };
      }),
    );
  });

  /**
   * Sets a person's identity assurance level — what the admin wallet bind used to carry.
   *
   * One person, with the basis stated and kept in the audit record, as the bind was. Never for
   * oneself: raising one's own level is granting oneself the roles that need it. Lowering is
   * allowed with the same justification (a check found wanting).
   */
  app.post<{ Params: { subjectId: string } }>(
    "/api/v1/admin/subjects/:subjectId/assurance",
    async (request) => {
      const { session, tenantId, idempotencyKey } = requireMutationContext(request);
      const effectiveRole = assertAuthorized(
        session,
        "admin.subject.manage",
        tenantResource(tenantId, { state: "active", statesAllowingAction: ["active"] }),
        sessionFacts(session),
      );

      const parsed = setSubjectAssuranceRequest.safeParse(request.body);
      if (!parsed.success) {
        // A level outside the table is a value problem, not a format problem — same as
        // `ROLE_UNKNOWN`. Answering 400 would send the client to fix the body shape.
        if (parsed.error.issues.some((issue) => issue.path[0] === "assuranceLevel")) {
          throw unprocessable("ASSURANCE_LEVEL_INVALID", "Assurance level is not in the assurance table", {
            allowed: ASSURANCE_LEVELS,
          });
        }
        throw badRequest("REQUEST_INVALID", "Request format is invalid", {
          issues: parsed.error.issues,
        });
      }
      if (request.params.subjectId === session.subjectId) {
        throw unprocessable("ASSURANCE_SELF", "You cannot set your own assurance level", {
          hint: "Another admin checks and records it",
        });
      }

      const { requestId, asOf, correlationId } = request.context;
      return withTenant(sql, { tenantId }, (tx) =>
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          const [before] = await tx<{ assurance_level: string; kind: string; version: number }[]>`
            SELECT assurance_level::text, kind, version FROM core.subjects
            WHERE tenant_id = ${tenantId} AND id = ${request.params.subjectId}
            FOR NO KEY UPDATE
          `;
          if (!before) throw notFound("Subject not found");
          // A service's reach is its token's scopes (D7); identity assurance is a person's.
          if (before.kind !== "person") {
            throw unprocessable("ASSURANCE_PERSON_ONLY", "Identity assurance is set for people only");
          }

          await tx`
            UPDATE core.subjects
            SET assurance_level = ${parsed.data.assuranceLevel}, version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${request.params.subjectId}
          `;

          await recordAudit(tx, {
            tenantId,
            session,
            effectiveRole,
            command: "admin.subject.assurance_set",
            resourceType: "subject",
            resourceId: request.params.subjectId,
            beforeVersion: before.version,
            afterVersion: before.version + 1,
            correlationId,
            requestIp: request.clientIp,
            // The level decides which roles the person can exercise. Without the stated basis
            // the record shows who set it but not why.
            detail: {
              assuranceLevel: parsed.data.assuranceLevel,
              previousAssuranceLevel: before.assurance_level,
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
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
          /**
           * Subject first, then its sessions — the order every account function keeps
           * (`core.mfa_lock_session`). Locking the wallet and the sessions before the subject
           * would deadlock against the holder disabling or binding a key at the same moment.
           */
          await tx`
            SELECT s.id FROM core.subjects s
            JOIN core.wallet_identities w ON w.subject_id = s.id
            WHERE w.tenant_id = ${tenantId} AND w.id = ${request.params.walletId}
            FOR NO KEY UPDATE OF s
          `;
          const [wallet] = await tx<WalletRow[]>`
            SELECT id, subject_id, wallet_address, chain_id, assurance_level, bound_via,
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

          /**
           * A cut key must not keep a session alive for the rest of its TTL (AC-27). Every
           * session of the subject ends, not only those signed with this wallet: the subject's
           * key was lost or compromised, and which session it reached is not knowable here.
           */
          const revokedSessions = wallet.subject_id
            ? await revokeSubjectSessions(tx, wallet.subject_id, "wallet_disabled")
            : 0;
          // An operator-bound wallet's level no longer counts toward the subject's. A proof-bound
          // one never counted (0122), so disabling it leaves the subject's level alone.
          const assurance =
            wallet.subject_id && wallet.bound_via === "operator"
              ? await syncSubjectAssurance(tx, tenantId, wallet.subject_id)
              : null;

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
            requestIp: request.clientIp,
            detail: {
              revokedSessions,
              ...(assurance
                ? {
                    subjectAssuranceLevel: assurance.current,
                    previousSubjectAssuranceLevel: assurance.previous,
                  }
                : {}),
            },
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
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
        const [subject] = await tx<{ id: string }[]>`
          SELECT id FROM core.subjects WHERE tenant_id = ${tenantId} AND id = ${parsed.data.subjectId}
        `;
        if (!subject) throw notFound("Subject not found");

        const id = randomUUID();
        try {
          await tx`
            INSERT INTO core.role_grant_requests (
              id, tenant_id, subject_id, organization_id, project_id, role, reason,
              requested_by_subject_id, jurisdiction
            ) VALUES (
              ${id}, ${tenantId}, ${parsed.data.subjectId},
              ${parsed.data.organizationId ?? null}, ${parsed.data.projectId ?? null},
              ${parsed.data.role}, ${parsed.data.reason}, ${session.subjectId},
              ${parsed.data.jurisdiction ?? null}
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
          requestIp: request.clientIp,
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
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
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

          /**
           * The person receiving the role does not decide it either.
           *
           * Otherwise A proposes a role for B and B approves what B receives — two people on the
           * record, one of whom decided their own grant. `role_grant_not_self_target` (0076)
           * holds the same rule in the DB.
           */
          if (grant.subject_id === session.subjectId) {
            throw unprocessable(
              "ROLE_GRANT_SELF_TARGET",
              "The subject of a proposal cannot decide it",
              { hint: "An admin holder other than the proposer and the subject decides" },
            );
          }

          /**
           * A second-person role is not granted to a subject whose active key was bound from
           * the admin UI.
           *
           * The admin bind (removed in WP5) refused subjects that already held these roles, so
           * the order could be reversed: bind an operator's own key to a subject with no roles,
           * then grant it one. Such keys still exist (`admin.wallet.bound` in the audit trail),
           * and refusing them holds whoever bound them. A key the holder bound by proof
           * (`account.wallet.bound`) is theirs, and does not block a grant.
           */
          if (parsed.data.decision === "approve" && SECOND_PERSON_ROLES.includes(grant.role)) {
            // Same subject-row lock as the bind route, so a concurrent bind is seen, not missed.
            await tx`
              SELECT id FROM core.subjects WHERE tenant_id = ${tenantId} AND id = ${grant.subject_id}
              FOR NO KEY UPDATE
            `;
            const [uiBound] = await tx<{ id: string }[]>`
              SELECT w.id FROM core.wallet_identities w
              WHERE w.tenant_id = ${tenantId} AND w.subject_id = ${grant.subject_id}
                AND w.disabled_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM audit.events e
                  WHERE e.tenant_id = ${tenantId} AND e.command = 'admin.wallet.bound'
                    AND e.resource_id = w.id
                )
              LIMIT 1
            `;
            if (uiBound) {
              throw unprocessable(
                "ROLE_GRANT_UI_BOUND_SUBJECT",
                "This role cannot be granted to a subject whose key was bound from the UI",
                {
                  role: grant.role,
                  hint: "Create the subject with its key through bootstrap, then grant the role",
                },
              );
            }
          }

          const approved = parsed.data.decision === "approve";
          let bindingId: string | null = null;

          if (approved) {
            bindingId = randomUUID();
            await tx`
              INSERT INTO core.role_bindings (
                id, tenant_id, subject_id, organization_id, project_id, role, jurisdiction
              ) VALUES (
                ${bindingId}, ${tenantId}, ${grant.subject_id}, ${grant.organization_id},
                ${grant.project_id}, ${grant.role}, ${grant.jurisdiction}
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
            requestIp: request.clientIp,
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
     * Where the worker will send, and which secret it will read, are checked on save.
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
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
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
          requestIp: request.clientIp,
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
        withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request), async () => {
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
            requestIp: request.clientIp,
          });

          reply.header("etag", etagOf(current.version + 1));
          const [updated] = await readSinks(tx, tenantId, current.id);
          return toSink(updated!, requestId, asOf);
        }),
      );
    },
  );
}
