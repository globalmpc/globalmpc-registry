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
 * 플랫폼 관리 — spec 11 §11.2 Administration.
 *
 * **없던 것을 만든다.** 역할을 부여하는 유일한 경로가 `bootstrap.ts`의 CLI였고,
 * 그것은 RLS를 우회하는 superuser 연결로 돈다. 배포된 시스템에 사람을 추가하려면
 * 매번 서버에 들어가야 했다.
 *
 * **2인 원칙(결정).** 역할 부여를 API로 올리면 "역할을 부여하는 역할"이
 * 생긴다. 그 역할 하나가 자기 자신에게 무엇이든 줄 수 있으면 권한표 전체가
 * 의미를 잃는다. 02 §2.8의 "운영자 단독 전환 금지"를 여기에도 적용해 제안과
 * 승인을 다른 사람이 하게 한다. DB의 `role_grant_two_person`이 같은 것을 막으므로
 * route가 하나 늘어도 규칙이 새지 않는다.
 *
 * **지갑 비활성은 1인이다.** 분실·침해된 키를 끊는 것은 급한 일이고, 2인을
 * 요구하면 두 번째 사람을 기다리는 동안 그 키가 살아 있다. 대신 사유 코드와
 * 실행자를 남긴다(AC-27).
 *
 * **tenant 생성은 여기 없다.** 세션은 언제나 하나의 tenant에 묶이고 RLS가 그것을
 * 강제한다. 다른 tenant를 만드는 route는 그 경계를 넘어야 하므로 SECURITY DEFINER
 * 함수가 필요하고, 그러면 **HTTP로 도달 가능한 tenant 생성 경로**가 생긴다. 운영자
 * 세션 하나가 탈취됐을 때의 피해 범위가 tenant 하나에서 플랫폼 전체로 넓어진다.
 * tenant 생성은 배포마다 한 번인 seed이므로 `bootstrap` CLI에 남긴다. 이 판단은
 * 뒤집을 수 있다.
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

/** 역할 부여를 승인할 수 있는 역할 — 이들의 지갑은 화면에서 붙이지 않는다. */
const ADMIN_ROLES: readonly string[] = ACTION_POLICIES["admin.role.approve"]?.allowedRoles ?? [];

