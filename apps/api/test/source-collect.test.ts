import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SOURCE_RESULTS, SOURCE_RESULT_BEHAVIOUR, receiptProcessingStateFor } from "@mpc/domain";
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

  beforeEach(async () => {
    calls = [];
    nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
    // A degrading result pauses the shared connection (AC-19). Each test starts from a live one.
    await fx.sql`
      UPDATE core.source_reconciliation_tasks
      SET state = 'resolved', resolved_at = now(), resolved_by = ${fx.operatorSubjectA},
          resolution = 'test reset'
      WHERE connection_id = ${fx.connectionA} AND state = 'open'
    `;
    await fx.sql`UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}`;
  });

  function collect(token: string, connectionId = fx.connectionA, projectId = fx.projectA) {
    return app.inject({
      method: "POST",
      url: `/api/v1/source-connections/${connectionId}/collect`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: { projectId, queryBasis: { licenseNumber: "MN-1" } },
    });
  }

  /**
   * The receipt is written to the project named in the body, so that project is what gets
   * authorized. A steward bound to one project must not create receipts in another project of
   * the same tenant.
   */
  it("does not collect into a project outside the caller's scope", async () => {
    const scopedToken = await signIn(app, fx.scopedStewardA);

    const outside = await collect(scopedToken, fx.connectionA, fx.otherProjectA);
    expect(outside.statusCode).toBe(403);
    expect(outside.json().details.reason).toBe("PROJECT_SCOPE_MISMATCH");
    // Refused before the source was called — no request, no receipt.
    expect(calls).toHaveLength(0);

    const inside = await collect(scopedToken, fx.connectionA, fx.projectA);
    expect(inside.statusCode).toBe(200);
  });

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

    const [row] = await fx.sql<{ result: string; raw_hash: string | null }[]>`
      SELECT result, raw_hash FROM core.source_receipts WHERE id = ${receiptId}
    `;
    expect(row?.result).toBe("source_returned_no_record");
    // Without a raw body, no fake hash is made.
    expect(row?.raw_hash).toBeNull();
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

    // The 503 paused the connection (AC-19). Reconcile it so the next lookup can run.
    await fx.sql`
      UPDATE core.source_reconciliation_tasks
      SET state = 'resolved', resolved_at = now(), resolved_by = ${fx.operatorSubjectA},
          resolution = 'outage confirmed'
      WHERE connection_id = ${fx.connectionA} AND state = 'open'
    `;
    await fx.sql`UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}`;

    // Confirmation requires the declared fields. `{ok:true}` is now schema_changed.
    nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
    await collect(stewardToken);

    const [ok] = await fx.sql<{ last_success_at: Date | null }[]>`
      SELECT last_success_at FROM core.source_connections WHERE id = ${fx.connectionA}
    `;
    expect(ok?.last_success_at).not.toBeNull();
  });

  /**
   * Response profile.
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

  /**
   * AC-19 — a degrading result pauses the connection and asks for reconciliation.
   *
   * Before, `schema_changed` left the connection `active` and collection kept going.
   */
  describe("degradation and reconciliation (AC-19)", () => {
    async function connectionState(): Promise<string> {
      const [row] = await fx.sql<{ state: string }[]>`
        SELECT state::text FROM core.source_connections WHERE id = ${fx.connectionA}
      `;
      return row!.state;
    }

    it("degrades the connection and opens a task on schema drift", async () => {
      nextResponse = () => new Response(JSON.stringify({ unexpected: 1 }), { status: 200 });
      const body = (await collect(stewardToken)).json();
      expect(body.result).toBe("schema_changed");

      expect(await connectionState()).toBe("degraded");

      const tasks = (
        await app.inject({
          method: "GET",
          url: `/api/v1/source-connections/${fx.connectionA}/reconciliation-tasks`,
          headers: { authorization: `Bearer ${operatorToken}` },
        })
      ).json().items as { state: string; receiptId: string; triggerResult: string }[];
      const open = tasks.filter((task) => task.state === "open");
      expect(open).toHaveLength(1);
      expect(open[0]?.receiptId).toBe(body.receiptId);
      expect(open[0]?.triggerResult).toBe("schema_changed");
    });

    it("pauses ingestion — the next lookup is not sent", async () => {
      nextResponse = () => new Response("", { status: 503 });
      await collect(stewardToken);
      calls = [];

      const response = await collect(stewardToken);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SOURCE_NOT_CALLABLE");
      expect(calls).toHaveLength(0);
    });

    it("does not degrade on a result that is a fact about the record", async () => {
      nextResponse = () => new Response("", { status: 404 });
      await collect(stewardToken);
      expect(await connectionState()).toBe("active");
    });

    it("quarantines a drifted response and classifies the rest", async () => {
      nextResponse = () => new Response(JSON.stringify({ unexpected: 1 }), { status: 200 });
      const drifted = (await collect(stewardToken)).json().receiptId;
      await fx.sql`
        UPDATE core.source_reconciliation_tasks
        SET state = 'resolved', resolved_at = now(), resolved_by = ${fx.operatorSubjectA},
            resolution = 'reset'
        WHERE connection_id = ${fx.connectionA} AND state = 'open'
      `;
      await fx.sql`UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}`;

      nextResponse = () => new Response("", { status: 404 });
      const noRecord = (await collect(stewardToken)).json().receiptId;

      const rows = await fx.sql<{ id: string; processing_state: string }[]>`
        SELECT id, processing_state FROM core.source_receipts WHERE id IN (${drifted}, ${noRecord})
      `;
      const byId = Object.fromEntries(rows.map((row) => [row.id, row.processing_state]));
      expect(byId[drifted]).toBe("quarantined");
      expect(byId[noRecord]).toBe("classified");
    });

    it("keeps the connection paused until the task is resolved", async () => {
      nextResponse = () => new Response("", { status: 503 });
      await collect(stewardToken);

      const [connection] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.source_connections WHERE id = ${fx.connectionA}
      `;
      const reactivate = (version: number) =>
        app.inject({
          method: "PATCH",
          url: `/api/v1/source-connections/${fx.connectionA}`,
          headers: {
            authorization: `Bearer ${operatorToken}`,
            "idempotency-key": idempotencyKey(),
            "if-match": `"${version}"`,
          },
          payload: { state: "active", reason: "source is back" },
        });

      const early = await reactivate(connection!.version);
      expect(early.statusCode).toBe(409);
      expect(early.json().code).toBe("RECONCILIATION_REQUIRED");

      const taskId = early.json().details.taskId as string;
      const [task] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.source_reconciliation_tasks WHERE id = ${taskId}
      `;
      const resolved = await app.inject({
        method: "POST",
        url: `/api/v1/source-reconciliation-tasks/${taskId}/resolve`,
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${task!.version}"`,
        },
        payload: { resolution: "Outage confirmed with the registry; no schema change" },
      });
      expect(resolved.statusCode).toBe(200);
      expect(resolved.json().state).toBe("resolved");

      // Going live again is an activation: the degraded version needs its own security review,
      // by someone other than the operator who reactivates.
      await fx.sql`
        INSERT INTO core.connection_security_reviews (
          id, tenant_id, connection_id, connection_version, decision, reason,
          reviewed_by_subject_id
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${fx.connectionA}, ${connection!.version}, 'approved',
          'reviewed after the outage', ${fx.stewardSubjectA}
        )
      `;
      expect((await reactivate(connection!.version)).statusCode).toBe(200);
    });
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

  // The DB applies these on every insert path; they must say what the domain says (0060, 0061).
  it("SQL degradation and processing rules match the domain for all 12 results", async () => {
    for (const result of SOURCE_RESULTS) {
      const [row] = await fx.sql<{ degrades: boolean; processing: string }[]>`
        SELECT core.source_result_degrades_connection(${result}::core.source_result) AS degrades,
               core.receipt_processing_state_for(${result}::core.source_result) AS processing
      `;
      expect(row?.degrades, result).toBe(SOURCE_RESULT_BEHAVIOUR[result].degradesConnection);
      expect(row?.processing, result).toBe(receiptProcessingStateFor(result));
    }
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
