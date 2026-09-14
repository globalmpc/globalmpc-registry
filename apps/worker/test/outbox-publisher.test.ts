import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import {
  backlogStats,
  claimEvent,
  publishBatch,
  type OutboxRow,
} from "../src/outbox-publisher.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("outbox 발행", () => {
  let sql: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    sql = await connectIsolated("outbox");

    tenant = randomUUID();
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenant}, ${`w-${tenant.slice(0, 8)}`}, 'worker test')
    `;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seed(correlationId: string, occurredAt?: string): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO core.outbox (
        id, tenant_id, event_type, aggregate_id, aggregate_version,
        payload, correlation_id, occurred_at
      ) VALUES (
        ${id}, ${tenant}, 'project.registered', ${randomUUID()}, 1,
        '{"projectKey":"X"}'::jsonb, ${correlationId},
        ${occurredAt ?? new Date().toISOString()}
      )
    `;
    return id;
  }

  async function pendingFor(correlationId: string): Promise<boolean> {
    const rows = await sql<{ published_at: Date | null }[]>`
      SELECT published_at FROM core.outbox WHERE correlation_id = ${correlationId}
    `;
    return rows[0]?.published_at === null;
  }

  it("미발행 이벤트를 발행하고 표시한다", async () => {
    const correlationId = `pub-${randomUUID()}`;
    await seed(correlationId);

    const seen: OutboxRow[] = [];
    const result = await publishBatch(sql, async (event) => {
      if (event.correlation_id === correlationId) seen.push(event);
    });

    expect(result.published).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event_type).toBe("project.registered");
    expect(await pendingFor(correlationId)).toBe(false);
  });

  it("이미 발행된 이벤트를 다시 보내지 않는다", async () => {
    const correlationId = `once-${randomUUID()}`;
    await seed(correlationId);

    await publishBatch(sql, async () => {});
    const seen: string[] = [];
    await publishBatch(sql, async (event) => {
      seen.push(event.correlation_id);
    });

    expect(seen).not.toContain(correlationId);
  });

  it("발행이 실패하면 published_at을 남기지 않는다 — at-least-once", async () => {
    const correlationId = `fail-${randomUUID()}`;
    await seed(correlationId);

    const result = await publishBatch(sql, async (event) => {
      if (event.correlation_id === correlationId) throw new Error("broker down");
    });

    expect(result.failed).toBeGreaterThan(0);
    expect(await pendingFor(correlationId)).toBe(true);
  });

  it("한 이벤트의 실패가 다른 이벤트를 막지 않는다", async () => {
    const bad = `bad-${randomUUID()}`;
    const good = `good-${randomUUID()}`;
    await seed(bad);
    await seed(good);

    const result = await publishBatch(sql, async (event) => {
      if (event.correlation_id === bad) throw new Error("broker down");
    });

    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(result.published).toBeGreaterThanOrEqual(1);
    expect(await pendingFor(bad)).toBe(true);
    expect(await pendingFor(good)).toBe(false);
  });

  it("실패 후 재실행하면 다시 시도한다", async () => {
    const correlationId = `retry-${randomUUID()}`;
    await seed(correlationId);

    await publishBatch(sql, async (event) => {
      if (event.correlation_id === correlationId) throw new Error("broker down");
    });

    const seen: string[] = [];
    await publishBatch(sql, async (event) => {
      seen.push(event.correlation_id);
    });

    expect(seen).toContain(correlationId);
    expect(await pendingFor(correlationId)).toBe(false);
  });

  it("occurred_at 순서로 발행한다", async () => {
    const older = `ord-a-${randomUUID()}`;
    const newer = `ord-b-${randomUUID()}`;
    await seed(newer, new Date(Date.now() + 60_000).toISOString());
    await seed(older, new Date(Date.now() - 60_000).toISOString());

    const order: string[] = [];
    await publishBatch(sql, async (event) => {
      if ([older, newer].includes(event.correlation_id)) order.push(event.correlation_id);
    });

    expect(order).toEqual([older, newer]);
  });

  it("limit을 넘겨 한 번에 다 보내지 않는다", async () => {
    for (let i = 0; i < 5; i += 1) await seed(`limit-${randomUUID()}`);

    const result = await publishBatch(sql, async () => {}, 2);
    expect(result.published).toBe(2);
  });
});

describeDb("consumer 중복 제거", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await connectIsolated("outbox");
  });

  afterAll(async () => {
    await sql.end();
  });

  it("같은 이벤트를 한 handler가 두 번 처리하지 않는다", async () => {
    const eventId = randomUUID();
    expect(await claimEvent(sql, eventId, "v1")).toBe(true);
    expect(await claimEvent(sql, eventId, "v1")).toBe(false);
  });

  it("handler version이 다르면 다시 처리한다", async () => {
    const eventId = randomUUID();
    expect(await claimEvent(sql, eventId, "v1")).toBe(true);
    expect(await claimEvent(sql, eventId, "v2")).toBe(true);
  });
});

describeDb("backlog 관측", () => {
  let sql: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    sql = await connectIsolated("outbox");
    tenant = randomUUID();
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenant}, ${`b-${tenant.slice(0, 8)}`}, 'backlog test')
    `;
  });

  afterAll(async () => {
    await sql.end();
  });

  it("미발행 개수와 가장 오래된 시각을 보고한다", async () => {
    await publishBatch(sql, async () => {});
    const before = await backlogStats(sql);
    expect(before.pending).toBe(0);

    await sql`
      INSERT INTO core.outbox (
        id, tenant_id, event_type, aggregate_id, aggregate_version,
        payload, correlation_id
      ) VALUES (
        ${randomUUID()}, ${tenant}, 'project.registered', ${randomUUID()}, 1,
        '{}'::jsonb, ${`backlog-${randomUUID()}`}
      )
    `;

    const after = await backlogStats(sql);
    expect(after.pending).toBe(1);
    expect(after.oldestPendingAt).toBeInstanceOf(Date);
  });
});
