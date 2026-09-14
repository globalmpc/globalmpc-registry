import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Scanner liveness.
 *
 * `promote` transitions only from `scanned_clean`, so in a deployment without a scan worker
 * uploads stay `quarantined` forever. **That stall looks like waiting, not an
 * error** — checks that the list states the difference itself.
 */
describeDb("scanner liveness reporting", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    stewardToken = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  beforeEach(async () => {
    await fx.sql`DELETE FROM core.worker_heartbeats WHERE worker_kind = 'scan'`;
  });

  function listUploads() {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { authorization: `Bearer ${stewardToken}` },
    });
  }

  it("distinguishes never-reported from 'waiting'", async () => {
    const response = await listUploads();

    expect(response.statusCode).toBe(200);
    expect(response.json().scanner.state).toBe("never_seen");
    // Must be able to answer "why not".
    expect(response.json().scanner.detail).toContain("quarantine");
  });

  it("is running with a recent heartbeat", async () => {
    await fx.sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at)
      VALUES ('scan', now())
    `;

    const response = await listUploads();
    expect(response.json().scanner.state).toBe("running");
    expect(response.json().scanner.secondsSinceHeartbeat).toBeLessThan(5);
  });

  it("an old heartbeat is stale — distinct from absent", async () => {
    // Heartbeats are every 15s, so 10 minutes means forty missed cycles.
    await fx.sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at)
      VALUES ('scan', now() - interval '10 minutes')
    `;

    const response = await listUploads();
    expect(response.json().scanner.state).toBe("stale");
    expect(response.json().scanner.secondsSinceHeartbeat).toBeGreaterThan(500);
  });

  it("returns the list even if the liveness query fails", async () => {
    // Unknown is a state too. Observability does not cost availability.
    // Forces the failure by dropping the function itself.
    await fx.sql`ALTER FUNCTION core.seconds_since_worker_heartbeat(TEXT) RENAME TO seconds_since_worker_heartbeat_hidden`;
    try {
      const response = await listUploads();
      expect(response.statusCode).toBe(200);
      expect(response.json().scanner.state).toBe("unknown");
      expect(Array.isArray(response.json().items)).toBe(true);
    } finally {
      await fx.sql`ALTER FUNCTION core.seconds_since_worker_heartbeat_hidden(TEXT) RENAME TO seconds_since_worker_heartbeat`;
    }
  });

  it("the gauge reports worker liveness", async () => {
    await fx.sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at)
      VALUES ('scan', now() - interval '42 seconds')
    `;

    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    expect(metrics.body).toContain('mpc_worker_seconds_since_heartbeat{state="scan"}');
  });

  it("a worker that never reported is absent from the gauge", async () => {
    // Emitting 0 would read as "just seen". Alert rules handle absent and old
    // separately — `absent()` and `> 300`.
    const metrics = await app.inject({ method: "GET", url: "/metrics" });

    expect(metrics.body).not.toContain('mpc_worker_seconds_since_heartbeat{state="scan"}');
  });

  it("reports liveness even with no uploads", async () => {
    // Backlog-count metrics go quiet when the queue is empty. This fills that gap.
    const empty = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.otherProjectA}/uploads`,
      headers: { authorization: `Bearer ${stewardToken}` },
    });

    expect(empty.statusCode).toBe(200);
    expect(empty.json().scanner.state).toBe("never_seen");
  });
});
