import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { deliverOnce, deliveryBacklog, signPayload } from "../src/notification-delivery.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Notification webhook delivery.
 *
 * Three guarantees.
 *
 * 1. **Sign it** — without a signature, anyone who knows the URL can forge a notification.
 * 2. **Never retry forever** — at the cap the delivery is frozen, and that fact is recorded.
 * 3. **Never record an unsent delivery as a success.**
 */
describeDb("notification delivery", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let sinkId: string;

  const options = {
    maxAttempts: 3,
    backoffMs: 1000,
    resolveSecret: (reference: string) => {
      if (reference === "env:BROKEN") throw new Error("cannot resolve reference");
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
      VALUES (${id}, ${tenantId}, 'registry_revoked', 'mpc_operator', 'Record revoked', '/w/registries')
    `;
    return id;
  }

  it("a delivery row is attached automatically when a notification is created", async () => {
    const id = await makeNotification();

    const [row] = await sql<{ state: string }[]>`
      SELECT state FROM core.notification_deliveries WHERE notification_id = ${id}
    `;
    // Four places create notifications. Attaching in a route would miss any new one.
    expect(row!.state).toBe("pending");
  });

  it("sends with a signature and records success", async () => {
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

    // The receiver must be able to recompute and match it with the same secret.
    const timestamp = seen!.headers["x-mpc-timestamp"]!;
    const expected = createHmac("sha256", "test-secret")
      .update(`${timestamp}.${seen!.body}`)
      .digest("hex");
    expect(seen!.headers["x-mpc-signature"]).toBe(expected);
    expect(signPayload("test-secret", seen!.body, timestamp)).toBe(expected);

    // The body carries neither projection nor evidence. We do not control the receiver.
    const body = JSON.parse(seen!.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([
      "kind",
      "link",
      "notificationId",
      "occurredAt",
      "summary",
    ]);
  });

  it("on failure, leaves it for retry with a backoff", async () => {
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
    // Not frozen — the cap has not been reached yet.
    expect(row!.state).toBe("pending");
    expect(row!.attempts).toBe(1);
    expect(row!.last_error).toContain("500");

    // Retrying immediately would keep hammering a dead receiver.
    const [again] = await sql<{ due: boolean }[]>`
      SELECT next_attempt_at > now() AS due FROM core.notification_deliveries
      WHERE notification_id = ${id}
    `;
    expect(again!.due).toBe(true);
  });

  it("freezes at the cap and records that fact", async () => {
    const id = await makeNotification();
    const failing = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;

    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      // Skip the backoff and create the next attempt immediately.
      await sql`UPDATE core.notification_deliveries SET next_attempt_at = now()`;
      await deliverOnce(sql, { ...options, fetchImpl: failing });
    }

    const [row] = await sql<{ state: string; attempts: number }[]>`
      SELECT state, attempts FROM core.notification_deliveries WHERE notification_id = ${id}
    `;
    expect(row!.state).toBe("failed");
    expect(row!.attempts).toBe(options.maxAttempts);

    // The in-app notification remains. Only the fact that it was "sent" is lost.
    const [notification] = await sql<{ id: string }[]>`
      SELECT id FROM core.notifications WHERE id = ${id}
    `;
    expect(notification).toBeDefined();
    expect((await deliveryBacklog(sql)).failed).toBe(1);
  });

  it("freezes without retrying when the secret cannot be resolved", async () => {
    await sql`UPDATE core.notification_sinks SET secret_reference = 'env:BROKEN'`;
    const id = await makeNotification();

    const result = await deliverOnce(sql, options);

    // Config must be fixed, so do not wait for the cap. Meanwhile the log would fill with the same
    // error.
    expect(result.failed).toBe(1);
    const [row] = await sql<{ state: string; last_error: string }[]>`
      SELECT state, last_error FROM core.notification_deliveries WHERE notification_id = ${id}
    `;
    expect(row!.state).toBe("failed");
    expect(row!.last_error).toContain("secret reference");
  });

  it("does not send to a paused receiver", async () => {
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

  it("does nothing when there is nothing to send", async () => {
    // Adds no load to deployments that have no receivers.
    const result = await deliverOnce(sql, options);
    expect(result).toEqual({ handled: false, delivered: 0, failed: 0 });
  });
});
