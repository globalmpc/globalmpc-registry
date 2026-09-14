import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Authority Registry — 05 §5.11, OD-42·OD-43.
 *
 * R5 gate가 요구하는 것은 "미확인 integration 과장 0"이다. 그래서 이 파일은
 * **연동되지 않은 기관이 목록에 남는가**와 **활성으로 보이지 않는가**를 함께 본다.
 */
describeDb("Authority Registry", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function list() {
    return app.inject({
      method: "GET",
      url: "/api/v1/authorities",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("확인하지 않는 것을 함께 반환한다", async () => {
    const response = await list();
    expect(response.statusCode).toBe(200);

    const items = response.json().items as { doesNotProve: string[] }[];
    expect(items.length).toBeGreaterThan(0);
    // 확인해 주는 것만 보여주면 읽는 쪽이 전체 확인으로 오해한다.
    for (const item of items) {
      expect(item.doesNotProve.length).toBeGreaterThan(0);
    }
  });

  it("active 연동은 호출 가능으로 표시된다", async () => {
    const items = (await list()).json().items as { adapterState: string; callable: boolean }[];
    const active = items.find((item) => item.adapterState === "active");
    expect(active?.callable).toBe(true);
  });

  it("연동이 없는 기관도 목록에 남는다", async () => {
    // 빼면 "왜 이 기관은 없나"를 알 수 없다.
    await fx.sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        gen_random_uuid(), ${fx.tenantA}, 'Unconnected Registry', 'MNG',
        ARRAY['land_use'], ARRAY['economic_viability'],
        ARRAY['land'], 'manual_official_registry_confirmation', 'public', '2020-01-01', 'accepted'
      )
    `;

    const items = (await list()).json().items as {
      name: string;
      adapterState: string;
      callable: boolean;
      nextAction: string | null;
    }[];
    const found = items.find((item) => item.name === "Unconnected Registry");

    expect(found).toBeDefined();
    // active로 두면 있지도 않은 연동을 약속한다.
    expect(found!.adapterState).toBe("none");
    expect(found!.callable).toBe(false);
    expect(found!.nextAction).toContain("연동");
  });

  it("계획 단계 연동은 호출 대상이 아니다", async () => {
    const [authority] = await fx.sql<{ id: string }[]>`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        gen_random_uuid(), ${fx.tenantA}, 'Planned Registry', 'MNG',
        ARRAY['tax_status'], ARRAY['economic_viability'],
        ARRAY['tax'], 'authenticated_api', 'public', '2020-01-01', 'accepted'
      )
      RETURNING id
    `;
    await fx.sql`
      INSERT INTO core.source_connections (
        id, tenant_id, authority_id, connection_key, collection_method,
        access_basis, state
      ) VALUES (
        gen_random_uuid(), ${fx.tenantA}, ${authority!.id}, ${`planned-${Date.now()}`},
        'authenticated_api', '협의 예정', 'planned'
      )
    `;

    const items = (await list()).json().items as {
      name: string;
      adapterState: string;
      callable: boolean;
      adapterStateReason: string | null;
    }[];
    const found = items.find((item) => item.name === "Planned Registry");

    // 호출하면 미확인 통합을 약속하는 것이 된다(OD-42).
    expect(found!.adapterState).toBe("pending_access");
    expect(found!.callable).toBe(false);
    // "왜 안 되나"에 답할 수 있어야 한다.
    expect(found!.adapterStateReason).toBeTruthy();
  });

  it("관할 profile이 활성과 대기를 나눠 센다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/jurisdictions/mng/profile",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // 합계만 보여주면 "10개 연동"이 실제로는 1개만 호출 가능한 상태를 감춘다.
    expect(body.activeCount).toBeGreaterThanOrEqual(1);
    expect(body.pendingCount).toBeGreaterThanOrEqual(1);
    expect(body.limitations.join(" ")).toContain("약속하지 않는다");
  });

  it("다른 tenant의 authority는 보이지 않는다", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/authorities",
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });
    expect(response.json().items).toEqual([]);
  });
});

describeDb("Asset/Offering gate (OD-07)", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function gate() {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/offering-gate`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  // AC-08: 프로젝트가 official reference여도 Issuer·SPV·권리가 pending이면
  // offering activation은 거절되고 Registry workflow는 정상 유지된다.
  it("조건이 채워지지 않은 상태를 그대로 보여준다", async () => {
    const response = await gate();

    expect(response.statusCode).toBe(200);
    expect(response.json().activatable).toBe(false);
    expect(response.json().missing.length).toBeGreaterThan(0);
  });

  it("기능이 없다는 사실을 응답이 직접 말한다", async () => {
    // 화면이 잊어도 API가 말한다. 비활성 버튼은 "곧 생긴다"로 읽힌다.
    const body = gate().then((response) => response.json());
    expect((await body).absenceNotice).toContain("숨겨 두지도");
    expect((await body).notMeaning).toContain("발행 승인이 아닙니다");
  });

  it("남은 조건마다 담당이 있다", async () => {
    const missing = (await gate()).json().missing as { owner: string; why: string }[];
    for (const item of missing) {
      expect(item.owner.length).toBeGreaterThan(0);
      expect(item.why.length).toBeGreaterThan(0);
    }
  });

  it("거래 route가 존재하지 않는다", async () => {
    // OD-07: 미승인 규제 기능은 flag 뒤에 있어도 오활성화 위험을 만든다.
    for (const path of ["subscriptions", "orders", "transfers", "custody"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/${path}`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
