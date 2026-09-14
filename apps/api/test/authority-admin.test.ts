import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Authority Registry operations path — 02 §2.8, REQ-DAPP-043.
 *
 * This file checks **whether separation is actually enforced**. Separation written in a
 * document does not exist unless the route blocks it.
 */
describeDb("Authority Registry writes", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let auditor: string;
  let steward: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    auditor = await signIn(app, fx.auditorA);
    steward = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  let counter = 0;
  function register(token = operator, overrides: Record<string, unknown> = {}) {
    counter += 1;
    return app.inject({
      method: "POST",
      url: "/api/v1/authorities",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        name: `Test Authority ${counter}`,
        jurisdiction: "MNG",
        proves: ["mining_right_registration"],
        doesNotProve: ["economic_viability"],
        recognizedScope: ["mining_license"],
        verificationMethod: "authenticated_api",
        publicDisclosureLevel: "public",
        validFrom: "2020-01-01",
        reason: "Mongolian mining right registry candidate",
        ...overrides,
      },
    });
  }

  function setState(id: string, version: number, state: string, token = auditor) {
    return app.inject({
      method: "POST",
      url: `/api/v1/authorities/${id}/state`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { state, reason: `transition to ${state}` },
    });
  }

  it("always starts registration in proposed", async () => {
    const response = await register();
    expect(response.statusCode).toBe(201);

    const body = response.json();
    // If the request could set the state, the registrant would also approve.
    expect(body.state).toBe("proposed");
    expect(body.version).toBe(1);
  });

  it("does not register with empty limitations", async () => {
    // An authority without limitations does not exist (05 §5.11).
    const response = await register(operator, { doesNotProve: [] });
    expect(response.statusCode).toBe(400);
  });

  it("does not let the registrant approve the same authority", async () => {
    const created = (await register()).json();

    // Add the auditor role to operatorA so that permissions alone would pass.
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (gen_random_uuid(), ${fx.tenantA}, ${fx.operatorSubjectA}, ${fx.orgA}, 'auditor')
    `;
    const bothRoles = await signIn(app, fx.operatorA);

    const response = await setState(created.id, created.version, "accepted", bothRoles);

    // A permission check alone cannot block this. Whether registrant equals approver is
    // checked separately.
    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe("SEPARATION_OF_DUTIES");

    await fx.sql`
      DELETE FROM core.role_bindings
      WHERE subject_id = ${fx.operatorSubjectA} AND role = 'auditor'
    `;
  });

  it("does not let the operator role alone change state", async () => {
    const created = (await register()).json();
    // 02 §2.8: an operator alone may not transition to accepted.
    const response = await setState(created.id, created.version, "accepted", operator);
    expect(response.statusCode).toBe(403);
  });

  it("lets an independent reviewer approve", async () => {
    const created = (await register()).json();
    const response = await setState(created.id, created.version, "accepted");

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("accepted");
  });

  it("requires a reason for suspension and revocation", async () => {
    const created = (await register()).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/authorities/${created.id}/state`,
      headers: {
        authorization: `Bearer ${auditor}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${created.version}"`,
      },
      payload: { state: "revoked", reason: "" },
    });

    expect(response.statusCode).toBe(400);
  });

  it("cannot change state without If-Match", async () => {
    const created = (await register()).json();
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/authorities/${created.id}/state`,
      headers: { authorization: `Bearer ${auditor}`, "idempotency-key": idempotencyKey() },
      payload: { state: "accepted", reason: "reviewed" },
    });

    expect(response.statusCode).toBe(428);
  });

  it("keeps a history entry for every change", async () => {
    const created = (await register()).json();

    await app.inject({
      method: "PATCH",
      url: `/api/v1/authorities/${created.id}`,
      headers: {
        authorization: `Bearer ${operator}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${created.version}"`,
      },
      payload: { doesNotProve: ["economic_viability", "title_validity"], reason: "widen limitations" },
    });

    const versions = (
      await app.inject({
        method: "GET",
        url: `/api/v1/authorities/${created.id}/versions`,
        headers: { authorization: `Bearer ${operator}` },
      })
    ).json().items as { version: number; doesNotProve: string[]; changeReason: string }[];

    expect(versions).toHaveLength(2);
    // What this authority said it does not confirm, at that time, must be kept.
    expect(versions[0]?.doesNotProve).toContain("title_validity");
    expect(versions[1]?.doesNotProve).not.toContain("title_validity");
    expect(versions[1]?.changeReason).toBe("Mongolian mining right registry candidate");
  });

  it("does not allow history to be modified", async () => {
    await expect(
      fx.sql`UPDATE core.authority_versions SET change_reason = 'changed' WHERE version = 1`,
    ).rejects.toThrow(/cannot be modified or deleted/);
  });

  describe("connections", () => {
    async function makeAccepted() {
      const created = (await register()).json();
      const accepted = (await setState(created.id, created.version, "accepted")).json();
      return accepted.id as string;
    }

    function createConnection(authorityId: string, body: Record<string, unknown> = {}) {
      counter += 1;
      return app.inject({
        method: "POST",
        url: `/api/v1/authorities/${authorityId}/connections`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: {
          connectionKey: `conn-test-${counter}`,
          collectionMethod: "authenticated_api",
          accessBasis: "data sharing agreement",
          reason: "configure connection",
          ...body,
        },
      });
    }

    it("does not activate a connection for an unapproved authority", async () => {
      const created = (await register()).json();

      // What 02 §2.8 forbids: turning API success into authority approval.
      const response = await createConnection(created.id, {
        state: "active",
        endpoint: "https://registry.example.test/x",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_REQUIRES_ACCEPTED_AUTHORITY");
    });

    it("activates a connection for an approved authority", async () => {
      const authorityId = await makeAccepted();
      const response = await createConnection(authorityId, {
        state: "active",
        endpoint: "https://registry.example.test/x",
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().state).toBe("active");
    });

    it("does not return credential values", async () => {
      const authorityId = await makeAccepted();
      const created = (await createConnection(authorityId, {
        secretReference: "vault://mn/registry",
      })).json();

      expect(created.hasSecret).toBe(true);
      // Not even the reference string is in the response.
      expect(JSON.stringify(created)).not.toContain("vault://");
    });

    // AC-04·AC-21: when a source loses approval, its dependents change state with it. This
    // covers the authority→connection segment — claim→attestation→Registry propagation does
    // not exist yet.
    it("degrades connections when the authority loses approval", async () => {
      const authorityId = await makeAccepted();
      const connection = (await createConnection(authorityId, {
        state: "active",
        endpoint: "https://registry.example.test/x",
      })).json();

      const [before] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.authorities WHERE id = ${authorityId}
      `;

      const suspended = await setState(authorityId, before!.version, "suspended");
      expect(suspended.statusCode).toBe(200);
      // The response says so, so the screen knows without re-fetching.
      expect(suspended.json().connectionsDegraded).toBe(true);

      const [row] = await fx.sql<{ state: string }[]>`
        SELECT state::text FROM core.source_connections WHERE id = ${connection.id}
      `;
      // If the connection stayed active after suspension, suspension would mean nothing.
      expect(row?.state).toBe("degraded");
    });

    it("does not let a role without connection configuration permission create one", async () => {
      const authorityId = await makeAccepted();
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/authorities/${authorityId}/connections`,
        headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
        payload: {
          connectionKey: "conn-denied",
          collectionMethod: "authenticated_api",
          accessBasis: "x",
          reason: "attempt",
        },
      });

      expect(response.statusCode).toBe(403);
    });

    it("allows updating the endpoint", async () => {
      const authorityId = await makeAccepted();
      const created = (await createConnection(authorityId)).json();

      const response = await app.inject({
        method: "PATCH",
        url: `/api/v1/source-connections/${created.id}`,
        headers: {
          authorization: `Bearer ${operator}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${created.version}"`,
        },
        payload: {
          endpoint: "https://registry.example.test/v2",
          state: "active",
          reason: "move to new address",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().endpoint).toBe("https://registry.example.test/v2");
      expect(response.json().version).toBe(created.version + 1);
    });
  });
});
