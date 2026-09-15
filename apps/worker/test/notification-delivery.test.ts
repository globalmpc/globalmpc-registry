import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { ResponseTooLargeError, type PinnedFetch, type PinnedRequestInit } from "@mpc/config";
import { connectIsolated } from "./helpers/isolated-db.js";
import {
  DELIVERY_ERROR_CATEGORIES,
  deliverOnce,
  deliveryBacklog,
  signPayload,
  WEBHOOK_MAX_RESPONSE_BYTES,
} from "../src/notification-delivery.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/** A public documentation address. Tests never use real DNS. */
const PUBLIC_ADDRESS = "203.0.113.10";

/**
 * Notification webhook delivery.
 *
 * Three guarantees.
 *
 * 1. **Sign it** — without a signature, anyone who knows the URL can forge a notification.
 * 2. **Never retry forever** — at the cap the delivery is frozen, and that fact is recorded.
 * 3. **Never record an unsent delivery as a success.**
 *
 * And since W-087: the receiver is judged like a source endpoint (resolved, private ranges
 * refused, connection pinned, no redirects), and what is stored about a failure is a category,
 * never the peer's status or error text — the admin screen shows it.
 */
describeDb("notification delivery", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let sinkId: string;

  const options = {
    maxAttempts: 3,
    backoffMs: 1000,
    resolveSecret: (reference: string) => {
      if (reference === "env:WEBHOOK_SECRET_BROKEN") throw new Error("cannot resolve reference");
      return "test-secret";
    },
    resolveHost: async () => [PUBLIC_ADDRESS],
  };

  const ok: PinnedFetch = async () => new Response("", { status: 200 });

  function recording(respond: PinnedFetch = ok) {
    const calls: { url: string; init: PinnedRequestInit }[] = [];
    const fetchImpl: PinnedFetch = async (url, init) => {
      calls.push({ url: url.toString(), init });
      return respond(url, init);
    };
    return { calls, fetchImpl };
  }

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
      VALUES (${sinkId}, ${tenantId}, 'https://hooks.example.test/a', 'env:WEBHOOK_SECRET_OK')
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

  async function setSink(url: string, secretReference = "env:WEBHOOK_SECRET_OK"): Promise<void> {
    await sql`
      UPDATE core.notification_sinks SET url = ${url}, secret_reference = ${secretReference}
      WHERE id = ${sinkId}
    `;
  }

  async function deliveryRow(id: string) {
    const [row] = await sql<{ state: string; attempts: number; last_error: string | null }[]>`
      SELECT state, attempts, last_error FROM core.notification_deliveries
      WHERE notification_id = ${id}
    `;
    return row!;
  }

  it("a delivery row is attached automatically when a notification is created", async () => {
    const id = await makeNotification();

    // Four places create notifications. Attaching in a route would miss any new one.
    expect((await deliveryRow(id)).state).toBe("pending");
  });

  it("sends with a signature and records success", async () => {
    await makeNotification();
    const { calls, fetchImpl } = recording();

    const result = await deliverOnce(sql, { ...options, fetchImpl });

    expect(result).toEqual({ handled: true, delivered: 1, failed: 0 });
    expect(calls[0]!.url).toBe("https://hooks.example.test/a");

    // The receiver must be able to recompute and match it with the same secret.
    const headers = calls[0]!.init.headers;
    const body = calls[0]!.init.body!;
    const timestamp = headers["x-mpc-timestamp"]!;
    const expected = createHmac("sha256", "test-secret").update(`${timestamp}.${body}`).digest("hex");
    expect(headers["x-mpc-signature"]).toBe(expected);
    expect(signPayload("test-secret", body, timestamp)).toBe(expected);

    // The body carries neither projection nor evidence. We do not control the receiver.
    const parsed = JSON.parse(body) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual([
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
      fetchImpl: async () => new Response("", { status: 500 }),
    });

    expect(result.failed).toBe(0);
    const row = await deliveryRow(id);
    // Not frozen — the cap has not been reached yet.
    expect(row.state).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.last_error).toBe("http_error");

    // Retrying immediately would keep hammering a dead receiver.
    const [again] = await sql<{ due: boolean }[]>`
      SELECT next_attempt_at > now() AS due FROM core.notification_deliveries
      WHERE notification_id = ${id}
    `;
    expect(again!.due).toBe(true);
  });

  it("freezes at the cap and records that fact", async () => {
    const id = await makeNotification();
    const failing: PinnedFetch = async () => new Response("", { status: 503 });

    for (let attempt = 0; attempt < options.maxAttempts; attempt += 1) {
      // Skip the backoff and create the next attempt immediately.
      await sql`UPDATE core.notification_deliveries SET next_attempt_at = now()`;
      await deliverOnce(sql, { ...options, fetchImpl: failing });
    }

    const row = await deliveryRow(id);
    expect(row.state).toBe("failed");
    expect(row.attempts).toBe(options.maxAttempts);

    // The in-app notification remains. Only the fact that it was "sent" is lost.
    const [notification] = await sql<{ id: string }[]>`
      SELECT id FROM core.notifications WHERE id = ${id}
    `;
    expect(notification).toBeDefined();
    expect((await deliveryBacklog(sql)).failed).toBe(1);
  });

  it("freezes without retrying when the secret cannot be resolved", async () => {
    await setSink("https://hooks.example.test/a", "env:WEBHOOK_SECRET_BROKEN");
    const id = await makeNotification();

    const result = await deliverOnce(sql, options);

    // Config must be fixed, so do not wait for the cap. Meanwhile the log would fill with the same
    // error.
    expect(result.failed).toBe(1);
    const row = await deliveryRow(id);
    expect(row.state).toBe("failed");
    expect(row.last_error).toBe("secret_unavailable");
  });

  it("does not send to a paused receiver", async () => {
    await makeNotification();
    await sql`UPDATE core.notification_sinks SET state = 'paused'`;
    const { calls, fetchImpl } = recording();

    const result = await deliverOnce(sql, { ...options, fetchImpl });

    expect(result.handled).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("does nothing when there is nothing to send", async () => {
    // Adds no load to deployments that have no receivers.
    const result = await deliverOnce(sql, options);
    expect(result).toEqual({ handled: false, delivered: 0, failed: 0 });
  });

  describe("destination checks at send time (W-087)", () => {
    it.each([
      ["a private IPv4 literal", "https://10.0.0.5/hook"],
      ["the metadata address", "https://169.254.169.254/latest/meta-data/"],
      ["localhost", "https://localhost/hook"],
      ["an IPv6 loopback literal", "https://[::1]/hook"],
      ["an IPv6 unique local literal", "https://[fd12:3456::1]/hook"],
    ])("refuses %s without connecting", async (_label, url) => {
      await setSink(url);
      const id = await makeNotification();
      const { calls, fetchImpl } = recording();

      await deliverOnce(sql, { ...options, fetchImpl });

      expect(calls).toHaveLength(0);
      expect((await deliveryRow(id)).last_error).toBe("rejected_destination");
    });

    it.each([
      ["loopback", ["127.0.0.1"]],
      ["an IPv6 unique local address", ["fd00::5"]],
      ["an IPv4-mapped private address", ["::ffff:10.0.0.1"]],
      ["one private address among public ones", [PUBLIC_ADDRESS, "10.0.0.7"]],
    ])("refuses a name that now resolves to %s (DNS rebinding)", async (_label, addresses) => {
      // The name was public when registered. What it resolves to at send time is what counts.
      const id = await makeNotification();
      const { calls, fetchImpl } = recording();

      await deliverOnce(sql, { ...options, fetchImpl, resolveHost: async () => addresses });

      expect(calls).toHaveLength(0);
      expect((await deliveryRow(id)).last_error).toBe("rejected_destination");
    });

    it("stores an unresolvable name under the same category", async () => {
      // "No such name" and "private name" must read the same, or the admin screen maps internal DNS.
      const id = await makeNotification();

      await deliverOnce(sql, {
        ...options,
        fetchImpl: recording().fetchImpl,
        resolveHost: async () => {
          throw new Error("getaddrinfo ENOTFOUND vault.corp.example");
        },
      });

      expect((await deliveryRow(id)).last_error).toBe("rejected_destination");
    });

    it("connects only to the addresses it checked", async () => {
      await makeNotification();
      let lookups = 0;
      const { calls, fetchImpl } = recording();

      await deliverOnce(sql, {
        ...options,
        fetchImpl,
        resolveHost: async () => {
          lookups += 1;
          return [PUBLIC_ADDRESS];
        },
      });

      // One resolution, and the connection is pinned to its answer — no second lookup to rebind.
      expect(lookups).toBe(1);
      expect(calls[0]!.init.pinnedAddresses).toEqual([PUBLIC_ADDRESS]);
      expect(calls[0]!.init.method).toBe("POST");
      expect(calls[0]!.init.redirect).toBe("manual");
      expect(calls[0]!.init.maxResponseBytes).toBe(WEBHOOK_MAX_RESPONSE_BYTES);
    });

    it("does not follow a redirect", async () => {
      const id = await makeNotification();
      const { calls, fetchImpl } = recording(
        async () =>
          new Response(null, { status: 302, headers: { location: "https://10.0.0.5/steal" } }),
      );

      const result = await deliverOnce(sql, { ...options, fetchImpl });

      expect(calls).toHaveLength(1);
      expect(result.delivered).toBe(0);
      const row = await deliveryRow(id);
      expect(row.state).toBe("pending");
      expect(row.last_error).toBe("http_error");
    });
  });

  describe("stored errors are categories (W-087)", () => {
    it("stores an HTTP failure without its status", async () => {
      const id = await makeNotification();

      await deliverOnce(sql, {
        ...options,
        fetchImpl: async () => new Response("Not Found: /admin", { status: 404 }),
      });

      expect((await deliveryRow(id)).last_error).toBe("http_error");
    });

    it("stores a timeout as a category", async () => {
      const id = await makeNotification();
      const hanging: PinnedFetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });

      await deliverOnce(sql, { ...options, timeoutMs: 20, fetchImpl: hanging });

      expect((await deliveryRow(id)).last_error).toBe("timeout");
    });

    it("stores a connection failure without its text", async () => {
      const id = await makeNotification();

      await deliverOnce(sql, {
        ...options,
        fetchImpl: async () => {
          throw new Error(`connect ECONNREFUSED ${PUBLIC_ADDRESS}:443`);
        },
      });

      expect((await deliveryRow(id)).last_error).toBe("network_error");
    });

    it("stores an oversized response as a category", async () => {
      const id = await makeNotification();

      await deliverOnce(sql, {
        ...options,
        fetchImpl: async () => {
          throw new ResponseTooLargeError(WEBHOOK_MAX_RESPONSE_BYTES);
        },
      });

      expect((await deliveryRow(id)).last_error).toBe("response_too_large");
    });

    it("the database accepts only the categories", async () => {
      const id = await makeNotification();
      for (const category of DELIVERY_ERROR_CATEGORIES) {
        await sql`
          UPDATE core.notification_deliveries SET last_error = ${category}
          WHERE notification_id = ${id}
        `;
      }

      await expect(
        sql`
          UPDATE core.notification_deliveries SET last_error = 'HTTP 404'
          WHERE notification_id = ${id}
        `,
      ).rejects.toThrow(/notification_deliveries_last_error_category/);
    });
  });

  describe("secret reference namespace at send time (W-087)", () => {
    it.each(["env:DATABASE_URL", "file:/run/secrets/worker_database_url", "plain:literal-secret"])(
      "refuses %s without resolving it",
      async (reference) => {
        await setSink("https://hooks.example.test/a", reference);
        const id = await makeNotification();
        const resolved: string[] = [];
        const { calls, fetchImpl } = recording();

        const result = await deliverOnce(sql, {
          ...options,
          fetchImpl,
          resolveSecret: (value: string) => {
            resolved.push(value);
            return "value";
          },
        });

        expect(result.failed).toBe(1);
        expect(resolved).toEqual([]);
        expect(calls).toHaveLength(0);
        const row = await deliveryRow(id);
        expect(row.state).toBe("failed");
        expect(row.last_error).toBe("secret_unavailable");
      },
    );
  });
});
