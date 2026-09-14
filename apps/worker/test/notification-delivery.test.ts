import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { deliverOnce, deliveryBacklog, signPayload } from "../src/notification-delivery.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 알림 webhook 배달.
 *
 * 지키는 것 셋.
 *
 * 1. **서명한다** — 서명이 없으면 URL을 아는 누구나 알림을 위조할 수 있다.
 * 2. **영원히 두드리지 않는다** — 상한에 닿으면 굳고, 그 사실이 남는다.
 * 3. **보내지 못한 것을 성공으로 적지 않는다.**
 */
describeDb("알림 배달", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let sinkId: string;

  const options = {
    maxAttempts: 3,
    backoffMs: 1000,
    resolveSecret: (reference: string) => {
      if (reference === "env:BROKEN") throw new Error("참조를 풀 수 없다");
      return "test-secret";
    },
  };

  beforeAll(async () => {
    sql = await connectIsolated("notify");
    tenantId = randomUUID();
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`notify-${tenantId.slice(0, 8)}`}, 'Notify tenant')
    `;
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    await sql`DELETE FROM core.notification_deliveries`;
    await sql`DELETE FROM core.notifications`;
    await sql`DELETE FROM core.notification_sinks`;
    sinkId = randomUUID();
    await sql`
      INSERT INTO core.notification_sinks (id, tenant_id, url, secret_reference)
      VALUES (${sinkId}, ${tenantId}, 'https://hooks.example.test/a', 'env:OK')
    `;
  });

  async function makeNotification(): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO core.notifications (id, tenant_id, kind, audience_role, summary, link)
      VALUES (${id}, ${tenantId}, 'registry_revoked', 'mpc_operator', '기록이 철회됐다', '/w/registries')
    `;
    return id;
  }

  it("알림이 생기면 배달 행이 자동으로 걸린다", async () => {
    const id = await makeNotification();

    const [row] = await sql<{ state: string }[]>`
      SELECT state FROM core.notification_deliveries WHERE notification_id = ${id}
    `;
    // 알림을 만드는 자리가 넷이다. route에서 걸면 새 자리에서 빠뜨린다.
    expect(row!.state).toBe("pending");
  });

  it("서명과 함께 보내고 성공을 기록한다", async () => {
    await makeNotification();
    let seen: { url: string; headers: Record<string, string>; body: string } | null = null;

    const result = await deliverOnce(sql, {
      ...options,
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen = {
          url: String(url),
          headers: init.headers as Record<string, string>,
          body: String(init.body),
        };
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(result).toEqual({ handled: true, delivered: 1, failed: 0 });
    expect(seen!.url).toBe("https://hooks.example.test/a");

    // 받는 쪽이 같은 비밀로 재계산해 맞출 수 있어야 한다.
    const timestamp = seen!.headers["x-mpc-timestamp"]!;
    const expected = createHmac("sha256", "test-secret")
      .update(`${timestamp}.${seen!.body}`)
      .digest("hex");
    expect(seen!.headers["x-mpc-signature"]).toBe(expected);
    expect(signPayload("test-secret", seen!.body, timestamp)).toBe(expected);

    // 본문에 projection도 증빙도 담지 않는다. 수신처는 우리가 통제하지 않는다.
    const body = JSON.parse(seen!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "kind",
      "link",
      "notificationId",
      "occurredAt",
      "summary",
    ]);
  });

  it("실패하면 재시도로 남기고 간격을 둔다", async () => {
    const id = await makeNotification();

    const result = await deliverOnce(sql, {
      ...options,
      fetchImpl: (async () => new Response("", { status: 500 })) as unknown as typeof fetch,
    });

    expect(result.failed).toBe(0);
    const [row] = await sql<{ state: string; attempts: number; last_error: string }[]>`
      SELECT state, attempts, last_error FROM core.notification_deliveries
      WHERE notification_id = ${id}
    `;
    // 굳지 않았다 — 아직 상한에 닿지 않았다.
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain("500");

    // 즉시 재시도하면 죽은 수신처에 대고 계속 두드린다.
    const [again] = await sql<{ due: boolean }[]>`
      SELECT next_attempt_at > now() AS due FROM core.notification_deliveries
      WHERE notification_id = ${id}
    `;
    expect(again!.due).toBe(true);
  });

  it("상한에 닿으면 굳고 그 사실이 남는다", async () => {
    const id = await makeNotification();
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;

    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      // 간격을 건너뛰고 바로 다음 시도를 만든다.
      await sql`UPDATE core.notification_deliveries SET next_attempt_at = now()`;
      await deliverOnce(sql, { ...options, fetchImpl: failing });
    }

    const [row] = await sql<{ state: string; attempts: number }[]>`
      SELECT state, attempts FROM core.notification_deliveries WHERE notification_id = ${id}
    `;
    expect(row!.state).toBe("failed");
    expect(row!.attempts).toBe(options.maxAttempts);

    // 앱 안 알림은 그대로 남는다. 사라지는 것은 "보냈다"는 사실뿐이다.
    const [notification] = await sql<{ id: string }[]>`
      SELECT id FROM core.notifications WHERE id = ${id}
    `;
    expect(notification).toBeDefined();
    expect((await deliveryBacklog(sql)).failed).toBe(1);
  });

  it("비밀을 풀지 못하면 재시도하지 않고 굳힌다", async () => {
    await sql`UPDATE core.notification_sinks SET secret_reference = 'env:BROKEN'`;
    const id = await makeNotification();

    const result = await deliverOnce(sql, options);

    // 설정이 고쳐져야 하는 것이므로 상한을 기다리지 않는다. 그 사이 로그가
    // 같은 오류로 찬다.
    expect(result.failed).toBe(1);
    const [row] = await sql<{ state: string; last_error: string }[]>`
      SELECT state, last_error FROM core.notification_deliveries WHERE notification_id = ${id}
    `;
    expect(row!.state).toBe("failed");
    expect(row!.last_error).toContain("비밀 참조");
  });

  it("멈춘 수신처로는 보내지 않는다", async () => {
    await makeNotification();
    await sql`UPDATE core.notification_sinks SET state = 'paused'`;

    let called = false;
    const result = await deliverOnce(sql, {
      ...options,
      fetchImpl: (async () => {
        called = true;
        return new Response("", { status: 200 });
      }) as unknown as typeof fetch,
    });

    expect(result.handled).toBe(false);
    expect(called).toBe(false);
  });

  it("보낼 것이 없으면 아무 일도 하지 않는다", async () => {
    // 수신처를 만들지 않은 배포에 부담을 주지 않는다.
    const result = await deliverOnce(sql, options);
    expect(result).toEqual({ handled: false, delivered: 0, failed: 0 });
  });
});
