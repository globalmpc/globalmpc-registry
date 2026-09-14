import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 알림.
 *
 * 검토 요청·gap·stale·revoke가 일어나도 당사자가 아는 경로는 화면을 다시 여는
 * 것뿐이었다. 여기서 지키는 것은 둘이다.
 *
 * 1. 사건이 **어느 경로로 들어오든** 알림이 생긴다 — 그래서 트리거로 만든다.
 * 2. 역할로 간 알림은 한 사람이 읽어도 **남에게 남는다.**
 */
describeDb("알림", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    stewardToken = await signIn(app, fx.stewardA);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function list(token: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("stale 신호가 생기면 역할에게 알림이 간다", async () => {
    const reason = `stale-${randomUUID().slice(0, 8)}`;
    // 신호는 트리거로도 만들어지지만, 여기서는 **어느 경로로 들어와도** 알림이
    // 생기는지를 본다.
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${reason}
      )
    `;

    const items = (await list(stewardToken)).json().items as {
      summary: string;
      audience: string;
      audienceRole: string | null;
      read: boolean;
      link: string;
    }[];
    const found = items.find((item) => item.summary.includes(reason));

    expect(found).toBeDefined();
    // 아무에게도 배정되지 않은 사건이다. 특정인에게 보내면 그 사람이 자리를
    // 비운 동안 아무도 모른다.
    expect(found!.audience).toBe("role");
    expect(found!.audienceRole).toBe("data_steward");
    // 알림만 있고 갈 곳이 없으면 다시 찾아야 한다.
    expect(found!.link).toBeTruthy();
    expect(found!.read).toBe(false);
  });

  it("역할 알림을 한 사람이 읽어도 다른 사람에게는 남는다", async () => {
    const reason = `shared-${randomUUID().slice(0, 8)}`;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${reason}
      )
    `;
    // steward와 같은 역할을 가진 두 번째 사람을 만든다.
    const secondSubject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${secondSubject}, ${fx.tenantA}, 'person', 'Second steward')
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${secondSubject}, ${fx.orgA}, 'data_steward')
    `;

    const mine = ((await list(stewardToken)).json().items as { id: string; summary: string }[]).find(
      (item) => item.summary.includes(reason),
    );
    expect(mine).toBeDefined();

    const marked = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${mine!.id}/read`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().read).toBe(true);

    // 같은 알림이 다른 사람에게는 여전히 안 읽음이어야 한다. 읽음을 알림 행에
    // 두면 한 사람이 읽는 순간 나머지에게서 사라진다.
    const [otherRead] = await fx.sql<{ count: string }[]>`
      SELECT count(*) FROM core.notification_reads
      WHERE notification_id = ${mine!.id} AND subject_id = ${secondSubject}
    `;
    expect(Number(otherRead!.count)).toBe(0);
  });

  it("공개 기록이 철회되면 운영자에게 알림이 간다", async () => {
    const publicKey = `NOTIF-${randomUUID().slice(0, 8)}`;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    await fx.sql`
      UPDATE core.registry_entry_versions
      SET status = 'revoked', revoked_at = now()
      WHERE id = ${published.json().id}
    `;

    const items = (await list(operatorToken)).json().items as { summary: string }[];
    // 철회는 공개된 것을 내리는 일이라 알림이 늦으면 그 사이 인용이 계속된다.
    expect(items.some((item) => item.summary.includes(publicKey))).toBe(true);
  });

  it("다른 tenant의 알림은 보이지 않는다", async () => {
    const operatorB = await signIn(app, fx.operatorB);
    const mine = (await list(operatorToken)).json().items as { id: string }[];
    const theirs = (await list(operatorB)).json().items as { id: string }[];

    const mineIds = new Set(mine.map((item) => item.id));
    for (const item of theirs) {
      expect(mineIds.has(item.id)).toBe(false);
    }
  });

  it("없는 알림을 읽음 처리하지 않는다", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/00000000-0000-4000-8000-000000000000/read",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
    });

    expect(response.statusCode).toBe(404);
  });
});
