import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { Secret } from "otpauth";
import { withTenant } from "@mpc/db";
import * as auditModule from "../src/audit.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { hashRecoveryCode, normalizeRecoveryCode, totpCodeAt } from "../src/services/mfa.js";
import { revokeSubjectSessions } from "../src/plugins/session-token.js";
import { bearer, idempotencyKey, issueTestSession, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";
import { SoftAuthenticator, strayChallenge } from "./helpers/webauthn.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Second factors — WP3 of account authentication (plan journeys 2–6, threat model T10).
 *
 * Every ceremony here is real: passkeys are a software ES256 authenticator verified by
 * `@simplewebauthn/server`, TOTP codes are computed from the secret the setup returned. What the
 * tests hold:
 *
 * - a factor is recorded only by consuming evidence: a WebAuthn assertion over a live challenge of
 *   this session (wrong origin, RP ID, challenge, missing UV, replay and counter regression are
 *   refused), or a TOTP step later than the last one, within ±1 step, under a 5-per-15-minutes
 *   lockout;
 * - first enrolment is open to a first-factor session only within 24 hours of account creation or
 *   of an approved admin reset, and never once a factor exists; a second passkey needs a passkey;
 * - removing a factor ends the other sessions and never removes the last one;
 * - a recovery code works once, ends every other session, and leaves its session limited to
 *   re-enrolment; proving a factor from it ends every session, that one included;
 * - an admin reset takes two people, neither of them the person reset;
 * - the database refuses a factor without a proof, even to the table owner; it cannot check a
 *   signature or a code, so what it guarantees to a caller that skips the API is single use,
 *   session binding and the enrolment rules.
 */
describeDb("second factors (WP3)", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
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

  // --- helpers -----------------------------------------------------------------------------------

  /** A new person in tenant A, optionally holding a role and created `ageHours` ago. */
  async function person(options: { role?: string; ageHours?: number } = {}): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level, created_at)
      VALUES (
        ${id}, ${fx.tenantA}, 'person', ${`Person ${id.slice(0, 8)}`}, 'high_assurance',
        now() - make_interval(hours => ${options.ageHours ?? 0})
      )
    `;
    if (options.role) {
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${id}, ${fx.orgA}, ${options.role})
      `;
    }
    return id;
  }

  const login = (subjectId: string) => issueTestSession(fx.appSql, fx.tenantA, subjectId, { firstFactor: "email_code" });

  const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: bearer(token) });
  const post = (url: string, token: string, payload: unknown = {}, headers: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...bearer(token), ...headers }, payload: payload as object });
  const session = async (token: string) => (await get("/api/v1/auth/session", token)).json();
  /** Whether the token still resolves to a session. */
  const alive = async (token: string) => (await get("/api/v1/auth/mfa", token)).statusCode !== 401;

  const authenticator = (countFrom?: number | null) =>
    new SoftAuthenticator({ origin: ORIGIN, rpId: RP_ID }, countFrom === undefined ? {} : { countFrom });

  async function registrationOptions(token: string) {
    const res = await post("/api/v1/auth/mfa/passkeys/registration/options", token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().options;
  }

  async function enrolPasskey(token: string, key: SoftAuthenticator) {
    const options = await registrationOptions(token);
    const res = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, {
      response: key.register(options),
      name: "Laptop",
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  async function authenticationOptions(token: string) {
    const res = await post("/api/v1/auth/mfa/passkeys/authentication/options", token);
    expect(res.statusCode, res.body).toBe(200);
    return res.json().options;
  }

  const verifyAssertion = (token: string, response: unknown) =>
    post("/api/v1/auth/mfa/passkeys/authentication/verify", token, { response });

  async function stepUp(token: string, key: SoftAuthenticator) {
    const res = await verifyAssertion(token, key.assert(await authenticationOptions(token)));
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  }

  const STEP_MS = 30_000;
  const currentStep = () => Math.floor(Date.now() / STEP_MS);
  const codeFor = (secret: Uint8Array, step: number) => totpCodeAt(secret, step * STEP_MS + 1);

  /** Starts a TOTP setup and returns the secret bytes the app would hold. */
  async function totpSetup(token: string): Promise<Uint8Array> {
    const res = await post("/api/v1/auth/mfa/totp/setup", token);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json();
    expect(body.otpauthUri).toMatch(/^otpauth:\/\/totp\//);
    expect(res.headers["cache-control"]).toBe("no-store");
    return new Uint8Array(Secret.fromBase32(body.secret).bytes);
  }

  async function enrolTotp(token: string, step = currentStep()) {
    const secret = await totpSetup(token);
    const res = await post("/api/v1/auth/mfa/totp/confirm", token, { code: codeFor(secret, step) });
    expect(res.statusCode, res.body).toBe(200);
    return { secret, body: res.json() };
  }

  describe("atomic success auditing", () => {
    // Fail only the success audit; the refusal audit must still be able to commit.
    async function failingAudit(command: string, action: () => Promise<void>) {
      const original = auditModule.recordAudit;
      const spy = vi.spyOn(auditModule, "recordAudit").mockImplementation(async (tx, event) => {
        if (event.command === command) throw new Error("injected success audit failure");
        return original(tx, event);
      });
      try {
        await action();
      } finally {
        spy.mockRestore();
      }
    }

    async function expectSuccessAudit(subjectId: string, command: string) {
      const [count] = await fx.sql`
        SELECT count(*)::int AS n FROM audit.events
        WHERE detail->>'subjectId' = ${subjectId} AND command = ${command}
      `;
      expect(count!.n).toBe(1);
    }

    describe("remaining self-bound mutations", () => {
      it("keeps a recovery code and all sessions usable when its success audit fails", async () => {
        const subject = await person();
        const owner = await login(subject);
        const [code] = (await enrolPasskey(owner, authenticator())).recoveryCodes as string[];
        const recovering = await login(subject);
        const bystander = await login(subject);
        await failingAudit("auth.mfa.recovery_code.used", async () => {
          const failed = await post("/api/v1/auth/mfa/recovery-codes/verify", recovering, { code });
          expect(failed.statusCode, failed.body).toBe(500);
          expect(await alive(owner)).toBe(true);
          expect(await alive(bystander)).toBe(true);
          expect(await session(recovering)).toMatchObject({ aal: "aal1", recoveryLimited: false });
          const [stored] = await fx.sql`SELECT consumed_at FROM core.recovery_codes WHERE subject_id = ${subject} AND code_hash = ${hashRecoveryCode(code!)}`;
          expect(stored!.consumed_at).toBeNull();
        });
        const retried = await post("/api/v1/auth/mfa/recovery-codes/verify", recovering, { code });
        expect(retried.statusCode, retried.body).toBe(200);
        expect(retried.json()).toMatchObject({ recoveryLimited: true });
        expect(await alive(owner)).toBe(false);
        expect(await alive(bystander)).toBe(false);
        const replay = await post("/api/v1/auth/mfa/recovery-codes/verify", await login(subject), { code });
        expect(replay.statusCode, replay.body).toBe(401);
        await expectSuccessAudit(subject, "auth.mfa.recovery_code.used");
      });

      it("rolls back passkey challenge consumption, counter and session elevation on audit failure", async () => {
        const subject = await person();
        const key = authenticator();
        await enrolPasskey(await login(subject), key);
        const token = await login(subject);
        const response = key.assert(await authenticationOptions(token));
        const stored = () => fx.sql`SELECT sign_count, last_used_at FROM core.webauthn_credentials WHERE credential_id = ${key.id}`;
        const before = await stored();
        await failingAudit("auth.mfa.passkey.verified", async () => {
          const failed = await verifyAssertion(token, response);
          expect(failed.statusCode, failed.body).toBe(500);
          expect(await session(token)).toMatchObject({ aal: "aal1", secondFactor: null });
          expect(await stored()).toEqual(before);
        });
        const retried = await verifyAssertion(token, response);
        expect(retried.statusCode, retried.body).toBe(200);
        expect(await session(token)).toMatchObject({ aal: "aal3", secondFactor: "passkey" });
        expect(await stored()).not.toEqual(before);
        await expectSuccessAudit(subject, "auth.mfa.passkey.verified");
      });

      it("preserves the passkey name on audit failure and renames it on retry", async () => {
        const subject = await person();
        const token = await login(subject);
        await enrolPasskey(token, authenticator());
        const [passkey] = (await get("/api/v1/auth/mfa", token)).json().passkeys;
        const rename = () => app.inject({ method: "PATCH", url: `/api/v1/auth/mfa/passkeys/${passkey.id}`, headers: bearer(token), payload: { name: "Renamed" } });
        await failingAudit("auth.mfa.passkey.renamed", async () => {
          const failed = await rename();
          expect(failed.statusCode, failed.body).toBe(500);
          expect((await get("/api/v1/auth/mfa", token)).json().passkeys[0].name).toBe("Laptop");
        });
        const retried = await rename();
        expect(retried.statusCode, retried.body).toBe(200);
        expect(retried.json().name).toBe("Renamed");
        await expectSuccessAudit(subject, "auth.mfa.passkey.renamed");
      });

      it.each(["passkey", "totp"] as const)("rolls back %s removal and session revocations on audit failure", async (kind) => {
        const subject = await person();
        const token = await login(subject);
        const key = authenticator();
        await enrolPasskey(token, key);
        if (kind === "passkey") await enrolPasskey(token, authenticator());
        else await enrolTotp(token);
        const bystander = await login(subject);
        const [passkey] = (await get("/api/v1/auth/mfa", token)).json().passkeys;
        const url = kind === "passkey" ? `/api/v1/auth/mfa/passkeys/${passkey.id}/removal` : "/api/v1/auth/mfa/totp/removal";
        const status = () => get("/api/v1/auth/mfa", token).then((result) => result.json());
        const before = await status();
        await failingAudit(`auth.mfa.${kind}.removed`, async () => {
          const failed = await post(url, token);
          expect(failed.statusCode, failed.body).toBe(500);
          expect(await alive(bystander)).toBe(true);
          const unchanged = await status();
          expect(unchanged.passkeys).toEqual(before.passkeys);
          expect(unchanged.totpEnrolled).toBe(before.totpEnrolled);
        });
        const retried = await post(url, token);
        expect(retried.statusCode, retried.body).toBe(200);
        expect(await alive(bystander)).toBe(false);
        const remaining = await status();
        if (kind === "passkey") expect(remaining.passkeys).toHaveLength(1);
        else expect(remaining.totpEnrolled).toBe(false);
        await expectSuccessAudit(subject, `auth.mfa.${kind}.removed`);
      });
    });

    it("rolls back passkey enrolment and keeps the same challenge retryable when its success audit fails", async () => {
      const subject = await person();
      const token = await login(subject);
      const response = authenticator().register(await registrationOptions(token));
      await failingAudit("auth.mfa.passkey.enrolled", async () => {
        const failed = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, { response });
        expect(failed.statusCode, failed.body).toBe(500);
        expect(failed.json().recoveryCodes).toBeUndefined();
        expect(await session(token)).toMatchObject({ aal: "aal1", secondFactor: null });
        const status = (await get("/api/v1/auth/mfa", token)).json();
        expect(status.passkeyEnrolled).toBe(false);
        const [count] = await fx.sql`SELECT count(*)::int AS n FROM core.recovery_codes WHERE subject_id = ${subject}`;
        expect(count!.n).toBe(0);
      });
      const retried = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, { response });
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().recoveryCodes).toHaveLength(10);
      expect(await session(token)).toMatchObject({ aal: "aal3", secondFactor: "passkey" });
      await expectSuccessAudit(subject, "auth.mfa.passkey.enrolled");
    });

    it("does not retain an undisclosed TOTP setup when its success audit fails", async () => {
      const subject = await person();
      const token = await login(subject);
      await failingAudit("auth.mfa.totp.setup_started", async () => {
        const failed = await post("/api/v1/auth/mfa/totp/setup", token);
        expect(failed.statusCode, failed.body).toBe(500);
        expect(failed.json().secret).toBeUndefined();
        const [count] = await fx.sql`SELECT count(*)::int AS n FROM core.totp_authenticators WHERE subject_id = ${subject}`;
        expect(count!.n).toBe(0);
      });
      await totpSetup(token);
      await expectSuccessAudit(subject, "auth.mfa.totp.setup_started");
    });

    it("rolls back TOTP activation and code creation without consuming the valid step", async () => {
      const subject = await person();
      const token = await login(subject);
      const secret = await totpSetup(token);
      const code = codeFor(secret, currentStep());
      await failingAudit("auth.mfa.totp.enrolled", async () => {
        const failed = await post("/api/v1/auth/mfa/totp/confirm", token, { code });
        expect(failed.statusCode, failed.body).toBe(500);
        expect((await get("/api/v1/auth/mfa", token)).json().totpEnrolled).toBe(false);
        expect(await session(token)).toMatchObject({ aal: "aal1", secondFactor: null });
        const [count] = await fx.sql`SELECT count(*)::int AS n FROM core.recovery_codes WHERE subject_id = ${subject}`;
        expect(count!.n).toBe(0);
      });
      const retried = await post("/api/v1/auth/mfa/totp/confirm", token, { code });
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().recoveryCodes).toHaveLength(10);
      await expectSuccessAudit(subject, "auth.mfa.totp.enrolled");
    });

    it("preserves the old recovery codes on audit failure and replaces them only on a successful retry", async () => {
      const subject = await person();
      const token = await login(subject);
      const old = (await enrolPasskey(token, authenticator())).recoveryCodes as string[];
      const stored = () => fx.sql`SELECT code_hash FROM core.recovery_codes WHERE subject_id = ${subject} AND consumed_at IS NULL AND voided_at IS NULL ORDER BY code_hash`;
      const before = await stored();
      expect(before.map((row) => row.code_hash)).toEqual(old.map(hashRecoveryCode).sort());
      await failingAudit("auth.mfa.recovery_codes.regenerated", async () => {
        const failed = await post("/api/v1/auth/mfa/recovery-codes", token);
        expect(failed.statusCode, failed.body).toBe(500);
        expect(failed.json().recoveryCodes).toBeUndefined();
        expect(await stored()).toEqual(before);
      });
      const retried = await post("/api/v1/auth/mfa/recovery-codes", token);
      expect(retried.statusCode, retried.body).toBe(200);
      expect(retried.json().recoveryCodes).toHaveLength(10);
      expect((await stored()).map((row) => row.code_hash)).toEqual(retried.json().recoveryCodes.map(hashRecoveryCode).sort());
      expect(await stored()).not.toEqual(before);
      await expectSuccessAudit(subject, "auth.mfa.recovery_codes.regenerated");
    });
  });

  // --- passkeys ----------------------------------------------------------------------------------

  describe("passkey enrolment", () => {
    it("a new account enrols its first passkey from a first-factor session and reaches aal3", async () => {
      const subject = await person();
      const token = await login(subject);
      expect((await session(token)).aal).toBe("aal1");

      const enrolled = await enrolPasskey(token, authenticator());
      expect(enrolled).toMatchObject({ aal: "aal3", secondFactor: "passkey", sessionEnded: false });
      // The first factor comes with the first recovery code set, shown once.
      expect(enrolled.recoveryCodes).toHaveLength(10);
      expect(new Set(enrolled.recoveryCodes).size).toBe(10);

      expect(await session(token)).toMatchObject({ aal: "aal3", secondFactor: "passkey", mfaSatisfied: true });
      const status = (await get("/api/v1/auth/mfa", token)).json();
      expect(status).toMatchObject({ passkeyEnrolled: true, totpEnrolled: false, recoveryCodesRemaining: 10 });
      expect(status.passkeys).toEqual([expect.objectContaining({ name: "Laptop", deviceType: "singleDevice" })]);
    });

    it.each([
      ["another origin", { origin: "https://evil.example.com" }],
      ["another RP ID", { rpId: "evil.example.com" }],
      ["a challenge the server did not issue", { challenge: strayChallenge() }],
      ["no user verification", { userVerified: false }],
    ])("refuses a registration made for %s", async (_label, overrides) => {
      const subject = await person();
      const token = await login(subject);
      const options = await registrationOptions(token);
      const res = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, {
        response: authenticator().register(options, overrides),
      });
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().code).toBe("MFA_PASSKEY_INVALID");
      expect(await session(token)).toMatchObject({ aal: "aal1", secondFactor: null });
      const [count] = await fx.sql`SELECT count(*)::int AS n FROM core.webauthn_credentials WHERE subject_id = ${subject}`;
      expect(count!.n).toBe(0);

      // The failure is on the audit trail without the response itself.
      const [audit] = await fx.sql`
        SELECT detail FROM audit.events
        WHERE command = 'auth.mfa.passkey.enrol_failed' AND detail->>'subjectId' = ${subject}
      `;
      expect(audit?.detail).toMatchObject({ outcome: "MFA_PASSKEY_INVALID" });
    });

    it("refuses a registration without a live challenge, and the same challenge twice", async () => {
      const subject = await person();
      const token = await login(subject);
      const key = authenticator();
      const none = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, {
        response: key.register({ challenge: strayChallenge() }),
      });
      expect(none.statusCode).toBe(401);
      expect(none.json().code).toBe("MFA_CHALLENGE_INVALID");

      const options = await registrationOptions(token);
      const response = key.register(options);
      expect((await post("/api/v1/auth/mfa/passkeys/registration/verify", token, { response })).statusCode).toBe(200);
      const again = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, { response });
      expect(again.statusCode).toBe(401);
      expect(again.json().code).toBe("MFA_CHALLENGE_INVALID");
    });

    it("a challenge belongs to the session it was issued to", async () => {
      const subject = await person();
      const first = await login(subject);
      const second = await login(subject);
      const options = await registrationOptions(first);
      const res = await post("/api/v1/auth/mfa/passkeys/registration/verify", second, {
        response: authenticator().register(options),
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("MFA_CHALLENGE_INVALID");
    });

    it("refuses first enrolment from a first-factor session once a factor exists", async () => {
      const subject = await person();
      await enrolPasskey(await login(subject), authenticator());

      const later = await login(subject);
      for (const url of ["/api/v1/auth/mfa/passkeys/registration/options", "/api/v1/auth/mfa/totp/setup"]) {
        const res = await post(url, later);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().code, url).toBe("MFA_STEP_UP_REQUIRED");
      }
      expect((await get("/api/v1/auth/mfa", later)).json().enrolment).toEqual({
        passkey: "MFA_STEP_UP_REQUIRED",
        totp: "MFA_STEP_UP_REQUIRED",
      });
    });

    it("refuses first enrolment more than 24 hours after the account was created", async () => {
      const token = await login(await person({ ageHours: 25 }));
      for (const url of ["/api/v1/auth/mfa/passkeys/registration/options", "/api/v1/auth/mfa/totp/setup"]) {
        const res = await post(url, token);
        expect(res.statusCode, url).toBe(403);
        expect(res.json().code, url).toBe("MFA_ENROLMENT_WINDOW_CLOSED");
      }
    });

    it("a second passkey needs a passkey session, not a TOTP one", async () => {
      const subject = await person();
      const first = await login(subject);
      const key = authenticator();
      await enrolPasskey(first, key);
      const { secret } = await enrolTotp(first); // a passkey session may add TOTP

      const totpSession = await login(subject);
      const verify = await post("/api/v1/auth/mfa/totp/verify", totpSession, { code: codeFor(secret, currentStep() + 1) });
      expect(verify.statusCode, verify.body).toBe(200);
      expect(verify.json()).toMatchObject({ aal: "aal2", secondFactor: "totp" });
      const refused = await post("/api/v1/auth/mfa/passkeys/registration/options", totpSession);
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe("MFA_PASSKEY_REQUIRED");

      const passkeySession = await login(subject);
      await stepUp(passkeySession, key);
      const second = await enrolPasskey(passkeySession, authenticator());
      // Codes exist already; adding a factor does not silently replace them.
      expect(second.recoveryCodes).toBeNull();
      const status = (await get("/api/v1/auth/mfa", passkeySession)).json();
      expect(status.passkeys).toHaveLength(2);
    });

    it("refuses the same authenticator twice", async () => {
      const subject = await person();
      const key = authenticator();
      const token = await login(subject);
      await enrolPasskey(token, key);
      const options = await registrationOptions(token);
      expect(options.excludeCredentials).toEqual([expect.objectContaining({ id: key.id })]);
      const res = await post("/api/v1/auth/mfa/passkeys/registration/verify", token, { response: key.register(options) });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MFA_CREDENTIAL_EXISTS");
    });

    it("renames a passkey from a second-factor session only", async () => {
      const subject = await person();
      const token = await login(subject);
      await enrolPasskey(token, authenticator());
      const [passkey] = (await get("/api/v1/auth/mfa", token)).json().passkeys;
      const renamed = await app.inject({
        method: "PATCH",
        url: `/api/v1/auth/mfa/passkeys/${passkey.id}`,
        headers: bearer(token),
        payload: { name: "Office key" },
      });
      expect(renamed.statusCode, renamed.body).toBe(200);
      expect(renamed.json().name).toBe("Office key");

      const aal1 = await login(subject);
      const refused = await app.inject({
        method: "PATCH",
        url: `/api/v1/auth/mfa/passkeys/${passkey.id}`,
        headers: bearer(aal1),
        payload: { name: "Mine now" },
      });
      expect(refused.statusCode).toBe(403);
      // A first-factor session sees that a passkey exists, not what it is called.
      const limitedView = (await get("/api/v1/auth/mfa", aal1)).json();
      expect(limitedView).toMatchObject({ passkeyEnrolled: true, passkeys: [], recoveryCodesRemaining: null });

      for (const bad of ["not-a-uuid", "1"]) {
        const res = await post(`/api/v1/auth/mfa/passkeys/${bad}/removal`, token);
        expect(res.statusCode, bad).toBe(400);
        expect(res.json().code, bad).toBe("PATH_PARAM_INVALID");
      }
    });
  });

  describe("passkey step-up", () => {
    let subject: string;
    let key: SoftAuthenticator;

    beforeAll(async () => {
      subject = await person();
      key = authenticator();
      await enrolPasskey(await login(subject), key);
    });

    it("an assertion over this session's challenge raises it to aal3", async () => {
      const token = await login(subject);
      expect(await stepUp(token, key)).toMatchObject({ aal: "aal3", secondFactor: "passkey" });
      expect(await session(token)).toMatchObject({ aal: "aal3", secondFactor: "passkey" });
    });

    it.each([
      ["another origin", { origin: "https://evil.example.com" }],
      ["another RP ID", { rpId: "evil.example.com" }],
      ["a challenge the server did not issue", { challenge: strayChallenge() }],
      ["no user verification", { userVerified: false }],
    ])("refuses an assertion made for %s", async (_label, overrides) => {
      const token = await login(subject);
      const res = await verifyAssertion(token, key.assert(await authenticationOptions(token), overrides));
      expect(res.statusCode, res.body).toBe(401);
      expect(res.json().code).toBe("MFA_PASSKEY_INVALID");
      expect((await session(token)).aal).toBe("aal1");
    });

    it("refuses a replayed assertion", async () => {
      const token = await login(subject);
      const assertion = key.assert(await authenticationOptions(token));
      expect((await verifyAssertion(token, assertion)).statusCode).toBe(200);

      // On the same session and on another one: the challenge is spent and was never theirs.
      const other = await login(subject);
      await authenticationOptions(other);
      for (const target of [token, other]) {
        const replay = await verifyAssertion(target, assertion);
        expect(replay.statusCode).toBe(401);
      }
      expect((await session(other)).aal).toBe("aal1");
    });

    it("refuses a sign counter that did not increase", async () => {
      const token = await login(subject);
      const [row] = await fx.sql`
        SELECT sign_count::int AS n FROM core.webauthn_credentials WHERE credential_id = ${key.id}
      `;
      expect(row!.n).toBeGreaterThan(0);
      for (const counter of [row!.n, row!.n - 1, 0]) {
        const res = await verifyAssertion(token, key.assert(await authenticationOptions(token), { counter }));
        expect(res.statusCode, `counter ${counter}`).toBe(401);
      }
      expect((await session(token)).aal).toBe("aal1");
    });

    it("accepts an authenticator that never counts (synced passkeys report 0)", async () => {
      const synced = await person();
      const flat = authenticator(null);
      await enrolPasskey(await login(synced), flat);
      for (let i = 0; i < 2; i += 1) {
        expect((await stepUp(await login(synced), flat)).aal).toBe("aal3");
      }
    });

    it("refuses a registration challenge used for authentication", async () => {
      const token = await login(subject);
      await stepUp(token, key);
      const options = await registrationOptions(token); // aal3 may add a passkey
      const res = await verifyAssertion(token, key.assert({ challenge: options.challenge }));
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("MFA_CHALLENGE_INVALID");
    });

    it("refuses a passkey of another account", async () => {
      const stranger = authenticator();
      await enrolPasskey(await login(await person()), stranger);
      const token = await login(subject);
      const res = await verifyAssertion(token, stranger.assert(await authenticationOptions(token)));
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("MFA_PASSKEY_INVALID");
    });

    it("has no challenge to issue for an account without a passkey", async () => {
      const res = await post("/api/v1/auth/mfa/passkeys/authentication/options", await login(await person()));
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MFA_NO_PASSKEY");
    });
  });

  // --- TOTP --------------------------------------------------------------------------------------

  describe("TOTP", () => {
    it("enrols from a first-factor session, then verifies a later step on a new session", async () => {
      const subject = await person();
      const first = await login(subject);
      const step = currentStep();
      const { secret, body } = await enrolTotp(first, step);
      expect(body).toMatchObject({ aal: "aal2", secondFactor: "totp" });
      expect(body.recoveryCodes).toHaveLength(10);

      const second = await login(subject);
      // The step enrolment used is spent — on any session.
      const replay = await post("/api/v1/auth/mfa/totp/verify", second, { code: codeFor(secret, step) });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().code).toBe("MFA_TOTP_INVALID");
      // Outside ±1 step.
      for (const offset of [5, -5]) {
        const far = await post("/api/v1/auth/mfa/totp/verify", second, { code: codeFor(secret, step + offset) });
        expect(far.statusCode).toBe(401);
      }
      const ok = await post("/api/v1/auth/mfa/totp/verify", second, { code: codeFor(secret, step + 1) });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(await session(second)).toMatchObject({ aal: "aal2", secondFactor: "totp" });
    });

    it("stores the secret sealed, never in the clear", async () => {
      const subject = await person();
      const secret = await totpSetup(await login(subject));
      const [row] = await fx.sql`
        SELECT secret_ciphertext, secret_nonce, key_version FROM core.totp_authenticators WHERE subject_id = ${subject}
      `;
      const stored = Buffer.from(row!.secret_ciphertext);
      expect(stored.includes(Buffer.from(secret))).toBe(false);
      expect(stored.toString("latin1")).not.toContain(new Secret({ buffer: secret.slice().buffer }).base32);
      expect(Buffer.from(row!.secret_nonce)).toHaveLength(12);
      expect(row!.key_version).toBe(1);
    });

    it("locks after five attempts in 15 minutes — counted before the code is checked", async () => {
      const subject = await person();
      const { secret } = await enrolTotp(await login(subject));
      const token = await login(subject);
      const wrong = codeFor(secret, currentStep()) === "000000" ? "111111" : "000000";
      const left: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        const res = await post("/api/v1/auth/mfa/totp/verify", token, { code: wrong });
        expect(res.statusCode).toBe(401);
        left.push(res.json().details.attemptsLeft);
      }
      expect(left).toEqual([4, 3, 2, 1, 0]);

      // Now even the right code is refused, on any session of the account.
      for (const target of [token, await login(subject)]) {
        const locked = await post("/api/v1/auth/mfa/totp/verify", target, { code: codeFor(secret, currentStep() + 1) });
        expect(locked.statusCode).toBe(429);
        expect(locked.json().code).toBe("MFA_TOTP_LOCKED");
        expect(Date.parse(locked.json().details.retryAfter)).toBeGreaterThan(Date.now());
      }
      expect((await session(token)).aal).toBe("aal1");

      // The window passes: attempts are counted afresh.
      await fx.sql`
        UPDATE core.totp_authenticators SET failure_window_started_at = now() - interval '16 minutes'
        WHERE subject_id = ${subject}
      `;
      const after = await post("/api/v1/auth/mfa/totp/verify", token, { code: codeFor(secret, currentStep() + 1) });
      expect(after.statusCode, after.body).toBe(200);
    });

    it("a pending setup expires and cannot be confirmed later", async () => {
      const subject = await person();
      const token = await login(subject);
      const secret = await totpSetup(token);
      await fx.sql`
        UPDATE core.totp_authenticators SET pending_expires_at = now() - interval '1 second'
        WHERE subject_id = ${subject}
      `;
      const res = await post("/api/v1/auth/mfa/totp/confirm", token, { code: codeFor(secret, currentStep()) });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MFA_TOTP_NOT_ENROLLED");
    });

    it("a TOTP code never lowers a passkey session", async () => {
      const subject = await person();
      const token = await login(subject);
      await enrolPasskey(token, authenticator());
      const { body } = await enrolTotp(token);
      expect(body).toMatchObject({ aal: "aal3", secondFactor: "passkey" });
      expect((await session(token)).aal).toBe("aal3");
    });
  });

  // --- recovery codes ----------------------------------------------------------------------------

  describe("recovery codes", () => {
    it("works once, ends every other session, and limits its own to re-enrolment", async () => {
      const subject = await person({ role: "data_steward" });
      const enrolled = await enrolPasskey(await login(subject), authenticator());
      const [code] = enrolled.recoveryCodes as string[];

      const bystander = await login(subject);
      const recovering = await login(subject);
      const used = await post("/api/v1/auth/mfa/recovery-codes/verify", recovering, {
        code: code!.toLowerCase(), // case and dashes do not matter
      });
      expect(used.statusCode, used.body).toBe(200);
      expect(used.json()).toMatchObject({ aal: "aal2", recoveryLimited: true });
      expect(used.json().revokedSessions).toBeGreaterThanOrEqual(2); // the enrolling session and the bystander
      expect(await alive(bystander)).toBe(false);

      // Limited: its own session view, MFA, logout — nothing else, and no roles.
      const view = await session(recovering);
      expect(view).toMatchObject({ aal: "aal2", secondFactor: "recovery_code", recoveryLimited: true });
      expect(view.roleBindings).toEqual([]);
      const projects = await get("/api/v1/projects", recovering);
      expect(projects.statusCode).toBe(403);
      expect(projects.json().code).toBe("MFA_RECOVERY_REENROLMENT_REQUIRED");
      // It cannot remove the factors it recovered from, either.
      const [passkey] = await fx.sql`SELECT id FROM core.webauthn_credentials WHERE subject_id = ${subject}`;
      const removal = await post(`/api/v1/auth/mfa/passkeys/${passkey!.id}/removal`, recovering);
      expect(removal.statusCode).toBe(403);
      expect(removal.json().code).toBe("MFA_RECOVERY_REENROLMENT_REQUIRED");

      // The code is spent.
      const reuse = await post("/api/v1/auth/mfa/recovery-codes/verify", await login(subject), { code });
      expect(reuse.statusCode).toBe(401);
      expect(reuse.json().code).toBe("MFA_RECOVERY_CODE_INVALID");

      // Enrolling a new factor completes the recovery: every session ends, this one too, and the
      // person signs in again with the new factor (plan journey 5).
      const meanwhile = await login(subject); // e.g. whoever else holds the first factor
      const { secret, body } = await enrolTotp(recovering);
      expect(body).toMatchObject({ secondFactor: "totp", sessionEnded: true });
      expect(await alive(recovering)).toBe(false);
      expect(await alive(meanwhile)).toBe(false);

      const again = await login(subject);
      const verified = await post("/api/v1/auth/mfa/totp/verify", again, { code: codeFor(secret, currentStep() + 1) });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({ aal: "aal2", sessionEnded: false });
      const after = await session(again);
      expect(after.recoveryLimited).toBe(false);
      expect(after.roleBindings.length).toBeGreaterThan(0);
      expect((await get("/api/v1/projects", again)).statusCode).toBe(200);
    });

    it("a recovering session that finds its passkey, or enrols a new one, also ends", async () => {
      const subject = await person();
      const key = authenticator();
      const codes = (await enrolPasskey(await login(subject), key)).recoveryCodes as string[];

      const found = await login(subject);
      expect((await post("/api/v1/auth/mfa/recovery-codes/verify", found, { code: codes[0] })).statusCode).toBe(200);
      expect(await stepUp(found, key)).toMatchObject({ aal: "aal3", sessionEnded: true });
      expect(await alive(found)).toBe(false);

      const replaced = await login(subject);
      expect((await post("/api/v1/auth/mfa/recovery-codes/verify", replaced, { code: codes[1] })).statusCode).toBe(200);
      const enrolled = await enrolPasskey(replaced, authenticator());
      expect(enrolled).toMatchObject({ aal: "aal3", sessionEnded: true });
      expect(await alive(replaced)).toBe(false);
      const [ended] = await fx.sql`
        SELECT count(*)::int AS n FROM core.sessions WHERE subject_id = ${subject} AND revoked_reason = 'recovery_completed'
      `;
      expect(ended!.n).toBe(2);
    });

    it("refuses a code of another account, a malformed code, and a session that already has a factor", async () => {
      const owner = await person();
      const codes = (await enrolPasskey(await login(owner), authenticator())).recoveryCodes as string[];
      const other = await person();
      await enrolPasskey(await login(other), authenticator());

      const theirs = await post("/api/v1/auth/mfa/recovery-codes/verify", await login(other), { code: codes[0] });
      expect(theirs.statusCode).toBe(401);
      const malformed = await post("/api/v1/auth/mfa/recovery-codes/verify", await login(owner), { code: "not-a-code" });
      expect(malformed.statusCode).toBe(401);

      const satisfied = await issueTestSession(fx.appSql, fx.tenantA, owner, { firstFactor: "email_code", secondFactor: "totp" });
      const res = await post("/api/v1/auth/mfa/recovery-codes/verify", satisfied, { code: codes[1] });
      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe("MFA_ALREADY_SATISFIED");
    });

    it("regenerating voids the previous set and needs a second factor", async () => {
      const subject = await person();
      const token = await login(subject);
      const old = (await enrolPasskey(token, authenticator())).recoveryCodes as string[];
      const fresh = await post("/api/v1/auth/mfa/recovery-codes", token);
      expect(fresh.statusCode, fresh.body).toBe(200);
      expect(fresh.json().recoveryCodes).toHaveLength(10);

      const stale = await post("/api/v1/auth/mfa/recovery-codes/verify", await login(subject), { code: old[0] });
      expect(stale.statusCode).toBe(401);
      expect((await post("/api/v1/auth/mfa/recovery-codes", await login(subject))).statusCode).toBe(403);
    });

    it("a TOTP session cannot mint codes on a passkey account and spend one to enrol its own passkey", async () => {
      // Found in review: regenerate (aal2) → spend a fresh code → recovering session enrols a
      // passkey → aal3 → strip the owner's passkey. Regeneration needs the strongest factor held.
      const subject = await person();
      const owner = await login(subject);
      await enrolPasskey(owner, authenticator());
      const { secret } = await enrolTotp(owner);
      const totpSession = await login(subject);
      expect(
        (await post("/api/v1/auth/mfa/totp/verify", totpSession, { code: codeFor(secret, currentStep() + 1) })).statusCode,
      ).toBe(200);
      const minted = await post("/api/v1/auth/mfa/recovery-codes", totpSession);
      expect(minted.statusCode).toBe(403);
      expect(minted.json().code).toBe("MFA_PASSKEY_REQUIRED");
      const [codes] = await fx.sql`
        SELECT count(*)::int AS n FROM core.recovery_codes
        WHERE subject_id = ${subject} AND consumed_at IS NULL AND voided_at IS NULL
      `;
      expect(codes!.n).toBe(10); // the owner's set is untouched

      // Without a passkey on the account, a TOTP session may regenerate.
      const totpOnly = await person();
      const { secret: other } = await enrolTotp(await login(totpOnly));
      const second = await login(totpOnly);
      expect((await post("/api/v1/auth/mfa/totp/verify", second, { code: codeFor(other, currentStep() + 1) })).statusCode).toBe(200);
      expect((await post("/api/v1/auth/mfa/recovery-codes", second)).statusCode).toBe(200);
    });

    it("an email change (WP2) ends proven and recovering sessions alike, and their factors stay", async () => {
      const subject = await person();
      const key = authenticator();
      const codes = (await enrolPasskey(await login(subject), key)).recoveryCodes as string[];
      const recovering = await login(subject);
      expect((await post("/api/v1/auth/mfa/recovery-codes/verify", recovering, { code: codes[0] })).statusCode).toBe(200);
      // Signed in after the recovery started (that ended every session before it).
      const proven = await login(subject);
      await stepUp(proven, key);

      // What the email-change decision calls (0114, `email_changed`).
      await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => revokeSubjectSessions(tx, subject, "email_changed"));
      expect(await alive(proven)).toBe(false);
      expect(await alive(recovering)).toBe(false);
      // The rows still satisfy every shape constraint, and the proof stays with its session.
      const rows = await fx.sql`
        SELECT s.second_factor, s.recovery_limited, s.revoked_reason, p.factor
        FROM core.sessions s JOIN core.session_factor_proofs p ON p.id = s.second_factor_proof_id
        WHERE s.subject_id = ${subject} AND s.revoked_reason = 'email_changed' ORDER BY s.second_factor
      `;
      expect(rows).toEqual([
        { second_factor: "passkey", recovery_limited: false, revoked_reason: "email_changed", factor: "passkey" },
        { second_factor: "recovery_code", recovery_limited: true, revoked_reason: "email_changed", factor: "recovery_code" },
      ]);
      // The passkey survives an email change: the person signs in again and steps up with it.
      expect((await stepUp(await login(subject), key)).aal).toBe("aal3");
    });

    it("a recovering session cannot regenerate codes", async () => {
      const subject = await person();
      const codes = (await enrolPasskey(await login(subject), authenticator())).recoveryCodes as string[];
      const recovering = await login(subject);
      expect((await post("/api/v1/auth/mfa/recovery-codes/verify", recovering, { code: codes[0] })).statusCode).toBe(200);
      const res = await post("/api/v1/auth/mfa/recovery-codes", recovering);
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("MFA_RECOVERY_REENROLMENT_REQUIRED");
      // Nor directly at the database.
      const [row] = await fx.sql`SELECT id FROM core.sessions WHERE subject_id = ${subject} AND recovery_limited`;
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT core.regenerate_recovery_codes(${row!.id}, ${Array.from({ length: 10 }, (_, i) => String(i).repeat(64))}::text[])`,
        ),
      ).rejects.toThrow(/MFA_RECOVERY_REENROLMENT_REQUIRED/);
    });
  });

  // --- removal -----------------------------------------------------------------------------------

  describe("removing a factor", () => {
    it("ends the other sessions and never removes the last factor", async () => {
      const subject = await person();
      const key = authenticator();
      const main = await login(subject);
      await enrolPasskey(main, key);
      const { secret } = await enrolTotp(main);

      // A TOTP session cannot remove anything while a passkey exists: removal needs the strongest factor held.
      const totpSession = await login(subject);
      expect(
        (await post("/api/v1/auth/mfa/totp/verify", totpSession, { code: codeFor(secret, currentStep() + 1) })).statusCode,
      ).toBe(200);
      const weak = await post("/api/v1/auth/mfa/totp/removal", totpSession);
      expect(weak.statusCode).toBe(403);

      const bystander = await login(subject);
      const removed = await post("/api/v1/auth/mfa/totp/removal", main);
      expect(removed.statusCode, removed.body).toBe(200);
      expect(removed.json()).toMatchObject({ currentSessionEnded: false });
      expect(removed.json().revokedSessions).toBeGreaterThanOrEqual(2);
      expect(await alive(bystander)).toBe(false);
      expect(await alive(totpSession)).toBe(false);
      expect(await alive(main)).toBe(true);

      const [passkey] = (await get("/api/v1/auth/mfa", main)).json().passkeys;
      const last = await post(`/api/v1/auth/mfa/passkeys/${passkey.id}/removal`, main);
      expect(last.statusCode).toBe(422);
      expect(last.json().code).toBe("MFA_LAST_FACTOR");

      const unknown = await post(`/api/v1/auth/mfa/passkeys/${randomUUID()}/removal`, main);
      expect(unknown.statusCode).toBe(404);
    });

    it("removing the passkey this session proved with ends this session too", async () => {
      const subject = await person();
      const main = await login(subject);
      const first = authenticator();
      await enrolPasskey(main, first);
      await enrolPasskey(main, authenticator());
      // `main` now stands on the passkey it registered last; prove it with `first` again.
      await stepUp(main, first);
      const [row] = await fx.sql`SELECT id FROM core.webauthn_credentials WHERE credential_id = ${first.id}`;
      const [proof] = await fx.sql`
        SELECT p.webauthn_credential_id AS id FROM core.sessions s
        JOIN core.session_factor_proofs p ON p.id = s.second_factor_proof_id
        WHERE s.subject_id = ${subject} AND s.revoked_at IS NULL
      `;
      expect(proof!.id).toBe(row!.id);

      const res = await post(`/api/v1/auth/mfa/passkeys/${row!.id}/removal`, main);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().currentSessionEnded).toBe(true);
      expect(await alive(main)).toBe(false);
    });
  });

  // --- authentication level and roles ------------------------------------------------------------

  describe("role assurance", () => {
    it("an aal2 session does not reach an aal3 role; a passkey step-up on it does", async () => {
      const operator = await person({ role: "mpc_operator" });
      const key = authenticator();
      const first = await login(operator);
      await enrolPasskey(first, key);
      const { secret } = await enrolTotp(first);

      const token = await login(operator);
      expect(
        (await post("/api/v1/auth/mfa/totp/verify", token, { code: codeFor(secret, currentStep() + 1) })).statusCode,
      ).toBe(200);
      const view = await session(token);
      expect(view.aal).toBe("aal2");
      expect(view.narrowedRoles).toEqual([expect.objectContaining({ role: "mpc_operator", requiredAal: "aal3" })]);
      expect((await get("/api/v1/admin/mfa-resets", token)).statusCode).toBe(403);

      await stepUp(token, key);
      expect((await session(token)).aal).toBe("aal3");
      expect((await get("/api/v1/admin/mfa-resets", token)).statusCode).toBe(200);
    });
  });

  // --- admin reset -------------------------------------------------------------------------------

  describe("admin MFA reset", () => {
    const adminSession = (subjectId: string) =>
      issueTestSession(fx.appSql, fx.tenantA, subjectId, { firstFactor: "email_code", secondFactor: "passkey" });
    const propose = (token: string, subjectId: string) =>
      post("/api/v1/admin/mfa-resets", token, { subjectId, reason: "Lost every device" }, { "idempotency-key": idempotencyKey() });
    const decide = (token: string, id: string, version: number, decision: "approve" | "reject") =>
      post(
        `/api/v1/admin/mfa-resets/${id}/decision`,
        token,
        { decision, reason: "Identity confirmed by call-back" },
        { "idempotency-key": idempotencyKey(), "if-match": `"${version}"` },
      );

    it("takes two people, ends the person's sessions and factors, and opens a 24-hour enrolment window", async () => {
      const target = await person({ ageHours: 72 });
      const key = authenticator();
      const enrolSession = await login(target);
      // Older account: enrol as it would have been within its window.
      await fx.sql`UPDATE core.subjects SET created_at = now() WHERE id = ${target}`;
      await enrolPasskey(enrolSession, key);
      await fx.sql`UPDATE core.subjects SET created_at = now() - interval '72 hours' WHERE id = ${target}`;
      const held = await login(target);

      const proposer = await adminSession(await person({ role: "mpc_operator" }));
      const decider = await adminSession(await person({ role: "security_operator" }));

      const proposed = await propose(proposer, target);
      expect(proposed.statusCode, proposed.body).toBe(200);
      const reset = proposed.json();
      expect(reset).toMatchObject({ state: "pending", version: 1, subjectId: target });
      expect((await propose(decider, target)).statusCode).toBe(409);

      const self = await decide(proposer, reset.id, 1, "approve");
      expect(self.statusCode).toBe(422);
      expect(self.json().code).toBe("MFA_RESET_SELF_APPROVAL");
      expect((await decide(decider, reset.id, 7, "approve")).statusCode).toBe(412);

      const approved = await decide(decider, reset.id, 1, "approve");
      expect(approved.statusCode, approved.body).toBe(200);
      expect(approved.json()).toMatchObject({ state: "approved", version: 2 });
      expect(Date.parse(approved.json().enrolmentWindowUntil) - Date.now()).toBeGreaterThan(23 * 3600_000);
      expect(await alive(enrolSession)).toBe(false);
      expect(await alive(held)).toBe(false);
      const [left] = await fx.sql`
        SELECT count(*)::int AS n FROM core.webauthn_credentials WHERE subject_id = ${target} AND revoked_at IS NULL
      `;
      expect(left!.n).toBe(0);
      expect((await decide(decider, reset.id, 2, "reject")).statusCode).toBe(422);

      // The person enrols their own new factor in the window, although the account is 72 hours old.
      const fresh = await login(target);
      const enrolled = await enrolPasskey(fresh, authenticator());
      expect(enrolled.aal).toBe("aal3");
      // The old passkey is gone for good.
      const old = await login(target);
      expect((await verifyAssertion(old, key.assert(await authenticationOptions(old)))).statusCode).toBe(401);
    });

    it("the person reset cannot decide their own reset", async () => {
      const targetAdmin = await person({ role: "security_operator" });
      const proposer = await adminSession(await person({ role: "mpc_operator" }));
      const reset = (await propose(proposer, targetAdmin)).json();
      const res = await decide(await adminSession(targetAdmin), reset.id, 1, "approve");
      expect(res.statusCode).toBe(422);
      expect(res.json().code).toBe("MFA_RESET_SELF_TARGET");
    });

    it("needs an admin role at aal3", async () => {
      const target = await person();
      const plain = await adminSession(await person({ role: "data_steward" }));
      expect((await propose(plain, target)).statusCode).toBe(403);
      const aal2 = await issueTestSession(fx.appSql, fx.tenantA, await person({ role: "mpc_operator" }), {
        firstFactor: "email_code",
        secondFactor: "totp",
      });
      expect((await propose(aal2, target)).statusCode).toBe(403);
    });

    it("the database refuses one person deciding, whatever the API checks", async () => {
      const target = await person();
      const admin = await person({ role: "mpc_operator" });
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id)
        VALUES (${id}, ${fx.tenantA}, ${target}, 'x', ${admin})
      `;
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT * FROM core.decide_mfa_reset(${id}, ${admin}, true, 'x', 1)`,
        ),
      ).rejects.toThrow(/MFA_RESET_SELF_APPROVAL/);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT * FROM core.decide_mfa_reset(${id}, ${target}, true, 'x', 1)`,
        ),
      ).rejects.toThrow(/MFA_RESET_SELF_TARGET/);
    });

    it("the application role cannot insert a reset that is already decided", async () => {
      const target = await person();
      const [requester, decider] = [await person({ role: "mpc_operator" }), await person({ role: "security_operator" })];
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`
            INSERT INTO core.mfa_reset_requests (
              id, tenant_id, subject_id, reason, requested_by_subject_id, state, decided_by_subject_id,
              decided_at, enrolment_window_until
            ) VALUES (
              ${randomUUID()}, ${fx.tenantA}, ${target}, 'x', ${requester}, 'approved', ${decider},
              now(), now() + interval '24 hours'
            )
          `,
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });

  // --- recovery separation and lock order (security review, migration 0118) -------------------

  describe("recovery separation (0118)", () => {
    const adminSession = (subjectId: string) =>
      issueTestSession(fx.appSql, fx.tenantA, subjectId, { firstFactor: "email_code", secondFactor: "passkey" });
    const proposeReset = (token: string, subjectId: string) =>
      post("/api/v1/admin/mfa-resets", token, { subjectId, reason: "Lost every device" }, { "idempotency-key": idempotencyKey() });
    const decideReset = (token: string, id: string, version: number, decision: "approve" | "reject") =>
      post(
        `/api/v1/admin/mfa-resets/${id}/decision`,
        token,
        { decision, reason: "Identity confirmed by call-back" },
        { "idempotency-key": idempotencyKey(), "if-match": `"${version}"` },
      );
    const proposeChange = (token: string, subjectId: string, newEmail: string) =>
      post("/api/v1/admin/email-changes", token, { subjectId, newEmail, reason: "Moved" }, { "idempotency-key": idempotencyKey() });
    const decideChange = (token: string, id: string, version: number, decision: "approve" | "reject") =>
      post(
        `/api/v1/admin/email-changes/${id}/decision`,
        token,
        { decision, reason: "Checked with the person" },
        { "idempotency-key": idempotencyKey(), "if-match": `"${version}"` },
      );
    const freshAddress = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;
    async function adminPair() {
      const a = await person({ role: "mpc_operator" });
      const b = await person({ role: "security_operator" });
      return { a, b, aToken: await adminSession(a), bToken: await adminSession(b) };
    }
    /** A 72-hour-old person who holds a passkey, signed in with their address. */
    async function victim() {
      const subject = await person({ ageHours: 72 });
      await fx.sql`UPDATE core.subjects SET created_at = now() WHERE id = ${subject}`;
      await enrolPasskey(await login(subject), authenticator());
      await fx.sql`UPDATE core.subjects SET created_at = now() - interval '72 hours' WHERE id = ${subject}`;
      const [row] = await fx.sql<{ email: string }[]>`SELECT email FROM core.subjects WHERE id = ${subject}`;
      return { subject, email: row!.email };
    }
    /** Proposes (a), approves (b) and completes a change to `newEmail` with the mailed code. */
    async function moveAddress(aToken: string, bToken: string, subject: string, newEmail: string) {
      const proposed = await proposeChange(aToken, subject, newEmail);
      expect(proposed.statusCode, proposed.body).toBe(200);
      const approved = await decideChange(bToken, proposed.json().id, 1, "approve");
      expect(approved.statusCode, approved.body).toBe(200);
      const [mail] = await fx.sql<{ params: { code: string } }[]>`
        SELECT params FROM core.email_outbox
        WHERE recipient = ${newEmail} AND template = 'email_change_code' AND state = 'pending'
        ORDER BY created_at DESC LIMIT 1
      `;
      const completed = await app.inject({
        method: "POST",
        url: "/api/v1/auth/email-change/verify",
        payload: { email: newEmail, code: mail!.params.code },
      });
      expect(completed.statusCode, completed.body).toBe(200);
    }

    it("the two admins who moved an address cannot also reset the factors (takeover chain)", async () => {
      const { subject, email: oldEmail } = await victim();
      const { a, b, aToken, bToken } = await adminPair();
      // The attackers' mailbox becomes the account's address.
      const attackerEmail = freshAddress("attacker");
      await moveAddress(aToken, bToken, subject, attackerEmail);

      // A and B now try the reset, in both roles. Each attempt is refused with the same code.
      const byA = await proposeReset(aToken, subject);
      expect(byA.statusCode, byA.body).toBe(422);
      expect(byA.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      expect((await proposeReset(bToken, subject)).json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");

      // An uninvolved proposer: neither A nor B may approve it.
      const c = await adminSession(await person({ role: "mpc_operator" }));
      const proposed = await proposeReset(c, subject);
      expect(proposed.statusCode, proposed.body).toBe(200);
      const reset = proposed.json();
      for (const token of [aToken, bToken]) {
        const refused = await decideReset(token, reset.id, 1, "approve");
        expect(refused.statusCode, refused.body).toBe(422);
        expect(refused.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      }
      const [still] = await fx.sql`SELECT state FROM core.mfa_reset_requests WHERE id = ${reset.id}`;
      expect(still!.state).toBe("pending");

      // So the attacker's own email-code session at the new address stays at aal1: the window
      // is closed and the victim's passkey still stands.
      const attacker = await issueTestSession(fx.appSql, fx.tenantA, subject, { firstFactor: "email_code" });
      const enrol = await post("/api/v1/auth/mfa/passkeys/registration/options", attacker);
      expect(enrol.statusCode).toBe(403);
      expect(enrol.json().code).toBe("MFA_STEP_UP_REQUIRED");

      // The database refuses both directions even to a caller that skips the API.
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`
            INSERT INTO core.mfa_reset_requests (id, tenant_id, subject_id, reason, requested_by_subject_id)
            VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, 'x', ${a})
          `,
        ),
      ).rejects.toThrow(/MFA_RESET_SEPARATION_REQUIRED/);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT * FROM core.decide_mfa_reset(${reset.id}, ${b}, true, 'x', 1)`,
        ),
      ).rejects.toThrow(/MFA_RESET_SEPARATION_REQUIRED/);

      // A fourth, uninvolved admin approves — and the reset is told to both addresses, the old
      // one included, since the owner may no longer read the new one.
      const d = await adminSession(await person({ role: "security_operator" }));
      const approved = await decideReset(d, reset.id, 1, "approve");
      expect(approved.statusCode, approved.body).toBe(200);
      const notices = await fx.sql<{ recipient: string; params: unknown }[]>`
        SELECT recipient, params FROM core.email_outbox
        WHERE template = 'mfa_reset_notice' AND recipient IN (${oldEmail}, ${attackerEmail})
      `;
      expect(notices.map((n) => n.recipient).sort()).toEqual([attackerEmail, oldEmail].sort());
      // No code, no link: only the provider names of revoked linked sign-ins (none here, 0123).
      expect(notices.every((n) => JSON.stringify(n.params) === JSON.stringify({ removedSignIns: [] }))).toBe(true);
    });

    it("admins of a pending or approved reset cannot move the address, and a rejection is always allowed", async () => {
      const { subject } = await victim();
      const { aToken, bToken } = await adminPair();
      const proposed = await proposeReset(aToken, subject);
      expect(proposed.statusCode, proposed.body).toBe(200);

      // The reset's proposer cannot propose an email change of the same person...
      const byProposer = await proposeChange(aToken, subject, freshAddress("moved"));
      expect(byProposer.statusCode, byProposer.body).toBe(422);
      expect(byProposer.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");

      // ...nor approve one somebody else proposed; rejecting it is fine.
      const e = await adminSession(await person({ role: "mpc_operator" }));
      const change = await proposeChange(e, subject, freshAddress("moved"));
      expect(change.statusCode, change.body).toBe(200);
      const approve = await decideChange(aToken, change.json().id, 1, "approve");
      expect(approve.statusCode, approve.body).toBe(422);
      expect(approve.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
      expect((await decideChange(aToken, change.json().id, 1, "reject")).statusCode).toBe(200);

      // Once B approves the reset, B is bound too.
      expect((await decideReset(bToken, proposed.json().id, 1, "approve")).statusCode).toBe(200);
      const byDecider = await proposeChange(bToken, subject, freshAddress("moved"));
      expect(byDecider.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
    });

    it("an approved but not yet completed change already binds its admins", async () => {
      const { subject } = await victim();
      const { aToken, bToken } = await adminPair();
      const change = await proposeChange(aToken, subject, freshAddress("pending"));
      expect((await decideChange(bToken, change.json().id, 1, "approve")).statusCode).toBe(200);
      const res = await proposeReset(bToken, subject);
      expect(res.statusCode, res.body).toBe(422);
      expect(res.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
    });

    it("the separation lasts 30 days", async () => {
      const { subject } = await victim();
      const { aToken, bToken } = await adminPair();
      await moveAddress(aToken, bToken, subject, freshAddress("old-move"));
      await fx.sql`
        UPDATE core.email_change_requests
        SET requested_at = requested_at - interval '31 days', decided_at = decided_at - interval '31 days',
            completed_at = completed_at - interval '31 days'
        WHERE subject_id = ${subject}
      `;
      expect((await proposeReset(aToken, subject)).statusCode).toBe(200);
    });

    it("just past the 30-day separation the same pair may reset, and the old address is still told (0119)", async () => {
      const { subject, email: oldEmail } = await victim();
      const { aToken, bToken } = await adminPair();
      const attackerEmail = freshAddress("attacker");
      await moveAddress(aToken, bToken, subject, attackerEmail);
      const shift = async (age: string) => fx.sql`
        UPDATE core.email_change_requests
        SET requested_at = now() - ${age}::interval - interval '1 hour',
            decided_at = now() - ${age}::interval - interval '30 minutes',
            completed_at = now() - ${age}::interval
        WHERE subject_id = ${subject}
      `;
      await shift("30 days 1 minute");

      // The separation has lapsed: the pair who moved the address may now reset it.
      const proposed = await proposeReset(aToken, subject);
      expect(proposed.statusCode, proposed.body).toBe(200);
      const approved = await decideReset(bToken, proposed.json().id, 1, "approve");
      expect(approved.statusCode, approved.body).toBe(200);

      // But the owner hears of it at the address they were moved away from.
      const notices = await fx.sql<{ recipient: string }[]>`
        SELECT recipient FROM core.email_outbox
        WHERE template = 'mfa_reset_notice' AND recipient IN (${oldEmail}, ${attackerEmail})
      `;
      expect(notices.map((n) => n.recipient).sort()).toEqual([attackerEmail, oldEmail].sort());

      // The previous address is kept for those 90 days and forgotten after them.
      const kept = () => fx.sql`
        SELECT 1 FROM core.email_change_requests WHERE subject_id = ${subject} AND previous_email IS NOT NULL
      `;
      await shift("89 days");
      await fx.sql`SELECT * FROM core.purge_email_auth_records()`;
      expect(await kept()).toHaveLength(1);
      await shift("90 days 1 minute");
      await fx.sql`SELECT * FROM core.purge_email_auth_records()`;
      expect(await kept()).toHaveLength(0);
    });

    it("the application role cannot read a previous address (0119)", async () => {
      const { subject } = await victim();
      const { aToken, bToken } = await adminPair();
      await moveAddress(aToken, bToken, subject, freshAddress("moved"));
      for (const query of [
        "SELECT previous_email FROM core.email_change_requests",
        "SELECT * FROM core.email_change_requests",
      ]) {
        await expect(
          withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx.unsafe(query)),
        ).rejects.toThrow(/permission denied/);
      }
      // Every column the API shows is still readable, and the admin listing still works.
      const rows = await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
        SELECT id, tenant_id, subject_id, new_email, reason, requested_by_subject_id, requested_at, state,
               decided_by_subject_id, decided_at, decision_reason, completed_at, version
        FROM core.email_change_requests WHERE subject_id = ${subject}
      `);
      expect(rows).toHaveLength(1);
      const listing = await get("/api/v1/admin/email-changes", aToken);
      expect(listing.statusCode, listing.body).toBe(200);
      expect(JSON.stringify(listing.json())).not.toContain("previous");
    });

    it("the same recovery code from two sessions at once: one succeeds, the other is refused, no deadlock", async () => {
      // Interleaved by hand, so the outcome does not depend on timing: session 1's call holds its
      // locks while session 2's call starts, then session 1 spends the code — which revokes
      // session 2. Locking session before subject (0116) deadlocked here; subject first (0118)
      // makes session 2 wait, then find its session revoked.
      const subject = await person({ role: "data_steward" });
      const codes = (await enrolPasskey(await login(subject), authenticator())).recoveryCodes as string[];
      await login(subject);
      await login(subject);
      const sessions = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.sessions
        WHERE subject_id = ${subject} AND revoked_at IS NULL AND second_factor IS NULL
        ORDER BY issued_at DESC LIMIT 2
      `;
      const [s1, s2] = sessions.map((row) => row.id) as [string, string];
      const hash = hashRecoveryCode(normalizeRecoveryCode(codes[0]!)!);
      const first = await fx.sql.reserve();
      const second = await fx.sql.reserve();
      try {
        await first`BEGIN`;
        await first`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
        await first`SELECT core.mfa_status(${s1})`; // takes session 1's call locks and keeps them
        await second`BEGIN`;
        await second`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
        const racing = second`SELECT core.consume_recovery_code(${s2}, ${hash})`.then(
          () => "ok",
          (error: { code?: string; message: string }) => `${error.code}:${error.message}`,
        );
        // Wait until the second call is blocked on a lock.
        for (let i = 0; i < 100; i += 1) {
          const [waiting] = await fx.sql`
            SELECT count(*)::int AS n FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%consume_recovery_code%'
          `;
          if (waiting!.n > 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const spent = await first`SELECT core.consume_recovery_code(${s1}, ${hash}) AS revoked`.then(
          (rows) => `ok:${rows[0]!.revoked}`,
          (error: { code?: string; message: string }) => `${error.code}:${error.message}`,
        );
        await first`COMMIT`;
        expect(spent).toMatch(/^ok:\d+$/);
        const outcome = await racing;
        await second`ROLLBACK`;
        expect(outcome).not.toMatch(/40P01|deadlock/);
        expect(outcome).toMatch(/MFA_SESSION_INVALID/);
      } finally {
        first.release();
        second.release();
      }
    });
  });

  describe("subject creation time (0118)", () => {
    it("the application role cannot write created_at, and no subject is created in the future", async () => {
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`
            INSERT INTO core.subjects (id, tenant_id, kind, display_name, created_at)
            VALUES (${randomUUID()}, ${fx.tenantA}, 'person', 'Forever new', now() + interval '10 years')
          `,
        ),
      ).rejects.toThrow(/permission denied/);
      // Its own insert still works; the creation time is the database's.
      const id = randomUUID();
      await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
        tx`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${id}, ${fx.tenantA}, 'person', 'Now')`,
      );
      await expect(
        fx.sql`UPDATE core.subjects SET created_at = now() + interval '1 day' WHERE id = ${id}`,
      ).rejects.toThrow(/subjects_created_at_not_future/);
    });
  });

  // --- the database boundary ---------------------------------------------------------------------

  describe("a factor without proof is refused by the database", () => {
    it("refuses a spent TOTP step and another tenant's session at the database too", async () => {
      const subject = await person();
      const step = currentStep();
      await enrolTotp(await login(subject), step);
      await login(subject);
      const [row] = await fx.sql`
        SELECT s.id AS session, t.id AS totp FROM core.sessions s
        JOIN core.totp_authenticators t ON t.subject_id = s.subject_id AND t.confirmed_at IS NOT NULL
        WHERE s.subject_id = ${subject} AND s.second_factor IS NULL AND s.revoked_at IS NULL
      `;
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT * FROM core.complete_totp(${row!.session}, ${row!.totp}, ${step}, NULL)`,
        ),
      ).rejects.toThrow(/MFA_TOTP_REPLAYED/);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) =>
          tx`SELECT * FROM core.complete_totp(${row!.session}, ${row!.totp}, ${step + 1}, NULL)`,
        ),
      ).rejects.toThrow(/MFA_SESSION_INVALID/);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) => tx`SELECT * FROM core.mfa_status(${row!.session})`),
      ).rejects.toThrow(/MFA_SESSION_INVALID/);
    });

    it("the application role cannot write a factor onto a session", async () => {
      const subject = await person();
      const token = await login(subject);
      const [row] = await fx.sql`SELECT id FROM core.sessions WHERE subject_id = ${subject}`;
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`UPDATE core.sessions SET second_factor = 'passkey', second_factor_at = now() WHERE id = ${row!.id}`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`INSERT INTO core.session_factor_proofs (id, tenant_id, subject_id, session_id, factor, recovery_code_id)
             VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, ${row!.id}, 'recovery_code', ${randomUUID()})`,
        ),
      ).rejects.toThrow(/permission denied/);
      // Since 0121 the application role cannot call the general session function at all; the
      // function itself still refuses a stated second factor first, even to its owner.
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT core.create_subject_session(${randomUUID()}, ${`0x${"c".repeat(64)}`}, ${subject}, 'google', 'passkey', 3600)`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(fx.sql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT core.create_subject_session(${randomUUID()}, ${`0x${"c".repeat(64)}`}, ${subject}, 'google', 'passkey', 3600)`,
        ),
      ).rejects.toThrow(/starts at its first factor/);
      // Completing a ceremony needs a live challenge of the session; inventing one does not do.
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT core.complete_webauthn_authentication(${row!.id}, ${strayChallenge()}, 'x', 1, true)`,
        ),
      ).rejects.toThrow(/MFA_CHALLENGE_INVALID/);
      expect((await session(token)).aal).toBe("aal1");
    });

    it("even the table owner cannot set a factor without a matching proof", async () => {
      const subject = await person();
      await login(subject);
      const other = await person();
      const proven = await issueTestSession(fx.appSql, fx.tenantA, other, { firstFactor: "email_code", secondFactor: "passkey" });
      expect((await session(proven)).aal).toBe("aal3");
      const [target] = await fx.sql`SELECT id FROM core.sessions WHERE subject_id = ${subject}`;
      const [foreign] = await fx.sql`SELECT second_factor_proof_id AS id FROM core.sessions WHERE subject_id = ${other} AND second_factor IS NOT NULL`;

      // No proof at all.
      await expect(
        fx.sql`UPDATE core.sessions SET second_factor = 'passkey', second_factor_at = now() WHERE id = ${target!.id}`,
      ).rejects.toThrow(/violates check constraint/);
      // Another session's proof.
      await expect(
        fx.sql`UPDATE core.sessions SET second_factor = 'passkey', second_factor_at = now(),
                 second_factor_proof_id = ${foreign!.id} WHERE id = ${target!.id}`,
      ).rejects.toThrow(/violates foreign key constraint/);
      // A recovery session that claims not to be limited.
      const limited = await issueTestSession(fx.appSql, fx.tenantA, other, { firstFactor: "email_code", secondFactor: "recovery_code" });
      expect((await session(limited)).recoveryLimited).toBe(true);
      await expect(
        fx.sql`UPDATE core.sessions SET recovery_limited = false WHERE second_factor = 'recovery_code'`,
      ).rejects.toThrow(/violates check constraint/);
    });

    it("a session proved with a passkey that was later revoked stops resolving", async () => {
      const subject = await person();
      const key = authenticator();
      const main = await login(subject);
      await enrolPasskey(main, key);
      await fx.sql`UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'test' WHERE credential_id = ${key.id}`;
      expect(await alive(main)).toBe(false);
    });
  });

  it("other tenants see none of it", async () => {
    const subject = await person();
    await enrolPasskey(await login(subject), authenticator());
    const counts = await withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) => tx`
      SELECT (SELECT count(*) FROM core.webauthn_credentials WHERE subject_id = ${subject})::int AS passkeys,
             (SELECT count(*) FROM core.recovery_codes WHERE subject_id = ${subject})::int AS codes
    `);
    expect(counts[0]).toEqual({ passkeys: 0, codes: 0 });
  });
});
