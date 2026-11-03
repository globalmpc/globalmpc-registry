import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { bearer, idempotencyKey, issueTestSession, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Suspension closes what is still open — security review of 0127 (migration 0128).
 *
 * Expected, from the review and the plan's recovery rules rather than the implementation:
 * - S-M1: an email change approved before a suspension never completes: the suspension closes it,
 *   and a suspended person's address does not change by any path (the public verify answers a
 *   wrong code). An email change or MFA reset of a suspended person is refused on propose and on
 *   approve. Whoever took part in an email change or MFA reset of a person takes no part in their
 *   suspension or reinstatement, and the reverse. An enrolment window does not outlive a
 *   suspension or an address change.
 * - S-L1: a suspended admin's open proposals are closed in the suspending transaction and audited;
 *   no suspended subject can propose or decide, even straight at the database.
 * - S-L2: no MFA reset is proposed for a suspended person.
 */
describeDb("suspension closes open recovery (0128)", { timeout: 30_000 }, () => {
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
  const withoutRequestId = (body: Record<string, unknown>) => {
    const { requestId: _ignored, correlationId: _alsoIgnored, ...rest } = body;
    return rest;
  };

  async function person(email = freshEmail(), ageHours = 72): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, email, created_at)
      VALUES (${id}, ${fx.tenantA}, 'person', ${`Person ${id.slice(0, 6)}`}, ${email},
              now() - make_interval(hours => ${ageHours}))
    `;
    return id;
  }

  async function admin(role: "mpc_operator" | "security_operator" = "security_operator") {
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level, email, created_at)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', ${`Admin ${subjectId.slice(0, 4)}`}, 'high_assurance',
              ${freshEmail("admin")}, now() - interval '72 hours')
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, ${role})
    `;
    const token = await issueTestSession(fx.appSql, fx.tenantA, subjectId, { firstFactor: "email_code", secondFactor: "passkey" });
    return { subjectId, token };
  }

  const adminPost = (url: string, token: string, payload: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url,
      payload: payload as never,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey(), ...extra },
    });
  const ifMatch = (version: number) => ({ "if-match": `"${version}"` });
  const decision = (approve: boolean) => ({
    decision: approve ? "approve" : "reject",
    reason: "Checked with the line manager",
  });

  const proposeSuspension = (token: string, subjectId: string, action: "suspend" | "reinstate" = "suspend") =>
    adminPost("/api/v1/admin/subject-suspensions", token, { subjectId, action, reason: "Left the organisation" });
  const decideSuspension = (token: string, request: { id: string; version: number }, approve = true) =>
    adminPost(`/api/v1/admin/subject-suspensions/${request.id}/decision`, token, decision(approve), ifMatch(request.version));

  const proposeEmailChange = (token: string, subjectId: string, newEmail = freshEmail("moved")) =>
    adminPost("/api/v1/admin/email-changes", token, { subjectId, newEmail, reason: "Lost access to the mailbox" });
  const decideEmailChange = (token: string, change: { id: string; version: number }, approve = true) =>
    adminPost(`/api/v1/admin/email-changes/${change.id}/decision`, token, decision(approve), ifMatch(change.version));
  const verifyEmailChange = (email: string, code: string) =>
    publicPost("/api/v1/auth/email-change/verify", { email, code });

  const proposeReset = (token: string, subjectId: string) =>
    adminPost("/api/v1/admin/mfa-resets", token, { subjectId, reason: "Lost every factor" });
  const decideReset = (token: string, reset: { id: string; version: number }, approve = true) =>
    adminPost(`/api/v1/admin/mfa-resets/${reset.id}/decision`, token, decision(approve), ifMatch(reset.version));

  async function emailChangeCode(newEmail: string): Promise<string> {
    const [mail] = await fx.sql<{ params: { code: string } }[]>`
      SELECT params FROM core.email_outbox
      WHERE recipient = ${newEmail} AND template = 'email_change_code' AND state = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!mail) throw new Error("no email-change code pending");
    return mail.params.code;
  }

  /** Two fresh admins suspend (or reinstate) the person. */
  async function suspendedBy(subjectId: string, action: "suspend" | "reinstate" = "suspend") {
    const proposer = await admin("mpc_operator");
    const decider = await admin("security_operator");
    const proposed = await proposeSuspension(proposer.token, subjectId, action);
    expect(proposed.statusCode, proposed.body).toBe(200);
    const approved = await decideSuspension(decider.token, proposed.json());
    expect(approved.statusCode, approved.body).toBe(200);
    return { proposer, decider, request: approved.json() as { id: string } };
  }

  /** A pending email change of the person proposed by `proposer`, approved by `decider` unless told otherwise. */
  async function emailChange(subjectId: string, proposer: { token: string }, decider?: { token: string }) {
    const newEmail = freshEmail("attacker");
    const proposed = await proposeEmailChange(proposer.token, subjectId, newEmail);
    expect(proposed.statusCode, proposed.body).toBe(200);
    if (!decider) return { newEmail, change: proposed.json() as { id: string; version: number } };
    const approved = await decideEmailChange(decider.token, proposed.json());
    expect(approved.statusCode, approved.body).toBe(200);
    return { newEmail, change: approved.json() as { id: string; version: number } };
  }

  const windowOpen = async (subjectId: string) =>
    (await fx.sql<{ open: boolean }[]>`SELECT core.mfa_reset_window_open(${subjectId}) AS open`)[0]!.open;

  const asApp = <T>(work: (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => Promise<T>) =>
    withTenant(fx.appSql, { tenantId: fx.tenantA }, work);

  describe("S-M1: the reviewer's chain", () => {
    it("fails at the email-change verify: the suspension closed the change, and the address stays", async () => {
      const victimEmail = freshEmail("victim");
      const victim = await person(victimEmail);
      const a = await admin("mpc_operator");
      const b = await admin("security_operator");

      // 1. A and B approve an email change to an address they read.
      const { newEmail, change } = await emailChange(victim, a, b);
      const code = await emailChangeCode(newEmail);

      // 2. A and B cannot suspend the person: they took part in the email change.
      const byA = await proposeSuspension(a.token, victim);
      expect(byA.statusCode).toBe(422);
      expect(byA.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      const c = await admin("mpc_operator");
      const proposed = await proposeSuspension(c.token, victim);
      expect(proposed.statusCode, proposed.body).toBe(200);
      const byB = await decideSuspension(b.token, proposed.json());
      expect(byB.statusCode).toBe(422);
      expect(byB.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");

      // Two admins outside the change suspend; the change closes with the suspension.
      const d = await admin("security_operator");
      const approved = await decideSuspension(d.token, proposed.json());
      expect(approved.statusCode, approved.body).toBe(200);
      const [closed] = await fx.sql<{ state: string; closed_reason: string | null }[]>`
        SELECT state, closed_reason FROM core.email_change_requests WHERE id = ${change.id}
      `;
      expect(closed).toEqual({ state: "expired", closed_reason: "subject_suspended" });
      const audits = await fx.sql<{ actor_subject_id: string; detail: { reason: string } }[]>`
        SELECT actor_subject_id, detail FROM audit.events
        WHERE command = 'admin.subject_suspension.request_closed' AND resource_id = ${change.id}
      `;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ actor_subject_id: d.subjectId, detail: { reason: "subject_suspended" } });

      // 3. The code from the new address no longer completes anything — answered as any wrong code.
      const completed = await verifyEmailChange(newEmail, code);
      const wrong = await verifyEmailChange(freshEmail("nobody"), "12345678");
      expect(completed.statusCode).toBe(401);
      expect(completed.statusCode).toBe(wrong.statusCode);
      expect(withoutRequestId(completed.json())).toEqual(withoutRequestId(wrong.json()));
      const [after] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${victim}`;
      expect(after!.email).toBe(victimEmail);

      // 4. Two more admins reinstate; the window that opens belongs to the victim's own address.
      await suspendedBy(victim, "reinstate");
      expect(await windowOpen(victim)).toBe(true);
      const start = await publicPost("/api/v1/auth/email/start", { email: newEmail });
      expect(start.statusCode).toBe(202);
      const mailed = await fx.sql`
        SELECT 1 FROM core.email_outbox WHERE recipient = ${newEmail} AND template = 'sign_in_code'
      `;
      expect(mailed).toHaveLength(0);
    });
  });

  describe("S-M1: a suspended person's address and factors stay as they are", () => {
    it("an email change of a suspended person is not proposed", async () => {
      const target = await person();
      await suspendedBy(target);
      const proposer = await admin("mpc_operator");
      const refused = await proposeEmailChange(proposer.token, target);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe("SUBJECT_SUSPENDED");
      const rows = await fx.sql`SELECT 1 FROM core.email_change_requests WHERE subject_id = ${target}`;
      expect(rows).toHaveLength(0);
    });

    it("an email change pending when the mark is set is not approved, and can still be rejected", async () => {
      const target = await person();
      const { change } = await emailChange(target, await admin("mpc_operator"));
      // Set directly, as a restore would leave it: the decision closes nothing here.
      await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${target}`;
      const decider = await admin("security_operator");
      const refused = await decideEmailChange(decider.token, change);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe("SUBJECT_SUSPENDED");
      const rejected = await decideEmailChange(decider.token, change, false);
      expect(rejected.statusCode, rejected.body).toBe(200);
      expect(rejected.json()).toMatchObject({ state: "rejected" });
    });

    it("an approved email change does not complete while the person is suspended, even if left open", async () => {
      const email = freshEmail("kept");
      const target = await person(email);
      const { newEmail, change } = await emailChange(target, await admin("mpc_operator"), await admin("security_operator"));
      const code = await emailChangeCode(newEmail);
      await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${target}`;

      const completed = await verifyEmailChange(newEmail, code);
      const wrong = await verifyEmailChange(freshEmail("nobody"), "12345678");
      expect(completed.statusCode).toBe(wrong.statusCode);
      expect(withoutRequestId(completed.json())).toEqual(withoutRequestId(wrong.json()));
      const [after] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${target}`;
      expect(after!.email).toBe(email);
      const [row] = await fx.sql<{ state: string }[]>`SELECT state FROM core.email_change_requests WHERE id = ${change.id}`;
      expect(row!.state).toBe("approved");
    });

    it("an MFA reset of a suspended person is not proposed (S-L2)", async () => {
      const target = await person();
      await suspendedBy(target);
      const refused = await proposeReset((await admin("mpc_operator")).token, target);
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe("SUBJECT_SUSPENDED");
      // Not at the database either, from any origin.
      const proposer = (await admin("mpc_operator")).subjectId;
      await expect(asApp((tx) => tx`
        INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${target}, 'x', ${proposer})
      `)).rejects.toThrow(/MFA_RESET_SUBJECT_SUSPENDED/);
      await expect(fx.sql`SELECT core.open_bootstrap_enrolment_window(${target})`).rejects.toThrow(
        /MFA_RESET_SUBJECT_SUSPENDED/,
      );
    });

    it("an MFA reset pending when the mark is set is not approved", async () => {
      const target = await person();
      const proposed = await proposeReset((await admin("mpc_operator")).token, target);
      expect(proposed.statusCode, proposed.body).toBe(200);
      await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${target}`;
      const decider = await admin("security_operator");
      const refused = await decideReset(decider.token, proposed.json());
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe("SUBJECT_SUSPENDED");
      const rejected = await decideReset(decider.token, proposed.json(), false);
      expect(rejected.statusCode, rejected.body).toBe(200);
    });

    it("a suspension closes the person's pending MFA reset and ends an approved one's window", async () => {
      const pendingTarget = await person();
      const pending = (await proposeReset((await admin("mpc_operator")).token, pendingTarget)).json();
      await suspendedBy(pendingTarget);
      const [closed] = await fx.sql<{ state: string; closed_reason: string; decided_by_subject_id: string | null }[]>`
        SELECT state, closed_reason, decided_by_subject_id FROM core.mfa_reset_requests WHERE id = ${pending.id}
      `;
      expect(closed).toEqual({ state: "rejected", closed_reason: "subject_suspended", decided_by_subject_id: null });

      const windowTarget = await person();
      const reset = (await proposeReset((await admin("mpc_operator")).token, windowTarget)).json();
      expect((await decideReset((await admin("security_operator")).token, reset)).statusCode).toBe(200);
      expect(await windowOpen(windowTarget)).toBe(true);
      const { request } = await suspendedBy(windowTarget);
      expect(await windowOpen(windowTarget)).toBe(false);
      const audits = await fx.sql<{ detail: { reason: string; suspensionId: string } }[]>`
        SELECT detail FROM audit.events
        WHERE command = 'admin.subject_suspension.request_closed' AND resource_id = ${reset.id}
      `;
      expect(audits.map((row) => row.detail)).toEqual([
        expect.objectContaining({ reason: "window_closed", suspensionId: request.id }),
      ]);
    });

    it("an address change ends an enrolment window opened before it", async () => {
      const target = await person();
      const reset = (await proposeReset((await admin("mpc_operator")).token, target)).json();
      expect((await decideReset((await admin("security_operator")).token, reset)).statusCode).toBe(200);
      expect(await windowOpen(target)).toBe(true);

      const { newEmail } = await emailChange(target, await admin("mpc_operator"), await admin("security_operator"));
      const done = await verifyEmailChange(newEmail, await emailChangeCode(newEmail));
      expect(done.statusCode, done.body).toBe(200);
      expect(await windowOpen(target)).toBe(false);
    });
  });

  describe("S-M1: separation between suspension and the recovery flows, both ways", () => {
    it("whoever took part in an email change of the person takes no part in their suspension", async () => {
      const target = await person();
      const a = await admin("mpc_operator");
      const b = await admin("security_operator");
      await emailChange(target, a, b);
      for (const actor of [a, b]) {
        const refused = await proposeSuspension(actor.token, target);
        expect(refused.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      }
      const proposed = (await proposeSuspension((await admin("mpc_operator")).token, target)).json();
      for (const actor of [a, b]) {
        const refused = await decideSuspension(actor.token, proposed);
        expect(refused.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      }
      // A rejection is never refused.
      expect((await decideSuspension(b.token, proposed, false)).statusCode).toBe(200);
    });

    it("whoever took part in an MFA reset of the person takes no part in their suspension or reinstatement", async () => {
      const target = await person();
      const a = await admin("mpc_operator");
      const b = await admin("security_operator");
      const reset = (await proposeReset(a.token, target)).json();
      expect((await decideReset(b.token, reset)).statusCode).toBe(200);

      expect((await proposeSuspension(a.token, target)).json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      const proposed = (await proposeSuspension((await admin("mpc_operator")).token, target)).json();
      expect((await decideSuspension(b.token, proposed)).json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      expect((await decideSuspension((await admin("security_operator")).token, proposed)).statusCode).toBe(200);

      expect((await proposeSuspension(b.token, target, "reinstate")).json().code).toBe(
        "ACCOUNT_RECOVERY_SEPARATION_REQUIRED",
      );
    });

    it("whoever suspended the person takes no part in an email change or MFA reset of them", async () => {
      const target = await person();
      const { proposer, decider } = await suspendedBy(target);
      await suspendedBy(target, "reinstate");
      for (const actor of [proposer, decider]) {
        expect((await proposeEmailChange(actor.token, target)).json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
        expect((await proposeReset(actor.token, target)).json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      }
      const { change } = await emailChange(target, await admin("mpc_operator"));
      expect((await decideEmailChange(decider.token, change)).json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      const reset = (await proposeReset((await admin("mpc_operator")).token, target)).json();
      expect((await decideReset(proposer.token, reset)).json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
    });
  });

  describe("S-L1: a suspended admin's proposals", () => {
    it("are closed with the suspension, each audited, and cannot be decided afterwards", async () => {
      const proposer = await admin("mpc_operator");
      const other = await person();
      const third = await person();

      // One open request of each kind, all proposed by the admin about to be suspended.
      const reset = (await proposeReset(proposer.token, other)).json();
      const { change } = await emailChange(third, proposer);
      const suspension = (await proposeSuspension(proposer.token, await person())).json();
      const grantId = randomUUID();
      await fx.sql`
        INSERT INTO core.role_grant_requests (id, tenant_id, subject_id, organization_id, role, reason, requested_by_subject_id)
        VALUES (${grantId}, ${fx.tenantA}, ${other}, ${fx.orgA}, 'data_steward', 'needs access', ${proposer.subjectId})
      `;
      const bindingId = randomUUID();
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${bindingId}, ${fx.tenantA}, ${third}, ${fx.orgA}, 'data_steward')
      `;
      const revocationId = randomUUID();
      await fx.sql`
        INSERT INTO core.role_revocation_requests (id, tenant_id, role_binding_id, reason_code, reason, requested_by_subject_id)
        VALUES (${revocationId}, ${fx.tenantA}, ${bindingId}, 'offboarding', 'left', ${proposer.subjectId})
      `;
      const proposalId = randomUUID();
      await fx.sql`
        INSERT INTO core.registry_proposals (
          id, tenant_id, kind, item_key, item_version, payload, rationale, effective_from, proposed_by_subject_id
        ) VALUES (
          ${proposalId}, ${fx.tenantA}, 'credential', ${`key-${proposalId.slice(0, 8)}`}, 1, '{}'::jsonb,
          'reviewed', now(), ${proposer.subjectId}
        )
      `;
      const elevationId = randomUUID();
      await fx.sql`
        INSERT INTO core.break_glass_elevations (id, tenant_id, subject_id, purpose, target, expires_at)
        VALUES (${elevationId}, ${fx.tenantA}, ${proposer.subjectId}, 'incident', 'credential', now() + interval '1 hour')
      `;

      const { request } = await suspendedBy(proposer.subjectId);

      const states = {
        reset: (await fx.sql`SELECT state::text, closed_reason FROM core.mfa_reset_requests WHERE id = ${reset.id}`)[0],
        change: (await fx.sql`SELECT state, closed_reason FROM core.email_change_requests WHERE id = ${change.id}`)[0],
        suspension: (await fx.sql`SELECT state::text, closed_reason FROM core.subject_suspensions WHERE id = ${suspension.id}`)[0],
        grant: (await fx.sql`SELECT state::text, closed_reason FROM core.role_grant_requests WHERE id = ${grantId}`)[0],
        revocation: (await fx.sql`SELECT state::text, closed_reason FROM core.role_revocation_requests WHERE id = ${revocationId}`)[0],
        proposal: (await fx.sql`SELECT state::text, closed_reason FROM core.registry_proposals WHERE id = ${proposalId}`)[0],
        elevation: (await fx.sql`SELECT state::text, closed_reason FROM core.break_glass_elevations WHERE id = ${elevationId}`)[0],
      };
      expect(states).toEqual({
        reset: { state: "rejected", closed_reason: "proposer_suspended" },
        change: { state: "expired", closed_reason: "proposer_suspended" },
        suspension: { state: "rejected", closed_reason: "proposer_suspended" },
        grant: { state: "withdrawn", closed_reason: "proposer_suspended" },
        revocation: { state: "withdrawn", closed_reason: "proposer_suspended" },
        proposal: { state: "rejected", closed_reason: "proposer_suspended" },
        elevation: { state: "rejected", closed_reason: "proposer_suspended" },
      });
      const audited = await fx.sql<{ resource_type: string; resource_id: string }[]>`
        SELECT resource_type, resource_id FROM audit.events
        WHERE command = 'admin.subject_suspension.request_closed' AND detail ->> 'suspensionId' = ${request.id}
        ORDER BY resource_type
      `;
      expect(audited.map((row) => `${row.resource_type}:${row.resource_id}`).sort()).toEqual(
        [
          `break_glass_elevation:${elevationId}`,
          `email_change_request:${change.id}`,
          `mfa_reset_request:${reset.id}`,
          `registry_proposal:${proposalId}`,
          `role_grant_request:${grantId}`,
          `role_revocation_request:${revocationId}`,
          `subject_suspension:${suspension.id}`,
        ].sort(),
      );

      // Another admin can no longer decide any of them.
      const decider = await admin("security_operator");
      // The admin lists still read the closed rows (rejected / expired with no decider).
      for (const [url, id] of [
        ["/api/v1/admin/mfa-resets", reset.id],
        ["/api/v1/admin/email-changes", change.id],
        ["/api/v1/admin/subject-suspensions", suspension.id],
        ["/api/v1/admin/role-grants", grantId],
        ["/api/v1/admin/break-glass", elevationId],
      ] as const) {
        const listed = await app.inject({ method: "GET", url: `${url}?limit=100`, headers: bearer(decider.token) });
        expect(listed.statusCode, `${url} ${listed.body}`).toBe(200);
        expect(listed.body, url).toContain(id);
      }
      expect((await decideReset(decider.token, reset)).statusCode).toBe(412);
      expect((await decideReset(decider.token, { id: reset.id, version: reset.version + 1 })).json().code).toBe(
        "MFA_RESET_ALREADY_DECIDED",
      );
      expect((await decideEmailChange(decider.token, { id: change.id, version: change.version + 1 })).json().code).toBe(
        "EMAIL_CHANGE_ALREADY_DECIDED",
      );
      expect(
        (await decideSuspension(decider.token, { id: suspension.id, version: suspension.version + 1 })).json().code,
      ).toBe("SUSPENSION_ALREADY_DECIDED");
    });

    it("F2 (0132): what a suspended admin approved or invited and is still open closes too, each audited", async () => {
      const approver = await admin("mpc_operator");
      // An email change the admin approved, still waiting for its code.
      const target = await person();
      const { newEmail, change } = await emailChange(target, await admin("mpc_operator"), approver);
      const code = await emailChangeCode(newEmail);
      // An MFA reset the admin approved, its window open.
      const resetTarget = await person();
      const proposedReset = (await proposeReset((await admin("security_operator")).token, resetTarget)).json();
      const reset = (await decideReset(approver.token, proposedReset)).json();
      expect(reset.state).toBe("approved");
      expect(await windowOpen(resetTarget)).toBe(true);
      // An invitation the admin created, still pending, with its mail queued.
      const invitee = freshEmail("invitee");
      const invited = await adminPost("/api/v1/admin/invitations", approver.token, { email: invitee, organizationId: fx.orgA });
      expect(invited.statusCode, invited.body).toBe(200);
      const invitation = invited.json() as { id: string };
      // Decided and completed history stays: a change the admin approved that already completed.
      const done = await person();
      const completedChange = await emailChange(done, await admin("mpc_operator"), approver);
      expect((await verifyEmailChange(completedChange.newEmail, await emailChangeCode(completedChange.newEmail))).statusCode).toBe(200);

      const { request } = await suspendedBy(approver.subjectId);

      expect((await fx.sql`SELECT state, closed_reason FROM core.email_change_requests WHERE id = ${change.id}`)[0]).toEqual({
        state: "expired",
        closed_reason: "approver_suspended",
      });
      expect(
        (await fx.sql`SELECT state::text, closed_reason, decided_by_subject_id FROM core.mfa_reset_requests WHERE id = ${reset.id}`)[0],
      ).toEqual({ state: "approved", closed_reason: "approver_suspended", decided_by_subject_id: approver.subjectId });
      expect(await windowOpen(resetTarget)).toBe(false);
      expect((await fx.sql`SELECT state, closed_reason FROM core.invitations WHERE id = ${invitation.id}`)[0]).toEqual({
        state: "expired",
        closed_reason: "inviter_suspended",
      });
      expect(
        await fx.sql`SELECT 1 FROM core.email_outbox WHERE invitation_id = ${invitation.id} AND state = 'pending'`,
      ).toHaveLength(0);
      expect((await fx.sql`SELECT state FROM core.email_change_requests WHERE id = ${completedChange.change.id}`)[0]).toEqual({
        state: "completed",
      });

      const audited = await fx.sql<{ resource_type: string; resource_id: string; detail: { reason: string } }[]>`
        SELECT resource_type, resource_id, detail FROM audit.events
        WHERE command = 'admin.subject_suspension.request_closed' AND detail ->> 'suspensionId' = ${request.id}
      `;
      expect(audited.map((row) => `${row.resource_type}:${row.resource_id}:${row.detail.reason}`).sort()).toEqual(
        [
          `email_change_request:${change.id}:approver_suspended`,
          `invitation:${invitation.id}:inviter_suspended`,
          `mfa_reset_request:${reset.id}:approver_suspended`,
        ].sort(),
      );

      // The approved change no longer completes: its code is answered as any wrong code.
      const completed = await verifyEmailChange(newEmail, code);
      expect(completed.statusCode).toBe(401);
      const [after] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${target}`;
      expect(after!.email).not.toBe(newEmail);
    });

    it("a suspended subject neither proposes nor decides, even straight at the database", async () => {
      const suspendedAdmin = await admin("mpc_operator");
      const proposer = await admin("mpc_operator");
      const target = await person();
      const reset = (await proposeReset(proposer.token, target)).json();
      const { change } = await emailChange(await person(), proposer);
      const suspension = (await proposeSuspension(proposer.token, await person())).json();
      const grantId = randomUUID();
      await fx.sql`
        INSERT INTO core.role_grant_requests (id, tenant_id, subject_id, organization_id, role, reason, requested_by_subject_id)
        VALUES (${grantId}, ${fx.tenantA}, ${target}, ${fx.orgA}, 'data_steward', 'needs access', ${proposer.subjectId})
      `;
      // Set directly: the admin has no session to act with, so this is the database's own line.
      await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${suspendedAdmin.subjectId}`;
      const as = suspendedAdmin.subjectId;

      await expect(asApp((tx) => tx`SELECT * FROM core.decide_mfa_reset(${reset.id}, ${as}, true, 'x', ${reset.version})`))
        .rejects.toThrow(/ACTOR_SUSPENDED/);
      await expect(asApp((tx) => tx`
        SELECT * FROM core.decide_email_change(${change.id}, ${as}, false, 'x', ${change.version}, ${randomUUID()}, ${Buffer.alloc(32)}, '12345678')
      `)).rejects.toThrow(/ACTOR_SUSPENDED/);
      await expect(asApp((tx) =>
        tx`SELECT * FROM core.decide_subject_suspension(${suspension.id}, ${as}, false, 'x', ${suspension.version})`,
      )).rejects.toThrow(/ACTOR_SUSPENDED/);
      await expect(asApp((tx) => tx`
        UPDATE core.role_grant_requests
        SET state = 'rejected', decided_by_subject_id = ${as}, decided_at = now(), decision_reason = 'x'
        WHERE id = ${grantId}
      `)).rejects.toThrow(/ACTOR_SUSPENDED/);
      // And as proposer.
      const someone = await person();
      await expect(asApp((tx) => tx`
        INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${someone}, 'x', ${as})
      `)).rejects.toThrow(/ACTOR_SUSPENDED/);
      await expect(asApp((tx) => tx`SELECT * FROM core.request_email_change(${randomUUID()}, ${target}, ${freshEmail()}, 'x', ${as})`))
        .rejects.toThrow(/ACTOR_SUSPENDED/);
      await expect(fx.sql`
        INSERT INTO core.break_glass_elevations (id, tenant_id, subject_id, purpose, target, expires_at)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${as}, 'incident', 'credential', now() + interval '1 hour')
      `).rejects.toThrow(/ACTOR_SUSPENDED/);
    });

    it("only the suspension writes `closed_reason`", async () => {
      const proposer = await admin("mpc_operator");
      const grantId = randomUUID();
      await fx.sql`
        INSERT INTO core.role_grant_requests (id, tenant_id, subject_id, organization_id, role, reason, requested_by_subject_id)
        VALUES (${grantId}, ${fx.tenantA}, ${await person()}, ${fx.orgA}, 'data_steward', 'needs access', ${proposer.subjectId})
      `;
      // The application role updates these tables, but not that column.
      await expect(asApp((tx) => tx`
        UPDATE core.role_grant_requests
        SET state = 'withdrawn', decided_at = now(), closed_reason = 'proposer_suspended'
        WHERE id = ${grantId}
      `)).rejects.toThrow(/permission denied/);
      // Other columns still work as before.
      await asApp((tx) => tx`
        UPDATE core.role_grant_requests SET state = 'withdrawn', decided_at = now() WHERE id = ${grantId}
      `);
      // No row is born closed, whoever writes it.
      await expect(fx.sql`
        INSERT INTO core.role_grant_requests (
          id, tenant_id, subject_id, organization_id, role, reason, requested_by_subject_id, state, decided_at, closed_reason
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${await person()}, ${fx.orgA}, 'data_steward', 'x', ${proposer.subjectId},
          'withdrawn', now(), 'proposer_suspended'
        )
      `).rejects.toThrow(/REQUEST_CLOSED_REASON_RESERVED/);
    });
  });

  describe("0133: what a closure leaves visible", () => {
    const bootstrap = async (subjectId: string) =>
      (await fx.sql<{ opened: boolean; reset_id: string | null }[]>`
        SELECT opened, reset_id FROM core.open_bootstrap_enrolment_window(${subjectId})
      `)[0]!;

    it("L1: a reset window closed by its approver's suspension does not stop a bootstrap re-run", async () => {
      const approver = await admin("security_operator");
      const target = await person();
      const proposed = (await proposeReset((await admin("mpc_operator")).token, target)).json();
      const reset = (await decideReset(approver.token, proposed)).json();
      expect(reset.state).toBe("approved");
      // Contrast: while the window counts, the re-run points at it and opens nothing.
      expect(await bootstrap(target)).toEqual({ opened: false, reset_id: reset.id });

      await suspendedBy(approver.subjectId);
      expect(await windowOpen(target)).toBe(false);
      const rerun = await bootstrap(target);
      expect(rerun.opened).toBe(true);
      expect(rerun.reset_id).not.toBe(reset.id);
      expect(await windowOpen(target)).toBe(true);
    });

    it("L1: nor does a window a later suspension of the person ended", async () => {
      const target = await person();
      const proposed = (await proposeReset((await admin("mpc_operator")).token, target)).json();
      const reset = (await decideReset((await admin("security_operator")).token, proposed)).json();
      await suspendedBy(target);
      await suspendedBy(target, "reinstate");
      const rerun = await bootstrap(target);
      expect(rerun.opened).toBe(true);
      expect(rerun.reset_id).not.toBe(reset.id);
    });

    it("L3: the admin lists say which requests a suspension closed, and why", async () => {
      const suspendedAdmin = await admin("security_operator");
      const colleague = await admin("mpc_operator");
      // Approved by the admin: an email change waiting for its code and a reset with an open window.
      const { change: approvedChange } = await emailChange(await person(), colleague, suspendedAdmin);
      const proposedReset = (await proposeReset(colleague.token, await person())).json();
      const approvedReset = (await decideReset(suspendedAdmin.token, proposedReset)).json();
      // Created by the admin: an invitation.
      const invited = await adminPost("/api/v1/admin/invitations", suspendedAdmin.token, {
        email: freshEmail("invitee"),
        organizationId: fx.orgA,
      });
      expect(invited.statusCode, invited.body).toBe(200);
      // Proposed by the admin: a reset, an email change, a suspension, a role grant and a revocation.
      const proposedByAdmin = {
        reset: (await proposeReset(suspendedAdmin.token, await person())).json().id as string,
        change: (await emailChange(await person(), suspendedAdmin)).change.id,
        suspension: (await proposeSuspension(suspendedAdmin.token, await person())).json().id as string,
        grant: randomUUID(),
        revocation: randomUUID(),
      };
      await fx.sql`
        INSERT INTO core.role_grant_requests (id, tenant_id, subject_id, organization_id, role, reason, requested_by_subject_id)
        VALUES (${proposedByAdmin.grant}, ${fx.tenantA}, ${await person()}, ${fx.orgA}, 'data_steward', 'needs access', ${suspendedAdmin.subjectId})
      `;
      const bindingId = randomUUID();
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${bindingId}, ${fx.tenantA}, ${await person()}, ${fx.orgA}, 'data_steward')
      `;
      await fx.sql`
        INSERT INTO core.role_revocation_requests (id, tenant_id, role_binding_id, reason_code, reason, requested_by_subject_id)
        VALUES (${proposedByAdmin.revocation}, ${fx.tenantA}, ${bindingId}, 'offboarding', 'left', ${suspendedAdmin.subjectId})
      `;
      // Contrast: open requests nobody suspended keep `closedReason: null`.
      const untouchedReset = (await proposeReset(colleague.token, await person())).json().id as string;
      const untouchedChange = (await emailChange(await person(), colleague)).change.id;

      const { proposer: suspensionProposer } = await suspendedBy(suspendedAdmin.subjectId);

      const reader = suspensionProposer.token;
      const listed = async (url: string) => {
        const response = await app.inject({ method: "GET", url, headers: bearer(reader) });
        expect(response.statusCode, `${url} ${response.body}`).toBe(200);
        const items = response.json().items as { id: string; state: string; closedReason: string | null }[];
        return (id: string) => {
          const item = items.find((candidate) => candidate.id === id);
          expect(item, `${url} lists ${id}`).toBeDefined();
          return { state: item!.state, closedReason: item!.closedReason };
        };
      };
      const resets = await listed("/api/v1/admin/mfa-resets");
      expect(resets(approvedReset.id)).toEqual({ state: "approved", closedReason: "approver_suspended" });
      expect(resets(proposedByAdmin.reset)).toEqual({ state: "rejected", closedReason: "proposer_suspended" });
      expect(resets(untouchedReset)).toEqual({ state: "pending", closedReason: null });
      const changes = await listed("/api/v1/admin/email-changes");
      expect(changes(approvedChange.id)).toEqual({ state: "expired", closedReason: "approver_suspended" });
      expect(changes(proposedByAdmin.change)).toEqual({ state: "expired", closedReason: "proposer_suspended" });
      expect(changes(untouchedChange)).toEqual({ state: "pending", closedReason: null });
      const invitations = await listed("/api/v1/admin/invitations");
      expect(invitations(invited.json().id)).toEqual({ state: "expired", closedReason: "inviter_suspended" });
      const suspensions = await listed("/api/v1/admin/subject-suspensions");
      expect(suspensions(proposedByAdmin.suspension)).toEqual({ state: "rejected", closedReason: "proposer_suspended" });
      const grants = await listed("/api/v1/admin/role-grants");
      expect(grants(proposedByAdmin.grant)).toEqual({ state: "withdrawn", closedReason: "proposer_suspended" });
      const revocations = await listed("/api/v1/admin/role-revocations");
      expect(revocations(proposedByAdmin.revocation)).toEqual({ state: "withdrawn", closedReason: "proposer_suspended" });
    });
  });
});
