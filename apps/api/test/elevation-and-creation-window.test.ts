import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { bearer, idempotencyKey, issueTestSession, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";
import { SoftAuthenticator } from "./helpers/webauthn.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Re-review of 0128 (migration 0129).
 *
 * Expected, from the review and 02 §2.6 rather than the implementation:
 * - L-1: an approved break-glass elevation does not survive a suspension of the person: after a
 *   reinstatement and a new passkey, the session holds no `break_glass` role until a new
 *   elevation is approved. An approved MFA reset ends it the same way. Each ending is audited.
 * - L-2: the 24-hour first-enrolment window after account creation closes once the person's
 *   address has changed (or they were suspended); an invited person still enrols within it.
 */
describeDb("elevations and the creation window (0129)", { timeout: 30_000 }, () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let ipCounter = 0;
  const ORIGIN = "http://localhost:3000";
  const RP_ID = "localhost";

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

  async function admin(role: "mpc_operator" | "security_operator" = "security_operator") {
    const subjectId = await subject({ email: freshEmail("admin"), role });
    const token = await issueTestSession(fx.appSql, fx.tenantA, subjectId, { firstFactor: "email_code", secondFactor: "passkey" });
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

  async function enrolPasskey(token: string) {
    const options = await post("/api/v1/auth/mfa/passkeys/registration/options", token);
    expect(options.statusCode, options.body).toBe(200);
    const key = new SoftAuthenticator({ origin: ORIGIN, rpId: RP_ID });
    const verified = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, {
      response: key.register(options.json().options),
      name: "Laptop",
    });
    expect(verified.statusCode, verified.body).toBe(200);
  }

  const roles = async (token: string) =>
    ((await get("/api/v1/auth/session", token)).json().roleBindings as { role: string }[]).map((b) => b.role);

  /** A security operator with an approved elevation, and a session that holds it. */
  async function elevated() {
    const email = freshEmail("responder");
    const responderId = await subject({ email, role: "security_operator" });
    const token = await issueTestSession(fx.appSql, fx.tenantA, responderId, { firstFactor: "email_code", secondFactor: "passkey" });
    const asked = await app.inject({
      method: "POST",
      url: "/api/v1/admin/break-glass",
      headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
      payload: { purpose: "Incident", target: "subject", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
    });
    expect(asked.statusCode, asked.body).toBe(201);
    const approver = await admin("security_operator");
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
    const proposer = await admin("mpc_operator");
    const decider = await admin("security_operator");
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
    it("ends with a suspension and does not come back with a reinstatement and a new passkey", async () => {
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
      await enrolPasskey(token);
      const after = await roles(token);
      expect(after).toContain("security_operator");
      expect(after).not.toContain("break_glass");
      // The person can ask for a new one, which two people approve as before.
      const again = await app.inject({
        method: "POST",
        url: "/api/v1/admin/break-glass",
        headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
        payload: { purpose: "Incident", target: "subject", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
      });
      expect(again.statusCode, again.body).toBe(201);
      expect(again.json().state).toBe("pending");
    });

    it("ends with an approved MFA reset", async () => {
      const { responderId, elevationId } = await elevated();
      const proposer = await admin("mpc_operator");
      const decider = await admin("security_operator");
      const proposed = await post("/api/v1/admin/mfa-resets", proposer.token, {
        subjectId: responderId,
        reason: "Lost every factor",
      });
      expect(proposed.statusCode, proposed.body).toBe(200);
      const approved = await post(
        `/api/v1/admin/mfa-resets/${proposed.json().id}/decision`,
        decider.token,
        decision,
        ifMatch(proposed.json().version),
      );
      expect(approved.statusCode, approved.body).toBe(200);
      expect(await elevation(elevationId)).toEqual({
        state: "released",
        release_cause: "mfa_reset",
        released_by_subject_id: decider.subjectId,
      });
      const audits = await fx.sql<{ actor_subject_id: string; detail: { resetId: string } }[]>`
        SELECT actor_subject_id, detail FROM audit.events
        WHERE command = 'admin.mfa_reset.elevation_released' AND resource_id = ${elevationId}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor_subject_id: decider.subjectId, detail: { resetId: proposed.json().id } });
    });

    it("is left alone by a rejected reset, and an expired one is not rewritten", async () => {
      const { responderId, elevationId } = await elevated();
      const proposed = await post("/api/v1/admin/mfa-resets", (await admin("mpc_operator")).token, {
        subjectId: responderId,
        reason: "Lost every factor",
      });
      const rejected = await post(
        `/api/v1/admin/mfa-resets/${proposed.json().id}/decision`,
        (await admin("security_operator")).token,
        { decision: "reject", reason: "Not verified" },
        ifMatch(proposed.json().version),
      );
      expect(rejected.statusCode, rejected.body).toBe(200);
      expect((await elevation(elevationId))!.state).toBe("active");

      // Expired already: its history stays as it ended, at its expiry.
      const lapsedOwner = await subject({ role: "security_operator" });
      const lapsedId = randomUUID();
      const approver = await admin("security_operator");
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
      const a = await admin("mpc_operator");
      const b = await admin("security_operator");
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
      const completed = await publicPost("/api/v1/auth/email-change/verify", { email: attackerEmail, code: mail!.params.code });
      expect(completed.statusCode, completed.body).toBe(200);

      const token = await signIn(attackerEmail);
      const setup = await post("/api/v1/auth/mfa/totp/setup", token);
      expect(setup.json().code).toBe("MFA_ENROLMENT_WINDOW_CLOSED");
      const options = await post("/api/v1/auth/mfa/passkeys/registration/options", token);
      expect(options.json().code).toBe("MFA_ENROLMENT_WINDOW_CLOSED");
      const status = (await get("/api/v1/auth/mfa", token)).json();
      expect(status.enrolment).toMatchObject({ passkey: "MFA_ENROLMENT_WINDOW_CLOSED", totp: "MFA_ENROLMENT_WINDOW_CLOSED" });
    });

    it("stays open for an invited person who has not changed address", async () => {
      const email = freshEmail("invited");
      await subject({ email, ageHours: 1 });
      const token = await signIn(email);
      const setup = await post("/api/v1/auth/mfa/totp/setup", token);
      expect(setup.statusCode, setup.body).toBe(200);
      await enrolPasskey(token);
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