export async function registerAdminRoutes(
  app: FastifyInstance,
  sql: postgres.Sql,
): Promise<void> {
  /**
   * 주체 하나를 지갑·역할과 **함께** 읽는다.
   *
   * 따로 조회하면 "역할은 있는데 붙은 지갑이 전부 비활성"인 상태가 두 화면에
   * 흩어진다 — 그 상태가 곧 로그인할 수 없는 계정이고, 관리 화면이 가장 먼저
   * 말해야 하는 것이다.
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
      // 세션 해석은 `disabled_at IS NULL`인 지갑만 본다(0005). 그것이 없으면
      // 역할이 무엇이든 로그인할 수 없다.
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
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
          if (!subject) throw notFound("주체를 찾을 수 없다");

          /**
           * 운영 권한자에게는 화면에서 지갑을 붙이지 않는다.
           *
           * 지갑 연결은 1인 행위다. 운영자 A가 자기 지갑을 운영자 B에게 붙이면 A는 B로
           * 로그인해 자기 제안을 승인한다 — 역할 부여의 2인 원칙이 한 사람 안에서 끝난다.
           * 운영자의 키 교체는 bootstrap(인프라 접근)으로 새 주체를 만들고 예전 지갑을 끈다.
           * 역할 없는 사람의 복구(AC-27)는 그대로 된다.
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
              "운영 권한을 가진 사람에게는 화면에서 지갑을 붙일 수 없다",
              { hint: "운영자 키 교체는 bootstrap으로 새 주체를 만들고 예전 지갑을 비활성한다" },
            );
          }

          /**
           * 주소는 체인 전체에서 하나의 주체에만 붙는다(`UNIQUE (wallet_address,
           * chain_id)`). 이미 붙어 있으면 조용히 옮기지 않는다 — 옮기면 그
           * 주소의 과거 서명이 다른 사람의 것으로 읽힌다.
           */
          const [existing] = await tx<{ subject_id: string | null; disabled_at: Date | null }[]>`
            SELECT subject_id, disabled_at FROM core.wallet_identities
            WHERE wallet_address = ${address} AND chain_id = ${parsed.data.chainId}
          `;
          if (existing) {
            throw conflict(
              "WALLET_ALREADY_BOUND",
              "이 주소는 이미 바인딩돼 있다. 다른 주체로 옮기지 않는다",
              { hint: "새 키로 복구하려면 새 주소를 바인딩하고 예전 것을 비활성한다" },
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
       * If-Match를 본문보다 **먼저** 본다.
       *
       * 순서가 반대면 헤더가 빠진 요청이 400(본문 오류)으로 답한다. 클라이언트는
       * 본문을 고치며 헤어나지 못하고, 빠진 것이 헤더라는 사실은 드러나지 않는다.
       */
      const expected = requireIfMatch(request);

      const parsed = disableWalletRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
          if (!wallet) throw notFound("지갑을 찾을 수 없다");
          assertVersionMatches(expected, wallet.version, "wallet_identity");

          /**
           * 자기 지갑은 끄지 않는다.
           *
           * 호출자는 언제나 운영 권한자이므로 이것이 "마지막 운영자가 사라지는" 경우도
           * 막는다. 되돌리는 화면이 없어서, 잘못 누르면 bootstrap으로만 돌아온다.
           * 자기 키가 침해됐다면 다른 운영자가 끈다.
           */
          if (wallet.subject_id === session.subjectId) {
            throw unprocessable(
              "WALLET_DISABLE_SELF",
              "자기 지갑은 비활성할 수 없다",
              { hint: "자기 키가 침해됐다면 다른 운영자가 끈다" },
            );
          }

          if (wallet.disabled_at !== null) {
            throw unprocessable(
              "WALLET_ALREADY_DISABLED",
              "이미 비활성된 지갑이다",
              { disabledAt: wallet.disabled_at.toISOString() },
            );
          }

          await tx`
            UPDATE core.wallet_identities
            SET disabled_at = now(), version = version + 1
            WHERE tenant_id = ${tenantId} AND id = ${wallet.id}
          `;

          /**
           * 끊은 이유를 함께 남긴다. 분실·침해·교체·퇴사는 같은 결과를 내지만
           * **과거 서명을 어떻게 읽어야 하는지가 다르다.**
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
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
        issues: parsed.error.issues,
      });
    }

    // 존재하지 않는 역할을 제안할 수 없다. 승인 시점에 실패하면 승인자가
    // 무엇을 잘못했는지 알 수 없다.
    if (ROLE_MINIMUM_ASSURANCE[parsed.data.role] === undefined) {
      throw unprocessable("ROLE_UNKNOWN", "권한표에 없는 역할이다", {
        role: parsed.data.role,
      });
    }

    const { requestId, asOf, correlationId } = request.context;
    return withTenant(sql, { tenantId }, (tx) =>
      withIdempotency(tx, tenantId, idempotencyKey, hashRequest(request.body), async () => {
        const [subject] = await tx<{ id: string }[]>`
          SELECT id FROM core.subjects WHERE tenant_id = ${tenantId} AND id = ${parsed.data.subjectId}
        `;
        if (!subject) throw notFound("주체를 찾을 수 없다");

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
          // 같은 대상에 pending이 둘 있으면 승인자가 어느 것을 승인했는지가
          // 이력에서 흐려진다. DB의 부분 UNIQUE가 막는다.
          if (caught instanceof Error && caught.message.includes("role_grant_requests_one_pending")) {
            throw conflict("ROLE_GRANT_ALREADY_PENDING", "같은 대상에 대기 중인 제안이 있다");
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

      // If-Match를 본문보다 먼저 본다 — 위와 같은 이유다.
      const expected = requireIfMatch(request);

      const parsed = decideRoleGrantRequest.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
          if (!grant) throw notFound("제안을 찾을 수 없다");
          assertVersionMatches(expected, grant.version, "role_grant_request");

          if (grant.state !== "pending") {
            throw unprocessable("ROLE_GRANT_ALREADY_DECIDED", "이미 결정된 제안이다", {
              state: grant.state,
            });
          }

          /**
           * 2인 원칙 — 02 §2.8.
           *
           * DB의 CHECK도 같은 것을 막지만 여기서 먼저 걸러 **왜 거절됐는지**를
           * 말한다. 제약 위반 메시지로는 사용자가 다음에 무엇을 해야 할지 모른다.
           */
          if (grant.requested_by_subject_id === session.subjectId) {
            throw unprocessable(
              "ROLE_GRANT_SELF_APPROVAL",
              "제안한 사람은 그 제안을 승인할 수 없다",
              { hint: "다른 admin 권한 보유자가 결정한다" },
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

  // --- 알림 수신처 ------------------------------------------
  //
  // **비밀을 반환하지 않는다.** `secret_reference`는 값이 아니지만 그것도 내지
  // 않는다 — `file:/run/secrets/x` 같은 경로는 그 자체가 배포 구조에 대한
  // 정보다. 설정돼 있는지만 낸다.

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
   * 배달 상태를 함께 읽는다.
   *
   * 수신처 목록만 내면 "등록돼 있다"와 "실제로 가고 있다"가 구분되지 않는다.
   * 설정해 두고 아무것도 못 보내는 상태가 가장 나쁘다 — 보내고 있다고 믿는다.
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
      throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
        issues: parsed.error.issues,
      });
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
            throw conflict("SINK_ALREADY_REGISTERED", "이 주소는 이미 등록돼 있다");
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
        throw badRequest("REQUEST_INVALID", "요청 형식이 올바르지 않다", {
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
          if (!current) throw notFound("수신처를 찾을 수 없다");
          assertVersionMatches(expected, current.version, "notification_sink");

          /**
           * 지우지 않고 멈춘다.
           *
           * 지우면 배달 이력의 FK가 끊기고, 그러면 "왜 알림이 끊겼나"에 답할
           * 근거가 사라진다. 멈춘 수신처는 새 배달을 받지 않는다(트리거가
           * `active`만 본다).
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
