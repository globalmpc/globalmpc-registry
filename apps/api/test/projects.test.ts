import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("project routes", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorA: string; operatorB: string; readerA: string; unknownWallet: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // From R1, auth is SIWE signature → session token. Tests take the same path.
    tokens = {
      operatorA: await signIn(app, fx.operatorA),
      operatorB: await signIn(app, fx.operatorB),
      readerA: await signIn(app, fx.readerA),
      unknownWallet: await signIn(app, fx.unknownWallet),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function body(overrides: Record<string, unknown> = {}) {
    return {
      projectKey: `TEST-${idempotencyKey().slice(0, 8)}`,
      name: "Test project",
      hostCountryIso3: "MNG",
      minerals: ["copper"],
      ownerOrganizationId: fx.orgA,
      ...overrides,
    };
  }

  function create(wallet: string, payload: Record<string, unknown>, key = idempotencyKey()) {
    return app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${wallet}`, "idempotency-key": key },
      payload,
    });
  }

  describe("create", () => {
    it("an authorized operator creates a project", async () => {
      const response = await create(tokens.operatorA, body());
      expect(response.statusCode).toBe(200);

      const created = response.json();
      expect(created.lifecycleState).toBe("draft");
      expect(created.version).toBe(1);
      expect(created.readinessSummary).toBeNull();
      // 07 §7.1: every response carries requestId and asOf.
      expect(created.requestId).toBeTruthy();
      expect(created.asOf).toBeTruthy();
    });

    it("writes audit and outbox in the same transaction", async () => {
      const payload = body();
      const response = await create(tokens.operatorA, payload);
      const created = response.json();

      const audits = await fx.sql`
        SELECT command, effective_role, after_version FROM audit.events
        WHERE resource_id = ${created.id}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]!["command"]).toBe("project.registered");
      expect(audits[0]!["effective_role"]).toBe("mpc_operator");

      const events = await fx.sql`
        SELECT event_type, published_at FROM core.outbox WHERE aggregate_id = ${created.id}
      `;
      expect(events).toHaveLength(1);
      expect(events[0]!["published_at"]).toBeNull();
    });

    /**
     * The audited role is the role that granted the action — 02 §2.7.
     *
     * Adds a second binding. `auditor` cannot perform `project.create`,
     * so only `mpc_operator` grants it. An implementation that records the session's
     * first binding breaks this assertion half the time —
     * `core.resolve_role_bindings` has no ORDER BY, so order depends on the plan.
     */
    it("records the role that allowed the action, not the session's first role", async () => {
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (gen_random_uuid(), ${fx.tenantA}, ${fx.operatorSubjectA}, ${fx.orgA}, 'auditor')
      `;

      try {
        const token = await signIn(app, fx.operatorA);
        const created = (await create(token, body())).json();

        const [audit] = await fx.sql<{ effective_role: string }[]>`
          SELECT effective_role FROM audit.events WHERE resource_id = ${created.id}
        `;
        expect(audit!.effective_role).toBe("mpc_operator");
      } finally {
        await fx.sql`
          DELETE FROM core.role_bindings
          WHERE subject_id = ${fx.operatorSubjectA} AND role = 'auditor'
        `;
      }
    });

    it("keeps personal data out of the outbox payload", async () => {
      const response = await create(tokens.operatorA, body());
      const created = response.json();
      const [event] = await fx.sql<{ payload: Record<string, unknown> }[]>`
        SELECT payload FROM core.outbox WHERE aggregate_id = ${created.id}
      `;
      const serialized = JSON.stringify(event!.payload);
      expect(serialized).not.toContain(fx.operatorA.address);
      expect(serialized).not.toMatch(/@/);
    });
  });

  describe("authentication and authorization", () => {
    it("rejects creation without authentication", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { "idempotency-key": idempotencyKey() },
        payload: body(),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("UNAUTHENTICATED");
    });

    it("an unenrolled wallet gets 403 WALLET_NOT_ENROLLED — signed in, no tenant", async () => {
      // A 401 reads as "sign in again". The signature already succeeded, so that is false.
      const response = await create(tokens.unknownWallet, body());
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("WALLET_NOT_ENROLLED");
    });

    it("returns 403 and the required roles for a tenant member without a role", async () => {
      const response = await create(tokens.readerA, body());
      expect(response.statusCode).toBe(403);

      const error = response.json();
      expect(error.code).toBe("AUTHORIZATION_DENIED");
      expect(error.details.reason).toBe("ROLE_ACTION_NOT_ALLOWED");
      expect(error.details.requiredRoles).toContain("mpc_operator");
      expect(error.details.accessRequestPath).toBeTruthy();
    });

    it("an authorization rejection creates no row", async () => {
      const payload = body({ projectKey: "DENIED-NO-ROW" });
      await create(tokens.readerA, payload);

      const rows = await fx.sql`
        SELECT id FROM core.projects WHERE project_key = 'DENIED-NO-ROW'
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("idempotency (07 §7.1)", () => {
    it("returns 400 without Idempotency-Key", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${tokens.operatorA}` },
        payload: body(),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("rejects a short key", async () => {
      const response = await create(tokens.operatorA, body(), "short");
      expect(response.statusCode).toBe(400);
    });

    it("same key + same request returns the same result", async () => {
      const key = idempotencyKey();
      const payload = body();

      const first = await create(tokens.operatorA, payload, key);
      const second = await create(tokens.operatorA, payload, key);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.json().id).toBe(first.json().id);

      const rows = await fx.sql`
        SELECT id FROM core.projects WHERE project_key = ${payload.projectKey as string}
      `;
      expect(rows).toHaveLength(1);
    });

    it("same key + different request returns 409", async () => {
      const key = idempotencyKey();
      await create(tokens.operatorA, body(), key);
      const response = await create(tokens.operatorA, body(), key);

      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("IDEMPOTENCY_KEY_REUSE");
    });

    it("an idempotent retry does not create the event twice", async () => {
      const key = idempotencyKey();
      const payload = body();
      const first = await create(tokens.operatorA, payload, key);
      await create(tokens.operatorA, payload, key);

      const events = await fx.sql`
        SELECT id FROM core.outbox WHERE aggregate_id = ${first.json().id}
      `;
      expect(events).toHaveLength(1);
    });
  });

  describe("request validation", () => {
    it("returns 400 when required fields are missing", async () => {
      const response = await create(tokens.operatorA, { name: "name only" });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("REQUEST_INVALID");
    });

    it("rejects an invalid ISO3 code", async () => {
      const response = await create(tokens.operatorA, body({ hostCountryIso3: "MONGOLIA" }));
      expect(response.statusCode).toBe(400);
    });
  });

  describe("tenant isolation", () => {
    it("another tenant's project is 404 — existence is not revealed", async () => {
      const created = await create(tokens.operatorB, body({ ownerOrganizationId: fx.orgB }));
      expect(created.statusCode).toBe(200);

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${created.json().id}`,
        headers: { authorization: `Bearer ${tokens.operatorA}` },
      });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("NOT_FOUND");
    });

    it("lists only the caller's tenant projects", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/projects",
        headers: { authorization: `Bearer ${tokens.operatorB}` },
      });
      expect(response.statusCode).toBe(200);

      const items = response.json().items as { id: string }[];
      const ids = items.map((item) => item.id);

      const rows = await withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) =>
        tx<{ id: string }[]>`SELECT id FROM core.projects`,
      );
      expect(new Set(ids)).toEqual(new Set(rows.map((row) => row.id)));
    });

    it("rejects creation under another tenant's organization", async () => {
      const response = await create(tokens.operatorA, body({ ownerOrganizationId: fx.orgB }));
      // RLS hides the FK target organization, so the insert fails.
      expect(response.statusCode).toBeGreaterThanOrEqual(400);

      const rows = await fx.sql`
        SELECT id FROM core.projects
        WHERE tenant_id = ${fx.tenantA} AND owner_organization_id = ${fx.orgB}
      `;
      expect(rows).toHaveLength(0);
    });
  });

  describe("response conventions", () => {
    it("error responses use the envelope format", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/does-not-exist" });
      const envelope = response.json();
      expect(envelope).toHaveProperty("code");
      expect(envelope).toHaveProperty("message");
      expect(envelope).toHaveProperty("retryable");
      expect(envelope).toHaveProperty("correlationId");
    });

    it("carries the correlation ID over from the header", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/does-not-exist",
        headers: { "x-correlation-id": "trace-from-client" },
      });
      expect(response.json().correlationId).toBe("trace-from-client");
      expect(response.headers["x-correlation-id"]).toBe("trace-from-client");
    });

    it("every response has X-Request-Id", async () => {
      const response = await app.inject({ method: "GET", url: "/health/live" });
      expect(response.headers["x-request-id"]).toBeTruthy();
    });
  });
});
