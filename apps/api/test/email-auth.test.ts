import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { bearer, idempotencyKey, issueTestSession, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Email codes, invitations and two-person email change — account authentication WP2.
 *
 * One test (at least) per security property of the plan:
 *
 * - start answers the same, in the same time, whether or not an address has an account;
 * - a code is 8 digits, stored only as an HMAC, valid 10 minutes, 5 tries, once, for its
 *   address only, and a new code replaces the old one;
 * - per-address and per-IP limits hold across IPs and addresses;
 * - an emailed-code session is aal1 and needs MFA for anything restricted, and no path but a
 *   consumed challenge mints one;
 * - an invitation carries no role, works once, expires, can be revoked, cannot name another
 *   tenant's organisation, and refuses an address in use with one generic, audited answer;
 * - an email change takes two admins other than the person, a code sent to the new address,
 *   and ends every session;
 * - the application role cannot write an address directly, and audit records carry a keyed hash,
 *   never the address.
 */
describeDb("email codes, invitations and email change", { timeout: 30_000 }, () => {
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

  /** A public-looking address per call, so the per-IP limit of one test does not reach another. */
  // Random within 100.64.0.0/10, so neither another test nor an earlier run within the limit
  // window shares a bucket.
  const freshIp = () =>
    `100.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.${(ipCounter++ % 254) + 1}`;
  const freshEmail = (label = "person") => `${label}-${randomUUID().slice(0, 8)}@example.com`;

  const post = (url: string, payload: unknown, ip = freshIp(), headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, payload: payload as never, remoteAddress: ip, headers });

  const start = (email: string, ip?: string) => post("/api/v1/auth/email/start", { email }, ip);
  const verify = (email: string, code: string, ip?: string) =>
    post("/api/v1/auth/email/verify", { email, code }, ip);

  /** The code the worker would mail to `email`, read where the worker reads it. */
  async function mailedCode(email: string, template = "sign_in_code"): Promise<string> {
    const [mail] = await fx.sql<{ params: { code: string } }[]>`
      SELECT params FROM core.email_outbox
      WHERE recipient = ${email} AND template = ${template} AND state = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!mail) throw new Error(`no ${template} mail pending`);
    return mail.params.code;
  }

  /** A person in tenant A with an address, created as the migration role would. */
  async function person(email: string, tenantId = fx.tenantA): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, email)
      VALUES (${id}, ${tenantId}, 'person', 'Email Person', ${email})
    `;
    return id;
  }

  /** An admin (mpc_operator or security_operator) session at aal3 in tenant A. */
  async function admin(role: "mpc_operator" | "security_operator" = "security_operator") {
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', ${`Admin ${subjectId.slice(0, 4)}`}, 'high_assurance')
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, ${role})
    `;
    const token = await issueTestSession(fx.appSql, fx.tenantA, subjectId, {
      firstFactor: "google",
      secondFactor: "passkey",
    });
    return { subjectId, token };
  }

  const adminPost = (url: string, token: string, payload: unknown, extra: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url,
      payload: payload as never,
      headers: { ...bearer(token), "idempotency-key": idempotencyKey(), ...extra },
    });

  const withoutRequestId = (body: Record<string, unknown>) => {
    const { requestId: _ignored, ...rest } = body;
    return rest;
  };

  describe("sign-in methods (WP6)", () => {
    it("names only the configured providers, offers no wallet sign-in, and needs no session", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/methods" });
      expect(response.statusCode).toBe(200);
      expect(withoutRequestId(response.json())).toEqual({
        emailCode: true,
        google: false,
        microsoft: false,
        emailCodeDigits: 8,
        emailCodeTtlMinutes: 10,
      });
      // Wallet sign-in was removed (WP7): the screen has no switch to read.
      expect(response.json()).not.toHaveProperty("legacyWalletLogin");

      const configured = await buildServer(
        loadConfig(
          testEnv({
            GOOGLE_CLIENT_ID: "google-client",
            GOOGLE_CLIENT_SECRET: "google-secret",
          }),
        ),
        fx.appSql,
      );
      try {
        // A Bearer header is not looked up on a public route: the answer is the same for everyone.
        const answer = await configured.inject({
          method: "GET",
          url: "/api/v1/auth/methods",
          headers: { authorization: "Bearer not-a-session" },
        });
        expect(answer.statusCode).toBe(200);
        expect(answer.json()).toMatchObject({ google: true, microsoft: false });
        expect(answer.json()).not.toHaveProperty("legacyWalletLogin");
      } finally {
        await configured.close();
      }
    });
  });

  describe("email sign-in", () => {
    it("answers an address with an account and one without identically, and no faster", async () => {
      const known = freshEmail("known");
      await person(known);
      const unknown = freshEmail("unknown");

      const startedAt = Date.now();
      const a = await start(known);
      const knownMs = Date.now() - startedAt;
      const b = await start(unknown);
      const unknownMs = Date.now() - startedAt - knownMs;

      expect(a.statusCode).toBe(202);
      expect(b.statusCode).toBe(202);
      expect(withoutRequestId(a.json())).toEqual(withoutRequestId(b.json()));
      expect(Object.keys(a.headers).sort()).toEqual(Object.keys(b.headers).sort());
      // Both take at least the floor, so the database work for a real account does not show.
      expect(knownMs).toBeGreaterThanOrEqual(240);
      expect(unknownMs).toBeGreaterThanOrEqual(240);

      // Only the real account gets mail; the decoy is settled unsent with nothing in it.
      expect(await mailedCode(known)).toMatch(/^[0-9]{8}$/);
      const decoys = await fx.sql`
        SELECT 1 FROM core.email_outbox
        WHERE state = 'pending' AND recipient = ${unknown}
      `;
      expect(decoys).toHaveLength(0);
    });

    it("stores a code only as a 32-byte HMAC", async () => {
      const email = freshEmail();
      const subjectId = await person(email);
      await start(email);
      const code = await mailedCode(email);
      const columns = await fx.sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'core' AND table_name = 'email_challenges'
      `;
      expect(columns.map((c) => c.column_name)).not.toContain("code");
      const [challenge] = await fx.sql<{ code_hmac: Buffer }[]>`
        SELECT code_hmac FROM core.email_challenges WHERE subject_id = ${subjectId}
      `;
      expect(challenge!.code_hmac).toHaveLength(32);
      expect(challenge!.code_hmac.toString("hex")).not.toContain(Buffer.from(code).toString("hex"));
    });

    it("signs in once with the code, as an aal1 email_code session bound to its challenge", async () => {
      const email = freshEmail();
      const subjectId = await person(email);
      await start(email);
      const code = await mailedCode(email);

      const first = await verify(email, code);
      expect(first.statusCode).toBe(200);
      const body = first.json();
      expect(body).toMatchObject({ subjectId, firstFactor: "email_code", aal: "aal1" });

      const [session] = await fx.sql<{ email_challenge_id: string | null }[]>`
        SELECT email_challenge_id FROM core.sessions WHERE subject_id = ${subjectId}
      `;
      expect(session!.email_challenge_id).not.toBeNull();

      const again = await verify(email, code);
      expect(again.statusCode).toBe(401);
      expect(again.json().code).toBe("EMAIL_CODE_INVALID");

      // The mail row's plaintext code is gone once the worker settles it; until then it is
      // pending. Consumption does not depend on mail state.
      expect(await fx.sql`SELECT 1 FROM core.sessions WHERE subject_id = ${subjectId}`).toHaveLength(1);
    });

    it("an aal1 session gets MFA_REQUIRED for anything restricted", async () => {
      const email = freshEmail();
      const subjectId = await person(email);
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, 'data_steward')
      `;
      await start(email);
      const { sessionToken } = (await verify(email, await mailedCode(email))).json();
      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}`,
        headers: bearer(sessionToken),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("MFA_REQUIRED");
    });

    it("allows five wrong codes, then refuses even the right one", async () => {
      const email = freshEmail();
      await person(email);
      await start(email);
      const code = await mailedCode(email);
      const wrong = code === "00000000" ? "11111111" : "00000000";
      for (let attempt = 1; attempt <= 5; attempt++) {
        const response = await verify(email, wrong);
        expect(response.statusCode, `attempt ${attempt}`).toBe(401);
      }
      const right = await verify(email, code);
      expect(right.statusCode).toBe(401);
      expect(right.json().code).toBe("EMAIL_CODE_ATTEMPTS_EXHAUSTED");
    });

    it("refuses a code after ten minutes", async () => {
      const email = freshEmail();
      const subjectId = await person(email);
      await start(email);
      const code = await mailedCode(email);
      await fx.sql`
        UPDATE core.email_challenges
        SET created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
        WHERE subject_id = ${subjectId}
      `;
      const response = await verify(email, code);
      expect(response.statusCode).toBe(401);
      expect(["EMAIL_CODE_EXPIRED", "EMAIL_CODE_INVALID"]).toContain(response.json().code);
      expect(await fx.sql`SELECT 1 FROM core.sessions WHERE subject_id = ${subjectId}`).toHaveLength(0);
    });

    it("refuses one address's code for another address", async () => {
      const a = freshEmail("a");
      const b = freshEmail("b");
      await person(a);
      const bSubject = await person(b);
      await start(a);
      await start(b);
      const response = await verify(b, await mailedCode(a));
      expect(response.statusCode).toBe(401);
      expect(await fx.sql`SELECT 1 FROM core.sessions WHERE subject_id = ${bSubject}`).toHaveLength(0);
    });

    it("a new code replaces the previous one and its pending mail", async () => {
      const email = freshEmail();
      await person(email);
      await start(email);
      const first = await mailedCode(email);
      await start(email);
      const second = await mailedCode(email);

      const states = await fx.sql<{ state: string }[]>`
        SELECT o.state FROM core.email_outbox o
        JOIN core.email_challenges c ON c.id = o.challenge_id
        WHERE c.email = ${email} ORDER BY o.created_at
      `;
      expect(states.map((s) => s.state)).toEqual(["superseded", "pending"]);
      if (first !== second) {
        expect((await verify(email, first)).statusCode).toBe(401);
      }
      expect((await verify(email, second)).statusCode).toBe(200);
    });

    it("limits starts per address across IPs, the same for an address without an account", async () => {
      for (const email of [freshEmail("limited-known"), freshEmail("limited-unknown")]) {
        if (email.includes("known") && !email.includes("unknown")) await person(email);
        for (let i = 1; i <= 5; i++) expect((await start(email)).statusCode, `start ${i}`).toBe(202);
        const sixth = await start(email);
        expect(sixth.statusCode).toBe(429);
        expect(sixth.json().code).toBe("RATE_LIMITED");
      }
    });

    it("limits starts per IP across addresses", async () => {
      const ip = freshIp();
      for (let i = 1; i <= 20; i++) {
        expect((await start(freshEmail("ip"), ip)).statusCode, `start ${i}`).toBe(202);
      }
      expect((await start(freshEmail("ip"), ip)).statusCode).toBe(429);
      // Another IP is unaffected.
      expect((await start(freshEmail("ip"))).statusCode).toBe(202);
    });

    it("counts an IPv6 requester by its /64", async () => {
      const prefix = `2001:db8:${Math.floor(Math.random() * 0xffff).toString(16)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;
      for (let i = 1; i <= 20; i++) {
        expect((await start(freshEmail("v6"), `${prefix}::${i.toString(16)}`)).statusCode, `start ${i}`).toBe(202);
      }
      expect((await start(freshEmail("v6"), `${prefix}:ffff:ffff:ffff:ffff`)).statusCode).toBe(429);
    });

    it("limits code checks per address across codes and IPs", async () => {
      const email = freshEmail();
      await person(email);
      let checks = 0;
      let limited = false;
      for (let round = 0; round < 3 && !limited; round++) {
        await start(email);
        const code = await mailedCode(email);
        const wrong = code === "00000000" ? "11111111" : "00000000";
        for (let i = 0; i < 5; i++) {
          const response = await verify(email, wrong);
          checks++;
          if (response.statusCode === 429) {
            limited = true;
            break;
          }
        }
      }
      expect(limited).toBe(true);
      expect(checks).toBe(11);
    });
  });

  describe("the session boundary", () => {
    it("create_subject_session cannot mint an email_code session", async () => {
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
          SELECT core.create_subject_session(
            ${randomUUID()}, ${`h-${randomUUID()}`}, ${fx.stewardSubjectA}, 'email_code', NULL, 3600
          )
        `),
      ).rejects.toThrow();
    });

    it("no email_code session row exists without a challenge consumed in the same transaction", async () => {
      const email = freshEmail();
      const subjectId = await person(email);
      await start(email);
      const [challenge] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.email_challenges WHERE subject_id = ${subjectId}
      `;
      // Even the migration role cannot attach an unconsumed challenge.
      await expect(fx.sql`
        INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, expires_at, email_challenge_id)
        VALUES (${randomUUID()}, ${`h-${randomUUID()}`}, ${fx.tenantA}, ${subjectId}, 'email_code',
                now() + interval '1 hour', ${challenge!.id})
      `).rejects.toThrow();
    });

    it("the application role cannot write an address or read challenges and mail", async () => {
      const email = freshEmail();
      const subjectId = await person(email);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
          UPDATE core.subjects SET email = ${freshEmail("takeover")} WHERE id = ${subjectId}
        `),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
          INSERT INTO core.subjects (id, tenant_id, kind, display_name, email)
          VALUES (${randomUUID()}, ${fx.tenantA}, 'person', 'x', ${freshEmail("insert")})
        `),
      ).rejects.toThrow(/permission denied/);
      for (const table of ["email_challenges", "email_outbox", "email_test_sink", "auth_rate_events"]) {
        await expect(
          withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx.unsafe(`SELECT 1 FROM core.${table}`)),
          table,
        ).rejects.toThrow(/permission denied/);
      }
    });
  });

  describe("invitations", () => {
    async function invite(email: string, token: string, organizationId = fx.orgA) {
      return adminPost("/api/v1/admin/invitations", token, { email, organizationId });
    }

    async function invitationToken(email: string): Promise<string> {
      const [mail] = await fx.sql<{ params: { link: string } }[]>`
        SELECT params FROM core.email_outbox
        WHERE recipient = ${email} AND template = 'invitation_link' AND state = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `;
      const link = new URL(mail!.params.link);
      expect(link.pathname).toBe("/invitations/accept");
      // The token rides in the fragment, which the browser never sends anywhere.
      expect(link.search).toBe("");
      return new URLSearchParams(link.hash.slice(1)).get("token")!;
    }

    it("creates an account with no role and an aal1 session, once", async () => {
      const { token: adminToken, subjectId: inviter } = await admin();
      const email = freshEmail("invitee");
      const created = await invite(email, adminToken);
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({ email, organizationId: fx.orgA, state: "pending", invitedBySubjectId: inviter });

      const token = await invitationToken(email);
      const [stored] = await fx.sql<{ token_hash: string }[]>`
        SELECT token_hash FROM core.invitations WHERE email = ${email}
      `;
      expect(stored!.token_hash).not.toContain(token);

      expect((await post("/api/v1/auth/invitations/accept/start", { token })).statusCode).toBe(200);
      const code = await mailedCode(email, "invitation_code");
      const accepted = await post("/api/v1/auth/invitations/accept/verify", { token, code, displayName: "New Person" });
      expect(accepted.statusCode).toBe(200);
      const session = accepted.json();
      expect(session).toMatchObject({ firstFactor: "email_code", aal: "aal1" });

      const [subject] = await fx.sql<{ email: string; assurance_level: string; organization_id: string; tenant_id: string }[]>`
        SELECT email, assurance_level, organization_id, tenant_id FROM core.subjects WHERE id = ${session.subjectId}
      `;
      expect(subject).toEqual({ email, assurance_level: "wallet_only", organization_id: fx.orgA, tenant_id: fx.tenantA });
      expect(await fx.sql`SELECT 1 FROM core.role_bindings WHERE subject_id = ${session.subjectId}`).toHaveLength(0);

      // Used once.
      const reused = await post("/api/v1/auth/invitations/accept/start", { token });
      expect(reused.statusCode).toBe(404);
      expect(reused.json().code).toBe("INVITATION_INVALID");
    });

    it("refuses an address already in use with one generic answer, and audits it", async () => {
      const { token: adminToken } = await admin();
      const inTenant = freshEmail("taken");
      await person(inTenant);
      const elsewhere = freshEmail("taken-elsewhere");
      await person(elsewhere, fx.tenantB);

      const answers = [];
      for (const email of [inTenant, elsewhere]) {
        const response = await invite(email, adminToken);
        expect(response.statusCode).toBe(409);
        answers.push({ code: response.json().code, message: response.json().message });
      }
      expect(answers[0]).toEqual({ code: "INVITATION_EMAIL_UNAVAILABLE", message: answers[0]!.message });
      expect(answers[1]).toEqual(answers[0]);

      const refused = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events
        WHERE tenant_id = ${fx.tenantA} AND command = 'admin.invitation.refused'
      `;
      expect(refused.length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(refused)).not.toContain("@");

      // A second pending invitation for the same address is refused the same way.
      const pending = freshEmail("pending");
      expect((await invite(pending, adminToken)).statusCode).toBe(200);
      expect((await invite(pending, adminToken)).json().code).toBe("INVITATION_EMAIL_UNAVAILABLE");
    });

    it("cannot name another tenant's organisation", async () => {
      const { token: adminToken } = await admin();
      const response = await invite(freshEmail(), adminToken, fx.orgB);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ORGANIZATION_UNKNOWN");
    });

    it("stops working after 72 hours", async () => {
      const { token: adminToken } = await admin();
      const email = freshEmail("late");
      await invite(email, adminToken);
      const token = await invitationToken(email);
      await fx.sql`
        UPDATE core.invitations
        SET created_at = created_at - interval '73 hours', expires_at = expires_at - interval '73 hours'
        WHERE email = ${email}
      `;
      const response = await post("/api/v1/auth/invitations/accept/start", { token });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("INVITATION_INVALID");
    });

    it("revoking stops the link and any code already sent for it", async () => {
      const { token: adminToken } = await admin();
      const email = freshEmail("revoked");
      const created = (await invite(email, adminToken)).json();
      const token = await invitationToken(email);
      await post("/api/v1/auth/invitations/accept/start", { token });
      const code = await mailedCode(email, "invitation_code");

      const revoked = await adminPost(
        `/api/v1/admin/invitations/${created.id}/revoke`,
        adminToken,
        {},
        { "if-match": `"${created.version}"` },
      );
      expect(revoked.statusCode).toBe(200);
      expect(revoked.json().state).toBe("revoked");

      const verifyAfter = await post("/api/v1/auth/invitations/accept/verify", { token, code, displayName: "Too Late" });
      expect(verifyAfter.statusCode).toBe(404);
      expect(verifyAfter.json().code).toBe("INVITATION_INVALID");
      expect(await fx.sql`SELECT 1 FROM core.subjects WHERE email = ${email}`).toHaveLength(0);
    });

    it("an unknown token gets the same answer as a used one", async () => {
      const response = await post("/api/v1/auth/invitations/accept/start", { token: "A".repeat(43) });
      expect(response.statusCode).toBe(404);
      expect(response.json().code).toBe("INVITATION_INVALID");
    });

    it("needs an admin at aal3", async () => {
      const email = freshEmail();
      const subjectId = await person(email);
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, 'security_operator')
      `;
      await start(email);
      const { sessionToken } = (await verify(email, await mailedCode(email))).json();
      const response = await invite(freshEmail(), sessionToken);
      expect(response.statusCode).toBe(403);
    });
  });

  describe("two-person email change", () => {
    async function propose(token: string, subjectId: string, newEmail: string) {
      return adminPost("/api/v1/admin/email-changes", token, { subjectId, newEmail, reason: "Lost access to the mailbox" });
    }
    async function decide(token: string, change: { id: string; version: number }, decision: "approve" | "reject") {
      return adminPost(
        `/api/v1/admin/email-changes/${change.id}/decision`,
        token,
        { decision, reason: "Confirmed by phone" },
        { "if-match": `"${change.version}"` },
      );
    }

    it("takes a second admin and a code at the new address, then ends every session", async () => {
      const proposer = await admin("mpc_operator");
      const approver = await admin("security_operator");
      const oldEmail = freshEmail("old");
      const subjectId = await person(oldEmail);
      await start(oldEmail);
      const sessionBefore = (await verify(oldEmail, await mailedCode(oldEmail))).json().sessionToken;
      const newEmail = freshEmail("new");

      const proposed = await propose(proposer.token, subjectId, newEmail);
      expect(proposed.statusCode).toBe(200);
      const change = proposed.json();

      // The proposer cannot decide.
      const selfDecision = await decide(proposer.token, change, "approve");
      expect(selfDecision.statusCode).toBe(422);
      expect(selfDecision.json().code).toBe("EMAIL_CHANGE_SELF_APPROVAL");

      const approved = await decide(approver.token, change, "approve");
      expect(approved.statusCode).toBe(200);
      // Nothing changed yet: the new address must prove it is reachable.
      const [still] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${subjectId}`;
      expect(still!.email).toBe(oldEmail);

      const code = await mailedCode(newEmail, "email_change_code");
      const completed = await post("/api/v1/auth/email-change/verify", { email: newEmail, code });
      expect(completed.statusCode).toBe(200);

      const [after] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${subjectId}`;
      expect(after!.email).toBe(newEmail);
      const live = await fx.sql`
        SELECT 1 FROM core.sessions WHERE subject_id = ${subjectId} AND revoked_at IS NULL
      `;
      expect(live).toHaveLength(0);
      const sessionCheck = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(sessionBefore) });
      expect(sessionCheck.json().authenticated).toBe(false);

      // The old address is told.
      expect(
        await fx.sql`SELECT 1 FROM core.email_outbox WHERE recipient = ${oldEmail} AND template = 'email_changed_notice'`,
      ).toHaveLength(1);

      // Each step is audited, with hashes only.
      const commands = await fx.sql<{ command: string; detail: unknown }[]>`
        SELECT command, detail FROM audit.events
        WHERE tenant_id = ${fx.tenantA} AND (resource_id = ${change.id} OR command = 'auth.email_change.completed')
      `;
      const names = commands.map((c) => c.command);
      for (const step of ["admin.email_change.proposed", "admin.email_change.approved", "auth.email_change.completed"]) {
        expect(names).toContain(step);
      }
      expect(JSON.stringify(commands)).not.toContain(newEmail);
      expect(JSON.stringify(commands)).not.toContain(oldEmail);

      // The old address no longer signs in to this person: asking for a code queues no mail.
      const pendingToOld = () => fx.sql`
        SELECT 1 FROM core.email_outbox
        WHERE recipient = ${oldEmail} AND template = 'sign_in_code' AND state = 'pending'
      `;
      const before = (await pendingToOld()).length;
      expect((await start(oldEmail)).statusCode).toBe(202);
      expect(await pendingToOld()).toHaveLength(before);
    });

    it("the person whose address changes cannot decide it, and nobody proposes their own", async () => {
      const proposer = await admin("mpc_operator");
      const target = await admin("security_operator");
      // Only an address can be changed (0118); the admin fixture has none of its own.
      await fx.sql`UPDATE core.subjects SET email = ${freshEmail("target")} WHERE id = ${target.subjectId}`;
      const own = await propose(target.token, target.subjectId, freshEmail());
      expect(own.statusCode).toBe(422);
      expect(own.json().code).toBe("EMAIL_CHANGE_SELF");

      const change = (await propose(proposer.token, target.subjectId, freshEmail())).json();
      const decided = await decide(target.token, change, "approve");
      expect(decided.statusCode).toBe(422);
      expect(decided.json().code).toBe("EMAIL_CHANGE_SELF_TARGET");
    });

    it("a person without an address cannot be given one by an email change", async () => {
      const proposer = await admin("mpc_operator");
      const walletOnly = await admin("security_operator"); // the fixture has no address
      const res = await propose(proposer.token, walletOnly.subjectId, freshEmail("attach"));
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().code).toBe("EMAIL_CHANGE_NO_ADDRESS");
      expect(await fx.sql`SELECT 1 FROM core.email_change_requests WHERE subject_id = ${walletOnly.subjectId}`).toHaveLength(0);
    });

    it("a rejected change sends no code and changes nothing", async () => {
      const proposer = await admin("mpc_operator");
      const approver = await admin("security_operator");
      const email = freshEmail("keep");
      const subjectId = await person(email);
      const newEmail = freshEmail("rejected");
      const change = (await propose(proposer.token, subjectId, newEmail)).json();
      expect((await decide(approver.token, change, "reject")).statusCode).toBe(200);
      expect(await fx.sql`SELECT 1 FROM core.email_outbox WHERE recipient = ${newEmail}`).toHaveLength(0);
      const [after] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${subjectId}`;
      expect(after!.email).toBe(email);
    });

    it("lists this tenant's invitations and email changes to an admin", async () => {
      const proposer = await admin("mpc_operator");
      const subjectId = await person(freshEmail());
      const change = (await propose(proposer.token, subjectId, freshEmail("listed"))).json();
      const invited = (await adminPost("/api/v1/admin/invitations", proposer.token, { email: freshEmail("listed"), organizationId: fx.orgA })).json();

      const changes = await app.inject({ method: "GET", url: "/api/v1/admin/email-changes", headers: bearer(proposer.token) });
      expect(changes.statusCode).toBe(200);
      expect(changes.json().items.map((item: { id: string }) => item.id)).toContain(change.id);
      const invitations = await app.inject({ method: "GET", url: "/api/v1/admin/invitations", headers: bearer(proposer.token) });
      expect(invitations.statusCode).toBe(200);
      expect(invitations.json().items.map((item: { id: string }) => item.id)).toContain(invited.id);

      // A stale version is refused.
      const stale = await adminPost(
        `/api/v1/admin/email-changes/${change.id}/decision`,
        (await admin("security_operator")).token,
        { decision: "approve", reason: "Confirmed by phone" },
        { "if-match": `"${change.version + 1}"` },
      );
      expect(stale.statusCode).toBe(412);
    });

    it("refuses an address already in use, audited", async () => {
      const proposer = await admin("mpc_operator");
      const subjectId = await person(freshEmail());
      const taken = freshEmail("taken");
      await person(taken, fx.tenantB);
      const response = await propose(proposer.token, subjectId, taken);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("EMAIL_CHANGE_EMAIL_UNAVAILABLE");
    });
  });

  it("audit records about codes carry a keyed hash, never an address", async () => {
    const rows = await fx.sql<{ detail: unknown }[]>`
      SELECT detail FROM audit.events
      WHERE command LIKE 'auth.%' OR command LIKE 'admin.invitation.%' OR command LIKE 'admin.email_change.%'
    `;
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toMatch(/@example\.com/);
    expect(JSON.stringify(rows)).toMatch(/[0-9a-f]{64}/);
  });
});
