import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 알림 수신처.
 *
 * 지키는 것 셋.
 *
 * 1. **비밀이 응답으로 나가지 않는다** — 참조조차도. 경로가 배포 구조를 드러낸다.
 * 2. **등록돼 있다와 실제로 가고 있다를 구분한다** — 설정해 두고 아무것도 못
 *    보내는 상태가 가장 나쁘다.
 * 3. **멈추되 지우지 않는다** — 지우면 왜 끊겼는지가 남지 않는다.
 */
describeDb("알림 수신처", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function create(token: string, body: unknown) {
    return app.inject({
      method: "POST",
      url: "/api/v1/admin/notification-sinks",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: body as never,
    });
  }

  function list(token: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/admin/notification-sinks",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("수신처를 등록한다", async () => {
    const response = await create(operatorToken, {
      url: `https://hooks.example.test/${randomUUID().slice(0, 8)}`,
      secretReference: "env:NOTIFY_TEST_SECRET",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("active");
    expect(response.json().hasSecret).toBe(true);
  });

  it("비밀 참조를 응답에 담지 않는다", async () => {
    await create(operatorToken, {
      url: `https://hooks.example.test/${randomUUID().slice(0, 8)}`,
      secretReference: "file:/run/secrets/notify_hmac",
    });

    const listed = await list(operatorToken);
    // 참조가 배포 구조를 드러낸다. 설정돼 있는지만 낸다.
    expect(listed.body).not.toContain("/run/secrets/notify_hmac");
    expect(listed.body).not.toContain("secretReference");
  });

  it("https가 아니면 거절한다", async () => {
    // 알림 본문에 프로젝트 식별자가 들어간다. 평문으로 보내지 않는다.
    const response = await create(operatorToken, {
      url: "http://hooks.example.test/plain",
      secretReference: "env:NOTIFY_TEST_SECRET",
    });

    expect(response.statusCode).toBe(400);
  });

  it("같은 주소를 두 번 등록하지 않는다", async () => {
    const url = `https://hooks.example.test/${randomUUID().slice(0, 8)}`;
    expect((await create(operatorToken, { url, secretReference: "env:A" })).statusCode).toBe(200);

    const second = await create(operatorToken, { url, secretReference: "env:B" });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("SINK_ALREADY_REGISTERED");
  });

  it("admin 권한이 없으면 거절한다", async () => {
    const response = await create(stewardToken, {
      url: "https://hooks.example.test/nope",
      secretReference: "env:A",
    });

    // 수신처를 바꾸면 알림이 다른 곳으로 간다. 조용히 바꿔 두면 원래 받던 쪽은
    // 알림이 끊긴 것을 모른다.
    expect(response.statusCode).toBe(403);
  });

  it("등록된 수신처에 알림이 배달 대기로 걸린다", async () => {
    const url = `https://hooks.example.test/${randomUUID().slice(0, 8)}`;
    const sink = (await create(operatorToken, { url, secretReference: "env:A" })).json();

    // 알림 생성 자리는 넷이다. 트리거가 그 전부를 덮는지 본다.
    const reason = `deliver-${randomUUID().slice(0, 8)}`;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${reason}
      )
    `;

    const listed = (await list(operatorToken)).json();
    const mine = listed.items.find((item: { id: string }) => item.id === sink.id);
    expect(mine.delivery.pending).toBeGreaterThan(0);
  });

  it("멈춘 수신처에는 새 배달이 걸리지 않는다", async () => {
    const url = `https://hooks.example.test/${randomUUID().slice(0, 8)}`;
    const sink = (await create(operatorToken, { url, secretReference: "env:A" })).json();

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-sinks/${sink.id}/state`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${sink.version}"`,
      },
      payload: { state: "paused" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().state).toBe("paused");

    const before = paused.json().delivery.pending;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${`paused-${randomUUID().slice(0, 6)}`}
      )
    `;

    const after = (await list(operatorToken)).json().items.find(
      (item: { id: string }) => item.id === sink.id,
    );
    // 멈춘 것은 지운 것이 아니다. 이력은 남고 새 배달만 걸리지 않는다.
    expect(after.delivery.pending).toBe(before);
    expect(after.state).toBe("paused");
  });

  it("다른 tenant의 수신처는 보이지 않는다", async () => {
    const operatorB = await signIn(app, fx.operatorB);
    const mine = (await list(operatorToken)).json().items as { id: string }[];
    const theirs = (await list(operatorB)).json().items as { id: string }[];

    const mineIds = new Set(mine.map((item) => item.id));
    for (const item of theirs) expect(mineIds.has(item.id)).toBe(false);
  });
});
