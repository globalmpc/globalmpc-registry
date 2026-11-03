import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { Secret } from "otpauth";
import { bootstrapOperator, BootstrapError } from "../src/bootstrap.js";
import { totpCodeAt } from "../src/services/mfa.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SoftAuthenticator } from "./helpers/webauthn.js";
import { hashToken } from "../src/plugins/session-token.js";
import { bearer, issueTestSession, newAccount, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Production bootstrap.
 *
 * Migrations only create the schema. Without a tenant, organization, person and role on top,
 * nobody can do anything in a deployed system, and nobody can invite the first person.
 * `apps/web/e2e/seed.ts` drops the schema and plants keys from the repo, so it cannot be used in
 * deployment.
 *
 * This test checks that the person bootstrap creates **signs in through the real emailed-code
 * path and gets their role** with a second factor. Checking only that rows exist misses the
 * "inserted but cannot sign in" state. Bootstrap binds no wallet (WP7): a signing key is bound by
 * its holder, by proof.
 */
describeDb("production bootstrap", () => {
  let fx: TestFixture;
  let app: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  const address = () => `First.Operator+${randomUUID().slice(0, 8)}@Example.COM`;

  function input(overrides: Record<string, unknown> = {}) {
    const suffix = randomUUID().slice(0, 8);
    return {
      tenantSlug: `bs-${suffix}`,
      tenantName: `Bootstrap ${suffix}`,
      organizationName: `Bootstrap Org ${suffix}`,
      jurisdiction: "MNG",
      subjectName: "First Operator",
      email: address(),
      role: "mpc_operator",
      assuranceLevel: "high_assurance",
      ...overrides,
    } as Parameters<typeof bootstrapOperator>[1];
  }

  async function signInByEmail(email: string): Promise<string> {
    const remoteAddress = `100.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.${1 + Math.floor(Math.random() * 254)}`;
    const start = await app.inject({ method: "POST", url: "/api/v1/auth/email/start", payload: { email }, remoteAddress });
    expect(start.statusCode).toBe(202);
    const [mail] = await fx.sql<{ params: { code: string } }[]>`
      SELECT params FROM core.email_outbox
      WHERE recipient = ${email.toLowerCase()} AND template = 'sign_in_code' AND state = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `;
    const verify = await app.inject({
      method: "POST",
      url: "/api/v1/auth/email/verify",
      payload: { email, code: mail!.params.code },
      remoteAddress,
    });
    expect(verify.statusCode).toBe(200);
    return verify.json().sessionToken as string;
  }

  it("a created person signs in by emailed code and, past a second factor, holds the role", async () => {
    const args = input();
    const result = await bootstrapOperator(fx.sql, args);
    expect(result).toMatchObject({ created: true, emailBound: true, roleGranted: true });

    const first = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: bearer(await signInByEmail(args.email)),
    });
    expect(first.json()).toMatchObject({ subjectId: result.subjectId, firstFactor: "email_code", aal: "aal1" });

    // The same person past a passkey: the role bootstrap granted is effective.
    const token = await issueTestSession(fx.appSql, result.tenantId, result.subjectId, {
      firstFactor: "email_code",
      secondFactor: "passkey",
    });
    const body = (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) })).json() as {
      tenantId: string;
      subjectId: string;
      assuranceLevel: string;
      roleBindings: { role: string; organizationId: string | null }[];
    };
    expect(body.tenantId).toBe(result.tenantId);
    expect(body.subjectId).toBe(result.subjectId);
    expect(body.assuranceLevel).toBe("high_assurance");
    expect(body.roleBindings).toEqual([
      { role: "mpc_operator", organizationId: result.organizationId, projectId: null },
    ]);
  });

  it("rerunning the same input keeps one tenant and one subject", async () => {
    const args = input();

    const first = await bootstrapOperator(fx.sql, args);
    const second = await bootstrapOperator(fx.sql, args);

    expect(second.created).toBe(false);
    expect(second.tenantId).toBe(first.tenantId);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.subjectId).toBe(first.subjectId);

    const rows = await fx.sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM core.role_bindings
      WHERE subject_id = ${first.subjectId} AND revoked_at IS NULL
    `;
    expect(rows[0]?.count).toBe("1");
  });

  it("rejects assurance below what the role requires", async () => {
    // mpc_operator requires high_assurance. With a lower value the row is inserted,
    // but every request gets 403 and the UI never shows why.
    await expect(
      bootstrapOperator(fx.sql, input({ assuranceLevel: "wallet_only" })),
    ).rejects.toThrow(BootstrapError);
  });

  it("refuses an existing role holder whose stored assurance is below the role minimum", async () => {
    const args = input();
    const first = await bootstrapOperator(fx.sql, args);
    await fx.sql`UPDATE core.subjects SET assurance_level = 'wallet_only', created_at = now() - interval '48 hours' WHERE id = ${first.subjectId}`;
    const state = () => fx.sql`
      SELECT row_to_json(s) AS subject,
        (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM core.role_bindings b WHERE b.subject_id = s.id) AS bindings,
        (SELECT count(*)::int FROM core.mfa_reset_requests WHERE subject_id = s.id) AS resets,
        (SELECT count(*)::int FROM audit.events WHERE tenant_id = s.tenant_id) AS audits
      FROM core.subjects s WHERE s.id = ${first.subjectId}
    `;
    const before = await state();
    // Input still says high_assurance. It must not mask the existing account's lower grade.
    await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(/stored assurance is insufficient/);
    expect(await state()).toEqual(before);
    await fx.sql`UPDATE core.subjects SET assurance_level = 'high_assurance' WHERE id = ${first.subjectId}`;
    expect(await bootstrapOperator(fx.sql, args)).toMatchObject({ subjectId: first.subjectId, created: false, roleGranted: false });
  });

  it("rejects an unknown role", async () => {
    await expect(bootstrapOperator(fx.sql, input({ role: "superuser" }))).rejects.toThrow(
      BootstrapError,
    );
  });

  describe("explicit legacy operator cutover", () => {
    async function legacy() {
      const args = input();
      const first = await bootstrapOperator(fx.sql, args);
      const walletId = randomUUID();
      const account = newAccount();
      await fx.sql`UPDATE core.subjects SET email = NULL, created_at = now() - interval '48 hours' WHERE id = ${first.subjectId}`;
      await fx.sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at)
        VALUES (${walletId}, ${first.tenantId}, ${first.subjectId}, ${account.address}, 31337, 'high_assurance', now())
      `;
      return { args: { ...args, subjectId: first.subjectId }, first, walletId };
    }

    const snapshot = (subjectId: string) => fx.sql`
      SELECT row_to_json(s) AS subject,
        (SELECT jsonb_agg(to_jsonb(b) ORDER BY b.id) FROM core.role_bindings b WHERE b.subject_id = s.id) AS bindings,
        (SELECT jsonb_agg(to_jsonb(w) ORDER BY w.id) FROM core.wallet_identities w WHERE w.subject_id = s.id) AS wallets,
        (SELECT count(*)::int FROM audit.events WHERE tenant_id = s.tenant_id) AS audits,
        (SELECT count(*)::int FROM core.mfa_reset_requests WHERE subject_id = s.id) AS resets
      FROM core.subjects s WHERE s.id = ${subjectId}
    `;

    it("initializes the selected legacy identity and preserves its bindings and signing history", async () => {
      const { args, first, walletId } = await legacy();
      // The signing key/session may already be disabled; initialization must not revive them.
      const oldToken = randomUUID();
      const [wallet] = await fx.sql<{ wallet_address: string }[]>`SELECT wallet_address FROM core.wallet_identities WHERE id = ${walletId}`;
      await fx.sql`INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, wallet_address, chain_id, expires_at, revoked_at, revoked_reason) VALUES (${randomUUID()}, ${hashToken(oldToken)}, ${first.tenantId}, ${first.subjectId}, 'siwe_legacy', ${wallet!.wallet_address}, 31337, now() + interval '1 hour', now(), 'legacy_wallet_login_removed')`;
      const historicalSessions = await fx.sql`SELECT * FROM core.sessions WHERE subject_id = ${first.subjectId}`;
      const [history] = await fx.sql`INSERT INTO audit.events (tenant_id, actor_subject_id, actor_wallet, effective_role, command, resource_type, resource_id, correlation_id) VALUES (${first.tenantId}, ${first.subjectId}, ${wallet!.wallet_address}, 'mpc_operator', 'fixture.legacy_action', 'subject', ${first.subjectId}, ${randomUUID()}) RETURNING *`;
      await fx.sql`UPDATE core.wallet_identities SET disabled_at = now() WHERE id = ${walletId}`;
      const [before] = await snapshot(first.subjectId);
      const result = await bootstrapOperator(fx.sql, args);
      expect(result).toMatchObject({ subjectId: first.subjectId, created: false, roleGranted: false, emailBound: true, enrolmentWindowOpened: true });
      const [after] = await snapshot(first.subjectId);
      expect(after!.bindings).toEqual(before!.bindings);
      expect(after!.wallets).toEqual(before!.wallets);
      expect(await fx.sql`SELECT * FROM core.sessions WHERE subject_id = ${first.subjectId}`).toEqual(historicalSessions);
      expect((await fx.sql`SELECT * FROM audit.events WHERE id = ${history!.id}`)[0]).toEqual(history);
      expect((await app.inject({ method: "GET", url: "/api/v1/admin/subjects", headers: bearer(oldToken) })).statusCode).toBe(401);
      const audit = await fx.sql`SELECT effective_role, actor_subject_id, detail FROM audit.events WHERE command = 'bootstrap.legacy_email.initialized' AND resource_id = ${first.subjectId}`;
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ effective_role: 'deploy_bound', actor_subject_id: null });
      expect(JSON.stringify(audit)).not.toContain(args.email.toLowerCase());
      expect(await bootstrapOperator(fx.sql, args)).toMatchObject({ emailBound: false, enrolmentWindowOpened: false, enrolmentWindowUntil: result.enrolmentWindowUntil });
      expect((await snapshot(first.subjectId))[0]).toEqual(after);
      const token = await signInByEmail(args.email);
      const setup = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/totp/setup", headers: bearer(token), payload: {} });
      expect(setup.statusCode, setup.body).toBe(200);
      const secret = new Uint8Array(Secret.fromBase32(setup.json().secret).bytes);
      const confirmed = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/totp/confirm", headers: bearer(token), payload: { code: totpCodeAt(secret, Math.floor(Date.now() / 30_000) * 30_000 + 1) } });
      expect(confirmed.statusCode, confirmed.body).toBe(200);
      const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
      expect(session.json()).toMatchObject({ subjectId: first.subjectId, firstFactor: "email_code", aal: "aal2" });
      const options = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/passkeys/registration/options", headers: bearer(token), payload: {} });
      expect(options.statusCode, options.body).toBe(200);
      const authenticator = new SoftAuthenticator({ origin: "http://localhost:3000", rpId: "localhost" });
      const passkey = await app.inject({ method: "POST", url: "/api/v1/auth/mfa/passkeys/registration/verify", headers: bearer(token), payload: { response: authenticator.register(options.json().options), name: "Operator passkey" } });
      expect(passkey.statusCode, passkey.body).toBe(200);
      const admin = await app.inject({ method: "GET", url: "/api/v1/admin/subjects", headers: bearer(token) });
      expect(admin.statusCode, admin.body).toBe(200);
      expect((await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) })).json()).toMatchObject({ subjectId: first.subjectId, aal: "aal3" });
      const [enrolled] = await snapshot(first.subjectId);
      expect(await bootstrapOperator(fx.sql, args)).toMatchObject({ emailBound: false, roleGranted: false, enrolmentWindowOpened: false });
      expect((await snapshot(first.subjectId))[0]).toEqual(enrolled);
    });

    it.each(["missing_subject", "wrong_tenant", "missing_tenant", "service", "suspended", "weak", "revoked_role", "wrong_role", "wrong_organization", "no_legacy_wallet", "different_email", "occupied_email"])("refuses %s without mutations", async (condition) => {
      const { args, first, walletId } = await legacy();
      let attempt = { ...args };
      if (condition === "missing_subject") attempt.subjectId = randomUUID();
      if (condition === "wrong_tenant") {
        const otherArgs = input();
        await bootstrapOperator(fx.sql, otherArgs);
        attempt.tenantSlug = otherArgs.tenantSlug;
      }
      if (condition === "missing_tenant") attempt.tenantSlug = "does-not-exist";
      if (condition === "service") await fx.sql`UPDATE core.subjects SET kind = 'service' WHERE id = ${first.subjectId}`;
      if (condition === "suspended") await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${first.subjectId}`;
      if (condition === "weak") await fx.sql`UPDATE core.subjects SET assurance_level = 'wallet_only' WHERE id = ${first.subjectId}`;
      if (condition === "revoked_role") await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${first.subjectId}`;
      if (condition === "wrong_role") attempt.role = "reviewer_cp_qp";
      if (condition === "wrong_organization") attempt.organizationName = "A different organization";
      if (condition === "no_legacy_wallet") await fx.sql`UPDATE core.wallet_identities SET bound_via = 'proof' WHERE id = ${walletId}`;
      if (condition === "different_email") await fx.sql`UPDATE core.subjects SET email = ${address().toLowerCase()} WHERE id = ${first.subjectId}`;
      if (condition === "occupied_email") {
        const other = await bootstrapOperator(fx.sql, input());
        await fx.sql`UPDATE core.subjects SET email = ${args.email.toLowerCase()} WHERE id = ${other.subjectId}`;
      }
      const [before] = await snapshot(first.subjectId);
      await expect(bootstrapOperator(fx.sql, attempt)).rejects.toThrow(BootstrapError);
      expect((await snapshot(first.subjectId))[0]).toEqual(before);
    });

    it.each(["session", "provider", "passkey", "totp", "recovery", "email_change"])("refuses retained %s account history even when revoked", async (history) => {
      const { args, first } = await legacy();
      if (history === "session") {
        await issueTestSession(fx.appSql, first.tenantId, first.subjectId, { firstFactor: "email_code" });
        await fx.sql`UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'logout' WHERE subject_id = ${first.subjectId}`;
      } else if (history === "provider") {
        await issueTestSession(fx.appSql, first.tenantId, first.subjectId, { firstFactor: "google" });
        await fx.sql`DELETE FROM core.sessions WHERE subject_id = ${first.subjectId}`;
        await fx.sql`UPDATE core.external_identities SET revoked_at = now(), revoked_reason = 'unlinked_by_holder' WHERE subject_id = ${first.subjectId}`;
      } else if (history === "passkey") {
        await fx.sql`INSERT INTO core.webauthn_credentials (id, tenant_id, subject_id, credential_id, public_key, aaguid, user_verified, device_type, backed_up, name, revoked_at, revoked_reason) VALUES (${randomUUID()}, ${first.tenantId}, ${first.subjectId}, ${randomUUID().replaceAll('-', '')}, ${Buffer.alloc(32)}, ${randomUUID()}, true, 'singleDevice', false, 'Old key', now(), 'holder_removed')`;
      } else if (history === "totp") {
        await fx.sql`INSERT INTO core.totp_authenticators (id, tenant_id, subject_id, secret_ciphertext, secret_nonce, pending_expires_at, revoked_at, revoked_reason) VALUES (${randomUUID()}, ${first.tenantId}, ${first.subjectId}, ${Buffer.alloc(36)}, ${Buffer.alloc(12)}, now(), now(), 'holder_removed')`;
      } else if (history === "recovery") {
        await fx.sql`INSERT INTO core.recovery_codes (id, tenant_id, subject_id, set_id, code_hash, voided_at) VALUES (${randomUUID()}, ${first.tenantId}, ${first.subjectId}, ${randomUUID()}, ${'a'.repeat(64)}, now())`;
      } else {
        const requester = randomUUID();
        await fx.sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${requester}, ${first.tenantId}, 'person', 'Requester')`;
        await fx.sql`INSERT INTO core.email_change_requests (id, tenant_id, subject_id, new_email, reason, requested_by_subject_id) VALUES (${randomUUID()}, ${first.tenantId}, ${first.subjectId}, ${address().toLowerCase()}, 'Old recovery', ${requester})`;
      }
      await fx.sql`UPDATE core.subjects SET email = NULL WHERE id = ${first.subjectId}`;
      const [before] = await snapshot(first.subjectId);
      await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(/account or recovery history/);
      expect((await snapshot(first.subjectId))[0]).toEqual(before);
    });

    it("refuses an address moved off another person", async () => {
      const { args, first } = await legacy();
      const ids = [randomUUID(), randomUUID(), randomUUID()];
      await fx.sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${ids[0]!}, ${first.tenantId}, 'person', 'Previous holder'), (${ids[1]!}, ${first.tenantId}, 'person', 'Requester'), (${ids[2]!}, ${first.tenantId}, 'person', 'Approver')`;
      await fx.sql`
        INSERT INTO core.email_change_requests (id, tenant_id, subject_id, new_email, reason, requested_by_subject_id, state, decided_by_subject_id, decided_at, decision_reason, completed_at, previous_email)
        VALUES (${randomUUID()}, ${first.tenantId}, ${ids[0]!}, ${address().toLowerCase()}, 'Address changed', ${ids[1]!}, 'completed', ${ids[2]!}, now(), 'Confirmed', now(), ${args.email.toLowerCase()})
      `;
      const [before] = await snapshot(first.subjectId);
      await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(/moved off a person/);
      expect((await snapshot(first.subjectId))[0]).toEqual(before);
    });

    it("rolls email initialization back when auditing fails", async () => {
      const { args, first } = await legacy();
      const [before] = await snapshot(first.subjectId);
      await fx.sql.unsafe(`CREATE FUNCTION audit.test_refuse_legacy_email() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.command = 'bootstrap.legacy_email.initialized' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`);
      await fx.sql`CREATE TRIGGER test_refuse_legacy_email BEFORE INSERT ON audit.events FOR EACH ROW EXECUTE FUNCTION audit.test_refuse_legacy_email()`;
      try {
        await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(/test audit unavailable/);
        expect((await snapshot(first.subjectId))[0]).toEqual(before);
      } finally {
        await fx.sql`DROP TRIGGER test_refuse_legacy_email ON audit.events`;
        await fx.sql`DROP FUNCTION audit.test_refuse_legacy_email()`;
      }
    });

    it("does not renew an expired window or repeat initialization after account-history cleanup", async () => {
      const { args, first } = await legacy();
      await bootstrapOperator(fx.sql, args);
      // Simulate retention cleanup after the first enrolment window has passed. The immutable
      // initialization audit remains authoritative even when transient account rows are gone.
      await fx.sql`DELETE FROM core.mfa_reset_requests WHERE subject_id = ${first.subjectId}`;
      const [before] = await snapshot(first.subjectId);
      expect(await bootstrapOperator(fx.sql, args)).toMatchObject({ emailBound: false, enrolmentWindowOpened: false, enrolmentWindowUntil: null });
      expect((await snapshot(first.subjectId))[0]).toEqual(before);
      await fx.sql`UPDATE core.subjects SET email = NULL WHERE id = ${first.subjectId}`;
      const [cleared] = await snapshot(first.subjectId);
      await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(/account or recovery history/);
      expect((await snapshot(first.subjectId))[0]).toEqual(cleared);
    });

    it.each(["closed_reset", "later_suspension"])("does not report a window invalidated by %s", async (reason) => {
      const { args, first } = await legacy();
      await bootstrapOperator(fx.sql, args);
      const requester = randomUUID();
      const decider = randomUUID();
      await fx.sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${requester}, ${first.tenantId}, 'person', 'Requester'), (${decider}, ${first.tenantId}, 'person', 'Approver')`;
      if (reason === "closed_reset") {
        await fx.sql`DELETE FROM core.mfa_reset_requests WHERE subject_id = ${first.subjectId}`;
        await fx.sql`INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id, state, decided_by_subject_id, decided_at, enrolment_window_until) VALUES (${randomUUID()}, ${first.tenantId}, ${first.subjectId}, 'Historical reset', ${requester}, 'approved', ${decider}, now(), now() + interval '24 hours')`;
        await fx.sql`UPDATE core.mfa_reset_requests SET closed_reason = 'approver_suspended' WHERE subject_id = ${first.subjectId}`;
      } else {
        await fx.sql`INSERT INTO core.subject_suspensions (id, tenant_id, subject_id, action, reason, requested_by_subject_id, state, decided_by_subject_id, decided_at) VALUES (${randomUUID()}, ${first.tenantId}, ${first.subjectId}, 'suspend', 'Historical suspension', ${requester}, 'approved', ${decider}, now())`;
      }
      const [before] = await snapshot(first.subjectId);
      expect(await bootstrapOperator(fx.sql, args)).toMatchObject({ enrolmentWindowOpened: false, enrolmentWindowUntil: null });
      expect((await snapshot(first.subjectId))[0]).toEqual(before);
    });

    it("rejects malformed stable subject IDs before database writes", async () => {
      await expect(bootstrapOperator(fx.sql, input({ subjectId: "not-a-uuid" }))).rejects.toThrow(/subjectId must be a UUID/);
    });
  });

  describe("email (WP2)", () => {
    it("creates a person with only an email and binds no wallet", async () => {
      const email = address();
      const args = input({ email });
      const result = await bootstrapOperator(fx.sql, args);
      expect(result).toMatchObject({ created: true, emailBound: true, roleGranted: true });

      const [subject] = await fx.sql<{ email: string; organization_id: string }[]>`
        SELECT email, organization_id FROM core.subjects WHERE id = ${result.subjectId}
      `;
      expect(subject).toEqual({ email: email.toLowerCase(), organization_id: result.organizationId });
      expect(await fx.sql`SELECT 1 FROM core.wallet_identities WHERE subject_id = ${result.subjectId}`).toHaveLength(0);

      const token = await signInByEmail(email);
      const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
      expect(session.json()).toMatchObject({ subjectId: result.subjectId, firstFactor: "email_code", aal: "aal1" });

      // Rerunning is a no-op.
      const again = await bootstrapOperator(fx.sql, args);
      expect(again).toMatchObject({ subjectId: result.subjectId, created: false, emailBound: false, roleGranted: false });
    });

    it("reopens the first-enrolment window for a person past 24 hours with no factor, never once one exists", async () => {
      const email = address();
      const args = input({ email });
      const first = await bootstrapOperator(fx.sql, args);
      // Just created: the creation window is the one that counts, nothing is recorded.
      expect(first.enrolmentWindowOpened).toBe(false);
      expect(first.enrolmentWindowUntil!.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);

      // The operator missed it.
      await fx.sql`UPDATE core.subjects SET created_at = now() - interval '48 hours' WHERE id = ${first.subjectId}`;
      const token = await signInByEmail(email);
      const mfaPost = (url: string, payload: unknown = {}) =>
        app.inject({ method: "POST", url, headers: bearer(token), payload: payload as object });
      const closed = await mfaPost("/api/v1/auth/mfa/totp/setup");
      expect(closed.statusCode).toBe(403);
      expect(closed.json().code).toBe("MFA_ENROLMENT_WINDOW_CLOSED");

      // A re-run opens a fresh 24 hours, audited as the deploy runner's act.
      const rerun = await bootstrapOperator(fx.sql, args);
      expect(rerun).toMatchObject({ subjectId: first.subjectId, created: false, enrolmentWindowOpened: true });
      expect(rerun.enrolmentWindowUntil!.getTime() - Date.now()).toBeGreaterThan(23 * 3600_000);
      const [audit] = await fx.sql<{ effective_role: string; actor_subject_id: string | null }[]>`
        SELECT effective_role, actor_subject_id FROM audit.events
        WHERE command = 'bootstrap.mfa_enrolment_window.opened' AND detail->>'subjectId' = ${first.subjectId}
      `;
      expect(audit).toEqual({ effective_role: "deploy_bound", actor_subject_id: null });

      // Another re-run while it is open records nothing new.
      const again = await bootstrapOperator(fx.sql, args);
      expect(again.enrolmentWindowOpened).toBe(false);
      expect(again.enrolmentWindowUntil).toEqual(rerun.enrolmentWindowUntil);
      const rows = await fx.sql`SELECT origin FROM core.mfa_reset_requests WHERE subject_id = ${first.subjectId}`;
      expect(rows).toEqual([{ origin: "bootstrap" }]);

      // The operator enrols an authenticator app in the window.
      const setup = await mfaPost("/api/v1/auth/mfa/totp/setup");
      expect(setup.statusCode, setup.body).toBe(200);
      const secret = new Uint8Array(Secret.fromBase32(setup.json().secret).bytes);
      const step = Math.floor(Date.now() / 30_000);
      const confirmed = await mfaPost("/api/v1/auth/mfa/totp/confirm", { code: totpCodeAt(secret, step * 30_000 + 1) });
      expect(confirmed.statusCode, confirmed.body).toBe(200);

      // With a factor held, a re-run opens nothing and leaves the factor alone.
      const held = await bootstrapOperator(fx.sql, args);
      expect(held).toMatchObject({ enrolmentWindowOpened: false, enrolmentWindowUntil: null });
      const factors = await fx.sql`
        SELECT 1 FROM core.totp_authenticators
        WHERE subject_id = ${first.subjectId} AND confirmed_at IS NOT NULL AND revoked_at IS NULL
      `;
      expect(factors).toHaveLength(1);
    });

    it("refuses an address already on a person in another tenant", async () => {
      const email = address();
      await bootstrapOperator(fx.sql, input({ email }));
      const other = input({ email });
      await expect(bootstrapOperator(fx.sql, other)).rejects.toThrow(/another tenant/);
      // Stopped before creating the tenant.
      expect(await fx.sql`SELECT 1 FROM core.tenants WHERE slug = ${other.tenantSlug}`).toHaveLength(0);
    });

    it("needs an email, and does not echo a malformed address", async () => {
      for (const email of [undefined, null, "", "  "]) {
        await expect(bootstrapOperator(fx.sql, input({ email })), String(email)).rejects.toThrow(/email is required/);
      }
      const attempt = bootstrapOperator(fx.sql, input({ email: "secret-person@@example.com" }));
      await expect(attempt).rejects.toThrow(/not one email address/);
      await expect(attempt).rejects.not.toThrow(/secret-person/);
    });
  });

  /**
   * The migration task runs bootstrap on every deploy while `BOOTSTRAP_EMAIL` is set, so a re-run
   * must never undo what two people decided after the first one.
   */
  describe("re-run on every deploy", () => {
    const liveBindings = (subjectId: string) => fx.sql<{ role: string }[]>`
      SELECT role FROM core.role_bindings WHERE subject_id = ${subjectId} AND revoked_at IS NULL
    `;
    const resets = (subjectId: string) => fx.sql`
      SELECT 1 FROM core.mfa_reset_requests WHERE subject_id = ${subjectId}
    `;

    it("does not grant a revoked role again, under any organization name, and writes nothing", async () => {
      const args = input();
      const first = await bootstrapOperator(fx.sql, args);
      // A two-person revocation (or a break-glass quarantine) ended the binding.
      await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${first.subjectId}`;

      await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(
        /mpc_operator binding was revoked\. Bootstrap does not grant it again/,
      );
      const renamed = { ...args, organizationName: `${args.organizationName} (renamed)` };
      await expect(bootstrapOperator(fx.sql, renamed)).rejects.toThrow(BootstrapError);
      expect(await liveBindings(first.subjectId)).toHaveLength(0);
      // The refused run rolled back whole: not even the new organization stays.
      expect(await fx.sql`SELECT 1 FROM core.organizations WHERE legal_name = ${renamed.organizationName}`).toHaveLength(0);

      // An admin granting it again (through the API) is what brings it back; the next deploy is a no-op.
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${first.tenantId}, ${first.subjectId}, ${first.organizationId}, 'mpc_operator')
      `;
      expect(await bootstrapOperator(fx.sql, args)).toMatchObject({ created: false, roleGranted: false });
    });

    it("opens no window for, and grants nothing to, a suspended person", async () => {
      const args = input();
      const first = await bootstrapOperator(fx.sql, args);
      // Past the creation window, with no factor (a suspension revokes them): the window function
      // alone would open one.
      await fx.sql`
        UPDATE core.subjects SET created_at = now() - interval '48 hours', suspended_at = now()
        WHERE id = ${first.subjectId}
      `;
      await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${first.subjectId}`;

      await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(/This person is suspended/);
      expect(await resets(first.subjectId)).toHaveLength(0);
      expect(await liveBindings(first.subjectId)).toHaveLength(0);
      expect(
        await fx.sql`SELECT 1 FROM audit.events WHERE command = 'bootstrap.mfa_enrolment_window.opened' AND detail->>'subjectId' = ${first.subjectId}`,
      ).toHaveLength(0);

      // Even with the role still bound, a suspended person gets no window.
      const kept = input();
      const held = await bootstrapOperator(fx.sql, kept);
      await fx.sql`
        UPDATE core.subjects SET created_at = now() - interval '48 hours', suspended_at = now()
        WHERE id = ${held.subjectId}
      `;
      await expect(bootstrapOperator(fx.sql, kept)).rejects.toThrow(/suspended/);
      expect(await resets(held.subjectId)).toHaveLength(0);
    });

    describe("creates only the first holder of the role", () => {
      const tenantCounts = (tenantId: string) => fx.sql<{ subjects: number; bindings: number; resets: number; audits: number }[]>`
        SELECT
          (SELECT count(*)::int FROM core.subjects WHERE tenant_id = ${tenantId}) AS subjects,
          (SELECT count(*)::int FROM core.role_bindings WHERE tenant_id = ${tenantId}) AS bindings,
          (SELECT count(*)::int FROM core.mfa_reset_requests WHERE tenant_id = ${tenantId}) AS resets,
          (SELECT count(*)::int FROM audit.events WHERE tenant_id = ${tenantId}) AS audits
      `;

      /** The two-person email change, completed: the operator now signs in at `next`. */
      async function moveAddress(first: { tenantId: string; subjectId: string }, previous: string, next: string) {
        const [a, b] = [randomUUID(), randomUUID()];
        await fx.sql`
          INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
          VALUES (${a}, ${first.tenantId}, 'person', 'Requester', 'wallet_only'),
                 (${b}, ${first.tenantId}, 'person', 'Approver', 'wallet_only')
        `;
        await fx.sql`UPDATE core.subjects SET email = ${next.toLowerCase()} WHERE id = ${first.subjectId}`;
        await fx.sql`
          INSERT INTO core.email_change_requests (
            id, tenant_id, subject_id, new_email, reason, requested_by_subject_id, state,
            decided_by_subject_id, decided_at, decision_reason, completed_at, previous_email
          ) VALUES (
            ${randomUUID()}, ${first.tenantId}, ${first.subjectId}, ${next.toLowerCase()}, 'mailbox moved', ${a},
            'completed', ${b}, now(), 'checked by phone', now(), ${previous.toLowerCase()}
          )
        `;
      }

      it("refuses the operator's old address after an email change, with the role live or revoked, and writes nothing", async () => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        const next = address();
        await moveAddress(first, args.email, next);
        const [before] = await tenantCounts(first.tenantId);

        // The deploy still names the old address: nobody holds it now.
        await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(
          /moved off a person in this tenant by a completed email change.*Remove BOOTSTRAP_EMAIL/,
        );
        // Revoking the role does not reopen the door.
        await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${first.subjectId}`;
        await expect(bootstrapOperator(fx.sql, args)).rejects.toThrow(BootstrapError);
        expect((await tenantCounts(first.tenantId))[0]).toEqual(before);
        expect(await fx.sql`SELECT 1 FROM core.subjects WHERE email = ${args.email.toLowerCase()}`).toHaveLength(0);
      });

      it("refuses a moved address even for a role the tenant never had (within the 90 days it is kept)", async () => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        await moveAddress(first, args.email, address());
        const [before] = await tenantCounts(first.tenantId);

        // Nobody in the tenant ever held reviewer_cp_qp, so only the moved-address rule refuses.
        await expect(
          bootstrapOperator(fx.sql, { ...args, role: "reviewer_cp_qp", subjectName: "Old Mailbox" }),
        ).rejects.toThrow(/moved off a person in this tenant by a completed email change/);
        expect((await tenantCounts(first.tenantId))[0]).toEqual(before);
        expect(await fx.sql`SELECT 1 FROM core.subjects WHERE email = ${args.email.toLowerCase()}`).toHaveLength(0);
      });

      it("refuses a new address once anyone in the tenant held the role, revoked included, and writes nothing", async () => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        const other = { ...args, email: address() };
        const [before] = await tenantCounts(first.tenantId);

        await expect(bootstrapOperator(fx.sql, other)).rejects.toThrow(
          /already has \(or had\) a mpc_operator.*Remove BOOTSTRAP_EMAIL/,
        );
        await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${first.subjectId}`;
        await expect(bootstrapOperator(fx.sql, other)).rejects.toThrow(/already has \(or had\)/);
        expect((await tenantCounts(first.tenantId))[0]).toEqual(before);
        expect(await fx.sql`SELECT 1 FROM core.subjects WHERE email = ${other.email.toLowerCase()}`).toHaveLength(0);
      });

      it.each(["mpc_operator", "reviewer_cp_qp"])("refuses a reused moved address on an existing account for %s", async (role) => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        await moveAddress(first, args.email, address());
        const replacementId = randomUUID();
        await fx.sql`
          INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level, email)
          VALUES (${replacementId}, ${first.tenantId}, 'person', 'New mailbox holder', 'high_assurance', ${args.email.toLowerCase()})
        `;
        const [before] = await tenantCounts(first.tenantId);
        await expect(bootstrapOperator(fx.sql, { ...args, role })).rejects.toThrow(
          /moved off a person in this tenant by a completed email change/,
        );
        expect((await tenantCounts(first.tenantId))[0]).toEqual(before);
        expect(await fx.sql`SELECT 1 FROM core.role_bindings WHERE subject_id = ${replacementId}`).toHaveLength(0);
      });

      it.each([false, true])("refuses a pre-existing different account once the role was held (revoked: %s)", async (revoked) => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        const email = address().toLowerCase();
        const otherId = randomUUID();
        await fx.sql`
          INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level, email)
          VALUES (${otherId}, ${first.tenantId}, 'person', 'Existing account', 'high_assurance', ${email})
        `;
        if (revoked) await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${first.subjectId}`;
        const [before] = await tenantCounts(first.tenantId);
        await expect(bootstrapOperator(fx.sql, { ...args, email })).rejects.toThrow(/already has \(or had\) a mpc_operator/);
        expect((await tenantCounts(first.tenantId))[0]).toEqual(before);
        expect(await fx.sql`SELECT 1 FROM core.role_bindings WHERE subject_id = ${otherId}`).toHaveLength(0);
      });

      it("concurrent bootstrap calls cannot both create the first role holder", async () => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        const role = "reviewer_cp_qp";
        let pending!: Promise<PromiseSettledResult<Awaited<ReturnType<typeof bootstrapOperator>>>[]>;
        await fx.sql.begin(async (hold) => {
          // Both calls must reach a blocking boundary before either can commit a grant.
          // Without tenant serialization, both read no holder and wait to insert here.
          await hold`LOCK TABLE core.role_bindings IN SHARE MODE`;
          pending = Promise.allSettled([
            bootstrapOperator(fx.sql, { ...args, role, email: address() }),
            bootstrapOperator(fx.sql, { ...args, role, email: address() }),
          ]);
          for (let attempt = 0; attempt < 200; attempt += 1) {
            await hold`SELECT pg_stat_clear_snapshot()`;
            const [blocked] = await hold<{ count: number }[]>`
              SELECT count(*)::int AS count FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND pid <> pg_backend_pid()
            `;
            if (blocked!.count >= 2) return;
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("Both bootstrap transactions never reached the lock boundary");
        });
        const attempts = await pending;
        expect(attempts.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        const rejected = attempts.find((result) => result.status === "rejected") as PromiseRejectedResult;
        expect(rejected.reason).toBeInstanceOf(BootstrapError);
        expect(rejected.reason.message).toMatch(/already has \(or had\)/);
        expect(await fx.sql`SELECT 1 FROM core.role_bindings WHERE tenant_id = ${first.tenantId} AND role = ${role}`).toHaveLength(1);
      });

      it("can create the first binding for an existing account when the role was never held", async () => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        expect(await bootstrapOperator(fx.sql, { ...args, role: "reviewer_cp_qp" })).toMatchObject({
          subjectId: first.subjectId, created: false, roleGranted: true,
        });
      });

      it("still creates the first holder, and the current address stays a no-op", async () => {
        const args = input();
        const first = await bootstrapOperator(fx.sql, args);
        expect(first).toMatchObject({ created: true, roleGranted: true });
        expect(await bootstrapOperator(fx.sql, args)).toMatchObject({
          subjectId: first.subjectId,
          created: false,
          roleGranted: false,
        });
        // After the move, the deploy naming the new address finds the same person.
        const next = address();
        await moveAddress(first, args.email, next);
        expect(await bootstrapOperator(fx.sql, { ...args, email: next })).toMatchObject({
          subjectId: first.subjectId,
          created: false,
          roleGranted: false,
        });
      });
    });

    it("re-runs with the same input change nothing once the operator holds a factor", async () => {
      const args = input();
      const first = await bootstrapOperator(fx.sql, args);
      await fx.sql`UPDATE core.subjects SET created_at = now() - interval '48 hours' WHERE id = ${first.subjectId}`;
      await fx.sql`
        INSERT INTO core.totp_authenticators (
          id, tenant_id, subject_id, secret_ciphertext, secret_nonce, pending_expires_at, confirmed_at
        ) VALUES (
          ${randomUUID()}, ${first.tenantId}, ${first.subjectId}, ${Buffer.alloc(36)}, ${Buffer.alloc(12)},
          now() + interval '10 minutes', now()
        )
      `;
      const counts = () => fx.sql<{ tenants: number; orgs: number; subjects: number; bindings: number; resets: number; audits: number }[]>`
        SELECT
          (SELECT count(*)::int FROM core.tenants WHERE slug = ${args.tenantSlug}) AS tenants,
          (SELECT count(*)::int FROM core.organizations WHERE tenant_id = ${first.tenantId}) AS orgs,
          (SELECT count(*)::int FROM core.subjects WHERE tenant_id = ${first.tenantId}) AS subjects,
          (SELECT count(*)::int FROM core.role_bindings WHERE tenant_id = ${first.tenantId}) AS bindings,
          (SELECT count(*)::int FROM core.mfa_reset_requests WHERE subject_id = ${first.subjectId}) AS resets,
          (SELECT count(*)::int FROM audit.events WHERE tenant_id = ${first.tenantId}) AS audits
      `;
      const [before] = await counts();
      for (let run = 0; run < 3; run += 1) {
        expect(await bootstrapOperator(fx.sql, args)).toMatchObject({
          subjectId: first.subjectId,
          created: false,
          emailBound: false,
          roleGranted: false,
          enrolmentWindowOpened: false,
          enrolmentWindowUntil: null,
        });
      }
      expect((await counts())[0]).toEqual(before);
      expect(before).toMatchObject({ tenants: 1, orgs: 1, subjects: 1, bindings: 1, resets: 0 });
    });
  });

  it("adds a second role in the same tenant as a separate subject", async () => {
    const args = input();
    const first = await bootstrapOperator(fx.sql, args);

    const second = await bootstrapOperator(fx.sql, {
      ...args,
      subjectName: "First Reviewer",
      email: address(),
      role: "reviewer_cp_qp",
    });

    expect(second.tenantId).toBe(first.tenantId);
    expect(second.organizationId).toBe(first.organizationId);
    expect(second.subjectId).not.toBe(first.subjectId);

    const token = await issueTestSession(fx.appSql, second.tenantId, second.subjectId, {
      firstFactor: "email_code",
      secondFactor: "passkey",
    });
    const session = await app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: bearer(token),
    });
    const body = session.json() as { roleBindings: { role: string }[] };
    expect(body.roleBindings.map((binding) => binding.role)).toEqual(["reviewer_cp_qp"]);
  });
});
