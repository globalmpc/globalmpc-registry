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

describeDb("outbox publishing", () => {
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

  it("publishes unpublished events and marks them", async () => {
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

  it("does not resend already-published events", async () => {
    const correlationId = `once-${randomUUID()}`;
    await seed(correlationId);

    await publishBatch(sql, async () => {});
    const seen: string[] = [];
    await publishBatch(sql, async (event) => {
      seen.push(event.correlation_id);
    });

    expect(seen).not.toContain(correlationId);
  });

  it("leaves published_at unset when publishing fails — at-least-once", async () => {
    const correlationId = `fail-${randomUUID()}`;
    await seed(correlationId);

    const result = await publishBatch(sql, async (event) => {
      if (event.correlation_id === correlationId) throw new Error("broker down");
    });

    expect(result.failed).toBeGreaterThan(0);
    expect(await pendingFor(correlationId)).toBe(true);
  });

  it("one event's failure does not block the others", async () => {
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

  it("retries on the next run after a failure", async () => {
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

  it("publishes in occurred_at order", async () => {
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

  it("does not send more than limit at once", async () => {
    for (let i = 0; i < 5; i += 1) await seed(`limit-${randomUUID()}`);

    const result = await publishBatch(sql, async () => {}, 2);
    expect(result.published).toBe(2);
  });
});

describeDb("consumer deduplication", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await connectIsolated("outbox");
  });

  afterAll(async () => {
    await sql.end();
  });

  it("one handler does not process the same event twice", async () => {
    const eventId = randomUUID();
    expect(await claimEvent(sql, eventId, "v1")).toBe(true);
    expect(await claimEvent(sql, eventId, "v1")).toBe(false);
  });

  it("reprocesses when the handler version differs", async () => {
    const eventId = randomUUID();
    expect(await claimEvent(sql, eventId, "v1")).toBe(true);
    expect(await claimEvent(sql, eventId, "v2")).toBe(true);
  });
});

describeDb("backlog observation", () => {
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

  it("reports the unpublished count and the oldest timestamp", async () => {
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
