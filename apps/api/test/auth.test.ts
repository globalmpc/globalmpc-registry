import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { privateKeyToAccount } from "viem/accounts";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { hashToken } from "../src/plugins/session-token.js";
import { bearer, issueTestSession, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("account sessions", () => {
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

  const session = (token: string) =>
    app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });

  it("stores only the token's hash", async () => {
    const token = await signIn(app, fx.operatorA);
    expect(await fx.sql`SELECT 1 FROM core.sessions WHERE token_hash = ${token}`).toHaveLength(0);
    expect(await fx.sql`SELECT 1 FROM core.sessions WHERE token_hash = ${hashToken(token)}`).toHaveLength(1);
  });

  it("invalidates the token on logout", async () => {
    const token = await signIn(app, fx.operatorA);
    expect((await session(token)).json().authenticated).toBe(true);

    await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: bearer(token) });

    expect((await session(token)).json().authenticated).toBe(false);
  });

  it("does not authenticate a forged token", async () => {
    expect((await session("forged-token-value")).json().authenticated).toBe(false);
  });

  it("returns authenticated=false without authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
    expect(response.statusCode).toBe(200);
    expect(response.json().authenticated).toBe(false);
  });

  it("gives a person their roles and tenant, and names no wallet", async () => {
    const body = (await session(await signIn(app, fx.operatorA))).json();
    expect(body.authenticated).toBe(true);
    expect(body.tenantId).toBe(fx.tenantA);
    expect(body.subjectId).toBe(fx.operatorSubjectA);
    expect(body.assuranceLevel).toBe("high_assurance");
    expect(body.firstFactor).toBe("email_code");
    expect(body.roleBindings.map((b: { role: string }) => b.role)).toContain("mpc_operator");
    // The wallet a SIWE session signed with was the only reason for these fields (WP7).
    expect(body).not.toHaveProperty("walletAddress");
    expect(body).not.toHaveProperty("chainId");
  });

  it("gives a first-factor-only session the narrow view without wallet fields either", async () => {
    const token = await issueTestSession(fx.appSql, fx.tenantA, fx.operatorSubjectA, { firstFactor: "email_code" });
    const body = (await session(token)).json();
    expect(body).toMatchObject({ authenticated: true, aal: "aal1", roleBindings: [] });
    expect(body).not.toHaveProperty("walletAddress");
    expect(body).not.toHaveProperty("chainId");
  });
});

/**
 * Wallet sign-in is gone (D3, WP7): the SIWE routes do not exist, and a wallet key signs nobody in.
 * What remains of a wallet is a signing key (`wallet-binding.test.ts`, `signing-wallets.test.ts`).
 */
