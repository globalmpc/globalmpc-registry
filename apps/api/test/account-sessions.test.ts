import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { withTenant } from "@mpc/db";
import { hashToken, revokeSubjectSessions } from "../src/plugins/session-token.js";
import {
  bearer,
  idempotencyKey,
  issueTestServiceToken,
  issueTestSession,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Account sessions — WP1 of account authentication.
 *
 * Sessions are keyed by subject and record the factors they proved; the authentication level
 * (AAL) is derived from those factors. These tests hold the plan's priority rules:
 *
 * 1. revoked, expired or idle sessions → no session (401); no wallet session exists at all (WP7);
 * 2. a first-factor-only session reaches only MFA, logout and its own session;
 * 4. a role whose AAL minimum is not met is narrowed out of the session, not 403-everything;
 *
 * and the service token boundary (D7): a token reaches only the routes its scopes name, makes
 * only service roles effective, and a person session never makes a service role effective.
 */
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

  const get = (url: string, token: string) => app.inject({ method: "GET", url, headers: bearer(token) });
  const session = async (token: string) => (await get("/api/v1/auth/session", token)).json();

  describe("derived authentication level", () => {
    it("a first-factor-only session reads its own session and nothing else", async () => {
      const token = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, { firstFactor: "email_code" });

      const own = await session(token);
      expect(own).toMatchObject({
        authenticated: true,
        subjectId: fx.stewardSubjectA,
        firstFactor: "email_code",
        secondFactor: null,
        aal: "aal1",
        mfaSatisfied: false,
      });
      expect(own).not.toHaveProperty("walletAddress");
      // Nothing about what the account could do once past MFA: no roles, no narrowed roles, no
      // actions, no tenant or project ids.
      expect(own.roleBindings).toEqual([]);
      for (const hidden of ["narrowedRoles", "actions", "projectIds", "tenantId"]) {
        expect(own, hidden).not.toHaveProperty(hidden);
      }
      // The same subject past MFA does see them.
      const full = await session(
        await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, { firstFactor: "email_code", secondFactor: "totp" }),
      );
      expect(full.roleBindings.length).toBeGreaterThan(0);
      expect(full.actions.length).toBeGreaterThan(0);

      // The same steward with a second factor reads the project; aal1 may not.
      for (const url of ["/api/v1/projects", `/api/v1/projects/${fx.projectA}`]) {
        const denied = await get(url, token);
        expect(denied.statusCode, url).toBe(403);
        expect(denied.json()).toMatchObject({
          code: "MFA_REQUIRED",
          details: { reason: "AUTHENTICATION_LEVEL_INSUFFICIENT", requiredAal: "aal2" },
        });
      }

      const logout = await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: bearer(token) });
      expect(logout.json()).toMatchObject({ revoked: true });
      expect((await session(token)).authenticated).toBe(false);
    });

    it("a TOTP session makes an aal2 role effective", async () => {
      const token = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, {
        firstFactor: "google",
        secondFactor: "totp",
      });
      expect(await session(token)).toMatchObject({ aal: "aal2", mfaSatisfied: true, narrowedRoles: [] });
      expect((await get(`/api/v1/projects/${fx.projectA}`, token)).statusCode).toBe(200);
    });

    it("a TOTP session cannot use a passkey-only role; a passkey session can", async () => {
      const totp = await issueTestSession(fx.appSql, fx.tenantA, fx.reviewerSubjectA, {
        firstFactor: "microsoft",
        secondFactor: "totp",
      });
      const view = await session(totp);
      expect(view.roleBindings).toEqual([]);
      expect(view.narrowedRoles).toEqual([{ role: "reviewer_cp_qp", requiredAal: "aal3" }]);
      expect(view.actions).toEqual([]);

      const denied = await get(`/api/v1/projects/${fx.projectA}`, totp);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().details).toMatchObject({
        reason: "AUTHENTICATION_LEVEL_INSUFFICIENT",
        role: "reviewer_cp_qp",
        requiredAal: "aal3",
      });

      const passkey = await issueTestSession(fx.appSql, fx.tenantA, fx.reviewerSubjectA, {
        firstFactor: "microsoft",
        secondFactor: "passkey",
      });
      expect(await session(passkey)).toMatchObject({ aal: "aal3", narrowedRoles: [] });
      expect((await get(`/api/v1/projects/${fx.projectA}`, passkey)).statusCode).toBe(200);
    });

    it("narrows only the role whose minimum is not met — the other roles keep working", async () => {
      // A steward who is also a gate approver: at aal2 the approver role is narrowed out, the
      // steward role stays and still reads the project.
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${fx.stewardSubjectA}, ${fx.reviewOrgA}, 'gate_approver')
      `;
      try {
        const token = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, {
          firstFactor: "email_code",
          secondFactor: "totp",
        });
        const view = await session(token);
        expect(view.roleBindings.map((binding: { role: string }) => binding.role)).toEqual(["data_steward"]);
        expect(view.narrowedRoles).toEqual([{ role: "gate_approver", requiredAal: "aal3" }]);
        expect(view.actions).not.toContain("gate.decide");
        expect((await get(`/api/v1/projects/${fx.projectA}`, token)).statusCode).toBe(200);
      } finally {
        await fx.sql`
          UPDATE core.role_bindings SET revoked_at = now()
          WHERE subject_id = ${fx.stewardSubjectA} AND role = 'gate_approver' AND revoked_at IS NULL
        `;
      }
    });

    it("an aal1 session cannot read restricted data through any authenticated route", async () => {
      const token = await issueTestSession(fx.appSql, fx.tenantA, fx.operatorSubjectA, { firstFactor: "email_code" });
      for (const url of [
        "/api/v1/admin/subjects",
        "/api/v1/audit-events/export",
        `/api/v1/projects/${fx.projectA}/evidence`,
      ]) {
        const response = await get(url, token);
        expect(response.statusCode, url).toBe(403);
        expect(response.json().code, url).toBe("MFA_REQUIRED");
      }
    });
  });

  describe("session lifetime", () => {
    it("refuses a session idle for 30 minutes, though its absolute expiry is hours away", async () => {
      const token = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, {
        firstFactor: "email_code",
        secondFactor: "totp",
      });
      expect((await session(token)).authenticated).toBe(true);

      await fx.sql`
        UPDATE core.sessions SET last_seen_at = now() - interval '30 minutes 1 second'
        WHERE subject_id = ${fx.stewardSubjectA} AND revoked_at IS NULL
      `;
      expect((await session(token)).authenticated).toBe(false);
      expect((await get(`/api/v1/projects/${fx.projectA}`, token)).statusCode).toBe(401);
    });

    it("a session used within the idle window stays alive", async () => {
      const token = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, {
        firstFactor: "email_code",
        secondFactor: "totp",
      });
      await fx.sql`
        UPDATE core.sessions SET last_seen_at = now() - interval '29 minutes'
        WHERE subject_id = ${fx.stewardSubjectA} AND revoked_at IS NULL
      `;
      expect((await session(token)).authenticated).toBe(true);
    });

    it("revoking a subject's sessions ends every one of them, whatever their factors", async () => {
      const tokens = [
        await issueTestSession(fx.appSql, fx.tenantA, fx.reviewerSubjectA, { firstFactor: "email_code", secondFactor: "passkey" }),
        await issueTestSession(fx.appSql, fx.tenantA, fx.reviewerSubjectA, { firstFactor: "google", secondFactor: "totp" }),
        await signIn(app, fx.reviewerA),
      ];
      for (const token of tokens) expect((await session(token)).authenticated).toBe(true);

      // Another subject's session is untouched.
      const other = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, { firstFactor: "email_code", secondFactor: "totp" });

      // From another tenant's context nothing is revoked.
      expect(
        await withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) =>
          revokeSubjectSessions(tx, fx.reviewerSubjectA, "test_revocation"),
        ),
      ).toBe(0);
      for (const token of tokens) expect((await session(token)).authenticated).toBe(true);

      expect(
        await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          revokeSubjectSessions(tx, fx.reviewerSubjectA, "test_revocation"),
        ),
      ).toBeGreaterThanOrEqual(3);
      for (const token of tokens) expect((await session(token)).authenticated).toBe(false);
      expect((await session(other)).authenticated).toBe(true);
    });

    it("the application role cannot read or write the sessions table directly", async () => {
      await expect(fx.appSql`SELECT 1 FROM core.sessions LIMIT 1`).rejects.toThrow(/permission denied/);
      await expect(fx.appSql`SELECT 1 FROM core.service_tokens LIMIT 1`).rejects.toThrow(/permission denied/);
    });

    it("never issues a session to a service subject", async () => {
      // A service authenticates with a service token; no identity can be linked to it, so no
      // Google / Microsoft sign-in can name it, and the general session function refuses every
      // first factor (0121).
      await expect(
        fx.sql`
          INSERT INTO core.external_identities (id, tenant_id, subject_id, provider, issuer, subject_key, linked_via)
          VALUES (${randomUUID()}, ${fx.tenantA}, ${fx.scanServiceSubjectA}, 'google', 'https://accounts.google.com', ${randomUUID()}, 'link')
        `,
      ).rejects.toThrow(/person subject/);
      await expect(issueTestSession(fx.appSql, fx.tenantA, fx.scanServiceSubjectA, { firstFactor: "google" })).rejects.toThrow(
        /no person subject/,
      );
    });

    it("no caller can state a first factor: the general session function refuses every one", async () => {
      for (const factor of ["google", "microsoft", "email_code", "siwe_legacy"]) {
        await expect(
          withTenant(fx.sql, { tenantId: fx.tenantA }, (tx) =>
            tx`SELECT core.create_subject_session(${randomUUID()}, ${hashToken(randomUUID())}, ${fx.stewardSubjectA}, ${factor}::core.session_first_factor, NULL, 3600)`,
          ),
          factor,
        ).rejects.toThrow(/created (only )?by/);
      }
      // And the application role may not even call it any more.
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
          tx`SELECT core.create_subject_session(${randomUUID()}, ${hashToken(randomUUID())}, ${fx.stewardSubjectA}, 'google', NULL, 3600)`,
        ),
      ).rejects.toThrow(/permission denied/);
    });

    it("a Google sign-in session lands in the identity's tenant, whatever context the caller set", async () => {
      // The tenant comes from the linked identity, never from the caller; RLS cannot be used to
      // steer a session into another tenant.
      const token = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, { firstFactor: "google", secondFactor: "totp" });
      const [row] = await fx.sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM core.sessions WHERE token_hash = ${hashToken(token)}
      `;
      expect(row!.tenant_id).toBe(fx.tenantA);
      // The completion run from inside tenant B's context still lands in A; covered end to end
      // in oidc.test.ts ("tenant isolation").
    });
  });

  describe("sessions and wallets (WP7)", () => {
    it("a session carries the subject's assurance, whatever key found the person", async () => {
      // Before WP7 a SIWE session of a weaker key was held to that key's level. Keys no longer
      // sign anyone in, so a session is the person's, at the person's level, whatever the key's.
      // An account holds one wallet (0130): here a high-assurance person whose key is `wallet_only`.
      const hot = newAccount();
      const subjectId = randomUUID();
      await fx.sql`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
        VALUES (${subjectId}, ${fx.tenantA}, 'person', 'Hot key holder', 'high_assurance')
      `;
      await fx.sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${hot.address}, 31337, 'wallet_only', now())
      `;
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.reviewOrgA}, 'reviewer_cp_qp')
      `;
      const viaHot = await session(await signIn(app, hot));
      const viaMain = await session(await signIn(app, fx.reviewerA));
      for (const [view, subject] of [
        [viaHot, subjectId],
        [viaMain, fx.reviewerSubjectA],
      ] as const) {
        expect(view).toMatchObject({ subjectId: subject, assuranceLevel: "high_assurance", firstFactor: "email_code" });
        expect(view.roleBindings.map((binding: { role: string }) => binding.role)).toContain("reviewer_cp_qp");
      }
    });

    it("no wallet session can be live: not inserted, not revived, not resolved — for any role", async () => {
      const id = randomUUID();
      const token = randomUUID();
      const insert = (revoked: boolean) => fx.sql`
        INSERT INTO core.sessions (id, token_hash, first_factor, wallet_address, chain_id, expires_at, revoked_at, revoked_reason)
        VALUES (
          ${id}, ${hashToken(token)}, 'siwe_legacy', ${fx.operatorA.address}, 31337, now() + interval '1 hour',
          ${revoked ? fx.sql`now()` : null}, ${revoked ? "legacy_wallet_login_removed" : null}
        )
      `;
      // The migration connection is a superuser: the constraint, not a grant, refuses it.
      await expect(insert(false)).rejects.toThrow(/sessions_no_live_wallet_login/);
      await insert(true);
      await expect(
        fx.sql`UPDATE core.sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = ${id}`,
      ).rejects.toThrow(/sessions_no_live_wallet_login/);
      expect((await session(token)).authenticated).toBe(false);
      await fx.sql`DELETE FROM core.sessions WHERE id = ${id}`;
    });
  });

  describe("service tokens", () => {
    const scanResult = (uploadId: string, token: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/uploads/${uploadId}/scan-result`,
        headers: { ...bearer(token), "idempotency-key": idempotencyKey(), "if-match": '"1"' },
        payload: { result: "clean" },
      });

    let uploadCounter = 0;
    /** A pending upload in project A, so authorization — not the resource lookup — decides. */
    async function pendingUpload(): Promise<string> {
      uploadCounter += 1;
      const steward = await signIn(app, fx.stewardA);
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads`,
        headers: { ...bearer(steward), "idempotency-key": idempotencyKey() },
        payload: {
          contentBase64: Buffer.from(`account sessions ${uploadCounter} ${randomUUID()}`).toString("base64"),
          contentType: "application/pdf",
          originalFilename: "license.pdf",
        },
      });
      expect(response.statusCode).toBe(200);
      return response.json().id as string;
    }

    async function serviceSubject(role: string | null, label: string): Promise<string> {
      const subject = randomUUID();
      await fx.sql`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
        VALUES (${subject}, ${fx.tenantA}, 'service', ${label}, 'high_assurance')
      `;
      if (role !== null) {
        await fx.sql`
          INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
          VALUES (${randomUUID()}, ${fx.tenantA}, ${subject}, ${fx.orgA}, ${role})
        `;
      }
      return subject;
    }

    it("cannot reach a person route, not even the session route", async () => {
      for (const [method, url] of [
        ["GET", "/api/v1/projects"],
        ["GET", "/api/v1/auth/session"],
        ["POST", "/api/v1/auth/logout"],
        ["GET", `/api/v1/projects/${fx.projectA}/uploads`],
      ] as const) {
        const response = await app.inject({ method, url, headers: bearer(fx.scanServiceToken) });
        expect(response.statusCode, url).toBe(403);
        expect(response.json().code, url).toBe("SERVICE_TOKEN_ROUTE_DENIED");
      }
    });

    it("cannot reach a service route outside its scopes", async () => {
      const creOnly = await issueTestServiceToken(fx.sql, {
        tenantId: fx.tenantA,
        subjectId: await serviceSubject("scan_service", "Scan with CRE scope"),
        scopes: ["cre_report"],
      });
      const response = await scanResult(await pendingUpload(), creOnly);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        code: "SERVICE_TOKEN_SCOPE_DENIED",
        details: { requiredScope: "scan_result" },
      });
    });

    it("reaches its scoped route with its service role", async () => {
      const response = await scanResult(await pendingUpload(), fx.scanServiceToken);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ id: expect.any(String) });
    });

    it("never makes a person role effective", async () => {
      // A service subject that (wrongly) holds a person role allowed on the CRE route.
      const token = await issueTestServiceToken(fx.sql, {
        tenantId: fx.tenantA,
        subjectId: await serviceSubject("data_steward", "Service with a person role"),
        scopes: ["cre_report"],
      });
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/cre-reports`,
        headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
        payload: { publicKey: "x", chainId: "31337", receiver: `0x${"12".repeat(20)}`, ttlSeconds: "300" },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().details).toMatchObject({ reason: "AUTHENTICATION_LEVEL_INSUFFICIENT", role: "data_steward", requiredAal: null });
    });

    it("a person session never makes a service role effective", async () => {
      // A person bound to scan_service, signed in at the highest level the transition allows.
      const person = randomUUID();
      const wallet = newAccount();
      await fx.sql`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
        VALUES (${person}, ${fx.tenantA}, 'person', 'Person with scan role', 'high_assurance')
      `;
      await fx.sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${person}, ${wallet.address}, 31337, 'high_assurance', now())
      `;
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${person}, ${fx.orgA}, 'scan_service')
      `;
      const token = await signIn(app, wallet);
      const view = await session(token);
      expect(view.aal).toBe("aal3");
      expect(view.roleBindings).toEqual([]);
      expect(view.narrowedRoles).toEqual([{ role: "scan_service", requiredAal: null }]);

      const response = await scanResult(await pendingUpload(), token);
      expect(response.statusCode).toBe(403);
      expect(response.json().details).toMatchObject({ reason: "AUTHENTICATION_LEVEL_INSUFFICIENT", role: "scan_service" });
    });

    it("is refused once expired or revoked", async () => {
      const subject = await serviceSubject("scan_service", "Short-lived scanner");
      const token = await issueTestServiceToken(fx.sql, { tenantId: fx.tenantA, subjectId: subject, scopes: ["scan_result"] });
      expect((await scanResult(await pendingUpload(), token)).statusCode).toBe(200);

      await fx.sql`UPDATE core.service_tokens SET revoked_at = now() WHERE subject_id = ${subject}`;
      expect((await scanResult(randomUUID(), token)).statusCode).toBe(401);

      const expiring = await issueTestServiceToken(fx.sql, { tenantId: fx.tenantA, subjectId: subject, scopes: ["scan_result"] });
      await fx.sql`
        UPDATE core.service_tokens SET issued_at = now() - interval '2 days', expires_at = now() - interval '1 second'
        WHERE subject_id = ${subject} AND revoked_at IS NULL
      `;
      expect((await scanResult(randomUUID(), expiring)).statusCode).toBe(401);
    });

    it("cannot be bound to a person, and only lists known scopes", async () => {
      await expect(
        issueTestServiceToken(fx.sql, { tenantId: fx.tenantA, subjectId: fx.stewardSubjectA, scopes: ["scan_result"] }),
      ).rejects.toThrow(/not a service subject/);
      await expect(
        fx.sql`
          INSERT INTO core.service_tokens (id, tenant_id, subject_id, label, token_hash, scopes, expires_at)
          VALUES (${randomUUID()}, ${fx.tenantA}, ${fx.scanServiceSubjectA}, 'x', ${`0x${"ab".repeat(32)}`},
                  ARRAY['admin'], now() + interval '1 day')
        `,
      ).rejects.toThrow(/check constraint/);
    });
  });
});
