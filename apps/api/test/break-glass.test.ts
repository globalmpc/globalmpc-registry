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
  type TestAccount,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Break-glass elevation — 02 §2.6, 13 §13.6 "admin JIT elevation expiry".
 *
 * Each test gets its own tenant-level people so one test's open or overdue elevation does not
 * block another's request (both rules are deliberately tenant-wide).
 */
describeDb("break-glass elevation", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  interface Person {
    readonly account: TestAccount;
    readonly subjectId: string;
    token: string;
  }

  /** A person in a fresh tenant, so tenant-wide rules do not leak between tests. */
  async function newTenant(): Promise<{ tenantId: string; orgId: string }> {
    const tenantId = randomUUID();
    const orgId = randomUUID();
    await fx.sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`bg-${tenantId.slice(0, 8)}`}, 'Break-glass tenant')
    `;
    await fx.sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${orgId}, ${tenantId}, 'Break-glass org', 'MNG')
    `;
    return { tenantId, orgId };
  }

  async function person(
    tenant: { tenantId: string; orgId: string },
    role: string,
  ): Promise<Person> {
    const account = newAccount();
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${tenant.tenantId}, 'person', ${role})
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${tenant.tenantId}, ${subjectId}, ${account.address}, 31337,
        'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${tenant.tenantId}, ${subjectId}, ${tenant.orgId}, ${role})
    `;
    return { account, subjectId, token: await signIn(app, account) };
  }

  function post(token: string, url: string, payload: unknown, version?: number) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "user-agent": "break-glass-test/1.0",
        ...(version === undefined ? {} : { "if-match": `"${version}"` }),
      },
      payload: payload as Record<string, unknown>,
    });
  }

  const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000).toISOString();

  async function team() {
    const tenant = await newTenant();
    const responder = await person(tenant, "security_operator");
    const approver = await person(tenant, "security_operator");
    const target = await person(tenant, "mpc_operator");
    return { tenant, responder, approver, target };
  }

  async function activeElevation(t: Awaited<ReturnType<typeof team>>) {
    const requested = await post(t.responder.token, "/api/v1/admin/break-glass", {
      purpose: "Operator key suspected compromised",
      target: `subject ${t.target.subjectId}`,
      expiresAt: inOneHour(),
    });
    expect(requested.statusCode).toBe(201);
    const approved = await post(
      t.approver.token,
      `/api/v1/admin/break-glass/${requested.json().id}/decision`,
      { decision: "approve", reason: "Confirmed with incident lead" },
      requested.json().version,
    );
    expect(approved.statusCode).toBe(200);
    return approved.json() as { id: string; version: number; effective: boolean };
  }

  function quarantine(token: string, subjectId: string) {
    return post(token, "/api/v1/admin/break-glass/quarantine", {
      subjectId,
      reason: "Contain suspected compromise",
    });
  }

  it("requires purpose, target and expiry", async () => {
    const t = await team();
    const response = await post(t.responder.token, "/api/v1/admin/break-glass", {
      purpose: "x",
      expiresAt: inOneHour(),
    });
    expect(response.statusCode).toBe(400);
  });

  it("is not available to roles other than security_operator", async () => {
    const t = await team();
    const response = await post(t.target.token, "/api/v1/admin/break-glass", {
      purpose: "Try",
      target: "anything",
      expiresAt: inOneHour(),
    });
    expect(response.statusCode).toBe(403);
  });

  it("cannot be approved by the person elevated", async () => {
    const t = await team();
    const requested = (
      await post(t.responder.token, "/api/v1/admin/break-glass", {
        purpose: "Incident",
        target: "subject",
        expiresAt: inOneHour(),
      })
    ).json();
    const response = await post(
      t.responder.token,
      `/api/v1/admin/break-glass/${requested.id}/decision`,
      { decision: "approve", reason: "self" },
      requested.version,
    );
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("BREAK_GLASS_SELF_APPROVAL");
  });

  it("does not grant anything before approval", async () => {
    const t = await team();
    await post(t.responder.token, "/api/v1/admin/break-glass", {
      purpose: "Incident",
      target: "subject",
      expiresAt: inOneHour(),
    });
    const response = await quarantine(t.responder.token, t.target.subjectId);
    expect(response.statusCode).toBe(403);
  });

  it("quarantines access immediately under an approved elevation", async () => {
    const t = await team();
    const elevation = await activeElevation(t);
    expect(elevation.effective).toBe(true);

    const response = await quarantine(t.responder.token, t.target.subjectId);
    expect(response.statusCode).toBe(200);
    expect(response.json().elevationId).toBe(elevation.id);
    expect(response.json().revokedBindingIds).toHaveLength(1);

    // The quarantined operator loses its role on the next request.
    const after = await app.inject({
      method: "GET",
      url: "/api/v1/admin/role-grants",
      headers: { authorization: `Bearer ${t.target.token}` },
    });
    expect(after.statusCode).toBe(403);

    const [audit] = await fx.sql<{ effective_role: string; user_agent_hash: string | null; request_ip_class: string | null }[]>`
      SELECT effective_role, user_agent_hash, request_ip_class FROM audit.events
      WHERE tenant_id = ${t.tenant.tenantId} AND command = 'break_glass.access_quarantined'
    `;
    expect(audit?.effective_role).toBe("break_glass");
    // 02 §2.7 device metadata — observed facts only.
    expect(audit?.user_agent_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(audit?.request_ip_class).toBe("loopback");
  });

  it("stops granting at its expiry with nothing running (13.6 JIT elevation expiry)", async () => {
    const t = await team();
    // Written directly: an API request cannot set an expiry in the past, and waiting for one
    // would make the test slow and timing-dependent.
    await fx.sql`
      INSERT INTO core.break_glass_elevations (
        id, tenant_id, subject_id, purpose, target, requested_at, expires_at, state,
        decided_by_subject_id, decided_at, decision_reason
      ) VALUES (
        ${randomUUID()}, ${t.tenant.tenantId}, ${t.responder.subjectId}, 'Incident', 'subject',
        now() - interval '2 hours', now() - interval '1 minute', 'active',
        ${t.approver.subjectId}, now() - interval '2 hours', 'ok'
      )
    `;

    const response = await quarantine(t.responder.token, t.target.subjectId);
    expect(response.statusCode).toBe(403);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/admin/break-glass",
      headers: { authorization: `Bearer ${t.approver.token}` },
    });
    expect(list.json().items[0].effective).toBe(false);
  });

  it("ends early on release, which the elevated person cannot sign off", async () => {
    const t = await team();
    const elevation = await activeElevation(t);
    const body = { cause: "Key rotated", recoveryVerification: "New key bound and tested" };

    const self = await post(
      t.responder.token,
      `/api/v1/admin/break-glass/${elevation.id}/release`,
      body,
      elevation.version,
    );
    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe("BREAK_GLASS_SELF_RELEASE");

    const released = await post(
      t.approver.token,
      `/api/v1/admin/break-glass/${elevation.id}/release`,
      body,
      elevation.version,
    );
    expect(released.statusCode).toBe(200);
    expect(released.json().state).toBe("released");
    expect(released.json().effective).toBe(false);

    expect((await quarantine(t.responder.token, t.target.subjectId)).statusCode).toBe(403);
  });

  it("stops granting and blocks new elevations when the incident record is overdue", async () => {
    const t = await team();
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.break_glass_elevations (
        id, tenant_id, subject_id, purpose, target, requested_at, expires_at, state,
        decided_by_subject_id, decided_at, decision_reason
      ) VALUES (
        ${id}, ${t.tenant.tenantId}, ${t.responder.subjectId}, 'Incident', 'subject',
        now() - interval '25 hours', now() + interval '1 day', 'active',
        ${t.approver.subjectId}, now() - interval '25 hours', 'ok'
      )
    `;

    // Past 24 hours without a record: the elevation no longer grants (02 §2.6).
    expect((await quarantine(t.responder.token, t.target.subjectId)).statusCode).toBe(403);

    const blocked = await post(t.approver.token, "/api/v1/admin/break-glass", {
      purpose: "Another incident",
      target: "subject",
      expiresAt: inOneHour(),
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().code).toBe("BREAK_GLASS_INCIDENT_OVERDUE");

    // Filing the record — late, and recorded as late — lifts the block.
    const recorded = await post(
      t.approver.token,
      `/api/v1/admin/break-glass/${id}/incident`,
      { incidentReference: "INC-1", summary: "Operator key compromise contained" },
      1,
    );
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json().incidentOverdue).toBe(false);

    const [audit] = await fx.sql<{ detail: { late: boolean } }[]>`
      SELECT detail FROM audit.events
      WHERE tenant_id = ${t.tenant.tenantId} AND command = 'break_glass.incident_recorded'
    `;
    expect(audit?.detail.late).toBe(true);

    const [event] = await fx.sql<{ event_type: string }[]>`
      SELECT event_type FROM core.outbox WHERE tenant_id = ${t.tenant.tenantId}
    `;
    expect(event?.event_type).toBe("incident.opened");

    const next = await post(t.approver.token, "/api/v1/admin/break-glass", {
      purpose: "Another incident",
      target: "subject",
      expiresAt: inOneHour(),
    });
    expect(next.statusCode).toBe(201);
  });

  it("keeps purpose, target and expiry as written", async () => {
    const t = await team();
    const elevation = await activeElevation(t);
    await expect(
      fx.sql`
        UPDATE core.break_glass_elevations SET expires_at = expires_at + interval '1 day'
        WHERE id = ${elevation.id}
      `,
    ).rejects.toThrow(/cannot be rewritten/);
  });
});
