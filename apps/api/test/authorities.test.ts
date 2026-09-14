import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Authority Registry — 05 §5.11, OD-42·OD-43.
 *
 * The R5 gate requires "zero overstatement of unverified integrations". So this file
 * checks both that **unintegrated authorities stay listed** and **do not look active**.
 */
describeDb("Authority Registry", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function list() {
    return app.inject({
      method: "GET",
      url: "/api/v1/authorities",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("also returns what is not verified", async () => {
    const response = await list();
    expect(response.statusCode).toBe(200);

    const items = response.json().items as { doesNotProve: string[] }[];
    expect(items.length).toBeGreaterThan(0);
    // Showing only what is verified makes readers assume everything is verified.
    for (const item of items) {
      expect(item.doesNotProve.length).toBeGreaterThan(0);
    }
  });

  it("an active integration is shown as callable", async () => {
    const items = (await list()).json().items as { adapterState: string; callable: boolean }[];
    const active = items.find((item) => item.adapterState === "active");
    expect(active?.callable).toBe(true);
  });

  it("an authority without an integration stays listed", async () => {
    // Dropping it leaves "why is this authority missing" unanswerable.
    await fx.sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        gen_random_uuid(), ${fx.tenantA}, 'Unconnected Registry', 'MNG',
        ARRAY['land_use'], ARRAY['economic_viability'],
        ARRAY['land'], 'manual_official_registry_confirmation', 'public', '2020-01-01', 'accepted'
      )
    `;

    const items = (await list()).json().items as {
      name: string;
      adapterState: string;
      callable: boolean;
      nextAction: string | null;
    }[];
    const found = items.find((item) => item.name === "Unconnected Registry");

    expect(found).toBeDefined();
    // Marking it active promises an integration that does not exist.
    expect(found!.adapterState).toBe("none");
    expect(found!.callable).toBe(false);
    expect(found!.nextAction).toContain("connection");
  });

  it("a planned integration is not called", async () => {
    const [authority] = await fx.sql<{ id: string }[]>`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        gen_random_uuid(), ${fx.tenantA}, 'Planned Registry', 'MNG',
        ARRAY['tax_status'], ARRAY['economic_viability'],
        ARRAY['tax'], 'authenticated_api', 'public', '2020-01-01', 'accepted'
      )
      RETURNING id
    `;
    await fx.sql`
      INSERT INTO core.source_connections (
        id, tenant_id, authority_id, connection_key, collection_method,
        access_basis, state
      ) VALUES (
        gen_random_uuid(), ${fx.tenantA}, ${authority!.id}, ${`planned-${Date.now()}`},
        'authenticated_api', 'Pending consultation', 'planned'
      )
    `;

    const items = (await list()).json().items as {
      name: string;
      adapterState: string;
      callable: boolean;
      adapterStateReason: string | null;
    }[];
    const found = items.find((item) => item.name === "Planned Registry");

    // Calling it would promise an unverified integration (OD-42).
    expect(found!.adapterState).toBe("pending_access");
    expect(found!.callable).toBe(false);
    // Must be able to answer "why not".
    expect(found!.adapterStateReason).toBeTruthy();
  });

  it("the jurisdiction profile counts active and pending separately", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/jurisdictions/mng/profile",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // A total alone hides that "10 integrations" may mean only 1 is callable.
    expect(body.activeCount).toBeGreaterThanOrEqual(1);
    expect(body.pendingCount).toBeGreaterThanOrEqual(1);
    expect(body.limitations.join(" ")).toContain("does not promise");
  });

  it("another tenant's authority is not visible", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/authorities",
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });
    expect(response.json().items).toEqual([]);
  });
});

describeDb("Asset/Offering gate (OD-07)", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    token = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function gate() {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/offering-gate`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  // AC-08: even with an official reference, if Issuer/SPV/rights are pending,
  // offering activation is rejected and the Registry workflow continues normally.
  it("shows unmet conditions as they are", async () => {
    const response = await gate();

    expect(response.statusCode).toBe(200);
    expect(response.json().activatable).toBe(false);
    expect(response.json().missing.length).toBeGreaterThan(0);
  });

  it("the response itself states that the feature does not exist", async () => {
    // The API says it even if the UI forgets. A disabled button reads as "coming soon".
    const body = gate().then((response) => response.json());
    expect((await body).absenceNotice).toContain("not hidden behind a flag");
    expect((await body).notMeaning).toContain("are not issuance approval");
  });

  it("every remaining condition has an owner", async () => {
    const missing = (await gate()).json().missing as { owner: string; why: string }[];
    for (const item of missing) {
      expect(item.owner.length).toBeGreaterThan(0);
      expect(item.why.length).toBeGreaterThan(0);
    }
  });

  it("no trading route exists", async () => {
    // OD-07: unapproved regulated features risk accidental activation even behind a flag.
    for (const path of ["subscriptions", "orders", "transfers", "custody"]) {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/${path}`,
        headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
        payload: {},
      });
      expect(response.statusCode).toBe(404);
    }
  });
});
