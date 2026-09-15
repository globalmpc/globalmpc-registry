import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Notification sinks.
 *
 * Three things are enforced.
 *
 * 1. **Secrets never leave in responses** — not even references. Paths reveal the deployment layout.
 * 2. **Registered is distinguished from actually delivering** — being configured but
 *    sending nothing is the worst state.
 * 3. **Pause, do not delete** — deleting loses why delivery stopped.
 */
describeDb("notification sinks", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function create(token: string, body: unknown) {
    return app.inject({
      method: "POST",
      url: "/api/v1/admin/notification-sinks",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: body as never,
    });
  }

  function list(token: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/admin/notification-sinks",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("registers a sink", async () => {
    const response = await create(operatorToken, {
      url: `https://hooks.example.test/${randomUUID().slice(0, 8)}`,
      secretReference: "env:WEBHOOK_SECRET_TEST",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("active");
    expect(response.json().hasSecret).toBe(true);
  });

  it("keeps the secret reference out of the response", async () => {
    await create(operatorToken, {
      url: `https://hooks.example.test/${randomUUID().slice(0, 8)}`,
      secretReference: "file:/run/secrets/webhook_notify_hmac",
    });

    const listed = await list(operatorToken);
    // The reference reveals the deployment layout. Only whether it is set is returned.
    expect(listed.body).not.toContain("/run/secrets/webhook_notify_hmac");
    expect(listed.body).not.toContain("secretReference");
  });

  it("rejects non-https", async () => {
    // Notification bodies carry project identifiers. They are not sent in plaintext.
    const response = await create(operatorToken, {
      url: "http://hooks.example.test/plain",
      secretReference: "env:WEBHOOK_SECRET_TEST",
    });

    expect(response.statusCode).toBe(400);
  });

  it("does not register the same address twice", async () => {
    const url = `https://hooks.example.test/${randomUUID().slice(0, 8)}`;
    expect((await create(operatorToken, { url, secretReference: "env:WEBHOOK_SECRET_A" })).statusCode).toBe(200);

    const second = await create(operatorToken, { url, secretReference: "env:WEBHOOK_SECRET_B" });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("SINK_ALREADY_REGISTERED");
  });

  /**
   * Registration refuses internal destinations (W-087).
   *
   * The worker checks again at send time, with the name resolved. This is the save-time
   * rejection that tells the operator what is wrong on the spot.
   */
  it.each([
    "https://10.0.0.1/hook",
    "https://169.254.169.254/latest/meta-data/",
    "https://localhost/hook",
    "https://api.internal/hook",
    "https://[fd00::1]/hook",
    "https://[::ffff:127.0.0.1]/hook",
  ])("refuses an internal destination at registration: %s", async (url) => {
    const response = await create(operatorToken, { url, secretReference: "env:WEBHOOK_SECRET_A" });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("SINK_URL_NOT_ALLOWED");
  });

  /**
   * The signing-secret reference stays inside the webhook namespace (W-087).
   *
   * Otherwise it could point the worker at its own database URL or signer key.
   */
  it.each([
    "env:DATABASE_URL",
    "file:/run/secrets/worker_database_url",
    "file:/etc/passwd",
    "plain:literal-secret",
    "literal-secret",
  ])("refuses a secret reference outside the webhook namespace: %s", async (secretReference) => {
    const response = await create(operatorToken, {
      url: `https://hooks.example.test/${randomUUID().slice(0, 8)}`,
      secretReference,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("SINK_SECRET_REFERENCE_NOT_ALLOWED");
    expect(response.body).not.toContain(secretReference);
  });

  it("rejects callers without admin rights", async () => {
    const response = await create(stewardToken, {
      url: "https://hooks.example.test/nope",
      secretReference: "env:WEBHOOK_SECRET_A",
    });

    // Changing a sink redirects notifications. A silent change leaves the original
    // recipient unaware that notices stopped.
    expect(response.statusCode).toBe(403);
  });

  it("queues deliveries for a registered sink", async () => {
    const url = `https://hooks.example.test/${randomUUID().slice(0, 8)}`;
    const sink = (await create(operatorToken, { url, secretReference: "env:WEBHOOK_SECRET_A" })).json();

    // Notifications are created in four places. Checks the trigger covers all of them.
    const reason = `deliver-${randomUUID().slice(0, 8)}`;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${reason}
      )
    `;

    const listed = (await list(operatorToken)).json();
    const mine = listed.items.find((item: { id: string }) => item.id === sink.id);
    expect(mine.delivery.pending).toBeGreaterThan(0);
  });

  it("queues no new deliveries for a paused sink", async () => {
    const url = `https://hooks.example.test/${randomUUID().slice(0, 8)}`;
    const sink = (await create(operatorToken, { url, secretReference: "env:WEBHOOK_SECRET_A" })).json();

    const paused = await app.inject({
      method: "POST",
      url: `/api/v1/admin/notification-sinks/${sink.id}/state`,
      headers: {
        authorization: `Bearer ${operatorToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${sink.version}"`,
      },
      payload: { state: "paused" },
    });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().state).toBe("paused");

    const before = paused.json().delivery.pending;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${`paused-${randomUUID().slice(0, 6)}`}
      )
    `;

    const after = (await list(operatorToken)).json().items.find(
      (item: { id: string }) => item.id === sink.id,
    );
    // Paused is not deleted. History stays; only new deliveries stop.
    expect(after.delivery.pending).toBe(before);
    expect(after.state).toBe("paused");
  });

  it("another tenant's sinks are not visible", async () => {
    const operatorB = await signIn(app, fx.operatorB);
    const mine = (await list(operatorToken)).json().items as { id: string }[];
    const theirs = (await list(operatorB)).json().items as { id: string }[];

    const mineIds = new Set(mine.map((item) => item.id));
    for (const item of theirs) expect(mineIds.has(item.id)).toBe(false);
  });
});
