import { randomBytes } from "node:crypto";
import { hashToken } from "../src/plugins/session-token.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { withTenant } from "@mpc/db";
import { bearer, issueTestSession, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";

describe.skipIf(!process.env.DATABASE_URL)("account sessions without Registry factors", () => {
  let fx: TestFixture;
  let app: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });
  afterAll(async () => { await app.close(); await fx.close(); });

  it("accepts a verified admin and exposes no enrolment, challenge or reset API", async () => {
    const token = await issueTestSession(fx.appSql, fx.tenantA, fx.operatorSubjectA, { firstFactor: "email_code" });
    const headers = bearer(token);
    expect((await app.inject({ url: "/api/v1/admin/subjects", headers })).statusCode).toBe(200);
    for (const url of ["/api/v1/auth/mfa/passkeys/registration/options", "/api/v1/auth/mfa/totp/setup",
      "/api/v1/auth/mfa/recovery-codes/verify", "/api/v1/admin/mfa-resets"]) {
      expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(404);
    }
  });

  it("lets a previous API task start a passkey challenge after migration", async () => {
    await issueTestSession(fx.appSql, fx.tenantA, fx.operatorSubjectA, { firstFactor: "email_code", secondFactor: "passkey" });
    const token = await issueTestSession(fx.appSql, fx.tenantA, fx.operatorSubjectA, { firstFactor: "email_code" });
    const [session] = await fx.sql`SELECT id FROM core.sessions WHERE token_hash=${hashToken(token)}`;
    const [privileges] = await fx.appSql`
      SELECT rolsuper, rolbypassrls, has_function_privilege(current_user,
        'core.decide_mfa_reset(uuid,uuid,boolean,text,integer)', 'EXECUTE') AS can_reset
      FROM pg_roles WHERE rolname=current_user`;
    expect(privileges).toMatchObject({ rolsuper: false, rolbypassrls: false, can_reset: true });
    await withTenant(fx.appSql, { tenantId: fx.tenantA }, async tx => {
      const challenge = randomBytes(32).toString("base64url");
      await tx`SELECT core.create_webauthn_challenge(${session!.id}, 'authentication', ${challenge})`;
      const rows = await tx`SELECT core.live_webauthn_challenge(${session!.id}, 'authentication') AS challenge`;
      expect(rows[0]?.challenge).toBe(challenge);
    });
  });
});
