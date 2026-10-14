import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import {
  backlogStats,
  createDispatcher,
  publishBatch,
  type OutboxHandler,
  type OutboxRow,
} from "../src/outbox-publisher.js";
import { replayEvents } from "../src/outbox-replay.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Retry, dead-letter, per-handler deduplication and replay — 07 §7.5.
 */
describeDb("outbox delivery", () => {
  let sql: postgres.Sql;
  let tenant: string;

  beforeAll(async () => {
    sql = await connectIsolated("outbox_delivery");
    tenant = randomUUID();
    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenant}, ${`d-${tenant.slice(0, 8)}`}, 'delivery test')
    `;
  });

  beforeEach(async () => {
    await sql`TRUNCATE core.outbox, core.inbox`;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seed(eventType = "project.registered"): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO core.outbox (
        id, tenant_id, event_type, aggregate_id, aggregate_version, payload, correlation_id
      ) VALUES (
        ${id}, ${tenant}, ${eventType}, ${randomUUID()}, 1, '{}'::jsonb, ${`c-${id}`}
      )
    `;
    return id;
  }

  async function row(id: string) {
    const [found] = await sql<
      {
        attempts: number;
        published_at: Date | null;
        dead_lettered_at: Date | null;
        last_error: string | null;
        next_attempt_at: Date | null;
      }[]
    >`SELECT attempts, published_at, dead_lettered_at, last_error, next_attempt_at
      FROM core.outbox WHERE id = ${id}`;
    return found!;
  }

  const failing = async () => {
    throw new Error("consumer down");
  };

  it("dead-letters an event at the attempt cap and reports it once", async () => {
    const id = await seed();
    const deadLettered: string[] = [];
    const options = {
      maxAttempts: 2,
      onDeadLetter: async (event: OutboxRow) => {
        deadLettered.push(event.id);
      },
    };

    const first = await publishBatch(sql, failing, options);
    expect(first).toMatchObject({ failed: 1, deadLettered: 0 });
    expect((await row(id)).dead_lettered_at).toBeNull();

    const second = await publishBatch(sql, failing, options);
    expect(second).toMatchObject({ failed: 1, deadLettered: 1 });
    const settled = await row(id);
    expect(settled.attempts).toBe(2);
    expect(settled.dead_lettered_at).toBeInstanceOf(Date);
    expect(settled.published_at).toBeNull();
    expect(settled.last_error).toBe("Error: consumer down");
    expect(deadLettered).toEqual([id]);

    // Out of the queue: a third run does not pick it up again.
    const third = await publishBatch(sql, failing, options);
    expect(third).toMatchObject({ published: 0, failed: 0 });
  });

  it("waits out the backoff before the next attempt", async () => {
    const id = await seed();
    await publishBatch(sql, failing, { backoffMs: 60_000 });

    const seen: string[] = [];
    await publishBatch(sql, async (event) => {
      seen.push(event.id);
    });

    expect(seen).not.toContain(id);
    expect((await row(id)).next_attempt_at!.getTime()).toBeGreaterThan(Date.now() + 30_000);
  });

  it("counts dead-lettered events apart from the delayed backlog", async () => {
    await seed();
    await publishBatch(sql, failing, { maxAttempts: 1 });
    await seed();

    expect(await backlogStats(sql)).toMatchObject({ pending: 1, deadLettered: 1 });
  });

  describe("dispatcher", () => {
    function recorder(name: string, fail = () => false) {
      const calls: string[] = [];
      const handler: OutboxHandler = {
        name,
        version: "1",
        accepts: () => true,
        handle: async (event) => {
          if (fail()) throw new Error(`${name} down`);
          calls.push(event.id);
        },
      };
      return { handler, calls };
    }

    it("a retry reruns only the handler that failed", async () => {
      const id = await seed();
      let bDown = true;
      const a = recorder("a");
      const b = recorder("b", () => bDown);
      const dispatcher = createDispatcher(sql, [a.handler, b.handler]);

      await publishBatch(sql, dispatcher.publish);
      expect((await row(id)).last_error).toBe("Error: b: Error: b down");

      bDown = false;
      await publishBatch(sql, dispatcher.publish);

      expect(a.calls).toEqual([id]);
      expect(b.calls).toEqual([id]);
      expect((await row(id)).published_at).toBeInstanceOf(Date);
    });

    it("skips handlers a replay excluded", async () => {
      const id = await seed();
      await sql`UPDATE core.outbox SET skip_handlers = '{b}' WHERE id = ${id}`;
      const a = recorder("a");
      const b = recorder("b");

      await publishBatch(sql, createDispatcher(sql, [a.handler, b.handler]).publish);

      expect(a.calls).toEqual([id]);
      expect(b.calls).toEqual([]);
    });

    it("tells each handler when an event is dead-lettered", async () => {
      const id = await seed("project.export.requested");
      const settled: string[] = [];
      const handler: OutboxHandler = {
        name: "export",
        version: "1",
        accepts: (type) => type === "project.export.requested",
        handle: failing,
        onDeadLetter: async (event) => {
          settled.push(event.id);
        },
      };
      const dispatcher = createDispatcher(sql, [handler]);

      await publishBatch(sql, dispatcher.publish, {
        maxAttempts: 1,
        onDeadLetter: dispatcher.onDeadLetter,
      });

      expect(settled).toEqual([id]);
    });

    it("does not settle a handler that already finished the event", async () => {
      const id = await seed("project.export.requested");
      const settled: string[] = [];
      const make = (name: string, handle: OutboxHandler["handle"]): OutboxHandler => ({
        name,
        version: "1",
        accepts: () => true,
        handle,
        onDeadLetter: async () => {
          settled.push(name);
        },
      });
      const dispatcher = createDispatcher(sql, [make("done", async () => {}), make("stuck", failing)]);

      await publishBatch(sql, dispatcher.publish, {
        maxAttempts: 1,
        onDeadLetter: dispatcher.onDeadLetter,
      });

      expect((await row(id)).dead_lettered_at).toBeInstanceOf(Date);
      expect(settled).toEqual(["stuck"]);
    });
  });

  describe("replay", () => {
    const handlers: OutboxHandler[] = [
      { name: "log", version: "1", accepts: () => true, handle: async () => {} },
      { name: "mailer", version: "1", accepts: () => true, handle: async () => {} },
    ];

    async function deadLetter(): Promise<string> {
      const id = await seed("anchor.failed");
      await publishBatch(sql, failing, { maxAttempts: 1 });
      return id;
    }

    it("a dry run reports the plan and writes nothing", async () => {
      const id = await deadLetter();
      await sql`INSERT INTO core.inbox (event_id, handler_version) VALUES (${id}, 'log@1')`;

      const result = await replayEvents(
        sql,
        handlers,
        { eventIds: [id], limit: 10 },
        { dryRun: true, skipHandlers: [], reason: "" },
      );

      expect(result.replayed).toBe(0);
      expect(result.items).toEqual([
        {
          eventId: id,
          tenantId: tenant,
          eventType: "anchor.failed",
          status: "dead_lettered",
          handlers: [
            { handler: "log", action: "already_processed" },
            { handler: "mailer", action: "run" },
          ],
        },
      ]);
      expect((await row(id)).dead_lettered_at).toBeInstanceOf(Date);
    });

    it("applying requeues the event with the exclusion and records an audit row", async () => {
      const id = await deadLetter();

      const result = await replayEvents(
        sql,
        handlers,
        { eventType: "anchor.failed", limit: 10 },
        { dryRun: false, skipHandlers: ["mailer"], reason: "consumer fixed" },
      );

      expect(result.replayed).toBe(1);
      const [requeued] = await sql<
        { dead_lettered_at: Date | null; attempts: number; skip_handlers: string[] }[]
      >`SELECT dead_lettered_at, attempts, skip_handlers FROM core.outbox WHERE id = ${id}`;
      expect(requeued).toEqual({ dead_lettered_at: null, attempts: 0, skip_handlers: ["mailer"] });

      const [audit] = await sql<{ command: string; effective_role: string; reason: string }[]>`
        SELECT command, effective_role, reason FROM audit.events
        WHERE resource_type = 'outbox_event' AND resource_id = ${id}
      `;
      expect(audit).toEqual({
        command: "outbox.event.replayed",
        effective_role: "deploy_bound",
        reason: "consumer fixed",
      });
    });

    it("leaves published events alone unless asked", async () => {
      const id = await seed("anchor.confirmed");
      await publishBatch(sql, async () => {});

      const without = await replayEvents(
        sql,
        handlers,
        { eventIds: [id], limit: 10 },
        { dryRun: true, skipHandlers: [], reason: "" },
      );
      const withPublished = await replayEvents(
        sql,
        handlers,
        { eventIds: [id], includePublished: true, limit: 10 },
        { dryRun: true, skipHandlers: [], reason: "" },
      );

      expect(without.items).toEqual([]);
      expect(withPublished.items.map((item) => item.status)).toEqual(["published"]);
    });

    it("rejects an unknown handler name, an empty selection, and a write without a reason", async () => {
      const id = await deadLetter();
      await expect(
        replayEvents(sql, handlers, { eventIds: [id], limit: 10 }, {
          dryRun: true,
          skipHandlers: ["mailr"],
          reason: "",
        }),
      ).rejects.toThrow(/Unknown handler/);
      await expect(
        replayEvents(sql, handlers, { limit: 10 }, { dryRun: true, skipHandlers: [], reason: "" }),
      ).rejects.toThrow(/Select events/);
      await expect(
        replayEvents(sql, handlers, { eventIds: [id], limit: 10 }, {
          dryRun: false,
          skipHandlers: [],
          reason: " ",
        }),
      ).rejects.toThrow(/--reason/);
    });
  });

  it("the worker role holds exactly what delivery and replay need", async () => {
    const id = await seed();
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE mpc_worker`;
      await tx`INSERT INTO core.inbox (event_id, handler_version) VALUES (${id}, 'log@1')`;
      await tx`UPDATE core.outbox SET attempts = 1 WHERE id = ${id}`;
      await tx`
        INSERT INTO audit.events (tenant_id, effective_role, command, resource_type, correlation_id)
        VALUES (${tenant}, 'deploy_bound', 'outbox.event.replayed', 'outbox_event', 'grant-check')
      `;
      // Replay may add audit rows, never change them.
      await expect(
        tx.savepoint((sp) => sp`UPDATE audit.events SET reason = 'x' WHERE correlation_id = 'grant-check'`),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
