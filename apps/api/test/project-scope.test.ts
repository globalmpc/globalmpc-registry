import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * project scope와 읽기 인가 — 02 §2.1.
 *
 * 결정식의 7개 조건 중 `project_scope_matches`와 역할 검사는 라우트가 사실을
 * 넘겨야 평가된다. 넘기지 않으면 판정 코드가 있어도 실행되지 않으므로, **경계를
 * 실제 요청으로 넘어 본다.**
 *
 * 두 가지를 시험한다.
 *
 * 1. 프로젝트 수준 바인딩은 그 프로젝트 밖에서 통하지 않는다.
 * 2. 역할 없는 세션은 tenant 안이라도 워크스페이스를 읽지 못한다 —
 *    RLS의 tenant 경계가 인가를 대신하지 않는다.
 */
describeDb("project scope와 읽기 인가", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: {
    scopedSteward: string;
    steward: string;
    reader: string;
    operator: string;
    sponsor: string;
  };
  /** 같은 tenant 안의 다른 회사와 그 회사 소유 프로젝트. */
  let foreign: { organizationId: string; projectId: string };

  /**
   * tenant A 안에 두 번째 조직을 만든다.
   *
   * 조직 격리는 tenant 격리와 다른 경계다. 다른 tenant로 시험하면 RLS가 먼저
   * 막아서 인가 코드가 조직을 보는지 알 수 없다.
   */
  async function seedForeignOrganization(): Promise<{ organizationId: string; projectId: string }> {
    const organizationId = randomUUID();
    const projectId = randomUUID();
    await fx.sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${organizationId}, ${fx.tenantA}, 'Org C (other company)', 'MNG')
    `;
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${fx.tenantA}, ${`FOREIGN-${projectId.slice(0, 8)}`}, 'Other Company Project',
        'MNG', ARRAY['copper'], ${organizationId}
      )
    `;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, 'registry_entry_version', ${randomUUID()},
        'foreign stale signal'
      )
    `;
    // 역할에게 가는 알림. steward 역할 이름은 같아도 다른 회사 프로젝트의 것이다.
    await fx.sql`
      INSERT INTO core.notifications (tenant_id, kind, audience_role, project_id, summary, link)
      VALUES (${fx.tenantA}, 'evidence_stale', 'data_steward', ${projectId},
              'foreign notification', ${`/w/projects/${projectId}`})
    `;
    return { organizationId, projectId };
  }

  /** orgA의 조직 수준 project_sponsor_operator. 프로젝트를 만들 수 있는 당사자 역할이다. */
  async function seedSponsor(): Promise<TestAccount> {
    const account = newAccount();
    const subject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${fx.tenantA}, 'person', 'Sponsor A')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subject}, ${account.address}, 97, 'identity_bound', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, 'project_sponsor_operator')
    `;
    // 결정 대기 중인 역할 부여 제안. 결정권(admin.role.approve)이 없는 steward의
    // 할 일에 올라오면 안 된다.
    await fx.sql`
      INSERT INTO core.role_grant_requests (
        id, tenant_id, subject_id, organization_id, role, reason, requested_by_subject_id
      )
      SELECT ${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, 'data_steward',
             'scope test', w.subject_id
      FROM core.wallet_identities w
      WHERE w.wallet_address = ${fx.operatorA.address}
    `;
    return account;
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    foreign = await seedForeignOrganization();

    tokens = {
      scopedSteward: await signIn(app, fx.scopedStewardA),
      steward: await signIn(app, fx.stewardA),
      reader: await signIn(app, fx.readerA),
      operator: await signIn(app, fx.operatorA),
      sponsor: await signIn(app, await seedSponsor()),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function claimBody() {
    return {
      claimType: "resource_estimate",
      valueText: "1200.5",
      unit: "kt",
      sourceCoordinate: { page: "12" },
    };
  }

  function createClaim(token: string, projectId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/claims`,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: claimBody(),
    });
  }

  describe("쓰기", () => {
    it("프로젝트 수준 바인딩은 자기 프로젝트에서 통한다", async () => {
      const response = await createClaim(tokens.scopedSteward, fx.projectA);
      expect(response.statusCode).toBe(200);
    });

    it("프로젝트 수준 바인딩은 다른 프로젝트에서 거절된다", async () => {
      const response = await createClaim(tokens.scopedSteward, fx.otherProjectA);

      expect(response.statusCode).toBe(403);
      const body = response.json() as { code: string; details?: { reason?: string } };
      expect(body.code).toBe("AUTHORIZATION_DENIED");
      expect(body.details?.reason).toBe("PROJECT_SCOPE_MISMATCH");
    });

    it("조직 수준 바인딩은 같은 조직의 다른 프로젝트에도 닿는다", async () => {
      const response = await createClaim(tokens.steward, fx.otherProjectA);
      expect(response.statusCode).toBe(200);
    });

    it("조직 수준 바인딩은 같은 tenant의 다른 조직 프로젝트에 닿지 않는다", async () => {
      const response = await createClaim(tokens.steward, foreign.projectId);

      expect(response.statusCode).toBe(403);
      expect((response.json() as { details?: { reason?: string } }).details?.reason).toBe(
        "PROJECT_SCOPE_MISMATCH",
      );
    });

    it("tenant 운영 역할은 다른 조직 프로젝트에도 닿는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${foreign.projectId}`,
        headers: bearer(tokens.operator),
      });
      expect(response.statusCode).toBe(200);
    });
  });

  describe("프로젝트 생성의 소유 조직", () => {
    function createProject(token: string, ownerOrganizationId: string) {
      return app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
        payload: {
          projectKey: `OWN-${randomUUID().slice(0, 8)}`,
          name: "소유 조직 시험",
          hostCountryIso3: "MNG",
          minerals: ["copper"],
          ownerOrganizationId,
        },
      });
    }

    it("프로젝트 당사자는 자기 조직 소유로만 만들 수 있다", async () => {
      const own = await createProject(tokens.sponsor, fx.orgA);
      expect(own.statusCode).toBe(200);

      const other = await createProject(tokens.sponsor, foreign.organizationId);
      expect(other.statusCode).toBe(403);
      expect(other.json().code).toBe("OWNER_ORGANIZATION_NOT_ALLOWED");
    });

    it("tenant 운영자는 다른 조직 소유로 등록할 수 있다 — 온보딩", async () => {
      const response = await createProject(tokens.operator, foreign.organizationId);
      expect(response.statusCode).toBe(200);
    });
  });

  describe("읽기", () => {
    it("역할 없는 세션은 프로젝트 목록을 읽지 못한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: bearer(tokens.reader),
      });

      expect(response.statusCode).toBe(403);
      expect((response.json() as { details?: { reason?: string } }).details?.reason).toBe(
        "ROLE_ACTION_NOT_ALLOWED",
      );
    });

    it("역할 없는 세션은 증빙을 읽지 못한다", async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/claims`,
        headers: bearer(tokens.reader),
      });

      expect(response.statusCode).toBe(403);
    });

    it("프로젝트 수준 바인딩은 범위 밖 프로젝트의 증빙을 읽지 못한다", async () => {
      const inScope = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/claims`,
        headers: bearer(tokens.scopedSteward),
      });
      expect(inScope.statusCode).toBe(200);

      const outOfScope = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.otherProjectA}/claims`,
        headers: bearer(tokens.scopedSteward),
      });
      expect(outOfScope.statusCode).toBe(403);
    });

    it("역할 없는 세션은 anchor batch 상태를 읽지 못한다", async () => {
      // 게시된 root는 공개지만 제출 이력과 실패 상태는 운영 정보다.
      // 공개 조회는 `/api/v1/public/*`이 따로 담당한다.
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/anchor-batches",
        headers: bearer(tokens.reader),
      });

      expect(response.statusCode).toBe(403);
    });

    it("거버넌스 목록은 범위 밖 프로젝트 제안을 담지 않는다", async () => {
      /**
       * 쓰기는 제안의 프로젝트로 범위를 보는데 조회가 tenant 전체를 돌려주면,
       * 손대지 못할 뿐 제목·근거·집계는 그대로 나간다.
       */
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/governance/proposals",
        headers: bearer(tokens.scopedSteward),
      });

      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { projectId: string | null }[] }).items;
      expect(items.every((item) => item.projectId !== fx.otherProjectA)).toBe(true);
    });

    it("프로젝트 목록은 다른 조직 프로젝트를 담지 않는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { items: { id: string }[] }).items.map((item) => item.id);
      expect(ids).toContain(fx.projectA);
      expect(ids).not.toContain(foreign.projectId);
    });

    it("registry 목록은 다른 조직 프로젝트의 기록을 담지 않는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/registry-entries",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { projectId: string | null }[] }).items;
      expect(items.every((item) => item.projectId === fx.projectA || item.projectId === fx.otherProjectA)).toBe(true);
    });

    it("할 일 목록은 다른 조직 프로젝트의 stale 신호와 결정권 없는 역할 부여 제안을 담지 않는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/my-work",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const unassigned = (
        response.json() as { unassigned: { kind: string; projectId: string | null }[] }
      ).unassigned;
      expect(unassigned.some((item) => item.projectId === foreign.projectId)).toBe(false);
      expect(unassigned.some((item) => item.kind === "role_grant_decision")).toBe(false);
    });

    it("역할에게 온 알림은 다른 조직 프로젝트의 것을 담지 않는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: bearer(tokens.steward),
      });

      expect(response.statusCode).toBe(200);
      const items = (response.json() as { items: { projectId: string | null }[] }).items;
      expect(items.some((item) => item.projectId === foreign.projectId)).toBe(false);
    });

    it("프로젝트 목록은 범위 밖 프로젝트를 담지 않는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: bearer(tokens.scopedSteward),
      });

      expect(response.statusCode).toBe(200);
      const ids = (response.json() as { items: { id: string }[] }).items.map((item) => item.id);
      expect(ids).toContain(fx.projectA);
      expect(ids).not.toContain(fx.otherProjectA);
    });
  });
});
