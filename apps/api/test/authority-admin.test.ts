import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

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
  /** Reviews connections for activation (02 §2.8). Not in the shared fixture. */
  let security: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    auditor = await signIn(app, fx.auditorA);
    steward = await signIn(app, fx.stewardA);

    const account = newAccount();
    const subject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${fx.tenantA}, 'person', 'Security A')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subject}, ${account.address}, 31337, 'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, 'security_operator')
    `;
    security = await signIn(app, account);
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

  /** proposed → under_review → accepted: the only path to approval (04 §4.9). */
  async function accept(id: string, version: number, token = auditor) {
    const reviewing = await setState(id, version, "under_review", token);
    expect(reviewing.statusCode).toBe(200);
    return setState(id, reviewing.json().version, "accepted", token);
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
    const response = await accept(created.id, created.version);

    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("accepted");
  });

  // 04 §4.9 authority lifecycle. Review cannot be skipped, and revocation is final.
  it("rejects approval that skips review", async () => {
    const created = (await register()).json();
    const response = await setState(created.id, created.version, "accepted");

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("AUTHORITY_TRANSITION_NOT_ALLOWED");
    expect(response.json().details.allowed).toEqual(["under_review", "revoked"]);
  });

  it("does not revive a revoked authority", async () => {
    const created = (await register()).json();
    const revoked = (await setState(created.id, created.version, "revoked")).json();

    for (const state of ["accepted", "under_review", "suspended"]) {
      const response = await setState(created.id, revoked.version, state);
      expect(response.statusCode, state).toBe(422);
    }
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
      const accepted = (await accept(created.id, created.version)).json();
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

    function patchConnection(
      id: string,
      version: number,
      payload: Record<string, unknown>,
      token = operator,
    ) {
      return app.inject({
        method: "PATCH",
        url: `/api/v1/source-connections/${id}`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${version}"`,
        },
        payload: { reason: "update connection", ...payload },
      });
    }

    function review(id: string, version: number, decision = "approved", token = security) {
      return app.inject({
        method: "POST",
        url: `/api/v1/source-connections/${id}/security-reviews`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${version}"`,
        },
        payload: { decision, reason: "endpoint, credential reference and data rights checked" },
      });
    }

    /** planned → feasibility_checked → access_confirmed → tested (04 §4.9), one step at a time. */
    async function testedConnection(authorityId: string, body: Record<string, unknown> = {}) {
      let connection = (await createConnection(authorityId, body)).json();
      for (const state of ["feasibility_checked", "access_confirmed", "tested"]) {
        const moved = await patchConnection(connection.id, connection.version, { state });
        expect(moved.statusCode, state).toBe(200);
        connection = moved.json();
      }
      return connection;
    }

    /** tested → reviewed by security → activated by the operator (04 §4.9: only tested activates). */
    async function activeConnection(authorityId: string) {
      const created = await testedConnection(authorityId, {
        endpoint: "https://registry.example.test/x",
      });
      expect((await review(created.id, created.version)).statusCode).toBe(201);
      const activated = await patchConnection(created.id, created.version, { state: "active" });
      expect(activated.statusCode).toBe(200);
      return activated.json();
    }

    it("does not create a connection already active — it needs a security review", async () => {
      const authorityId = await makeAccepted();
      const response = await createConnection(authorityId, {
        state: "active",
        endpoint: "https://registry.example.test/x",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_SECURITY_REVIEW_REQUIRED");
    });

    it("creates a connection only as planned", async () => {
      const authorityId = await makeAccepted();
      const response = await createConnection(authorityId, { state: "tested" });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_TRANSITION_NOT_ALLOWED");
    });

    it("activates a connection after a security operator reviews that version", async () => {
      const authorityId = await makeAccepted();
      const connection = await activeConnection(authorityId);
      expect(connection.state).toBe("active");
    });

    it("does not activate without an approved review", async () => {
      const authorityId = await makeAccepted();
      const created = await testedConnection(authorityId);

      const unreviewed = await patchConnection(created.id, created.version, { state: "active" });
      expect(unreviewed.statusCode).toBe(422);
      expect(unreviewed.json().code).toBe("CONNECTION_SECURITY_REVIEW_REQUIRED");

      // A later rejection withdraws an earlier approval of the same version.
      await review(created.id, created.version, "approved");
      await review(created.id, created.version, "rejected");
      const rejected = await patchConnection(created.id, created.version, { state: "active" });
      expect(rejected.json().code).toBe("CONNECTION_SECURITY_REVIEW_REQUIRED");
    });

    it("does not let the reviewer also activate", async () => {
      const authorityId = await makeAccepted();
      const created = await testedConnection(authorityId);
      await review(created.id, created.version);

      const response = await patchConnection(created.id, created.version, { state: "active" }, security);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_REVIEW_SAME_PERSON");
    });

    it("does not let a review carry over to a changed configuration", async () => {
      const authorityId = await makeAccepted();
      const created = await testedConnection(authorityId);
      await review(created.id, created.version);

      const moved = (await patchConnection(created.id, created.version, {
        endpoint: "https://elsewhere.example.test/x",
      })).json();
      const response = await patchConnection(moved.id, moved.version, { state: "active" });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_SECURITY_REVIEW_REQUIRED");
    });

    it("does not change the data rights of an active connection without a new review", async () => {
      const authorityId = await makeAccepted();
      const connection = await activeConnection(authorityId);

      const response = await patchConnection(connection.id, connection.version, {
        disclosurePermission: "public",
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_REVIEW_INVALIDATED");
    });

    it("does not re-point an active connection without a new review", async () => {
      const authorityId = await makeAccepted();
      const connection = await activeConnection(authorityId);

      const response = await patchConnection(connection.id, connection.version, {
        endpoint: "https://elsewhere.example.test/x",
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CONNECTION_REVIEW_INVALIDATED");
    });

    it("refuses unreviewed activation in the database too", async () => {
      const authorityId = await makeAccepted();
      const created = (await createConnection(authorityId)).json();

      // The application role, as the API uses it — a route that forgot the check.
      await expect(
        fx.appSql.begin(async (tx) => {
          await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
          await tx`UPDATE core.source_connections SET state = 'active' WHERE id = ${created.id}`;
        }),
      ).rejects.toThrow(/no approved security review/);
    });

    it("does not let a role without review permission review", async () => {
      const authorityId = await makeAccepted();
      const created = (await createConnection(authorityId)).json();
      const response = await review(created.id, created.version, "approved", operator);
      expect(response.statusCode).toBe(403);
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
      const connection = await activeConnection(authorityId);

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
      const created = await testedConnection(authorityId);

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
          reason: "move to new address",
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().endpoint).toBe("https://registry.example.test/v2");
      expect(response.json().version).toBe(created.version + 1);
    });

    // 04 §4.9 connection lifecycle — an untested or switched-off integration is not declared live.
    it("rejects skipping stages and reviving a disabled connection", async () => {
      const authorityId = await makeAccepted();
      const planned = (await createConnection(authorityId, {
        endpoint: "https://registry.example.test/x",
      })).json();

      const skipped = await patchConnection(planned.id, planned.version, { state: "active" });
      expect(skipped.statusCode).toBe(422);
      expect(skipped.json().code).toBe("CONNECTION_TRANSITION_NOT_ALLOWED");

      const disabled = (await patchConnection(planned.id, planned.version, { state: "disabled" })).json();
      const revived = await patchConnection(planned.id, disabled.version, { state: "planned" });
      expect(revived.statusCode).toBe(422);
    });

    it("walks the stages in order and keeps each one as evidence", async () => {
      const authorityId = await makeAccepted();
      let connection = (await createConnection(authorityId, {
        endpoint: "https://registry.example.test/x",
      })).json();

      for (const state of ["feasibility_checked", "access_confirmed", "tested", "active"]) {
        // A tested connection goes live only after a security review of that version.
        if (state === "active") {
          expect((await review(connection.id, connection.version)).statusCode).toBe(201);
        }
        const response = await patchConnection(connection.id, connection.version, {
          state,
          reason: `reached ${state}`,
        });
        expect(response.statusCode, state).toBe(200);
        connection = response.json();
      }

      const history = (
        await app.inject({
          method: "GET",
          url: `/api/v1/source-connections/${connection.id}/transitions`,
          headers: { authorization: `Bearer ${operator}` },
        })
      ).json().items as { fromState: string | null; toState: string; reason: string; actorSubjectId: string | null }[];

      expect(history.map((row) => row.toState)).toEqual([
        "planned",
        "feasibility_checked",
        "access_confirmed",
        "tested",
        "active",
      ]);
      expect(history[4]?.reason).toBe("reached active");
      expect(history[4]?.actorSubjectId).toBe(fx.operatorSubjectA);
    });

    it("records a demotion nobody requested through the API", async () => {
      const authorityId = await makeAccepted();
      const connection = await activeConnection(authorityId);
      const [authority] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.authorities WHERE id = ${authorityId}
      `;
      await setState(authorityId, authority!.version, "suspended");

      const [last] = await fx.sql<{ to_state: string; reason: string; actor_subject_id: string | null }[]>`
        SELECT to_state::text, reason, actor_subject_id FROM core.source_connection_transitions
        WHERE connection_id = ${connection.id} ORDER BY occurred_at DESC LIMIT 1
      `;
      expect(last?.to_state).toBe("degraded");
      expect(last?.reason).toMatch(/outside an API request/);
    });
  });
});
