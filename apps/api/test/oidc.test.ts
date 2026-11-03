import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { generateInvitationToken } from "../src/account-crypto.js";
import { hashToken } from "../src/plugins/session-token.js";
import { bearer, issueTestSession, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";
import {
  MockOidcProvider,
  TEST_GOOGLE_CLIENT,
  TEST_MICROSOFT_CLIENT,
  type AuthorizeOptions,
} from "./helpers/mock-oidc.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/** Directories the API is configured to accept (`MICROSOFT_ALLOWED_TENANTS`). */
const TID_ALLOWED = "11111111-1111-4111-8111-111111111111";
const TID_ALSO_ALLOWED = "22222222-2222-4222-8222-222222222222";
const TID_OTHER = "33333333-3333-4333-8333-333333333333";

const oidcEnv = (overrides: Record<string, string> = {}) =>
  testEnv({
    GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT.id,
    GOOGLE_CLIENT_SECRET: TEST_GOOGLE_CLIENT.secret,
    MICROSOFT_CLIENT_ID: TEST_MICROSOFT_CLIENT.id,
    MICROSOFT_CLIENT_SECRET: TEST_MICROSOFT_CLIENT.secret,
    MICROSOFT_ALLOWED_TENANTS: `${TID_ALLOWED},${TID_ALSO_ALLOWED}`,
    ...overrides,
  });

type Provider = "google" | "microsoft";

/**
 * Google and Microsoft sign-in — account authentication WP4.
 *
 * Every request goes through the real `openid-client` flow against an in-process provider
 * (`helpers/mock-oidc.ts`) that signs with its own keys: discovery, keys, the code exchange with
 * PKCE, and ID-token validation all run as in production. One test (at least) per property:
 *
 * - `state` is single use, bound to the browser that started the flow and, for a link, to the
 *   session that started it; a nonce, audience, issuer, expiry, signature or `azp` that is not
 *   ours is refused; the code is bound to this flow's PKCE verifier;
 * - Microsoft: `iss` must name the token's own `tid`; a directory outside the allowlist, or a
 *   personal account, is refused;
 * - sign-in works only for a linked identity; a token whose email matches an account never signs
 *   in, links or creates anything;
 * - linking needs aal2, comes back to the same session, and an identity linked anywhere gets one
 *   generic code; unlinking needs aal2, ends the sessions the identity signed in, and never
 *   removes the last way in;
 * - an invitation is accepted with a provider only for the address the provider verified;
 * - a Google / Microsoft session is aal1 (MFA_REQUIRED elsewhere), and the application role
 *   cannot mint one without a completed transaction;
 * - the provider's own error text is never echoed;
 * - nothing crosses tenants.
 */
describeDb("Google and Microsoft sign-in (WP4)", { timeout: 30_000 }, () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let idp: MockOidcProvider;
  let ipCounter = 0;

  beforeAll(async () => {
    fx = await setupFixture();
    idp = await MockOidcProvider.create();
    app = await buildServer(loadConfig(oidcEnv()), fx.appSql, { oidcFetch: idp.fetch });
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  // A fresh public-looking address per request, so the per-IP start limit of one test does not
  // reach another (`rate limit` below uses a fixed one).
  const freshIp = () =>
    `100.${64 + Math.floor(Math.random() * 64)}.${Math.floor(Math.random() * 256)}.${(ipCounter++ % 254) + 1}`;

  const post = (url: string, payload?: unknown, headers: Record<string, string> = {}, ip = freshIp()) =>
    app.inject({ method: "POST", url, ...(payload === undefined ? {} : { payload: payload as never }), headers, remoteAddress: ip });
  const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: bearer(token) });

  interface Started {
    authorizationUrl: string;
    browserBinding: string;
    expiresAt: string;
  }

  async function startSignIn(provider: Provider, body: Record<string, unknown> = { purpose: "sign_in" }): Promise<Started> {
    const response = await post(`/api/v1/auth/oidc/${provider}/start`, body);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Started;
  }

  async function startLink(provider: Provider, token: string): Promise<Started> {
    const response = await post(`/api/v1/auth/oidc/${provider}/link/start`, undefined, bearer(token));
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as Started;
  }

  /** The provider approves the flow and the redirect page posts the result to `route`. */
  function finish(provider: Provider, started: Started, options: AuthorizeOptions = {}, token?: string) {
    const { code, state } = idp.authorize(started.authorizationUrl, options);
    const route = token === undefined ? "callback" : "link/callback";
    return post(
      `/api/v1/auth/oidc/${provider}/${route}`,
      { state, code, browserBinding: started.browserBinding },
      token === undefined ? {} : bearer(token),
    );
  }

  /** A person in tenant A (or `tenantId`) with an address and no role. */
  async function person(tenantId = fx.tenantA, email: string | null = `p-${randomUUID().slice(0, 8)}@example.com`) {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, email)
      VALUES (${id}, ${tenantId}, 'person', 'OIDC Person', ${email})
    `;
    return { id, email };
  }

  /** An aal2 session (email code + TOTP) of a new person. */
  async function aal2Person(tenantId = fx.tenantA) {
    const subject = await person(tenantId);
    const token = await issueTestSession(fx.appSql, tenantId, subject.id, { firstFactor: "email_code", secondFactor: "totp" });
    return { ...subject, token };
  }

  /** Links an identity to `token`'s subject through the API. */
  async function link(provider: Provider, token: string, claims: Record<string, unknown> = {}) {
    const response = await finish(provider, await startLink(provider, token), { claims }, token);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; provider: Provider; issuer: string; idpTenant: string | null };
  }

  const googleSub = () => `${Math.floor(Math.random() * 1e15)}${Math.floor(Math.random() * 1e6)}`;

  async function sessionOf(token: string) {
    return (await get("/api/v1/auth/session", token)).json();
  }

  // --- Sign-in --------------------------------------------------------------

  describe("sign-in", () => {
    it("signs a linked Google identity in at aal1; everything but MFA is refused", async () => {
      const holder = await aal2Person();
      const sub = googleSub();
      await link("google", holder.token, { sub });

      const response = await finish("google", await startSignIn("google"), { claims: { sub } });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ subjectId: holder.id, firstFactor: "google", secondFactor: null, aal: "aal1", mfaSatisfied: false });
      expect(body.roleBindings).toEqual([]);

      const denied = await get("/api/v1/projects", body.sessionToken);
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toMatchObject({ code: "MFA_REQUIRED", details: { requiredAal: "aal2" } });
      expect((await get("/api/v1/auth/mfa", body.sessionToken)).statusCode).toBe(200);
      // Not even the identity list: it says how the account can be reached.
      expect((await get("/api/v1/auth/identities", body.sessionToken)).statusCode).toBe(403);

      const audits = await fx.sql<{ command: string; detail: Record<string, unknown> }[]>`
        SELECT command, detail FROM audit.events
        WHERE actor_subject_id = ${holder.id} AND command IN ('auth.oidc.signed_in', 'auth.session.created')
        ORDER BY id
      `;
      expect(audits.map((row) => row.command)).toEqual(["auth.oidc.signed_in", "auth.session.created"]);
      expect(audits[1]!.detail).toMatchObject({ firstFactor: "google", aal: "aal1" });
    });

    it("signs a linked Microsoft identity in by (tid, oid), whatever its sub", async () => {
      const holder = await aal2Person();
      const oid = randomUUID();
      const linked = await link("microsoft", holder.token, { oid, tid: TID_ALSO_ALLOWED, iss: `https://login.microsoftonline.com/${TID_ALSO_ALLOWED}/v2.0` });
      expect(linked).toMatchObject({ provider: "microsoft", idpTenant: TID_ALSO_ALLOWED, issuer: `https://login.microsoftonline.com/${TID_ALSO_ALLOWED}/v2.0` });

      const response = await finish("microsoft", await startSignIn("microsoft"), {
        claims: { oid, tid: TID_ALSO_ALLOWED, iss: `https://login.microsoftonline.com/${TID_ALSO_ALLOWED}/v2.0`, sub: "another-pairwise-sub" },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ subjectId: holder.id, firstFactor: "microsoft", aal: "aal1" });

      // The same oid in another directory is another identity: not linked, not signed in.
      const elsewhere = await finish("microsoft", await startSignIn("microsoft"), {
        claims: { oid, tid: TID_ALLOWED, iss: `https://login.microsoftonline.com/${TID_ALLOWED}/v2.0` },
      });
      expect(elsewhere.statusCode).toBe(401);
      expect(elsewhere.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
    });

    it("never signs in, links or creates anything by email — even a verified one that an account holds", async () => {
      const holder = await aal2Person();
      await link("google", holder.token, { sub: googleSub() });
      // This file's tenants only: other test files create identities and people concurrently.
      const identities = async () =>
        (await fx.sql`SELECT count(*)::int AS n FROM core.external_identities WHERE tenant_id IN (${fx.tenantA}, ${fx.tenantB})`)[0]!.n as number;
      const people = async () =>
        (await fx.sql`SELECT count(*)::int AS n FROM core.subjects WHERE tenant_id IN (${fx.tenantA}, ${fx.tenantB})`)[0]!.n as number;
      const countBefore = await identities();
      const subjectsBefore = await people();

      const google = await finish("google", await startSignIn("google"), {
        claims: { sub: googleSub(), email: holder.email, email_verified: true },
      });
      expect(google.statusCode).toBe(401);
      expect(google.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");

      // Plan §5: a Microsoft token with a matching email (and upn) but an unknown oid.
      const microsoft = await finish("microsoft", await startSignIn("microsoft"), {
        claims: { email: holder.email, preferred_username: holder.email, upn: holder.email, xms_edov: true },
      });
      expect(microsoft.statusCode).toBe(401);
      expect(microsoft.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
      // The same answer as for an address nobody holds.
      const nobody = await finish("google", await startSignIn("google"), { claims: { email: "nobody@example.com" } });
      expect(nobody.json()).toMatchObject({ code: "OIDC_ACCOUNT_NOT_FOUND", message: google.json().message });

      expect(await identities()).toBe(countBefore);
      expect(await people()).toBe(subjectsBefore);
      expect(await fx.sql`SELECT 1 FROM core.sessions WHERE subject_id = ${holder.id} AND first_factor IN ('google', 'microsoft')`).toHaveLength(0);
    });

    it("a suspended person's identity answers as one nobody linked, even while still live (0127)", async () => {
      const holder = await aal2Person();
      const sub = googleSub();
      await link("google", holder.token, { sub });
      // Suspension revokes identities; here the identity is left live to test the sign-in itself.
      await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${holder.id}`;
      const response = await finish("google", await startSignIn("google"), { claims: { sub } });
      const nobody = await finish("google", await startSignIn("google"), { claims: { sub: googleSub() } });
      expect(response.statusCode).toBe(nobody.statusCode);
      expect(response.json()).toMatchObject({ code: "OIDC_ACCOUNT_NOT_FOUND", message: nobody.json().message });
      expect(await fx.sql`SELECT 1 FROM core.sessions WHERE subject_id = ${holder.id} AND first_factor = 'google'`).toHaveLength(0);
    });

    it("an unlinked identity no longer signs in", async () => {
      const holder = await aal2Person();
      const sub = googleSub();
      const linked = await link("google", holder.token, { sub });
      await fx.sql`UPDATE core.external_identities SET revoked_at = now(), revoked_reason = 'test' WHERE id = ${linked.id}`;
      const response = await finish("google", await startSignIn("google"), { claims: { sub } });
      expect(response.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
    });
  });

  // --- The flow itself ------------------------------------------------------

  describe("state, binding, PKCE and the ID token", () => {
    let sub: string;
    beforeAll(async () => {
      const holder = await aal2Person();
      sub = googleSub();
      await link("google", holder.token, { sub });
    });

    it("sends the browser off with the code flow, PKCE S256, state, nonce and the exact redirect URI", async () => {
      const started = await startSignIn("google");
      const url = new URL(started.authorizationUrl);
      expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        client_id: TEST_GOOGLE_CLIENT.id,
        response_type: "code",
        code_challenge_method: "S256",
        redirect_uri: "http://localhost:3000/auth/oidc/google/callback",
        scope: "openid email profile",
      });
      expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(url.searchParams.get("nonce")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.browserBinding).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started.browserBinding).not.toBe(url.searchParams.get("state"));
      // Nothing secret is stored in the clear: state, binding and nonce only as hashes.
      const [row] = await fx.sql<{ state_hash: string; binding_hash: string; secret_ciphertext: Buffer }[]>`
        SELECT state_hash, binding_hash, secret_ciphertext FROM core.oidc_login_transactions
        ORDER BY created_at DESC LIMIT 1
      `;
      expect(row!.state_hash).not.toContain(url.searchParams.get("state"));
      expect(row!.secret_ciphertext.toString("utf8")).not.toContain(url.searchParams.get("nonce")!);
    });

    it("refuses an unknown state, and a state used once (replay)", async () => {
      const started = await startSignIn("google");
      const { code, state } = idp.authorize(started.authorizationUrl, { claims: { sub } });

      const unknown = await post("/api/v1/auth/oidc/google/callback", {
        state: "A".repeat(43), code, browserBinding: started.browserBinding,
      });
      expect(unknown.statusCode).toBe(401);
      expect(unknown.json().code).toBe("OIDC_STATE_INVALID");

      const first = await post("/api/v1/auth/oidc/google/callback", { state, code, browserBinding: started.browserBinding });
      expect(first.statusCode, first.body).toBe(200);
      const replay = await post("/api/v1/auth/oidc/google/callback", { state, code, browserBinding: started.browserBinding });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().code).toBe("OIDC_STATE_INVALID");
    });

    it("refuses a callback from another browser (login CSRF) without spending the state", async () => {
      const started = await startSignIn("google");
      const { code, state } = idp.authorize(started.authorizationUrl, { claims: { sub } });
      const forged = await post("/api/v1/auth/oidc/google/callback", { state, code, browserBinding: "B".repeat(43) });
      expect(forged.statusCode).toBe(401);
      expect(forged.json().code).toBe("OIDC_STATE_INVALID");
      // The real browser still finishes its own flow.
      const real = await post("/api/v1/auth/oidc/google/callback", { state, code, browserBinding: started.browserBinding });
      expect(real.statusCode, real.body).toBe(200);
    });

    it("refuses a state started for the other provider", async () => {
      const started = await startSignIn("google");
      const { code, state } = idp.authorize(started.authorizationUrl, { claims: { sub } });
      const crossed = await post("/api/v1/auth/oidc/microsoft/callback", { state, code, browserBinding: started.browserBinding });
      expect(crossed.json().code).toBe("OIDC_STATE_INVALID");
    });

    it("refuses an expired state and spends it", async () => {
      const started = await startSignIn("google");
      const { code, state } = idp.authorize(started.authorizationUrl, { claims: { sub } });
      await fx.sql`
        UPDATE core.oidc_login_transactions
        SET created_at = created_at - interval '11 minutes', expires_at = expires_at - interval '11 minutes'
        WHERE state_hash = encode(sha256(${state}::bytea), 'hex')
      `;
      const late = await post("/api/v1/auth/oidc/google/callback", { state, code, browserBinding: started.browserBinding });
      expect(late.json().code).toBe("OIDC_STATE_INVALID");
      const [row] = await fx.sql<{ claimed_at: Date | null; secret_ciphertext: Buffer | null }[]>`
        SELECT claimed_at, secret_ciphertext FROM core.oidc_login_transactions WHERE state_hash = encode(sha256(${state}::bytea), 'hex')
      `;
      expect(row!.claimed_at).not.toBeNull();
      expect(row!.secret_ciphertext).toBeNull();
    });

    it("refuses a code issued for another flow: PKCE binds it to this one", async () => {
      const mine = await startSignIn("google");
      const theirs = await startSignIn("google");
      const { code } = idp.authorize(theirs.authorizationUrl, { claims: { sub } });
      const { state } = idp.authorize(mine.authorizationUrl, { claims: { sub } });
      const swapped = await post("/api/v1/auth/oidc/google/callback", { state, code, browserBinding: mine.browserBinding });
      expect(swapped.statusCode).toBe(401);
      expect(swapped.json().code).toBe("OIDC_TOKEN_INVALID");
      // The provider's error text is not echoed.
      expect(swapped.body).not.toContain("provider text");
      expect(swapped.body).not.toContain("invalid_grant");
    });

    const refusedTokens: [string, AuthorizeOptions][] = [
      ["a nonce that is not this flow's", { claims: { nonce: "x".repeat(43) } }],
      ["no nonce", { claims: { nonce: undefined } }],
      ["another audience", { claims: { aud: "someone-elses-client" } }],
      ["our audience among others, without azp", { claims: { aud: [TEST_GOOGLE_CLIENT.id, "other-client"] } }],
      ["an azp that is another client", { claims: { azp: "other-client" } }],
      ["an expired token", { claims: { exp: Math.floor(Date.now() / 1000) - 3600, iat: Math.floor(Date.now() / 1000) - 7200 } }],
      ["another issuer", { claims: { iss: "https://accounts.google.example" } }],
      ["the issuer without its scheme", { claims: { iss: "accounts.google.com" } }],
      ["a signature from a key that is not the provider's", { signWithRogueKey: true }],
    ];
    for (const [label, options] of refusedTokens) {
      it(`refuses an ID token with ${label}`, async () => {
        const response = await finish("google", await startSignIn("google"), { ...options, claims: { sub, ...options.claims } });
        expect(response.statusCode, response.body).toBe(401);
        expect(response.json().code).toBe("OIDC_TOKEN_INVALID");
        expect(response.json().message).not.toMatch(/nonce|aud|iss|signature/i);
      });
    }

    it("the contrast: the same identity with an honest token signs in", async () => {
      const response = await finish("google", await startSignIn("google"), { claims: { sub } });
      expect(response.statusCode, response.body).toBe(200);
    });
  });

  describe("Microsoft directories", () => {
    const ms = (tid: string, extra: Record<string, unknown> = {}) => ({
      claims: { tid, iss: `https://login.microsoftonline.com/${tid}/v2.0`, ...extra },
    });

    it("refuses a token whose iss names another directory than its tid", async () => {
      const holder = await aal2Person();
      const oid = randomUUID();
      await link("microsoft", holder.token, { oid });
      const response = await finish("microsoft", await startSignIn("microsoft"), {
        claims: { oid, tid: TID_ALLOWED, iss: `https://login.microsoftonline.com/${TID_ALSO_ALLOWED}/v2.0` },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("OIDC_TOKEN_INVALID");
      // A token without tid cannot fill the issuer template at all.
      const noTid = await finish("microsoft", await startSignIn("microsoft"), { claims: { oid, tid: undefined } });
      expect(noTid.json().code).toBe("OIDC_TOKEN_INVALID");
      // The contrast: the same oid and the matching issuer.
      const ok = await finish("microsoft", await startSignIn("microsoft"), ms(TID_ALLOWED, { oid }));
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("refuses a directory outside MICROSOFT_ALLOWED_TENANTS, and personal accounts", async () => {
      const outside = await finish("microsoft", await startSignIn("microsoft"), ms(TID_OTHER));
      expect(outside.statusCode).toBe(403);
      expect(outside.json().code).toBe("OIDC_TENANT_NOT_ALLOWED");
      const consumer = await finish("microsoft", await startSignIn("microsoft"), ms("9188040d-6c67-4c5b-b112-36a304b66dad"));
      expect(consumer.json().code).toBe("OIDC_TENANT_NOT_ALLOWED");
    });

    it("without an allowlist any work or school directory may sign in (once linked)", async () => {
      const open = await buildServer(loadConfig(oidcEnv({ MICROSOFT_ALLOWED_TENANTS: "" })), fx.appSql, { oidcFetch: idp.fetch });
      try {
        const holder = await aal2Person();
        const oid = randomUUID();
        const started = await open.inject({ method: "POST", url: "/api/v1/auth/oidc/microsoft/link/start", headers: bearer(holder.token), remoteAddress: freshIp() });
        const { code, state } = idp.authorize(started.json().authorizationUrl, ms(TID_OTHER, { oid }));
        const linked = await open.inject({
          method: "POST", url: "/api/v1/auth/oidc/microsoft/link/callback", headers: bearer(holder.token), remoteAddress: freshIp(),
          payload: { state, code, browserBinding: started.json().browserBinding },
        });
        expect(linked.statusCode, linked.body).toBe(200);
        expect(linked.json().idpTenant).toBe(TID_OTHER);
      } finally {
        await open.close();
      }
    });
  });

  describe("provider errors", () => {
    it("maps access_denied and any other error to generic codes, never echoing the provider, and spends the state", async () => {
      const started = await startSignIn("google");
      const { state } = idp.authorize(started.authorizationUrl);
      const denied = await post("/api/v1/auth/oidc/google/callback", {
        state, browserBinding: started.browserBinding, error: "access_denied", error_description: "<b>user said no</b>",
      });
      expect(denied.statusCode).toBe(401);
      expect(denied.json().code).toBe("OIDC_ACCESS_DENIED");
      expect(denied.body).not.toContain("user said no");
      const again = await post("/api/v1/auth/oidc/google/callback", { state, browserBinding: started.browserBinding, error: "access_denied" });
      expect(again.json().code).toBe("OIDC_STATE_INVALID");

      const other = await startSignIn("google");
      const otherState = new URL(other.authorizationUrl).searchParams.get("state")!;
      const failed = await post("/api/v1/auth/oidc/google/callback", {
        state: otherState, browserBinding: other.browserBinding, error: "temporarily_unavailable", error_description: "<script>x</script>",
      });
      expect(failed.json().code).toBe("OIDC_PROVIDER_ERROR");
      expect(failed.body).not.toContain("script");
      expect(failed.body).not.toContain("temporarily_unavailable");
    });

    it("refuses an error that is not an OAuth error code", async () => {
      const started = await startSignIn("google");
      const state = new URL(started.authorizationUrl).searchParams.get("state")!;
      const response = await post("/api/v1/auth/oidc/google/callback", {
        state, browserBinding: started.browserBinding, error: "<img src=x>",
      });
      expect(response.statusCode).toBe(400);
    });
  });

  // --- Linking and unlinking --------------------------------------------------

  describe("linking", () => {
    it("needs a session past its second factor", async () => {
      const subject = await person();
      const aal1 = await issueTestSession(fx.appSql, fx.tenantA, subject.id, { firstFactor: "email_code" });
      const refused = await post("/api/v1/auth/oidc/google/link/start", undefined, bearer(aal1));
      expect(refused.statusCode).toBe(403);
      expect(refused.json().code).toBe("MFA_REQUIRED");
      const anonymous = await post("/api/v1/auth/oidc/google/link/start");
      expect(anonymous.statusCode).toBe(401);

      // The database refuses a first-factor session on its own too.
      const [session] = await fx.sql<{ id: string }[]>`SELECT id FROM core.sessions WHERE token_hash = ${hashToken(aal1)}`;
      const [started] = await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx<{ status: string }[]>`
        SELECT status FROM core.start_oidc_transaction(
          ${randomUUID()}, 'google', 'link', ${"a".repeat(64)}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${Buffer.alloc(40)},
          'http://localhost:3000/auth/oidc/google/callback', ${session!.id}, NULL, NULL, ${randomUUID()}
        )
      `);
      expect(started!.status).toBe("step_up_required");
    });

    it("links to the session's subject and lists it", async () => {
      const holder = await aal2Person();
      const linked = await link("google", holder.token, { sub: googleSub(), email: "shown@gmail.example" });
      expect(linked).toMatchObject({ provider: "google", issuer: "https://accounts.google.com", idpTenant: null });
      const list = (await get("/api/v1/auth/identities", holder.token)).json();
      expect(list.items).toEqual([expect.objectContaining({ id: linked.id, linkedVia: "link", revokedAt: null })]);
      // Only a keyed hash of the address the provider reported is kept.
      const [row] = await fx.sql<{ email_hash: string }[]>`SELECT email_hash FROM core.external_identities WHERE id = ${linked.id}`;
      expect(row!.email_hash).toMatch(/^[0-9a-f]{64}$/);
      const [audit] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'auth.oidc.identity_linked' AND resource_id = ${linked.id}
      `;
      expect(JSON.stringify(audit!.detail)).not.toContain("shown@gmail.example");
    });

    it("comes back only on the session that started it", async () => {
      const holder = await aal2Person();
      const other = await issueTestSession(fx.appSql, fx.tenantA, holder.id, { firstFactor: "email_code", secondFactor: "totp" });
      const started = await startLink("google", holder.token);
      const { code, state } = idp.authorize(started.authorizationUrl);
      const body = { state, code, browserBinding: started.browserBinding };

      expect((await post("/api/v1/auth/oidc/google/link/callback", body, bearer(other))).json().code).toBe("OIDC_STATE_INVALID");
      // A link state on the public callback does not sign anyone in.
      expect((await post("/api/v1/auth/oidc/google/callback", body)).json().code).toBe("OIDC_STATE_INVALID");
      expect((await post("/api/v1/auth/oidc/google/link/callback", body)).statusCode).toBe(401);
      const done = await post("/api/v1/auth/oidc/google/link/callback", body, bearer(holder.token));
      expect(done.statusCode, done.body).toBe(200);
    });

    it("a sign-in state on the link callback does not link", async () => {
      const holder = await aal2Person();
      const started = await startSignIn("google");
      const { code, state } = idp.authorize(started.authorizationUrl);
      const response = await post("/api/v1/auth/oidc/google/link/callback", { state, code, browserBinding: started.browserBinding }, bearer(holder.token));
      expect(response.json().code).toBe("OIDC_STATE_INVALID");
    });

    it("refuses with one generic code an identity linked anywhere — this account, another, another tenant", async () => {
      const sub = googleSub();
      const first = await aal2Person();
      await link("google", first.token, { sub });

      const sameTenant = await aal2Person();
      const otherTenant = await aal2Person(fx.tenantB);
      const answers = [];
      for (const holder of [first, sameTenant, otherTenant]) {
        const response = await finish("google", await startLink("google", holder.token), { claims: { sub } }, holder.token);
        expect(response.statusCode).toBe(409);
        answers.push(response.json());
      }
      for (const answer of answers) {
        expect(answer).toMatchObject({ code: "OIDC_IDENTITY_UNAVAILABLE" });
        expect(answer.message).toBe(answers[0].message);
      }
      // Audited in the refusing tenant, without saying where the identity lives.
      const [audit] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'auth.oidc.link_refused' AND tenant_id = ${fx.tenantB}
        ORDER BY occurred_at DESC LIMIT 1
      `;
      expect(audit!.detail).toMatchObject({ reason: "unavailable" });
      expect(JSON.stringify(audit!.detail)).not.toContain(first.id);
    });

    it("one identity per provider per account", async () => {
      const holder = await aal2Person();
      await link("google", holder.token, { sub: googleSub() });
      const second = await finish("google", await startLink("google", holder.token), { claims: { sub: googleSub() } }, holder.token);
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("OIDC_PROVIDER_ALREADY_LINKED");
    });

    it("refuses a link whose session lost its second factor before the callback", async () => {
      const holder = await aal2Person();
      const started = await startLink("google", holder.token);
      const { code, state } = idp.authorize(started.authorizationUrl);
      await fx.sql`UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'test' WHERE token_hash = ${hashToken(holder.token)}`;
      const response = await post("/api/v1/auth/oidc/google/link/callback", { state, code, browserBinding: started.browserBinding }, bearer(holder.token));
      expect(response.statusCode).toBe(401);
      expect(await fx.sql`SELECT 1 FROM core.external_identities WHERE subject_id = ${holder.id}`).toHaveLength(0);
    });
  });

  describe("unlinking", () => {
    it("needs aal2, ends the sessions the identity signed in, and is audited", async () => {
      const holder = await aal2Person();
      const sub = googleSub();
      const linked = await link("google", holder.token, { sub });
      const signedIn = (await finish("google", await startSignIn("google"), { claims: { sub } })).json().sessionToken as string;
      expect((await sessionOf(signedIn)).authenticated).toBe(true);

      // A first-factor session cannot unlink — not even the one the identity signed in.
      const aal1 = await post(`/api/v1/auth/identities/${linked.id}/unlink`, undefined, bearer(signedIn));
      expect(aal1.statusCode).toBe(403);
      expect(aal1.json().code).toBe("MFA_REQUIRED");

      const done = await post(`/api/v1/auth/identities/${linked.id}/unlink`, undefined, bearer(holder.token));
      expect(done.statusCode, done.body).toBe(200);
      expect(done.json()).toEqual({ revokedSessions: 1, currentSessionEnded: false });
      expect((await sessionOf(signedIn)).authenticated).toBe(false);
      expect((await sessionOf(holder.token)).authenticated).toBe(true);
      expect((await get("/api/v1/auth/identities", holder.token)).json().items[0]).toMatchObject({ id: linked.id, revokedAt: expect.any(String) });
      expect(await fx.sql`SELECT 1 FROM audit.events WHERE command = 'auth.oidc.identity_unlinked' AND resource_id = ${linked.id}`).toHaveLength(1);

      // Unlinked once is unlinked: a second try finds nothing.
      expect((await post(`/api/v1/auth/identities/${linked.id}/unlink`, undefined, bearer(holder.token))).statusCode).toBe(404);
      // And the key is free to be linked again.
      await link("google", holder.token, { sub });
    });

    it("ends the current session when it was signed in with the identity", async () => {
      const subject = await person();
      const token = await issueTestSession(fx.appSql, fx.tenantA, subject.id, { firstFactor: "google", secondFactor: "totp" });
      const [identity] = await fx.sql<{ id: string }[]>`SELECT id FROM core.external_identities WHERE subject_id = ${subject.id}`;
      const response = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(response.json()).toEqual({ revokedSessions: 0, currentSessionEnded: true });
      expect((await sessionOf(token)).authenticated).toBe(false);
    });

    it("never unlinks the last way to sign in", async () => {
      // A person without an address whose one way in is a Google identity.
      const subject = await person(fx.tenantA, null);
      const token = await issueTestSession(fx.appSql, fx.tenantA, subject.id, { firstFactor: "google", secondFactor: "totp" });
      const [identity] = await fx.sql<{ id: string }[]>`SELECT id FROM core.external_identities WHERE subject_id = ${subject.id}`;
      const refused = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe("OIDC_LAST_SIGN_IN_METHOD");

      // The contrast: with a second identity, the first can go.
      await issueTestSession(fx.appSql, fx.tenantA, subject.id, { firstFactor: "microsoft" });
      const done = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(done.statusCode, done.body).toBe(200);
    });

    it("a recovery-limited session cannot unlink", async () => {
      const subject = await person();
      const token = await issueTestSession(fx.appSql, fx.tenantA, subject.id, { firstFactor: "google", secondFactor: "recovery_code" });
      const [identity] = await fx.sql<{ id: string }[]>`SELECT id FROM core.external_identities WHERE subject_id = ${subject.id}`;
      const response = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("MFA_RECOVERY_REENROLMENT_REQUIRED");
      const [session] = await fx.sql<{ id: string }[]>`SELECT id FROM core.sessions WHERE token_hash = ${hashToken(token)}`;
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`SELECT * FROM core.unlink_external_identity(${session!.id}, ${identity!.id})`),
      ).rejects.toThrow(/MFA_RECOVERY_REENROLMENT_REQUIRED/);
    });
  });

  // --- Invitations -------------------------------------------------------------

  describe("accepting an invitation with a provider", () => {
    async function invite(email = `invitee-${randomUUID().slice(0, 8)}@example.com`) {
      const token = generateInvitationToken();
      const id = randomUUID();
      await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
        SELECT * FROM core.create_invitation(${id}, ${fx.orgA}, ${email}, ${fx.operatorSubjectA}, ${hashToken(token)}, 'http://localhost:3000/invitations/accept#token=x')
      `);
      return { id, token, email };
    }
    const acceptStart = (provider: Provider, token: string) =>
      startSignIn(provider, { purpose: "invitation_accept", invitationToken: token, displayName: "Invited Person" });

    it("creates the account with no role and links the identity when Google verified the invited address", async () => {
      const invitation = await invite();
      const sub = googleSub();
      // A code is also out for this invitation; accepting with Google retires it.
      await post("/api/v1/auth/invitations/accept/start", { token: invitation.token });
      const response = await finish("google", await acceptStart("google", invitation.token), {
        claims: { sub, email: invitation.email.toUpperCase(), email_verified: true, hd: "example.com" },
      });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ firstFactor: "google", aal: "aal1", roleBindings: [] });

      const [subject] = await fx.sql<{ email: string; organization_id: string; assurance_level: string; created_at: Date }[]>`
        SELECT email, organization_id, assurance_level, created_at FROM core.subjects WHERE id = ${body.subjectId}
      `;
      expect(subject).toMatchObject({ email: invitation.email, organization_id: fx.orgA, assurance_level: "wallet_only" });
      expect(await fx.sql`SELECT 1 FROM core.role_bindings WHERE subject_id = ${body.subjectId}`).toHaveLength(0);
      expect(await fx.sql`SELECT 1 FROM core.external_identities WHERE subject_id = ${body.subjectId} AND subject_key = ${sub} AND linked_via = 'invitation'`).toHaveLength(1);
      const [state] = await fx.sql<{ state: string }[]>`SELECT state FROM core.invitations WHERE id = ${invitation.id}`;
      expect(state!.state).toBe("accepted");
      expect(await fx.sql`SELECT 1 FROM core.email_challenges WHERE invitation_id = ${invitation.id} AND consumed_at IS NULL AND superseded_at IS NULL`).toHaveLength(0);
      expect(await fx.sql`SELECT 1 FROM core.email_outbox WHERE invitation_id = ${invitation.id} AND template = 'invitation_code' AND state = 'pending'`).toHaveLength(0);

      // The 24 h first-enrolment window runs from the account's creation, as with a code.
      const mfa = (await get("/api/v1/auth/mfa", body.sessionToken)).json();
      expect(mfa.enrolment).toEqual({ passkey: "allowed", totp: "allowed" });

      // And the identity signs in afterwards.
      const again = await finish("google", await startSignIn("google"), { claims: { sub } });
      expect(again.json().subjectId).toBe(body.subjectId);

      // The invitation cannot be used twice.
      const reuse = await post("/api/v1/auth/oidc/google/start", { purpose: "invitation_accept", invitationToken: invitation.token, displayName: "X" });
      expect(reuse.json().code).toBe("INVITATION_INVALID");
    });

    it("refuses an address Google did not verify, and another verified address; the invitation stays usable", async () => {
      const invitation = await invite();
      const unverified = await finish("google", await acceptStart("google", invitation.token), {
        claims: { email: invitation.email, email_verified: false },
      });
      expect(unverified.statusCode).toBe(403);
      expect(unverified.json().code).toBe("OIDC_EMAIL_NOT_VERIFIED");

      const missing = await finish("google", await acceptStart("google", invitation.token), {
        claims: { email: invitation.email, email_verified: undefined },
      });
      expect(missing.json().code).toBe("OIDC_EMAIL_NOT_VERIFIED");

      const other = await finish("google", await acceptStart("google", invitation.token), {
        claims: { email: "someone-else@example.com", email_verified: true, hd: "example.com" },
      });
      expect(other.json().code).toBe("OIDC_EMAIL_MISMATCH");

      const [state] = await fx.sql<{ state: string }[]>`SELECT state FROM core.invitations WHERE id = ${invitation.id}`;
      expect(state!.state).toBe("pending");
      expect(await fx.sql`SELECT 1 FROM core.subjects WHERE email = ${invitation.email}`).toHaveLength(0);
      expect(await fx.sql`SELECT 1 FROM audit.events WHERE command = 'auth.oidc.failed' AND detail->>'invitationId' = ${invitation.id}`).toHaveLength(3);
    });

    it("Microsoft: only with the domain-owner-verified claim (xms_edov)", async () => {
      const invitation = await invite();
      const unverified = await finish("microsoft", await acceptStart("microsoft", invitation.token), {
        claims: { email: invitation.email },
      });
      expect(unverified.json().code).toBe("OIDC_EMAIL_NOT_VERIFIED");
      const verified = await finish("microsoft", await acceptStart("microsoft", invitation.token), {
        claims: { email: invitation.email, xms_edov: true },
      });
      expect(verified.statusCode, verified.body).toBe(200);
      expect(verified.json()).toMatchObject({ firstFactor: "microsoft", aal: "aal1" });
    });

    it("refuses an identity that is already linked", async () => {
      const holder = await aal2Person();
      const sub = googleSub();
      await link("google", holder.token, { sub });
      const invitation = await invite();
      const response = await finish("google", await acceptStart("google", invitation.token), {
        claims: { sub, email: invitation.email, email_verified: true, hd: "example.com" },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("OIDC_IDENTITY_UNAVAILABLE");
    });

    describe("Google: only an address Google manages (L7)", () => {
      // A consumer Google account on someone's own domain reports `email_verified` from the day
      // it was made; if the address later changes hands, the old account still says true.
      const accept = async (email: string, claims: Record<string, unknown>) => {
        const invitation = await invite(email);
        const response = await finish("google", await acceptStart("google", invitation.token), {
          claims: { email, email_verified: true, ...claims },
        });
        return { invitation, response };
      };
      const stillPending = async (id: string) =>
        (await fx.sql<{ state: string }[]>`SELECT state FROM core.invitations WHERE id = ${id}`)[0]!.state;

      it("accepts a Gmail address, whose verification Google keeps current", async () => {
        for (const domain of ["gmail.com", "googlemail.com"]) {
          const { response } = await accept(`invitee-${randomUUID().slice(0, 8)}@${domain}`, { hd: undefined });
          expect(response.statusCode, response.body).toBe(200);
        }
      });

      it("accepts an address in the Workspace domain the token's hd names", async () => {
        const { response } = await accept(`invitee-${randomUUID().slice(0, 8)}@corp.example`, { hd: "corp.example" });
        expect(response.statusCode, response.body).toBe(200);
      });

      it("refuses a mismatched hd and a missing hd, and leaves the invitation for the emailed code", async () => {
        for (const claims of [{ hd: "other.example" }, { hd: undefined }, { hd: "example" }]) {
          const { invitation, response } = await accept(`invitee-${randomUUID().slice(0, 8)}@corp.example`, claims);
          expect(response.statusCode, JSON.stringify(claims)).toBe(403);
          expect(response.json().code).toBe("OIDC_EMAIL_CODE_REQUIRED");
          expect(await stillPending(invitation.id)).toBe("pending");
          expect(await fx.sql`SELECT 1 FROM core.subjects WHERE email = ${invitation.email}`).toHaveLength(0);
          expect(
            await fx.sql`SELECT 1 FROM audit.events WHERE command = 'auth.oidc.failed' AND detail->>'invitationId' = ${invitation.id} AND detail->>'reason' = 'email_code_required'`,
          ).toHaveLength(1);
          // The code path is untouched: the same invitation still starts a code.
          expect((await post("/api/v1/auth/invitations/accept/start", { token: invitation.token })).statusCode).toBe(200);
        }
      });

      it("hd only vouches for its own domain, not for a Gmail look-alike or a subdomain", async () => {
        const { response } = await accept(`invitee-${randomUUID().slice(0, 8)}@mail.corp.example`, { hd: "corp.example" });
        expect(response.json().code).toBe("OIDC_EMAIL_CODE_REQUIRED");
        const lookalike = await accept(`invitee-${randomUUID().slice(0, 8)}@gmail.com.example`, { hd: undefined });
        expect(lookalike.response.json().code).toBe("OIDC_EMAIL_CODE_REQUIRED");
      });
    });

    it("refuses an unknown, revoked or used invitation at the start", async () => {
      const unknown = await post("/api/v1/auth/oidc/google/start", {
        purpose: "invitation_accept", invitationToken: generateInvitationToken(), displayName: "X",
      });
      expect(unknown.statusCode).toBe(404);
      expect(unknown.json().code).toBe("INVITATION_INVALID");
    });

    it("refuses an invitation revoked between start and callback", async () => {
      const invitation = await invite();
      const started = await acceptStart("google", invitation.token);
      await fx.sql`UPDATE core.invitations SET state = 'revoked', revoked_at = now(), revoked_by_subject_id = ${fx.operatorSubjectA}, version = version + 1 WHERE id = ${invitation.id}`;
      const response = await finish("google", started, { claims: { email: invitation.email, email_verified: true, hd: "example.com" } });
      expect(response.json().code).toBe("INVITATION_INVALID");
    });
  });

  // --- Recovery revokes linked identities (M3, 0123) ---------------------------

  describe("recovery revokes linked identities (M3)", () => {
    /** An aal3 admin of tenant A with `role`. */
    async function admin(role: "mpc_operator" | "security_operator") {
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
        VALUES (${id}, ${fx.tenantA}, 'person', 'Recovery Admin', 'high_assurance')
      `;
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${id}, ${fx.orgA}, ${role})
      `;
      return issueTestSession(fx.appSql, fx.tenantA, id, { firstFactor: "email_code", secondFactor: "passkey" });
    }
    const adminPost = (url: string, token: string, payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST", url, payload: payload as never, remoteAddress: freshIp(),
        headers: { ...bearer(token), "idempotency-key": randomUUID().replace(/-/g, ""), ...headers },
      });
    const signInWith = (sub: string) => startSignIn("google").then((started) => finish("google", started, { claims: { sub } }));
    const live = (subjectId: string) =>
      fx.sql<{ provider: string }[]>`SELECT provider FROM core.external_identities WHERE subject_id = ${subjectId} AND revoked_at IS NULL`;

    /** Bystanders whose identities must survive: another person in tenant A, one in tenant B. */
    async function bystanders() {
      const sameTenant = await aal2Person(fx.tenantA);
      const otherTenant = await aal2Person(fx.tenantB);
      const subs = [googleSub(), googleSub()];
      await link("google", sameTenant.token, { sub: subs[0] });
      await link("google", otherTenant.token, { sub: subs[1] });
      return { subjects: [sameTenant.id, otherTenant.id], subs };
    }
    async function expectBystandersUntouched(b: Awaited<ReturnType<typeof bystanders>>) {
      for (const id of b.subjects) expect(await live(id), id).toHaveLength(1);
      for (const sub of b.subs) expect((await signInWith(sub)).statusCode).toBe(200);
    }

    it("the reviewer's chain: an identity linked during brief aal2 access does not survive an MFA reset", async () => {
      const victim = await aal2Person();
      const attackerSub = googleSub();
      // The attacker, holding the victim's aal2 session for a moment, links their own Google.
      await link("google", victim.token, { sub: attackerSub });
      await link("microsoft", victim.token, { oid: randomUUID() });
      expect((await signInWith(attackerSub)).json().subjectId).toBe(victim.id);
      const others = await bystanders();

      const proposer = await admin("mpc_operator");
      const decider = await admin("security_operator");
      const proposed = await adminPost("/api/v1/admin/mfa-resets", proposer, { subjectId: victim.id, reason: "Lost every device" });
      expect(proposed.statusCode, proposed.body).toBe(200);
      const approved = await adminPost(
        `/api/v1/admin/mfa-resets/${proposed.json().id}/decision`, decider,
        { decision: "approve", reason: "Identity confirmed by call-back" }, { "if-match": `"${proposed.json().version}"` },
      );
      expect(approved.statusCode, approved.body).toBe(200);

      // Inside the 24-hour enrolment window, the attacker's Google gets nowhere.
      const after = await signInWith(attackerSub);
      expect(after.statusCode).toBe(401);
      expect(after.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
      expect(await live(victim.id)).toHaveLength(0);
      const reasons = await fx.sql<{ revoked_reason: string }[]>`
        SELECT DISTINCT revoked_reason FROM core.external_identities WHERE subject_id = ${victim.id}
      `;
      expect(reasons.map((row) => row.revoked_reason)).toEqual(["mfa_reset"]);

      // The notice names the providers, nothing else.
      const [notice] = await fx.sql<{ params: unknown }[]>`
        SELECT params FROM core.email_outbox WHERE recipient = ${victim.email} AND template = 'mfa_reset_notice'
      `;
      expect(notice!.params).toEqual({ removedSignIns: ["google", "microsoft"] });
      await expectBystandersUntouched(others);

      // The owner, back at aal2, links the same Google account again.
      const owner = await issueTestSession(fx.appSql, fx.tenantA, victim.id, { firstFactor: "email_code", secondFactor: "totp" });
      await link("google", owner, { sub: attackerSub });
      expect((await signInWith(attackerSub)).json().subjectId).toBe(victim.id);
    });

    it("an email change revokes them too", async () => {
      const victim = await aal2Person();
      const attackerSub = googleSub();
      await link("google", victim.token, { sub: attackerSub });
      const others = await bystanders();

      const proposer = await admin("mpc_operator");
      const approver = await admin("security_operator");
      const newEmail = `moved-${randomUUID().slice(0, 8)}@example.com`;
      const proposed = await adminPost("/api/v1/admin/email-changes", proposer, {
        subjectId: victim.id, newEmail, reason: "Lost access to the mailbox",
      });
      expect(proposed.statusCode, proposed.body).toBe(200);
      const change = proposed.json();
      const approved = await adminPost(
        `/api/v1/admin/email-changes/${change.id}/decision`, approver,
        { decision: "approve", reason: "Confirmed by phone" }, { "if-match": `"${change.version}"` },
      );
      expect(approved.statusCode, approved.body).toBe(200);
      // Approval alone changes nothing; completion does.
      expect(await live(victim.id)).toHaveLength(1);
      const [mail] = await fx.sql<{ params: { code: string } }[]>`
        SELECT params FROM core.email_outbox WHERE recipient = ${newEmail} AND template = 'email_change_code' AND state = 'pending'
      `;
      const completed = await post("/api/v1/auth/email-change/verify", { email: newEmail, code: mail!.params.code });
      expect(completed.statusCode, completed.body).toBe(200);

      const after = await signInWith(attackerSub);
      expect(after.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
      expect(await live(victim.id)).toHaveLength(0);
      const [row] = await fx.sql<{ revoked_reason: string }[]>`
        SELECT revoked_reason FROM core.external_identities WHERE subject_id = ${victim.id}
      `;
      expect(row!.revoked_reason).toBe("email_change");
      const [notice] = await fx.sql<{ params: unknown }[]>`
        SELECT params FROM core.email_outbox WHERE recipient = ${victim.email} AND template = 'email_changed_notice'
      `;
      expect(notice!.params).toEqual({ removedSignIns: ["google"] });
      await expectBystandersUntouched(others);

      const owner = await issueTestSession(fx.appSql, fx.tenantA, victim.id, { firstFactor: "email_code", secondFactor: "totp" });
      await link("google", owner, { sub: attackerSub });
      expect((await signInWith(attackerSub)).json().subjectId).toBe(victim.id);
    });

    it("a recovery with nothing linked says nothing about sign-ins", async () => {
      const victim = await aal2Person();
      const proposer = await admin("mpc_operator");
      const decider = await admin("security_operator");
      const proposed = await adminPost("/api/v1/admin/mfa-resets", proposer, { subjectId: victim.id, reason: "Lost every device" });
      await adminPost(
        `/api/v1/admin/mfa-resets/${proposed.json().id}/decision`, decider,
        { decision: "approve", reason: "Identity confirmed by call-back" }, { "if-match": `"${proposed.json().version}"` },
      );
      const [notice] = await fx.sql<{ params: unknown }[]>`
        SELECT params FROM core.email_outbox WHERE recipient = ${victim.email} AND template = 'mfa_reset_notice'
      `;
      expect(notice!.params).toEqual({ removedSignIns: [] });
    });
  });

  // --- Database boundary --------------------------------------------------------

  describe("database boundary", () => {
    it("the application role cannot read identities or transactions, nor mint a Google session", async () => {
      await expect(fx.appSql`SELECT 1 FROM core.external_identities LIMIT 1`).rejects.toThrow(/permission denied/);
      await expect(fx.appSql`SELECT 1 FROM core.oidc_login_transactions LIMIT 1`).rejects.toThrow(/permission denied/);
      const subject = await person();
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`INSERT INTO core.external_identities (id, tenant_id, subject_id, provider, issuer, subject_key, linked_via)
             VALUES (${randomUUID()}, ${fx.tenantA}, ${subject.id}, 'google', 'https://accounts.google.com', 'x', 'link')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT core.create_subject_session(${randomUUID()}, ${hashToken(randomUUID())}, ${subject.id}, 'google', NULL, 3600)`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("a completed transaction makes one session, and completing it again is refused", async () => {
      const subject = await person();
      const token = await issueTestSession(fx.appSql, fx.tenantA, subject.id, { firstFactor: "google" });
      const [row] = await fx.sql<{ oidc_transaction_id: string }[]>`SELECT oidc_transaction_id FROM core.sessions WHERE token_hash = ${hashToken(token)}`;
      const [identity] = await fx.sql<{ issuer: string; subject_key: string }[]>`SELECT issuer, subject_key FROM core.external_identities WHERE subject_id = ${subject.id}`;
      await expect(
        fx.appSql`SELECT * FROM core.complete_oidc_sign_in(${row!.oidc_transaction_id}, ${identity!.issuer}, ${identity!.subject_key}, ${randomUUID()}, ${hashToken(randomUUID())}, 3600)`,
      ).rejects.toThrow(/OIDC_TRANSACTION_INVALID/);
    });
  });

  describe("tenant isolation", () => {
    it("an identity of one tenant is invisible and unreachable from another", async () => {
      const a = await aal2Person(fx.tenantA);
      const linked = await link("google", a.token, { sub: googleSub() });
      const b = await aal2Person(fx.tenantB);
      expect((await get("/api/v1/auth/identities", b.token)).json().items).toEqual([]);
      const unlink = await post(`/api/v1/auth/identities/${linked.id}/unlink`, undefined, bearer(b.token));
      expect(unlink.statusCode).toBe(404);
      expect(await fx.sql`SELECT 1 FROM core.external_identities WHERE id = ${linked.id} AND revoked_at IS NULL`).toHaveLength(1);

      // The list function with another tenant's context returns nothing for a session of A.
      const [session] = await fx.sql<{ id: string }[]>`SELECT id FROM core.sessions WHERE token_hash = ${hashToken(a.token)}`;
      expect(await withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) => tx`SELECT * FROM core.list_external_identities(${session!.id})`)).toHaveLength(0);
      // And starting a link for A's session from B's context finds no session.
      const [started] = await withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) => tx<{ status: string }[]>`
        SELECT status FROM core.start_oidc_transaction(
          ${randomUUID()}, 'google', 'link', ${"d".repeat(64)}, ${"e".repeat(64)}, ${"f".repeat(64)}, ${Buffer.alloc(40)},
          'http://localhost:3000/auth/oidc/google/callback', ${session!.id}, NULL, NULL, ${randomUUID()}
        )
      `);
      expect(started!.status).toBe("session_invalid");
    });

    it("a sign-in lands in the identity's tenant", async () => {
      const b = await aal2Person(fx.tenantB);
      const sub = googleSub();
      await link("google", b.token, { sub });
      const response = await finish("google", await startSignIn("google"), { claims: { sub } });
      const [row] = await fx.sql<{ tenant_id: string }[]>`SELECT tenant_id FROM core.sessions WHERE token_hash = ${hashToken(response.json().sessionToken)}`;
      expect(row!.tenant_id).toBe(fx.tenantB);

      // The caller's tenant context cannot steer it: completed from inside tenant A, the session
      // is still B's.
      const sha = (value: string) => createHash("sha256").update(value).digest("hex");
      const [state, binding, txId, sessionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const [identity] = await fx.sql<{ issuer: string; subject_key: string }[]>`
        SELECT issuer, subject_key FROM core.external_identities WHERE subject_id = ${b.id} AND revoked_at IS NULL
      `;
      const steered = await withTenant(fx.appSql, { tenantId: fx.tenantA }, async (tx) => {
        await tx`SELECT * FROM core.start_oidc_transaction(
          ${txId}, 'google', 'sign_in', ${sha(state)}, ${sha(binding)}, ${sha(randomUUID())}, ${Buffer.alloc(40)},
          'http://localhost:3000/auth/oidc/google/callback', NULL, NULL, NULL, ${randomUUID()})`;
        await tx`SELECT * FROM core.claim_oidc_transaction(${sha(state)}, ${sha(binding)}, 'google', NULL)`;
        return tx<{ status: string; tenant_id: string }[]>`
          SELECT * FROM core.complete_oidc_sign_in(${txId}, ${identity!.issuer}, ${identity!.subject_key}, ${sessionId}, ${hashToken(randomUUID())}, 3600)
        `;
      });
      expect(steered[0]).toMatchObject({ status: "session_created", tenant_id: fx.tenantB });
      const [session] = await fx.sql<{ tenant_id: string }[]>`SELECT tenant_id FROM core.sessions WHERE id = ${sessionId}`;
      expect(session!.tenant_id).toBe(fx.tenantB);
    });
  });

  // --- Configuration and network ---------------------------------------------

  describe("configuration and network", () => {
    it("answers OIDC_PROVIDER_DISABLED for a provider that is not configured, and REQUEST_INVALID for an unknown one", async () => {
      const bare = await buildServer(loadConfig(testEnv()), fx.appSql, { oidcFetch: idp.fetch });
      try {
        for (const provider of ["google", "microsoft"]) {
          const response = await bare.inject({ method: "POST", url: `/api/v1/auth/oidc/${provider}/start`, payload: { purpose: "sign_in" }, remoteAddress: freshIp() });
          expect(response.statusCode, provider).toBe(404);
          expect(response.json().code).toBe("OIDC_PROVIDER_DISABLED");
        }
        // Not a provider at all: a malformed path, on any deployment.
        for (const server of [bare, app]) {
          const response = await server.inject({ method: "POST", url: "/api/v1/auth/oidc/github/start", payload: { purpose: "sign_in" }, remoteAddress: freshIp() });
          expect(response.statusCode).toBe(400);
          expect(response.json().code).toBe("REQUEST_INVALID");
        }
      } finally {
        await bare.close();
      }
    });

    it("caches discovery, and does not cache a failure", async () => {
      const own = await MockOidcProvider.create();
      const fresh = await buildServer(loadConfig(oidcEnv()), fx.appSql, { oidcFetch: own.fetch });
      const start = () => fresh.inject({ method: "POST", url: "/api/v1/auth/oidc/google/start", payload: { purpose: "sign_in" }, remoteAddress: freshIp() });
      try {
        own.down = true;
        const down = await start();
        expect(down.statusCode).toBe(503);
        expect(down.json().code).toBe("OIDC_PROVIDER_UNAVAILABLE");
        own.down = false;
        expect((await start()).statusCode).toBe(200);
        expect((await start()).statusCode).toBe(200);
        expect(own.discoveryFetches("google")).toBe(2);

        // The token endpoint unreachable at the callback: 503, not a token refusal.
        const started = (await start()).json() as Started;
        const { code, state } = own.authorize(started.authorizationUrl);
        own.down = true;
        const response = await fresh.inject({
          method: "POST", url: "/api/v1/auth/oidc/google/callback", remoteAddress: freshIp(),
          payload: { state, code, browserBinding: started.browserBinding },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().code).toBe("OIDC_PROVIDER_UNAVAILABLE");
      } finally {
        own.down = false;
        await fresh.close();
      }
    });

    it("limits starts per requester address in the database", async () => {
      const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
      let last = 0;
      for (let i = 0; i < 31; i += 1) {
        last = (await post("/api/v1/auth/oidc/google/start", { purpose: "sign_in" }, {}, ip)).statusCode;
        if (i < 30) expect(last).toBe(200);
      }
      expect(last).toBe(429);
    });
  });
});
