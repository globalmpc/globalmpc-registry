import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { bearer, idempotencyKey, issueTestSession, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("elevations and the creation window (0129)", { timeout: 30_000 }, () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let ipCounter = 0;
  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  const freshIp = () =>
    `100.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.${(ipCounter++ % 254) + 1}`;
  const freshEmail = (label = "person") => `${label}-${randomUUID().slice(0, 8)}@example.com`;
  const publicPost = (url: string, payload: unknown) =>
    app.inject({ method: "POST", url, payload: payload as never, remoteAddress: freshIp() });
  const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: bearer(token) });
  const post = (url: string, token: string, payload: unknown = {}, extra: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url,
      payload: payload as never,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey(), ...extra },
    });
  const ifMatch = (version: number) => ({ "if-match": `"${version}"` });
  const decision = { decision: "approve", reason: "Checked with the line manager" };

  async function subject(options: { email?: string; role?: string; ageHours?: number } = {}): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level, email, created_at)
      VALUES (${id}, ${fx.tenantA}, 'person', ${`Person ${id.slice(0, 6)}`}, 'high_assurance',
              ${options.email ?? freshEmail()}, now() - make_interval(hours => ${options.ageHours ?? 72}))
    `;
    if (options.role) {
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${id}, ${fx.orgA}, ${options.role})
      `;
    }
    return id;
  }

  async function admin(role: "administrator" = "administrator") {
    const subjectId = await subject({ email: freshEmail("admin"), role });
    const token = await issueTestSession(fx.appSql, fx.tenantA, subjectId, { firstFactor: "email_code" });
    return { subjectId, token };
  }

  async function signIn(email: string): Promise<string> {
    expect((await publicPost("/api/v1/auth/email/start", { email })).statusCode).toBe(202);
    const [mail] = await fx.sql<{ params: { code: string } }[]>`
      SELECT params FROM core.email_outbox
      WHERE recipient = ${email} AND template = 'sign_in_code' AND state = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `;
    const verified = await publicPost("/api/v1/auth/email/verify", { email, code: mail!.params.code });
    expect(verified.statusCode, verified.body).toBe(200);
    return verified.json().sessionToken as string;
  }

  const roles = async (token: string) =>
    ((await get("/api/v1/auth/session", token)).json().roleBindings as { role: string }[]).map((b) => b.role);

  /** A security operator with an approved elevation, and a session that holds it. */
  async function elevated() {
    const email = freshEmail("responder");
    const responderId = await subject({ email, role: "administrator" });
    const token = await issueTestSession(fx.appSql, fx.tenantA, responderId, { firstFactor: "email_code" });
    const asked = await app.inject({
      method: "POST",
      url: "/api/v1/admin/break-glass",
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: { purpose: "Incident", target: "subject", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const approver = await admin("administrator");
    const approved = await post(
      `/api/v1/admin/break-glass/${asked.json().id}/decision`,
      approver.token,
      { decision: "approve", reason: "Incident confirmed" },
      ifMatch(asked.json().version),
    );
    expect(approved.statusCode, approved.body).toBe(200);
    expect(await roles(token)).toContain("break_glass");
    return { email, responderId, elevationId: asked.json().id as string };
  }

  async function suspension(subjectId: string, action: "suspend" | "reinstate") {
    const proposer = await admin("administrator");
    const decider = await admin("administrator");
    const proposed = await post("/api/v1/admin/subject-suspensions", proposer.token, {
      subjectId,
      action,
      reason: "Left the organisation",
    });
    expect(proposed.statusCode, proposed.body).toBe(200);
    const approved = await post(
      `/api/v1/admin/subject-suspensions/${proposed.json().id}/decision`,
      decider.token,
      decision,
      ifMatch(proposed.json().version),
    );
    expect(approved.statusCode, approved.body).toBe(200);
    return { decider, id: proposed.json().id as string };
  }

  const elevation = async (id: string) =>
    (
      await fx.sql<{ state: string; release_cause: string | null; released_by_subject_id: string | null }[]>`
        SELECT state::text, release_cause, released_by_subject_id FROM core.break_glass_elevations WHERE id = ${id}
      `
    )[0];

  describe("L-1: an approved elevation", () => {
    it("ends with a suspension and does not come back with a reinstatement", async () => {
      const { email, responderId, elevationId } = await elevated();
      const suspended = await suspension(responderId, "suspend");
      expect(await elevation(elevationId)).toEqual({
        state: "released",
        release_cause: "subject_suspended",
        released_by_subject_id: suspended.decider.subjectId,
      });
      const audits = await fx.sql<{ detail: { reason: string; suspensionId: string } }[]>`
        SELECT detail FROM audit.events
        WHERE command = 'admin.subject_suspension.request_closed' AND resource_id = ${elevationId}
      `;
      expect(audits.map((row) => row.detail)).toEqual([
        expect.objectContaining({ reason: "subject_suspended", suspensionId: suspended.id }),
      ]);

      await suspension(responderId, "reinstate");
      const token = await signIn(email);
      const after = await roles(token);
      expect(after).toContain("administrator");
      expect(after).not.toContain("break_glass");
      // The person can ask for a new one, using the primary session.
      const again = await app.inject({
        method: "POST",
        url: "/api/v1/admin/break-glass",
        headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
        payload: { purpose: "Incident", target: "subject", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      });
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json().state).toBe("pending");
    });

    it("preserves the history of an already expired elevation", async () => {
      // Expired already: its history stays as it ended, at its expiry.
      const lapsedOwner = await subject({ role: "administrator" });
      const lapsedId = randomUUID();
      const approver = await admin("administrator");
      await fx.sql`
        INSERT INTO core.break_glass_elevations (
          id, tenant_id, subject_id, purpose, target, requested_at, expires_at, state,
          decided_by_subject_id, decided_at, decision_reason
        ) VALUES (
          ${lapsedId}, ${fx.tenantA}, ${lapsedOwner}, 'incident', 'subject', now() - interval '3 hours',
          now() - interval '1 hour', 'active', ${approver.subjectId}, now() - interval '3 hours', 'ok'
        )
      `;
      await suspension(lapsedOwner, "suspend");
      expect((await elevation(lapsedId))!.state).toBe("active");
    });
  });

  describe("L-2: the creation window", () => {
    it("closes once the address of a new account changed: the reviewer's repro", async () => {
      const victim = await subject({ ageHours: 1 });
      const a = await admin("administrator");
      const b = await admin("administrator");
      const attackerEmail = freshEmail("attacker");
      const proposed = await post("/api/v1/admin/email-changes", a.token, {
        subjectId: victim,
        newEmail: attackerEmail,
        reason: "Lost access to the mailbox",
      });
      expect(proposed.statusCode, proposed.body).toBe(200);
      const approved = await post(
        `/api/v1/admin/email-changes/${proposed.json().id}/decision`,
        b.token,
        decision,
        ifMatch(proposed.json().version),
      );
      expect(approved.statusCode, approved.body).toBe(200);
      const [mail] = await fx.sql<{ params: { code: string } }[]>`
        SELECT params FROM core.email_outbox
        WHERE recipient = ${attackerEmail} AND template = 'email_change_code' AND state = 'pending'
      `;
      const [owner] = await fx.sql`SELECT params FROM core.email_outbox WHERE template='email_change_owner'
        AND params->>'destination'=${attackerEmail}`;
      const completed = await publicPost("/api/v1/auth/email-change/verify", {
        email: attackerEmail, code: mail!.params.code, ownerCode: owner!.params.code,
      });
      expect(completed.statusCode, completed.body).toBe(200);
      const [window] = await fx.sql`SELECT core.mfa_creation_window_open(${victim}) AS open`;
      expect(window!.open).toBe(false);
    });

    it("does not count after a suspension; the reinstatement opens its own window", async () => {
      const young = await subject({ ageHours: 1 });
      const open = async () =>
        (await fx.sql<{ open: boolean }[]>`SELECT core.mfa_creation_window_open(${young}) AS open`)[0]!.open;
      expect(await open()).toBe(true);
      await suspension(young, "suspend");
      expect(await open()).toBe(false);
      await suspension(young, "reinstate");
      expect(await open()).toBe(false);
      expect(
        (await fx.sql<{ open: boolean }[]>`SELECT core.mfa_reset_window_open(${young}) AS open`)[0]!.open,
      ).toBe(true);
    });
  });
});
