import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withActor } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { generateInvitationToken } from "../src/account-crypto.js";
import { hashToken } from "../src/plugins/session-token.js";
import { publishProject } from "./helpers/registry.js";
import { bindWalletByProof } from "./helpers/wallets.js";
import { bearer, newAccount, issueTestSession, signIn, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";
import {
  MockOidcProvider,
  TEST_GOOGLE_CLIENT,
  type AuthorizeOptions,
} from "./helpers/mock-oidc.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const oidcEnv = (overrides: Record<string, string> = {}) =>
  testEnv({
    GOOGLE_CLIENT_ID: TEST_GOOGLE_CLIENT.id,
    GOOGLE_CLIENT_SECRET: TEST_GOOGLE_CLIENT.secret,
    ...overrides,
  });

type Provider = "google";

/**
 * Google sign-in — account authentication WP4. Microsoft sign-in was removed (0171): its routes
 * answer as for any unknown provider.
 *
 * Every request goes through the real `openid-client` flow against an in-process provider
 * (`helpers/mock-oidc.ts`) that signs with its own keys: discovery, keys, the code exchange with
 * PKCE, and ID-token validation all run as in production. One test (at least) per property:
 *
 * - `state` is single use, bound to the browser that started the flow and, for a link, to the
 *   session that started it; a nonce, audience, issuer, expiry, signature or `azp` that is not
 *   ours is refused; the code is bound to this flow's PKCE verifier;
 * - sign-in works only for a linked identity; a token whose email matches an account never signs
 *   in, links or creates anything;
 * - linking needs aal2, comes back to the same session, and an identity linked anywhere gets one
 *   generic code; unlinking ends the sessions the identity signed in, and never
 *   removes the last way in;
 * - an invitation is accepted with a provider only for the address the provider verified;
 * - a Google session is aal1 (MFA_REQUIRED elsewhere), and the application role
 *   cannot mint one without a completed transaction;
 * - the provider's own error text is never echoed;
 * - nothing crosses accounts.
 */
describeDb("Google sign-in (WP4)", { timeout: 30_000 }, () => {
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

  /** A person with an address (or none) and no role. */
  async function person(email: string | null = `p-${randomUUID().slice(0, 8)}@example.com`) {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, kind, display_name, email)
      VALUES (${id}, 'person', 'OIDC Person', ${email})
    `;
    return { id, email };
  }

  /** An aal2 session (email code + TOTP) of a new person. */
  async function aal2Person() {
    const subject = await person();
    const token = await issueTestSession(fx.appSql, subject.id, { firstFactor: "email_code", secondFactor: "totp" });
    return { ...subject, token };
  }

  /** Links an identity to `token`'s subject through the API. */
  async function link(provider: Provider, token: string, claims: Record<string, unknown> = {}) {
    const { subjectId } = await sessionOf(token);
    const [person] = await fx.sql`SELECT email FROM core.subjects WHERE id=${subjectId}`;
    const email = person!.email as string;
    const response = await finish(provider, await startLink(provider, token), { claims: {
      email, email_verified: true, hd: email.split("@")[1], ...claims,
    } }, token);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as { id: string; provider: Provider; issuer: string };
  }

  const googleSub = () => `${Math.floor(Math.random() * 1e15)}${Math.floor(Math.random() * 1e6)}`;

  async function sessionOf(token: string) {
    return (await get("/api/v1/auth/session", token)).json();
  }

  // --- Sign-in --------------------------------------------------------------

  describe("sign-in", () => {
    it("refuses to link a provider identity verified for another mailbox", async () => {
      const holder = await aal2Person();
      const sub = googleSub();
      const response = await finish("google", await startLink("google", holder.token), {
        claims: { sub, email: "other@gmail.com", email_verified: true },
      }, holder.token);
      expect(response.statusCode).toBe(409);
      expect(await fx.sql`SELECT id FROM core.external_identities WHERE subject_key=${sub}`).toHaveLength(0);
    });

    it("signs a linked Google identity in at aal1 without granting roles", async () => {
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
      expect(denied.json().code).not.toBe("MFA_REQUIRED");
      expect((await get("/api/v1/auth/mfa", body.sessionToken)).statusCode).toBe(404);
      // Account holders can inspect their own sign-in identities.
      expect((await get("/api/v1/auth/identities", body.sessionToken)).statusCode).toBe(200);

      const audits = await fx.sql<{ command: string; detail: Record<string, unknown> }[]>`
        SELECT command, detail FROM audit.events
        WHERE actor_subject_id = ${holder.id} AND command IN ('auth.oidc.signed_in', 'auth.session.created')
        ORDER BY id
      `;
      expect(audits.map((row) => row.command)).toEqual(["auth.oidc.signed_in", "auth.session.created"]);
      expect(audits[1]!.detail).toMatchObject({ firstFactor: "google", aal: "aal1" });
    });

    it("opens My Work and account administration with live administrator bindings", async () => {
      const admin = await issueTestSession(fx.appSql, fx.operatorSubjectA, { firstFactor: "email_code", secondFactor: "passkey" });
      const sub = googleSub();
      await link("google", admin, { sub });
      const response = await finish("google", await startSignIn("google"), { claims: { sub } });
      const token = response.json().sessionToken;
      expect(await sessionOf(token)).toMatchObject({ aal: "aal1", actions: expect.arrayContaining(["project.read", "admin.read"]) });
      expect((await get("/api/v1/my-work", token)).statusCode).toBe(200);
      expect((await get("/api/v1/admin/subjects", token)).statusCode).toBe(200);
      expect((await get("/api/v1/admin/invitations", token)).statusCode).toBe(200);
      expect((await get(`/api/v1/projects/${fx.projectA}/overview`, token)).statusCode).toBe(200);
      expect((await post("/api/v1/admin/role-grants", {}, bearer(token))).json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    });

    it("keeps Google workspace reads within the project binding and refuses administrator lists", async () => {
      const sub = googleSub();
      await link("google", await signIn(app, fx.scopedStewardA), { sub });
      const signed = await finish("google", await startSignIn("google"), { claims: { sub } });
      const token = signed.json().sessionToken;
      expect((await get(`/api/v1/projects/${fx.projectA}/overview`, token)).statusCode).toBe(200);
      expect([403, 404]).toContain((await get(`/api/v1/projects/${fx.otherProjectA}/overview`, token)).statusCode);
      expect((await get("/api/v1/admin/subjects", token)).statusCode).toBe(403);
    });

    it("grants reviewer actions independently of historical session factors", async () => {
      const approver = await sessionOf(await signIn(app, fx.approverA));
      for (const secondFactor of [null, "totp"] as const) {
        const token = await issueTestSession(fx.appSql, approver.subjectId, { firstFactor: "google", secondFactor });
        const view = await sessionOf(token);
        expect(view.narrowedRoles ?? []).toEqual([]);
        expect(view.actions).toContain("verification.read");
        expect(view.actions).toContain("attestation.sign");
        expect((await get(`/api/v1/projects/${fx.projectA}/verification-cases`, token)).statusCode).toBe(200);
      }
    });

    it("drops an outstanding assignment from My Work after its project binding is revoked", async () => {
      const sub = googleSub();
      await link("google", await signIn(app, fx.reviewerA), { sub });
      const signed = await finish("google", await startSignIn("google"), { claims: { sub } });
      const token = signed.json().sessionToken;
      // This fixture normally also holds a Registry-wide reviewer binding.
      await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${fx.reviewerSubjectA} AND project_id IS NULL`;
      const cases: string[] = [];
      for (const projectId of [fx.projectA, fx.otherProjectA]) {
        const caseId = randomUUID();
        await fx.sql`INSERT INTO core.role_bindings(id,subject_id,project_id,role)
          VALUES (gen_random_uuid(),${fx.reviewerSubjectA},${projectId},'reviewer')`;
        await fx.sql`INSERT INTO core.verification_cases(id,project_id,schema_id)
          VALUES (${caseId},${projectId},${fx.schemaA})`;
        await fx.sql`INSERT INTO core.assignments(id,case_id,subject_id,credential_id)
          VALUES (gen_random_uuid(),${caseId},${fx.reviewerSubjectA},${fx.credentialA})`;
        cases.push(caseId);
      }
      const assigned = async () => (await get("/api/v1/my-work", token)).json().assignedToMe.map((row: {caseId: string}) => row.caseId);
      expect(await assigned()).toEqual(expect.arrayContaining(cases));
      await fx.sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${fx.reviewerSubjectA} AND project_id = ${fx.otherProjectA}`;
      expect(await assigned()).toEqual([cases[0]]);
    });

    it("classifies and opens an uploaded document with a development Google session", async () => {
      const steward = await sessionOf(await signIn(app, fx.stewardA));
      const token = await issueTestSession(fx.appSql, steward.subjectId, { firstFactor: "google", secondFactor: null });
      const dev = await buildServer(loadConfig(oidcEnv({ DEPLOY_ENVIRONMENT: "develop", CHAIN_ID: "5611" })), fx.appSql);
      try {
        for (const secondFactor of ["totp", "passkey"] as const) {
          const elevated = await issueTestSession(fx.appSql, steward.subjectId, { firstFactor: "google", secondFactor });
          const session = await dev.inject({ url: "/api/v1/auth/session", headers: bearer(elevated) });
          expect(session.json().actions).toContain("attestation.sign");
          expect(session.json().actions).toContain("attestation.dispute.resolve");
        }
        const headers = bearer(token);
        const project = `/api/v1/projects/${fx.projectA}`;
        const upload = await dev.inject({ method: "POST", url: `${project}/uploads`,
          headers: { ...headers, "idempotency-key": randomUUID() },
          payload: { originalFilename: "permit.pdf", contentType: "application/pdf", contentBase64: Buffer.from("permit").toString("base64") } });
        expect(upload.statusCode, upload.body).toBe(200);
        const document = `/api/v1/uploads/${upload.json().id}`;
        const profile = await dev.inject({ method: "PATCH", url: `${document}/document-profile`,
          headers: { ...headers, "idempotency-key": randomUUID(), "if-match": `"${upload.json().version}"` },
          payload: { documentType: "Mining permit" } });
        expect(profile.statusCode, profile.body).toBe(200);
        expect(profile.json().documentType).toBe("Mining permit");
        for (const url of [`${project}/document-graph`, `${document}/impact-preview`]) {
          const detail = await dev.inject({ url, headers });
          expect(detail.statusCode, detail.body).toBe(200);
        }
      } finally {
        await dev.close();
      }
    });

    it("opens an existing administrator workspace on first and returning verified Google sign-in", async () => {
      const holder = await aal2Person();
      if (!holder.email) throw new Error("Expected a fixture email");
      await fx.sql`UPDATE core.subjects SET assurance_level='high_assurance' WHERE id=${holder.id}`;
      await fx.sql`INSERT INTO core.role_bindings(id,subject_id,organization_id,role)
        VALUES(${randomUUID()},${holder.id},${fx.orgA},'administrator')`;
      const sub = googleSub();
      const claims = {
        sub, email: holder.email, email_verified: true, hd: holder.email.split("@")[1],
      };
      const response = await finish("google", await startSignIn("google"), { claims });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ firstFactor: "google", aal: "aal1" });
      const identities = await fx.sql`
        SELECT subject_id FROM core.external_identities WHERE provider = 'google' AND subject_key = ${sub}
      `;
      expect(identities).toHaveLength(1);
      expect(identities[0]!.subject_id).toBe(response.json().subjectId);
      const session = await get("/api/v1/auth/session", holder.token);
      expect(response.json().subjectId).toBe(session.json().subjectId);
      const dev = await buildServer(loadConfig(oidcEnv({ DEPLOY_ENVIRONMENT: "develop", CHAIN_ID: "5611" })), fx.appSql);
      try {
        for (const token of [response.json().sessionToken,
          (await finish("google", await startSignIn("google"), { claims })).json().sessionToken]) {
          const headers = bearer(token);
          const session = await dev.inject({ url: "/api/v1/auth/session", headers });
          expect(session.json()).toMatchObject({ aal: "aal1",
            roleBindings: expect.arrayContaining([expect.objectContaining({ role: "administrator" })]) });
          expect((await dev.inject({ url: "/api/v1/projects", headers })).statusCode).toBe(200);
          expect((await get("/api/v1/auth/session", token)).json()).toMatchObject({ aal: "aal1", subjectId: holder.id });
          expect((await get("/api/v1/projects", token)).statusCode).toBe(200);
          const project = await dev.inject({ method: "POST", url: "/api/v1/projects",
            headers: { ...headers, "idempotency-key": randomUUID() },
            payload: { projectKey: randomUUID(), name: "Development project", hostCountryIso3: "MNG", ownerOrganizationId: fx.orgA } });
          expect(project.statusCode, project.body).toBe(200);
          const projectId = project.json().id;
          for (const url of ["/api/v1/jurisdictions/MNG/profile", "/api/v1/claim-types"]) {
            const data = await dev.inject({ url, headers });
            expect(data.statusCode, data.body).toBe(200);
          }
          const assessment = await dev.inject({ method: "POST", url: `/api/v1/projects/${projectId}/evidence-ledger`,
            headers: { ...headers, "idempotency-key": randomUUID() }, payload: {} });
          expect(assessment.statusCode, assessment.body).toBe(200);
          const publisher = await signIn(app, fx.disclosureApproverA);
          const published = await publishProject(dev, fx.sql, { drafter: token, publisher }, projectId);
          expect(published.statusCode, published.body).toBe(200);
          const batch = await dev.inject({ method: "POST", url: "/api/v1/anchor-batches",
            headers: { ...headers, "idempotency-key": randomUUID() }, payload: { projectId } });
          expect(batch.statusCode, batch.body).toBe(200);
          const grant = await dev.inject({ method: "POST", url: "/api/v1/admin/role-grants", headers });
          expect(grant.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");
        }
        const key = newAccount();
        const token = response.json().sessionToken;
        await expect(fx.appSql`INSERT INTO core.development_google_wallet_policy VALUES(true)`).rejects.toThrow(/permission denied/);
        await fx.sql`INSERT INTO core.development_google_wallet_policy VALUES(true)`;
        try {
          const bound = await bindWalletByProof(dev, token, key.account);
          expect(bound.statusCode, bound.body).toBe(200);
          expect(bound.json()).toMatchObject({ chainId: 5611, walletAddress: key.address, boundVia: "proof" });
          const replacement = await bindWalletByProof(dev, token, newAccount().account, "rotation");
          expect(replacement.statusCode, replacement.body).toBe(403);
          expect(replacement.json().code).toBe("WALLET_PREVIOUS_SIGNATURE_REQUIRED");
          const authorized = await bindWalletByProof(dev, token, newAccount().account, "rotation", key.account);
          expect(authorized.statusCode, authorized.body).toBe(200);
        } finally {
          await fx.sql`DELETE FROM core.development_google_wallet_policy`;
        }
      } finally {
        await dev.close();
      }
    });

    it("rejects email matching without Workspace authority", async () => {
      const holder = await aal2Person();
      await link("google", holder.token, { sub: googleSub() });
      // The fixture's database is this file's own.
      const identities = async () =>
        (await fx.sql`SELECT count(*)::int AS n FROM core.external_identities`)[0]!.n as number;
      const people = async () =>
        (await fx.sql`SELECT count(*)::int AS n FROM core.subjects`)[0]!.n as number;
      const countBefore = await identities();
      const subjectsBefore = await people();

      const google = await finish("google", await startSignIn("google"), {
        claims: { sub: googleSub(), email: holder.email, email_verified: true },
      });
      expect(google.statusCode).toBe(401);
      expect(google.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");

      // The same answer as for an address nobody holds.
      const nobody = await finish("google", await startSignIn("google"), { claims: { email: "nobody@example.com" } });
      expect(nobody.json()).toMatchObject({ code: "OIDC_ACCOUNT_NOT_FOUND", message: google.json().message });

      expect(await identities()).toBe(countBefore);
      expect(await people()).toBe(subjectsBefore);
      expect(await fx.sql`SELECT 1 FROM core.sessions WHERE subject_id = ${holder.id} AND first_factor = 'google'`).toHaveLength(0);
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
    it("requires an authenticated account session", async () => {
      const subject = await person();
      const aal1 = await issueTestSession(fx.appSql, subject.id, { firstFactor: "email_code" });
      const refused = await post("/api/v1/auth/oidc/google/link/start", undefined, bearer(aal1));
      expect(refused.statusCode).toBe(200);
      const anonymous = await post("/api/v1/auth/oidc/google/link/start");
      expect(anonymous.statusCode).toBe(401);

      // The database binds the new transaction to this session.
      const [session] = await fx.sql<{ id: string; subject_id: string }[]>`SELECT id, subject_id FROM core.sessions WHERE token_hash = ${hashToken(aal1)}`;
      // The caller acts as the session's own subject.
      const [started] = await withActor(fx.appSql, { subjectId: session!.subject_id }, (tx) => tx<{ status: string }[]>`
        SELECT status FROM core.start_oidc_transaction(
          ${randomUUID()}, 'google', 'link', ${createHash("sha256").update(randomUUID()).digest("hex")}, ${"b".repeat(64)}, ${"c".repeat(64)}, ${Buffer.alloc(40)},
          'http://localhost:3000/auth/oidc/google/callback', ${session!.id}, NULL, NULL, ${randomUUID()}
        )
      `);
      expect(started!.status).toBe("started");
    });

    it("links to the session's subject and lists it", async () => {
      const holder = await aal2Person();
      const linked = await link("google", holder.token, { sub: googleSub() });
      expect(linked).toMatchObject({ provider: "google", issuer: "https://accounts.google.com" });
      const list = (await get("/api/v1/auth/identities", holder.token)).json();
      expect(list.items).toEqual([expect.objectContaining({ id: linked.id, linkedVia: "link", revokedAt: null })]);
      // Only a keyed hash of the address the provider reported is kept.
      const [row] = await fx.sql<{ email_hash: string }[]>`SELECT email_hash FROM core.external_identities WHERE id = ${linked.id}`;
      expect(row!.email_hash).toMatch(/^[0-9a-f]{64}$/);
      const [audit] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'auth.oidc.identity_linked' AND resource_id = ${linked.id}
      `;
      expect(JSON.stringify(audit!.detail)).not.toContain(holder.email!);
    });

    it("comes back only on the session that started it", async () => {
      const holder = await aal2Person();
      const other = await issueTestSession(fx.appSql, holder.id, { firstFactor: "email_code", secondFactor: "totp" });
      const started = await startLink("google", holder.token);
      const { code, state } = idp.authorize(started.authorizationUrl, { claims: { email: holder.email, hd: "example.com", email_verified: true } });
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

    it("refuses with one generic code an identity linked anywhere — this account or another", async () => {
      const sub = googleSub();
      const first = await aal2Person();
      await link("google", first.token, { sub });

      const another = await aal2Person();
      const answers = [];
      for (const holder of [first, another]) {
        const response = await finish("google", await startLink("google", holder.token), { claims: { sub } }, holder.token);
        expect(response.statusCode).toBe(409);
        answers.push(response.json());
      }
      for (const answer of answers) {
        expect(answer).toMatchObject({ code: "OIDC_IDENTITY_UNAVAILABLE" });
        expect(answer.message).toBe(answers[0].message);
      }
      // Audited without saying where the identity lives.
      const [audit] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'auth.oidc.link_refused'
        ORDER BY occurred_at DESC LIMIT 1
      `;
      expect(audit!.detail).toMatchObject({ reason: "unavailable" });
      expect(JSON.stringify(audit!.detail)).not.toContain(first.id);
    });

    it("one identity per provider per account", async () => {
      const holder = await aal2Person();
      await link("google", holder.token, { sub: googleSub() });
      const second = await finish("google", await startLink("google", holder.token), { claims: { sub: googleSub(), email: holder.email, hd: "example.com", email_verified: true } }, holder.token);
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("OIDC_PROVIDER_ALREADY_LINKED");
    });

    it("refuses a link whose session was revoked before the callback", async () => {
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
    it("ends the sessions the identity signed in, and is audited", async () => {
      const holder = await aal2Person();
      const sub = googleSub();
      const linked = await link("google", holder.token, { sub });
      const signedIn = (await finish("google", await startSignIn("google"), { claims: { sub } })).json().sessionToken as string;
      expect((await sessionOf(signedIn)).authenticated).toBe(true);

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
      const token = await issueTestSession(fx.appSql, subject.id, { firstFactor: "google", secondFactor: "totp" });
      const [identity] = await fx.sql<{ id: string }[]>`SELECT id FROM core.external_identities WHERE subject_id = ${subject.id}`;
      const response = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(response.json()).toEqual({ revokedSessions: 0, currentSessionEnded: true });
      expect((await sessionOf(token)).authenticated).toBe(false);
    });

    it("never unlinks the last way to sign in", async () => {
      // A person without an address whose one way in is a Google identity.
      const subject = await person(null);
      const token = await issueTestSession(fx.appSql, subject.id, { firstFactor: "google", secondFactor: "totp" });
      const [identity] = await fx.sql<{ id: string }[]>`SELECT id FROM core.external_identities WHERE subject_id = ${subject.id}`;
      const refused = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(refused.statusCode).toBe(422);
      expect(refused.json().code).toBe("OIDC_LAST_SIGN_IN_METHOD");

      // The contrast: with an account address to sign in with, the identity can go.
      await fx.sql`UPDATE core.subjects SET email = ${`last-way-${subject.id}@example.test`} WHERE id = ${subject.id}`;
      const done = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(done.statusCode, done.body).toBe(200);
    });

    it("a recovery-limited session cannot unlink", async () => {
      const subject = await person();
      const token = await issueTestSession(fx.appSql, subject.id, { firstFactor: "google", secondFactor: "recovery_code" });
      const [identity] = await fx.sql<{ id: string }[]>`SELECT id FROM core.external_identities WHERE subject_id = ${subject.id}`;
      const response = await post(`/api/v1/auth/identities/${identity!.id}/unlink`, undefined, bearer(token));
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("UNAUTHENTICATED");
      const [session] = await fx.sql<{ id: string }[]>`SELECT id FROM core.sessions WHERE token_hash = ${hashToken(token)}`;
      await expect(
        withActor(fx.appSql, { subjectId: subject.id }, (tx) => tx`SELECT * FROM core.unlink_external_identity(${session!.id}, ${identity!.id})`),
      ).rejects.toThrow(/MFA_RECOVERY_REENROLMENT_REQUIRED/);
    });
  });

  // --- Invitations -------------------------------------------------------------

  describe("accepting an invitation with a provider", () => {
    async function invite(email = `invitee-${randomUUID().slice(0, 8)}@example.com`) {
      const token = generateInvitationToken();
      const id = randomUUID();
      await withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, (tx) => tx`
        SELECT * FROM core.create_invitation(${id}, ${fx.orgA}, ${email}, ${fx.operatorSubjectA}, ${hashToken(token)}, 'http://localhost:3000/invitations/accept#token=x')
      `);
      return { id, token, email };
    }
    const acceptStart = (provider: Provider, token: string) =>
      startSignIn(provider, { purpose: "invitation_accept", invitationToken: token, displayName: "Invited Person" });

    it("activates exactly one approved project role on first Google sign-in", async () => {
      const admin = await signIn(app, fx.operatorA);
      const email = `invited-reviewer-${randomUUID()}@example.com`;
      const payload = { email, organizationId: fx.reviewOrgA, access: {
        role: "reviewer", projectId: fx.projectA, identityBasis: "Checked company personnel record",
      } };
      const send = (token: string, data = payload) => post("/api/v1/admin/invitations", data,
        { ...bearer(token), "idempotency-key": randomUUID() });
      expect((await send(await signIn(app, fx.stewardA))).statusCode).toBe(403);
      expect((await send(admin, { ...payload, access: { ...payload.access, projectId: randomUUID() } })).statusCode).toBe(422);
      expect((await send(admin, { ...payload, access: { ...payload.access, role: "project_member" } })).statusCode).toBe(422);
      // Another company's organization-scoped administrator does not reach project A.
      const foreign = await send(await signIn(app, fx.operatorB));
      expect(foreign.statusCode).toBe(403);
      for (const state of ["revoked", "expired"]) {
        const address = `${state}-${email}`;
        const issued = await send(admin, { ...payload, email: address });
        expect(issued.statusCode, issued.body).toBe(200);
        const { id, version } = issued.json();
        if (state === "revoked") {
          const revoked = await post(`/api/v1/admin/invitations/${id}/revoke`, undefined,
            { ...bearer(admin), "idempotency-key": randomUUID(), "if-match": `"${version}"` });
          expect(revoked.statusCode, revoked.body).toBe(200);
        } else {
          await fx.sql`UPDATE core.invitations SET created_at = now() - interval '4 days',
            expires_at = now() - interval '1 day' WHERE id = ${id}`;
        }
        const rejected = await finish("google", await startSignIn("google"),
          { claims: { sub: googleSub(), email: address, email_verified: true, hd: "example.com" } });
        expect(rejected.statusCode).toBe(401);
        expect(await fx.sql`SELECT id FROM core.subjects WHERE email=${address}`).toHaveLength(0);
      }
      const created = await send(admin);
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json()).toMatchObject({ role: "reviewer", projectId: fx.projectA, state: "pending" });
      const claims = { sub: googleSub(), email, email_verified: true, hd: "example.com" };
      const dev = await buildServer(loadConfig(oidcEnv({ DEPLOY_ENVIRONMENT: "develop", CHAIN_ID: "5611" })), fx.appSql);
      try {
        for (let visit = 0; visit < 2; visit++) {
          const login = await finish("google", await startSignIn("google"), { claims });
          expect(login.statusCode, login.body).toBe(200);
          const headers = bearer(login.json().sessionToken);
          const session = await dev.inject({ url: "/api/v1/auth/session", headers });
          expect(session.json()).toMatchObject({ aal: "aal1", assuranceLevel: "high_assurance",
            roleBindings: [expect.objectContaining({ role: "reviewer", organizationId: fx.reviewOrgA, projectId: fx.projectA })] });
          expect((await dev.inject({ url: `/api/v1/projects/${fx.projectA}/overview`, headers })).statusCode).toBe(200);
          expect([403, 404]).toContain((await dev.inject({ url: `/api/v1/projects/${fx.otherProjectA}/overview`, headers })).statusCode);
        }
      } finally {
        await dev.close();
      }
    });

    it("accepts a pending invitation from ordinary Google sign-in without the invitation token", async () => {
      const [runtime] = await fx.appSql`SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`;
      expect(runtime).toMatchObject({ rolsuper: false, rolbypassrls: false });
      const invitation = await invite();
      const sub = googleSub();
      const claims = { sub, email: invitation.email, email_verified: true, hd: "example.com", name: "Alex Lee" };
      const first = await finish("google", await startSignIn("google"), { claims });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({ firstFactor: "google", roleBindings: [] });
      expect(await fx.sql`SELECT display_name FROM core.subjects WHERE id = ${first.json().subjectId}`).toMatchObject([{ display_name: "Alex Lee" }]);
      const again = await finish("google", await startSignIn("google"), { claims });
      expect(again.json().subjectId).toBe(first.json().subjectId);
      await fx.sql`UPDATE core.subjects SET created_at = now() - interval '2 days' WHERE id = ${first.json().subjectId}`;
      const deferred = await get("/api/v1/auth/mfa", again.json().sessionToken);
      expect(deferred.statusCode).toBe(404);
      const stranger = await finish("google", await startSignIn("google"), { claims: { ...claims, sub: googleSub() } });
      expect(stranger.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
    });

    it("does not consume an invitation from an untrusted email or after revocation", async () => {
      const invitation = await invite();
      const claims = { sub: googleSub(), email: invitation.email, email_verified: true };
      const untrusted = await finish("google", await startSignIn("google"), { claims });
      expect(untrusted.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
      await withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, (tx) => tx`
        SELECT * FROM core.revoke_invitation(${invitation.id}, ${fx.operatorSubjectA}, 1)
      `);
      const revoked = await finish("google", await startSignIn("google"), { claims: { ...claims, hd: "example.com" } });
      expect(revoked.json().code).toBe("OIDC_ACCOUNT_NOT_FOUND");
      expect(await fx.sql`SELECT 1 FROM core.subjects WHERE email = ${invitation.email}`).toHaveLength(0);
    });

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

      expect((await get("/api/v1/auth/mfa", body.sessionToken)).statusCode).toBe(404);

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
    /** An aal3 admin with `role`. */
    async function admin(role: "administrator" | "administrator") {
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.subjects (id, kind, display_name, assurance_level)
        VALUES (${id}, 'person', 'Recovery Admin', 'high_assurance')
      `;
      await fx.sql`
        INSERT INTO core.role_bindings (id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${id}, ${fx.orgA}, ${role})
      `;
      return issueTestSession(fx.appSql, id, { firstFactor: "email_code", secondFactor: "passkey" });
    }
    const adminPost = (url: string, token: string, payload: unknown, headers: Record<string, string> = {}) =>
      app.inject({
        method: "POST", url, payload: payload as never, remoteAddress: freshIp(),
        headers: { ...bearer(token), "idempotency-key": randomUUID().replace(/-/g, ""), ...headers },
      });
    const signInWith = (sub: string) => startSignIn("google").then((started) => finish("google", started, { claims: { sub } }));
    const live = (subjectId: string) =>
      fx.sql<{ provider: string }[]>`SELECT provider FROM core.external_identities WHERE subject_id = ${subjectId} AND revoked_at IS NULL`;

    /** Bystanders whose identities must survive: two other people. */
    async function bystanders() {
      const first = await aal2Person();
      const second = await aal2Person();
      const subs = [googleSub(), googleSub()];
      await link("google", first.token, { sub: subs[0] });
      await link("google", second.token, { sub: subs[1] });
      return { subjects: [first.id, second.id], subs };
    }
    async function expectBystandersUntouched(b: Awaited<ReturnType<typeof bystanders>>) {
      for (const id of b.subjects) expect(await live(id), id).toHaveLength(1);
      for (const sub of b.subs) expect((await signInWith(sub)).statusCode).toBe(200);
    }

    it("an email change revokes them too", async () => {
      const victim = await aal2Person();
      const attackerSub = googleSub();
      await link("google", victim.token, { sub: attackerSub });
      const others = await bystanders();

      const proposer = await admin("administrator");
      const approver = await admin("administrator");
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
      const [ownerMail] = await fx.sql`SELECT params FROM core.email_outbox WHERE recipient=${victim.email} AND template='email_change_owner' AND state='pending'`;
      const completed = await post("/api/v1/auth/email-change/verify", { email: newEmail, code: mail!.params.code, ownerCode: ownerMail!.params.code });
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

      const owner = await issueTestSession(fx.appSql, victim.id, { firstFactor: "email_code", secondFactor: "totp" });
      await link("google", owner, { sub: attackerSub });
      expect((await signInWith(attackerSub)).json().subjectId).toBe(victim.id);
    });


  });

  // --- Database boundary --------------------------------------------------------

  describe("database boundary", () => {
    it("the application role cannot read identities or transactions, nor mint a Google session", async () => {
      await expect(fx.appSql`SELECT 1 FROM core.external_identities LIMIT 1`).rejects.toThrow(/permission denied/);
      await expect(fx.appSql`SELECT 1 FROM core.oidc_login_transactions LIMIT 1`).rejects.toThrow(/permission denied/);
      const subject = await person();
      await expect(
        withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, (tx) =>
          tx`INSERT INTO core.external_identities (id, subject_id, provider, issuer, subject_key, linked_via)
             VALUES (${randomUUID()}, ${subject.id}, 'google', 'https://accounts.google.com', 'x', 'link')`,
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, (tx) =>
          tx`SELECT core.create_subject_session(${randomUUID()}, ${hashToken(randomUUID())}, ${subject.id}, 'google', NULL, 3600)`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("a completed transaction makes one session, and completing it again is refused", async () => {
      const subject = await person();
      const token = await issueTestSession(fx.appSql, subject.id, { firstFactor: "google" });
      const [row] = await fx.sql<{ oidc_transaction_id: string }[]>`SELECT oidc_transaction_id FROM core.sessions WHERE token_hash = ${hashToken(token)}`;
      const [identity] = await fx.sql<{ issuer: string; subject_key: string }[]>`SELECT issuer, subject_key FROM core.external_identities WHERE subject_id = ${subject.id}`;
      await expect(
        fx.appSql`SELECT * FROM core.complete_oidc_sign_in(${row!.oidc_transaction_id}, ${identity!.issuer}, ${identity!.subject_key}, ${randomUUID()}, ${hashToken(randomUUID())}, 3600)`,
      ).rejects.toThrow(/OIDC_TRANSACTION_INVALID/);
    });
  });

  describe("account isolation", () => {
    it("an identity of one account is invisible and unreachable from another", async () => {
      const a = await aal2Person();
      const linked = await link("google", a.token, { sub: googleSub() });
      const b = await aal2Person();
      expect((await get("/api/v1/auth/identities", b.token)).json().items).toEqual([]);
      const unlink = await post(`/api/v1/auth/identities/${linked.id}/unlink`, undefined, bearer(b.token));
      expect(unlink.statusCode).toBe(404);
      expect(await fx.sql`SELECT 1 FROM core.external_identities WHERE id = ${linked.id} AND revoked_at IS NULL`).toHaveLength(1);
    });

    it("a sign-in lands on the identity's subject, whatever actor the caller set", async () => {
      const b = await aal2Person();
      const sub = googleSub();
      await link("google", b.token, { sub });
      const response = await finish("google", await startSignIn("google"), { claims: { sub } });
      const [row] = await fx.sql<{ subject_id: string }[]>`SELECT subject_id FROM core.sessions WHERE token_hash = ${hashToken(response.json().sessionToken)}`;
      expect(row!.subject_id).toBe(b.id);

      // The caller's actor cannot steer it: completed as operator A, the session is still B's.
      const sha = (value: string) => createHash("sha256").update(value).digest("hex");
      const [state, binding, txId, sessionId] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const [identity] = await fx.sql<{ issuer: string; subject_key: string }[]>`
        SELECT issuer, subject_key FROM core.external_identities WHERE subject_id = ${b.id} AND revoked_at IS NULL
      `;
      const steered = await withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, async (tx) => {
        await tx`SELECT * FROM core.start_oidc_transaction(
          ${txId}, 'google', 'sign_in', ${sha(state)}, ${sha(binding)}, ${sha(randomUUID())}, ${Buffer.alloc(40)},
          'http://localhost:3000/auth/oidc/google/callback', NULL, NULL, NULL, ${randomUUID()})`;
        await tx`SELECT * FROM core.claim_oidc_transaction(${sha(state)}, ${sha(binding)}, 'google', NULL)`;
        return tx<{ status: string; subject_id: string }[]>`
          SELECT * FROM core.complete_oidc_sign_in(${txId}, ${identity!.issuer}, ${identity!.subject_key}, ${sessionId}, ${hashToken(randomUUID())}, 3600)
        `;
      });
      expect(steered[0]).toMatchObject({ status: "session_created", subject_id: b.id });
      const [session] = await fx.sql<{ subject_id: string }[]>`SELECT subject_id FROM core.sessions WHERE id = ${sessionId}`;
      expect(session!.subject_id).toBe(b.id);
    });
  });

  // --- Configuration and network ---------------------------------------------

  describe("configuration and network", () => {
    it("answers OIDC_PROVIDER_DISABLED for a provider that is not configured, and REQUEST_INVALID for an unknown one", async () => {
      const bare = await buildServer(loadConfig(testEnv()), fx.appSql, { oidcFetch: idp.fetch });
      try {
        const response = await bare.inject({ method: "POST", url: "/api/v1/auth/oidc/google/start", payload: { purpose: "sign_in" }, remoteAddress: freshIp() });
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe("OIDC_PROVIDER_DISABLED");
        // Not a provider at all — and Microsoft, removed in 0171, is no longer one: a malformed
        // path, on any deployment, for both public routes of the flow. (The link routes answer
        // an anonymous caller 401 before reading the provider.)
        for (const server of [bare, app]) {
          for (const provider of ["github", "microsoft"]) {
            for (const path of ["start", "callback"]) {
              const response = await server.inject({ method: "POST", url: `/api/v1/auth/oidc/${provider}/${path}`, payload: { purpose: "sign_in" }, remoteAddress: freshIp() });
              expect(response.statusCode, `${provider}/${path}`).toBe(400);
              expect(response.json().code).toBe("REQUEST_INVALID");
            }
          }
        }
        // Signed in past the second factor, the link routes refuse Microsoft the same way.
        const holder = await aal2Person();
        for (const path of ["link/start", "link/callback"]) {
          const response = await post(`/api/v1/auth/oidc/microsoft/${path}`, {}, bearer(holder.token));
          expect(response.statusCode, path).toBe(400);
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
