import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { bearer, idempotencyKey, issueTestSession, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { decideSigned } from "./helpers/gate-decision.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Suspending a person — plan journey 6, AUTH-06 (migration 0127).
 *
 * Expected, from the plan and the repository rules rather than the implementation:
 * - two people with an admin role at aal3; the decider is not the proposer; nobody proposes or
 *   decides their own suspension or reinstatement; the database holds this without the API;
 * - approval ends every session of the person (each answers 401 next), revokes every passkey,
 *   authenticator app, recovery code and linked identity, and drops open ceremonies, at once;
 * - while suspended the address signs in exactly as an unknown one (same answer, no mail, a code
 *   issued before is refused as a wrong one) and no session can be created by any path;
 * - signed history — gate decisions, role bindings, wallets, audit — is not touched;
 * - reinstatement takes two people too, keeps 0118's recovery separation, lets the person sign in
 *   by code again and opens a 24-hour first-enrolment window.
 */
describeDb("suspending a person (AUTH-06)", { timeout: 30_000 }, () => {
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
  const publicPost = (url: string, payload: unknown, ip = freshIp()) =>
    app.inject({ method: "POST", url, payload: payload as never, remoteAddress: ip });
  const start = (email: string) => publicPost("/api/v1/auth/email/start", { email });
  const verify = (email: string, code: string) => publicPost("/api/v1/auth/email/verify", { email, code });
  /** A response body without the fields that differ per request. */
  const withoutRequestId = (body: Record<string, unknown>) => {
    const { requestId: _ignored, correlationId: _alsoIgnored, ...rest } = body;
    return rest;
  };

  async function mailedCode(email: string): Promise<string> {
    const [mail] = await fx.sql<{ params: { code: string } }[]>`
      SELECT params FROM core.email_outbox
      WHERE recipient = ${email} AND template = 'sign_in_code' AND state = 'pending'
      ORDER BY created_at DESC LIMIT 1
    `;
    if (!mail) throw new Error("no sign-in code pending");
    return mail.params.code;
  }

  /** A person in tenant A with an address, `ageHours` old (past the first-enrolment window by default). */
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
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', ${`Admin ${subjectId.slice(0, 4)}`}, 'high_assurance')
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
  const propose = (token: string, subjectId: string, action: "suspend" | "reinstate" = "suspend") =>
    adminPost("/api/v1/admin/subject-suspensions", token, { subjectId, action, reason: "Left the organisation" });
  const decide = (token: string, request: { id: string; version: number }, decision: "approve" | "reject" = "approve") =>
    adminPost(
      `/api/v1/admin/subject-suspensions/${request.id}/decision`,
      token,
      { decision, reason: "Confirmed with the line manager" },
      { "if-match": `"${request.version}"` },
    );

  /** Whether the token still resolves to a session (the MFA status answers 401 otherwise). */
  const alive = async (token: string) =>
    (await app.inject({ method: "GET", url: "/api/v1/auth/mfa", headers: bearer(token) })).statusCode !== 401;

  /** Two admins suspend (or reinstate) the person; returns the decided request. */
  async function decided(subjectId: string, action: "suspend" | "reinstate" = "suspend") {
    const proposer = await admin("mpc_operator");
    const decider = await admin("security_operator");
    const proposed = await propose(proposer.token, subjectId, action);
    expect(proposed.statusCode, proposed.body).toBe(200);
    const approved = await decide(decider.token, proposed.json());
    expect(approved.statusCode, approved.body).toBe(200);
    return approved.json();
  }

  const live = async (table: string, subjectId: string) =>
    (
      await fx.sql.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM core.${table} WHERE subject_id = $1 AND revoked_at IS NULL`,
        [subjectId],
      )
    )[0]!.n;

  it("takes two people, then ends every session, factor and linked identity at once, and tells the address", async () => {
    const email = freshEmail("suspended");
    const target = await person(email);
    const byCode = await issueTestSession(fx.appSql, fx.tenantA, target, { firstFactor: "email_code", secondFactor: "passkey" });
    const byGoogle = await issueTestSession(fx.appSql, fx.tenantA, target, { firstFactor: "google", secondFactor: "totp" });
    // An open passkey ceremony of one of the sessions.
    const options = await app.inject({
      method: "POST",
      url: "/api/v1/auth/mfa/passkeys/authentication/options",
      headers: bearer(byCode),
    });
    expect(options.statusCode, options.body).toBe(200);
    expect(await live("external_identities", target)).toBe(1);

    const proposer = await admin("mpc_operator");
    const decider = await admin("security_operator");
    const proposed = await propose(proposer.token, target);
    expect(proposed.statusCode, proposed.body).toBe(200);
    const request = proposed.json();
    expect(request).toMatchObject({ action: "suspend", state: "pending", version: 1, subjectId: target });
    // Nothing happens on a proposal alone.
    expect(await alive(byCode)).toBe(true);
    expect((await propose(decider.token, target)).statusCode).toBe(409);

    const self = await decide(proposer.token, request);
    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe("SUSPENSION_SELF_APPROVAL");
    expect((await decide(decider.token, { ...request, version: 9 })).statusCode).toBe(412);

    const approved = await decide(decider.token, request);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(approved.json()).toMatchObject({ state: "approved", version: 2, enrolmentWindowUntil: null });

    expect(await alive(byCode)).toBe(false);
    expect(await alive(byGoogle)).toBe(false);
    const sessions = await fx.sql<{ revoked_reason: string | null }[]>`
      SELECT revoked_reason FROM core.sessions WHERE subject_id = ${target}
    `;
    expect(sessions.map((row) => row.revoked_reason)).toEqual(["suspension", "suspension"]);
    expect(await live("webauthn_credentials", target)).toBe(0);
    expect(await live("totp_authenticators", target)).toBe(0);
    expect(await live("external_identities", target)).toBe(0);
    const [codes] = await fx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM core.recovery_codes
      WHERE subject_id = ${target} AND consumed_at IS NULL AND voided_at IS NULL
    `;
    expect(codes!.n).toBe(0);
    const [ceremonies] = await fx.sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM core.webauthn_challenges WHERE subject_id = ${target} AND consumed_at IS NULL
    `;
    expect(ceremonies!.n).toBe(0);
    const [subject] = await fx.sql<{ suspended_at: Date | null }[]>`SELECT suspended_at FROM core.subjects WHERE id = ${target}`;
    expect(subject!.suspended_at).not.toBeNull();

    const notices = await fx.sql<{ params: unknown }[]>`
      SELECT params FROM core.email_outbox WHERE recipient = ${email} AND template = 'account_suspended_notice'
    `;
    expect(notices.map((row) => row.params)).toEqual([{ removedSignIns: ["google"] }]);
    const audits = await fx.sql`
      SELECT 1 FROM audit.events WHERE command = 'admin.subject_suspension.suspend_approved' AND resource_id = ${request.id}
    `;
    expect(audits).toHaveLength(1);

    // The admin list says so.
    const listed = await app.inject({ method: "GET", url: "/api/v1/admin/subjects", headers: bearer(decider.token) });
    const row = (listed.json().items as { id: string; suspendedAt: string | null }[]).find((item) => item.id === target);
    expect(row?.suspendedAt).toEqual(expect.any(String));
  });

  it("a suspended address signs in exactly as an unknown one: same answer, no mail, a code from before is refused", async () => {
    const email = freshEmail("held");
    const target = await person(email);
    // A code mailed before the suspension.
    expect((await start(email)).statusCode).toBe(202);
    const earlier = await mailedCode(email);

    await decided(target);

    const unknown = freshEmail("nobody");
    const a = await start(email);
    const b = await start(unknown);
    expect(a.statusCode).toBe(202);
    expect(b.statusCode).toBe(202);
    expect(withoutRequestId(a.json())).toEqual(withoutRequestId(b.json()));
    expect(Object.keys(a.headers).sort()).toEqual(Object.keys(b.headers).sort());
    const mailed = await fx.sql`
      SELECT 1 FROM core.email_outbox WHERE recipient = ${email} AND template = 'sign_in_code' AND state = 'pending'
    `;
    expect(mailed).toHaveLength(0);

    const withEarlier = await verify(email, earlier);
    const wrong = await verify(unknown, "12345678");
    expect(withEarlier.statusCode).toBe(wrong.statusCode);
    expect(withoutRequestId(withEarlier.json())).toEqual(withoutRequestId(wrong.json()));
    expect(withEarlier.json()).not.toHaveProperty("sessionToken");
    const [created] = await fx.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM core.sessions WHERE subject_id = ${target}`;
    expect(created!.n).toBe(0);
  });

  it("no path creates a session for a suspended person, and one that exists does not resolve", async () => {
    const target = await person();
    const token = await issueTestSession(fx.appSql, fx.tenantA, target, { firstFactor: "email_code", secondFactor: "passkey" });
    // Set directly, as a restore or a missed revocation would leave it: the resolver still refuses.
    await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${target}`;
    expect(await alive(token)).toBe(false);
    // Through the code and provider functions: refused as a wrong code / unknown identity.
    await expect(
      issueTestSession(fx.appSql, fx.tenantA, target, { firstFactor: "email_code", secondFactor: "passkey" }),
    ).rejects.toThrow(/code_invalid/);
    await expect(
      issueTestSession(fx.appSql, fx.tenantA, target, { firstFactor: "google", secondFactor: "passkey" }),
    ).rejects.toThrow(/not_found/);
    // Written straight into the table, even by the table owner: the trigger refuses it first.
    await expect(fx.sql`
      INSERT INTO core.sessions (id, token_hash, subject_id, tenant_id, first_factor, expires_at)
      VALUES (${randomUUID()}, ${"f".repeat(64)}, ${target}, ${fx.tenantA}, 'email_code', now() + interval '1 hour')
    `).rejects.toThrow(/ACCOUNT_SUSPENDED/);
  });

  it("a right code still pending when the mark is set is answered as a wrong one, not with an error", async () => {
    const email = freshEmail("pending");
    const target = await person(email);
    expect((await start(email)).statusCode).toBe(202);
    const code = await mailedCode(email);
    // Set directly, so the pending code is not superseded as the decision would do.
    await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${target}`;
    const response = await verify(email, code);
    const wrong = await verify(freshEmail("nobody"), "12345678");
    expect(response.statusCode).toBe(wrong.statusCode);
    expect(withoutRequestId(response.json())).toEqual(withoutRequestId(wrong.json()));
  });

  it("keeps everything the person signed: gate decisions, roles, wallets and the audit trail", async () => {
    const policySetId = randomUUID();
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id, jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${policySetId}, ${fx.tenantA}, 'registry-publication-gate', '1.0.0', 'registry_publication', 'MNG', now(),
        ${fx.sql.json(rulesFixture as never)}, 'effective'
      )
    `;
    const assessmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.compliance_assessments (
        id, tenant_id, project_id, gate_id, policy_set_id, input_snapshot_hash, evaluated_as_of, status,
        requirement_results, canonical_result_hash
      ) VALUES (
        ${assessmentId}, ${fx.tenantA}, ${fx.projectA}, 'registry_publication', ${policySetId}, ${"0x" + "a1".repeat(32)},
        now(), 'ok', ${fx.sql.json([{ requirementId: "req-0", status: "gap", applicable: true, reasonCode: "REQUIREMENT_SATISFIED", missing: [] }] as never)},
        ${"0x" + "b2".repeat(32)}
      )
    `;
    const signed = await decideSigned(app, await signIn(app, fx.approverA), fx.approverA, fx.projectA, {
      gateId: "registry_publication",
      decision: "hold",
      inputAssessmentId: assessmentId,
      rationale: "holding for lack of evidence",
    });
    expect(signed.statusCode, signed.body).toBe(200);
    const [holder] = await fx.sql<{ subject_id: string }[]>`
      SELECT subject_id FROM core.wallet_identities WHERE wallet_address = ${fx.approverA.address}
    `;
    const approver = holder!.subject_id;

    const snapshot = async () => ({
      decisions: await fx.sql`SELECT * FROM core.gate_decisions WHERE decision_maker_subject_id = ${approver} ORDER BY id`,
      roles: await fx.sql`SELECT * FROM core.role_bindings WHERE subject_id = ${approver} ORDER BY id`,
      wallets: await fx.sql`SELECT * FROM core.wallet_identities WHERE subject_id = ${approver} ORDER BY id`,
      audit: await fx.sql`SELECT * FROM audit.events WHERE actor_subject_id = ${approver} ORDER BY id`,
    });
    const before = await snapshot();
    expect(before.decisions).toHaveLength(1);

    await decided(approver);

    expect(await snapshot()).toEqual(before);
  });

  it("takes two different people, neither of them the person, also at the database", async () => {
    const target = await person();
    const proposer = await admin("mpc_operator");

    const own = await propose(proposer.token, proposer.subjectId);
    expect(own.statusCode).toBe(422);
    expect(own.json().code).toBe("SUSPENSION_SELF_TARGET");

    // The person, an admin themself, cannot decide their own suspension.
    const targetAdmin = await admin("security_operator");
    const proposed = (await propose(proposer.token, targetAdmin.subjectId)).json();
    const selfDecided = await decide(targetAdmin.token, proposed);
    expect(selfDecided.statusCode).toBe(422);
    expect(selfDecided.json().code).toBe("SUSPENSION_SELF_TARGET");

    // An admin role at aal3 is needed to propose.
    const steward = await issueTestSession(fx.appSql, fx.tenantA, await person(), { firstFactor: "email_code", secondFactor: "passkey" });
    expect((await propose(steward, target)).statusCode).toBe(403);
    const aal2Subject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name, assurance_level)
      VALUES (${aal2Subject}, ${fx.tenantA}, 'person', 'Admin aal2', 'high_assurance')
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${aal2Subject}, ${fx.orgA}, 'mpc_operator')
    `;
    const aal2 = await issueTestSession(fx.appSql, fx.tenantA, aal2Subject, { firstFactor: "email_code", secondFactor: "totp" });
    expect((await propose(aal2, target)).statusCode).toBe(403);

    // Whatever the API checks, the database refuses one person deciding, and the person deciding.
    const id = randomUUID();
    await withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
      INSERT INTO core.subject_suspensions (id, tenant_id, subject_id, action, reason, requested_by_subject_id)
      VALUES (${id}, ${fx.tenantA}, ${target}, 'suspend', 'x', ${proposer.subjectId})
    `);
    await expect(
      withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
        tx`SELECT * FROM core.decide_subject_suspension(${id}, ${proposer.subjectId}, true, 'x', 1)`,
      ),
    ).rejects.toThrow(/SUSPENSION_SELF_APPROVAL/);
    await expect(
      withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) =>
        tx`SELECT * FROM core.decide_subject_suspension(${id}, ${target}, true, 'x', 1)`,
      ),
    ).rejects.toThrow(/SUSPENSION_SELF_TARGET/);

    // The application role cannot write the mark itself, nor insert a decided request.
    await expect(
      withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`UPDATE core.subjects SET suspended_at = now() WHERE id = ${target}`),
    ).rejects.toThrow(/permission denied/);
    const other = await person();
    const decider = await admin("security_operator");
    await expect(
      withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
        INSERT INTO core.subject_suspensions (
          id, tenant_id, subject_id, action, reason, requested_by_subject_id, state, decided_by_subject_id, decided_at
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${other}, 'suspend', 'x', ${proposer.subjectId}, 'approved',
          ${decider.subjectId}, now()
        )
      `),
    ).rejects.toThrow(/permission denied/);
  });

  it("reinstates with two people: the code signs in again and a first factor can be enrolled for 24 hours", async () => {
    const email = freshEmail("back");
    const target = await person(email);
    const proposer = await admin("mpc_operator");
    const decider = await admin("security_operator");

    // Reinstating someone active, or suspending twice, is a state conflict.
    const early = await propose(proposer.token, target, "reinstate");
    expect(early.statusCode).toBe(422);
    expect(early.json().code).toBe("SUSPENSION_STATE_CONFLICT");
    await decided(target);
    const twice = await propose(proposer.token, target, "suspend");
    expect(twice.json().code).toBe("SUSPENSION_STATE_CONFLICT");

    const proposed = await propose(proposer.token, target, "reinstate");
    expect(proposed.statusCode, proposed.body).toBe(200);
    const rejected = await decide(decider.token, proposed.json(), "reject");
    expect(rejected.json()).toMatchObject({ state: "rejected" });
    expect((await start(email)).statusCode).toBe(202);
    await expect(mailedCode(email)).rejects.toThrow();

    const again = (await propose(proposer.token, target, "reinstate")).json();
    const approved = await decide(decider.token, again);
    expect(approved.statusCode, approved.body).toBe(200);
    expect(Date.parse(approved.json().enrolmentWindowUntil) - Date.now()).toBeGreaterThan(23 * 3600_000);
    const notices = await fx.sql`
      SELECT 1 FROM core.email_outbox WHERE recipient = ${email} AND template = 'account_reinstated_notice'
    `;
    expect(notices).toHaveLength(1);

    expect((await start(email)).statusCode).toBe(202);
    const signedIn = await verify(email, await mailedCode(email));
    expect(signedIn.statusCode, signedIn.body).toBe(200);
    const token = signedIn.json().sessionToken as string;
    const status = (await app.inject({ method: "GET", url: "/api/v1/auth/mfa", headers: bearer(token) })).json();
    // 72 hours old with no factor: only the reinstatement window lets it enrol one.
    expect(status.enrolment).toMatchObject({ passkey: "allowed", totp: "allowed" });
  });

  it("a reinstatement keeps the recovery separation: nobody in a recent email change of the person takes part", async () => {
    const target = await person();
    // Proposed before the suspension: a suspended person's address changes by no path (0128), and
    // the suspension closes this request — but the proposer's part in it still counts.
    const changer = await admin("mpc_operator");
    const change = await adminPost("/api/v1/admin/email-changes", changer.token, {
      subjectId: target,
      newEmail: freshEmail("moved"),
      reason: "Lost access to the mailbox",
    });
    expect(change.statusCode, change.body).toBe(200);
    await decided(target);
    const [closed] = await fx.sql<{ state: string }[]>`
      SELECT state FROM core.email_change_requests WHERE id = ${change.json().id}
    `;
    expect(closed!.state).toBe("expired");

    const refused = await propose(changer.token, target, "reinstate");
    expect(refused.statusCode).toBe(422);
    expect(refused.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");

    const proposer = await admin("security_operator");
    const proposed = (await propose(proposer.token, target, "reinstate")).json();
    const refusedDecision = await decide(changer.token, proposed);
    expect(refusedDecision.statusCode).toBe(422);
    expect(refusedDecision.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");

    // And the reverse: whoever reinstated the person takes no part in an email change of them.
    const reinstater = await admin("mpc_operator");
    expect((await decide(reinstater.token, proposed)).statusCode).toBe(200);
    const afterwards = await adminPost("/api/v1/admin/email-changes", reinstater.token, {
      subjectId: target,
      newEmail: freshEmail("again"),
      reason: "Lost access to the mailbox",
    });
    expect(afterwards.statusCode).toBe(422);
    expect(afterwards.json().code).toBe("ACCOUNT_RECOVERY_SEPARATION_REQUIRED");
  });
});
