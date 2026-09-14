import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Official source lookup — 05 §5.12, OD-42.
 *
 * This file guards two things: **responses are classified truthfully**, and **a call that
 * was not made is never recorded as if it were.**
 */
describeDb("source lookup", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;
  let operatorToken: string;

  /** The next response. The test plays the source. */
  let nextResponse: () => Response | Promise<Response>;
  /** Requests actually sent. Checks that nothing was called when it should not be. */
  let calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return nextResponse();
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, {
      fetchImpl,
      // Tests do not use real DNS. Treat the host as resolved to a public address.
      resolveHost: async () => ["203.0.113.10"],
    });
    stewardToken = await signIn(app, fx.stewardA);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  beforeEach(() => {
    calls = [];
    nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
  });

  function collect(token: string, connectionId = fx.connectionA) {
    return app.inject({
      method: "POST",
      url: `/api/v1/source-connections/${connectionId}/collect`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: { projectId: fx.projectA, queryBasis: { licenseNumber: "MN-1" } },
    });
  }

  it("records 200 with a matching schema as confirmed", async () => {
    const response = await collect(stewardToken);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.result).toBe("confirmed_from_source");
    expect(body.confirmed).toBe(true);

    // Even when confirmed, the limitations the authority declared are always attached.
    expect(body.limitations).toContain("economic_viability");
  });

  it("treats 404 as no record, not a source outage", async () => {
    nextResponse = () => new Response("", { status: 404 });

    const body = (await collect(stewardToken)).json();
    // Mixing the two keeps retrying a record that does not exist.
    expect(body.result).toBe("source_returned_no_record");
    expect(body.confirmed).toBe(false);
  });

  it("records 503 as a source outage", async () => {
    nextResponse = () => new Response("", { status: 503 });
    expect((await collect(stewardToken)).json().result).toBe("source_unavailable");
  });

  it("does not follow redirects", async () => {
    // Following them would turn a registry lookup into a channel for reading internal addresses.
    nextResponse = () =>
      new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("manual_review_required");
    // No second request was sent.
    expect(calls).toHaveLength(1);
  });

  it("does not guess values from a non-JSON body", async () => {
    nextResponse = () => new Response("<html>Under maintenance</html>", { status: 200 });
    expect((await collect(stewardToken)).json().result).toBe("schema_changed");
  });

  it("records failures as receipts too", async () => {
    nextResponse = () => new Response("", { status: 404 });
    const receiptId = (await collect(stewardToken)).json().receiptId;

    const [row] = await fx.sql<{ result: string; raw_hash: string }[]>`
      SELECT result, raw_hash FROM core.source_receipts WHERE id = ${receiptId}
    `;
    expect(row?.result).toBe("source_returned_no_record");
    // Without a raw body, no fake hash is made.
    expect(row?.raw_hash).toBe(`0x${"0".repeat(64)}`);
  });

  it("updates last_success_at only when confirmed", async () => {
    await fx.sql`UPDATE core.source_connections SET last_success_at = NULL WHERE id = ${fx.connectionA}`;

    nextResponse = () => new Response("", { status: 503 });
    await collect(stewardToken);

    const [after] = await fx.sql<{ last_success_at: Date | null }[]>`
      SELECT last_success_at FROM core.source_connections WHERE id = ${fx.connectionA}
    `;
    // Recording an outage response as the success time makes "when did we last get an
    // answer" false.
    expect(after?.last_success_at).toBeNull();

    // Confirmation requires the declared fields (A7). `{ok:true}` is now schema_changed.
    nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
    await collect(stewardToken);

    const [ok] = await fx.sql<{ last_success_at: Date | null }[]>`
      SELECT last_success_at FROM core.source_connections WHERE id = ${fx.connectionA}
    `;
    expect(ok?.last_success_at).not.toBeNull();
  });

  /**
   * Response profile — 2026-09-10 audit A7.
   *
   * Previously, 200 + valid JSON meant confirmed. Even a response in which the source said
   * "cannot answer" was recorded as confirmed.
   */
  it("does not confirm a 200 without the declared fields", async () => {
    nextResponse = () => new Response(JSON.stringify({ unexpected: 1 }), { status: 200 });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("schema_changed");
    expect(body.confirmed).toBe(false);
  });

  it("does not read a business error in a 200 body as confirmed", async () => {
    nextResponse = () => new Response(JSON.stringify({ error: "unavailable" }), { status: 200 });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("manual_review_required");
    expect(body.detail).toContain("unavailable");
  });

  it("does not read a 'no record' sent as 200 as confirmed", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ found: false }), { status: 200 });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("source_returned_no_record");
  });

  it("does not confirm for a connection without a declared response format", async () => {
    await fx.sql`
      UPDATE core.source_connections SET schema_fingerprint = NULL WHERE id = ${fx.connectionA}
    `;
    try {
      nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
      const body = (await collect(stewardToken)).json();
      expect(body.result).toBe("manual_review_required");
      expect(body.confirmed).toBe(false);
    } finally {
      await fx.sql`
        UPDATE core.source_connections SET schema_fingerprint = ARRAY['licenseId']
        WHERE id = ${fx.connectionA}
      `;
    }
  });

  // AC-24: a source without a real API proceeds by manual check but is not shown as an
  // `active API` or as government cooperation.
  it("does not call a pending_access connection", async () => {
    await fx.sql`UPDATE core.source_connections SET state = 'planned' WHERE id = ${fx.connectionA}`;

    const response = await collect(stewardToken);
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("SOURCE_NOT_CALLABLE");

    // Calling would get a 401 recorded as "authentication failed". In fact access was never
    // agreed.
    expect(calls).toHaveLength(0);

    // No receipt either — nothing was looked up, so no lookup record may exist.
    const [count] = await fx.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM core.source_receipts
      WHERE connection_id = ${fx.connectionA} AND result = 'access_not_authorized'
    `;
    expect(count?.n).toBe("0");

    await fx.sql`UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}`;
  });

  it("does not let a role without lookup permission call", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/source-connections/${fx.connectionA}/collect`,
      headers: {
        authorization: `Bearer ${await signIn(app, fx.reviewerA)}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { projectId: fx.projectA, queryBasis: {} },
    });

    expect(response.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("lets mpc_operator call too", async () => {
    expect((await collect(operatorToken)).statusCode).toBe(200);
  });

  it("does not expose another tenant's connection", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/source-connections/${fx.connectionA}/collect`,
      headers: {
        authorization: `Bearer ${await signIn(app, fx.operatorB)}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { projectId: fx.projectA, queryBasis: {} },
    });

    expect(response.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("looks up only once for the same Idempotency-Key", async () => {
    const key = idempotencyKey();
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/source-connections/${fx.connectionA}/collect`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": key },
        payload: { projectId: fx.projectA, queryBasis: { licenseNumber: "MN-1" } },
      });

    const first = (await send()).json();
    const second = (await send()).json();

    expect(second.receiptId).toBe(first.receiptId);
    // Retries must not put load on the source.
    expect(calls).toHaveLength(1);
  });
});

