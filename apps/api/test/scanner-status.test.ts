import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at, detail)
      VALUES ('scan', now(), '{"scannerAvailable":true}'::jsonb)
    `;

    const response = await listUploads();
    expect(response.json().scanner.state).toBe("running");
    expect(response.json().scanner.secondsSinceHeartbeat).toBeLessThan(5);
  });

  it("reports unavailable when the worker is fresh but its scanner is down, and recovers", async () => {
    await fx.sql`INSERT INTO core.worker_heartbeats(worker_kind,last_seen_at,detail)
      VALUES('scan',now(),' {"scannerAvailable":false}'::jsonb)`;
    const down = await listUploads();
    expect(down.json().scanner.state).toBe("unavailable");
    expect(down.json().scanner.secondsSinceHeartbeat).toBeLessThan(5);
    expect(down.json().scanner.detail).toContain("quarantine");
    await fx.sql`UPDATE core.worker_heartbeats SET detail='{"scannerAvailable":true}'::jsonb WHERE worker_kind='scan'`;
    expect((await listUploads()).json().scanner.state).toBe("running");
  });

  it("reports unauthorized while the worker backs off a rejected token, and recovers", async () => {
    await fx.sql`INSERT INTO core.worker_heartbeats(worker_kind,last_seen_at,detail)
      VALUES('scan',now(),'{"scannerAvailable":true,"status":"unauthorized","unauthorizedFailures":4}'::jsonb)`;
    const refused = (await listUploads()).json().scanner;
    // The scanner answers, but nothing can be reported: the operator has to act on the token.
    expect(refused.state).toBe("unauthorized");
    expect(refused.secondsSinceHeartbeat).toBeLessThan(5);
    expect(refused.detail).toContain("service token");
    expect(refused.detail).toContain("quarantine");
    await fx.sql`UPDATE core.worker_heartbeats SET detail='{"scannerAvailable":true}'::jsonb WHERE worker_kind='scan'`;
    expect((await listUploads()).json().scanner.state).toBe("running");
  });

  it("a stale heartbeat outranks an old unauthorized status", async () => {
    await fx.sql`INSERT INTO core.worker_heartbeats(worker_kind,last_seen_at,detail)
      VALUES('scan',now() - interval '10 minutes','{"status":"unauthorized"}'::jsonb)`;
    expect((await listUploads()).json().scanner.state).toBe("stale");
  });

  it("does not infer scanner health from a legacy heartbeat without availability", async () => {
    await fx.sql`INSERT INTO core.worker_heartbeats(worker_kind,last_seen_at) VALUES('scan',now())`;
    expect((await listUploads()).json().scanner.state).toBe("unknown");
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

  it("the gauge says when the API refuses the scan worker's token, for MpcScanWorkerUnauthorized", async () => {
    await fx.sql`INSERT INTO core.worker_heartbeats(worker_kind,last_seen_at,detail)
      VALUES('scan',now(),'{"scannerAvailable":true,"status":"unauthorized","unauthorizedFailures":2}'::jsonb)`;
    const refused = (await app.inject({ method: "GET", url: "/metrics" })).body;
    expect(refused).toContain('mpc_worker_unauthorized{state="scan"} 1');
    // The other gauges are still there, and HELP/TYPE is emitted once.
    expect(refused).toContain('mpc_worker_seconds_since_heartbeat{state="scan"}');
    expect(refused.match(/# TYPE mpc_worker_unauthorized gauge/g)).toHaveLength(1);

    await fx.sql`UPDATE core.worker_heartbeats SET detail='{"scannerAvailable":true}'::jsonb WHERE worker_kind='scan'`;
    expect((await app.inject({ method: "GET", url: "/metrics" })).body).toContain('mpc_worker_unauthorized{state="scan"} 0');
  });

  it("the rule exists and reads the gauge the API exports", () => {
    const rules = readFileSync(new URL("../../../config/observability/alerts.yml", import.meta.url), "utf8");
    expect(rules).toMatch(/- alert: MpcScanWorkerUnauthorized\n\s+expr: max\(mpc_worker_unauthorized\{state="scan"\}\) == 1/);
  });

  it("a worker that never reported is absent from the gauge", async () => {
    // Emitting 0 would read as "just seen". Alert rules handle absent and old
    // separately — `absent()` and `> 300`.
    const metrics = await app.inject({ method: "GET", url: "/metrics" });

    expect(metrics.body).not.toContain('mpc_worker_seconds_since_heartbeat{state="scan"}');
    expect(metrics.body).not.toContain("mpc_worker_unauthorized");
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
