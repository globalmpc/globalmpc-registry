import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { backlogStats, publishBatch, type Publish } from "../src/outbox-publisher.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Several outbox workers against one database — 07 §7.5.
 *
 * Each simulated worker gets its own connection pool, as a separate process would. Sharing one
 * pool would not show the race: the workers must hold rows through different sessions.
 */
describeDb("outbox publishing with concurrent workers", () => {
  let sql: postgres.Sql;
  let url: string;
  let tenant: string;
  const workers: postgres.Sql[] = [];

  beforeAll(async () => {
    sql = await connectIsolated("outbox_concurrency");
    // The same database connectIsolated created, reached through separate pools.
    const isolated = new URL(process.env["DATABASE_URL"]!);
    isolated.pathname = `${isolated.pathname}_outbox_concurrency`;
    url = isolated.toString();
    tenant = randomUUID();
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenant}, ${`c-${tenant.slice(0, 8)}`}, 'concurrency test')
    `;
  });

  beforeEach(async () => {
    await sql`TRUNCATE core.outbox, core.inbox`;
  });

  afterAll(async () => {
    await Promise.all(workers.map((worker) => worker.end({ timeout: 0 })));
    await sql.end();
  });

  function connectWorker(name: string): postgres.Sql {
    const worker = postgres(url, { onnotice: () => {}, connection: { application_name: name } });
    workers.push(worker);
    return worker;
  }

  async function seed(count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    for (const id of ids) {
      await sql`
        INSERT INTO core.outbox (
          id, tenant_id, event_type, aggregate_id, aggregate_version, payload, correlation_id
        ) VALUES (
          ${id}, ${tenant}, 'project.registered', ${randomUUID()}, 1, '{}'::jsonb, ${`c-${id}`}
        )
      `;
    }
    return ids;
  }

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("publishes every event exactly once across four workers", async () => {
    const ids = await seed(120);
    const calls = new Map<string, number>();
    const perWorker: number[] = [];

    const publish: Publish = async (event) => {
      calls.set(event.id, (calls.get(event.id) ?? 0) + 1);
      // A real sink takes time. Without it one worker could drain the queue before the
      // others start, and the test would pass without any overlap.
      await pause(Math.random() * 3);
    };

    await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const worker = connectWorker(`outbox-worker-${index}`);
        let total = 0;
        for (;;) {
          const result = await publishBatch(worker, publish, { limit: 10 });
          total += result.published;
          if (result.published === 0 && result.failed === 0) break;
        }
        perWorker[index] = total;
      }),
    );

    const duplicates = [...calls.values()].reduce((sum, count) => sum + (count - 1), 0);
    expect({ duplicates, distinct: calls.size }).toEqual({ duplicates: 0, distinct: ids.length });
    expect(perWorker.reduce((sum, count) => sum + count, 0)).toBe(ids.length);
    // The work really was shared; otherwise nothing above was exercised concurrently.
    expect(perWorker.filter((count) => count > 0).length).toBeGreaterThan(1);

    expect(await backlogStats(sql)).toMatchObject({ pending: 0, deadLettered: 0 });
    const [marked] = await sql<{ wrong: string }[]>`
      SELECT count(*)::text AS wrong FROM core.outbox WHERE published_at IS NULL OR attempts <> 1
    `;
    expect(marked!.wrong).toBe("0");
  });

  it("a worker that dies mid-publish does not strand the event", async () => {
    const [id] = await seed(1);

    // The first worker takes the event and never returns from the sink.
    let started!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    const crashing = connectWorker("outbox-crashing-worker");
    void publishBatch(crashing, async () => {
      started();
      await new Promise(() => {});
    }).catch(() => {});
    await inFlight;

    // While it is in flight, another worker must leave it alone.
    const survivor = connectWorker("outbox-surviving-worker");
    const seen: string[] = [];
    const record: Publish = async (event) => {
      seen.push(event.id);
    };
    expect(await publishBatch(survivor, record)).toMatchObject({ published: 0 });
    expect(seen).toEqual([]);

    // The process dies: its connections close without committing anything.
    await crashing.end({ timeout: 0 });

    // The server releases the lock once it notices the closed session. No lease to wait out.
    const deadline = Date.now() + 5_000;
    while (seen.length === 0 && Date.now() < deadline) {
      await publishBatch(survivor, record);
      if (seen.length === 0) await pause(50);
    }
    expect(seen).toEqual([id]);
    const [row] = await sql<{ published_at: Date | null; attempts: number }[]>`
      SELECT published_at, attempts FROM core.outbox WHERE id = ${id!}
    `;
    expect(row!.published_at).toBeInstanceOf(Date);
    expect(row!.attempts).toBe(1);
  });
});