/**
 * DB constraints — 0019.
 *
 * Rules that hold even if the application bypasses them.
 */
describeDb("connection configuration constraints", () => {
  let fx: TestFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.close();
  });

  it("cannot become active without a call target", async () => {
    await expect(
      fx.sql`
        UPDATE core.source_connections SET endpoint = NULL WHERE id = ${fx.connectionA}
      `,
    ).rejects.toThrow(/source_connections_active_needs_endpoint/);
  });

  it("rejects an http endpoint", async () => {
    // Requests to a registry cannot go out in plaintext.
    await expect(
      fx.sql`
        UPDATE core.source_connections
        SET endpoint = 'http://registry.example.test/x' WHERE id = ${fx.connectionA}
      `,
    ).rejects.toThrow(/source_connections_endpoint_check/);
  });

  it("rejects credentials inside the URL", async () => {
    // A secret in a URL stays verbatim in logs, audit records and error messages.
    //
    // Match on the constraint name. PostgreSQL error text follows the server locale, so
    // matching English text fails under a non-English server locale — the constraint fires but the test
    // still fails.
    await expect(
      fx.sql`
        UPDATE core.source_connections
        SET endpoint = 'https://user:pass@registry.example.test/x' WHERE id = ${fx.connectionA}
      `,
    ).rejects.toThrow(/source_connections_endpoint_check/);
  });
});