describeDb("wallet sign-in removed", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  const key = privateKeyToAccount(`0x${"11".repeat(32)}`);

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  it.each([
    ["POST", "/api/v1/auth/siwe/nonce", { walletAddress: key.address.toLowerCase(), chainId: 31337 }],
    ["POST", "/api/v1/auth/siwe/verify", { message: "localhost:3000 wants you to sign in", signature: "0x00" }],
    ["GET", "/api/v1/auth/siwe/nonce", undefined],
  ] as const)("answers %s %s with 404 and issues nothing", async (method, url, payload) => {
    const before = await fx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM core.sessions`;
    const response = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("sessionToken");
    const after = await fx.sql<{ count: number }[]>`SELECT count(*)::int AS count FROM core.sessions`;
    expect(after[0]!.count).toBe(before[0]!.count);
  });

  it("keeps no nonce table to fill", async () => {
    const [row] = await fx.sql<{ exists: boolean }[]>`SELECT to_regclass('core.siwe_nonces') IS NOT NULL AS exists`;
    expect(row!.exists).toBe(false);
  });

  it("does not authenticate a wallet address placed in the header", async () => {
    // The R0 development path was removed. The address is treated as a token and the lookup fails.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: bearer(fx.operatorA.address),
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * Production configuration. `OBJECT_STORE=memory` is rejected in production, so the store is
   * filled with valid values; only the client is created, no network is used.
   */
  const productionEnv = () =>
    testEnv({
      NODE_ENV: "production",
      OBJECT_STORE: "s3",
      OBJECT_BUCKET: "test-bucket",
      OBJECT_REGION: "us-east-1",
      WEB_ORIGIN: "https://registry.example.com",
      WEBAUTHN_RP_ID: "registry.example.com",
      WEBAUTHN_ORIGIN: "https://registry.example.com",
    });

  it("accepts account sessions in production", async () => {
    const app2 = await buildServer(loadConfig(productionEnv()), fx.appSql);
    const token = await signIn(app2, fx.operatorA);
    const response = await app2.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
    expect(response.json()).toMatchObject({ authenticated: true, firstFactor: "email_code", aal: "aal3" });
    await app2.close();
  });

  it("refuses to start a deployment that still asks for wallet sign-in", () => {
    expect(() => loadConfig({ ...productionEnv(), LEGACY_WALLET_LOGIN: "1" })).toThrow(/LEGACY_WALLET_LOGIN/);
    expect(() => loadConfig(testEnv({ LEGACY_WALLET_LOGIN: "1" }))).toThrow(/wallet sign-in was removed/);
  });
});

/**
 * `GET /api/v1/auth/sessions`, `POST /api/v1/auth/sessions/{id}/revocation` (0126): a person sees
 * and ends only their own sessions.
 */
describeDb("own sessions", () => {
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

  const list = (token: string) =>
    app.inject({ method: "GET", url: "/api/v1/auth/sessions", headers: bearer(token) });
  const revoke = (token: string, id: string) =>
    app.inject({ method: "POST", url: `/api/v1/auth/sessions/${id}/revocation`, headers: bearer(token) });
  const sessionIdOf = async (token: string) => {
    const [row] = await fx.sql<{ id: string }[]>`SELECT id FROM core.sessions WHERE token_hash = ${hashToken(token)}`;
    return row!.id;
  };
  const authenticated = async (token: string) =>
    (await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) })).json().authenticated;

  it("lists the caller's live sessions, marks the current one, and carries no token", async () => {
    const mine = await signIn(app, fx.approverA);
    const other = await signIn(app, fx.approverA);
    const ended = await signIn(app, fx.approverA);
    await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: bearer(ended) });
    // Someone else's session in the same tenant never appears.
    const stranger = await signIn(app, fx.reviewerA);

    const response = await list(mine);
    expect(response.statusCode).toBe(200);
    const items = response.json().items as { id: string; current: boolean }[];
    const ids = items.map((item) => item.id);
    expect(ids).toContain(await sessionIdOf(mine));
    expect(ids).toContain(await sessionIdOf(other));
    expect(ids).not.toContain(await sessionIdOf(ended));
    expect(ids).not.toContain(await sessionIdOf(stranger));
    expect(items.filter((item) => item.current).map((item) => item.id)).toEqual([await sessionIdOf(mine)]);
    expect(items.find((item) => item.current)).toMatchObject({
      firstFactor: "email_code",
      secondFactor: "passkey",
      createdAt: expect.any(String),
      expiresAt: expect.any(String),
    });
    for (const secret of [mine, other, hashToken(mine), hashToken(other)]) {
      expect(response.body).not.toContain(secret);
    }
  });

  it("ends another session of the caller, records it, and answers a second time without change", async () => {
    const mine = await signIn(app, fx.auditorA);
    const other = await signIn(app, fx.auditorA);
    const otherId = await sessionIdOf(other);

    const first = await revoke(mine, otherId);
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ id: otherId, revoked: true, current: false });
    expect(await authenticated(other)).toBe(false);
    expect(await authenticated(mine)).toBe(true);
    const [row] = await fx.sql<{ revoked_reason: string }[]>`SELECT revoked_reason FROM core.sessions WHERE id = ${otherId}`;
    expect(row!.revoked_reason).toBe("revoked_by_holder");
    const audit = await fx.sql`
      SELECT 1 FROM audit.events WHERE command = 'auth.session.revoked' AND resource_id = ${otherId}
    `;
    expect(audit).toHaveLength(1);

    const again = await revoke(mine, otherId);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ id: otherId, revoked: false });
  });

  it("can end the caller's own session — a sign-out", async () => {
    const mine = await signIn(app, fx.auditorA);
    const response = await revoke(mine, await sessionIdOf(mine));
    expect(response.json()).toMatchObject({ revoked: true, current: true });
    expect(await authenticated(mine)).toBe(false);
  });

  it("knows its own session however the id is spelt, and records it so", async () => {
    const mine = await signIn(app, fx.auditorA);
    const id = await sessionIdOf(mine);
    const response = await revoke(mine, id.toUpperCase());
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id, revoked: true, current: true });
    const [audit] = await fx.sql<{ detail: { current: boolean } }[]>`
      SELECT detail FROM audit.events WHERE command = 'auth.session.revoked' AND resource_id = ${id}
    `;
    expect(audit!.detail.current).toBe(true);
  });

  it("cannot end another person's session, in this tenant or another, and says nothing about it", async () => {
    const mine = await signIn(app, fx.disclosureApproverA);
    const neighbour = await signIn(app, fx.stewardA);
    const foreign = await signIn(app, fx.operatorB);
    const unknown = "00000000-0000-4000-8000-000000000000";

    const answers = [];
    for (const target of [await sessionIdOf(neighbour), await sessionIdOf(foreign), unknown]) {
      const response = await revoke(mine, target);
      expect(response.statusCode, target).toBe(404);
      answers.push(response.json().code);
    }
    // One answer for "someone else's" and "no such session".
    expect(new Set(answers).size).toBe(1);
    expect(await authenticated(neighbour)).toBe(true);
    expect(await authenticated(foreign)).toBe(true);
    // Not an id at all: refused before any lookup, as on every route.
    expect((await revoke(mine, "not-a-session")).json().code).toBe("PATH_PARAM_INVALID");
  });

  it("needs a second factor, and is refused to a service token and to nobody", async () => {
    const firstFactorOnly = await issueTestSession(fx.appSql, fx.tenantA, fx.operatorSubjectA, { firstFactor: "email_code" });
    const target = await sessionIdOf(await signIn(app, fx.operatorA));
    expect((await list(firstFactorOnly)).json().code).toBe("MFA_REQUIRED");
    expect((await revoke(firstFactorOnly, target)).json().code).toBe("MFA_REQUIRED");

    const recovering = await issueTestSession(fx.appSql, fx.tenantA, fx.operatorSubjectA, {
      firstFactor: "email_code",
      secondFactor: "recovery_code",
    });
    expect((await revoke(recovering, target)).statusCode).toBe(403);

    expect((await list(fx.scanServiceToken)).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/v1/auth/sessions" })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url: `/api/v1/auth/sessions/${target}/revocation` })).statusCode).toBe(401);
  });

  it("refuses at the database a caller session from another tenant", async () => {
    const foreign = await sessionIdOf(await signIn(app, fx.operatorB));
    const target = await sessionIdOf(await signIn(app, fx.operatorA));
    await expect(
      fx.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
        return tx`SELECT core.revoke_own_session(${foreign}, ${target})`;
      }),
    ).rejects.toThrow(/MFA_SESSION_INVALID/);
    await expect(
      fx.appSql.begin(async (tx) => {
        await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
        return tx`SELECT * FROM core.list_own_sessions(${foreign})`;
      }),
    ).rejects.toThrow(/MFA_SESSION_INVALID/);
  });
});
