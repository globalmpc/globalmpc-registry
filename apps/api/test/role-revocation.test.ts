import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  idempotencyKey,
  issueTestSession,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  setupBareRegistry,
  type BareRegistry,
  type TestFixture, syncSubjectAssurance } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Two-person role revocation — 02 §2.8.
 *
 * Before this, the only way to take a role away was to disable every wallet of the person.
 * That also cut off whatever else they legitimately held, and it left the role binding in force
 * for the day a new key is bound.
 *
 * This file guards four things.
 *
 * 1. **No one person can revoke a role alone** — proposal and decision are split, and the DB
 *    blocks the same person doing both even when the route is bypassed.
 * 2. **A revoked binding stops authorizing on the next request.** Sessions are re-resolved per
 *    request, so there is no stale token that keeps the role.
 * 3. **The Registry cannot revoke its way out of administration.** A revocation that would leave
 *    no one able to approve role changes is refused; otherwise only the bootstrap CLI recovers it.
 * 4. **Another company's organization admin cannot see or touch these proposals.**
 */

interface Person {
  readonly subjectId: string;
  readonly bindingId: string;
  readonly walletId: string;
  readonly account: TestAccount;
}

interface Revocation {
  readonly id: string;
  readonly version: number;
  readonly state: string;
}

describeDb("role revocation", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  /** company A · Registry administrator. Proposes. */
  let operatorAToken: string;
  /** company A · Registry administrator. Decides — a different person and a different role. */
  let securityToken: string;
  /** Company B's administrator (organization-scoped). Must see nothing of company A. */
  let operatorBToken: string;

  /**
   * A Registry of its own holding only what the test seeds, so "the last administrator" means the
   * administrators it seeds. `fx` and `app` point at it until the test ends.
   */
  let shared: { fx: TestFixture; app: FastifyInstance } | null = null;
  let isolated: { registry: BareRegistry; app: FastifyInstance } | null = null;
  async function isolatedRegistry(label: string): Promise<{ orgId: string }> {
    const registry = await setupBareRegistry();
    const isolatedApp = await buildServer(loadConfig(testEnv()), registry.appSql);
    shared ??= { fx, app };
    isolated = { registry, app: isolatedApp };
    fx = { ...fx, sql: registry.sql, appSql: registry.appSql };
    app = isolatedApp;
    const orgId = randomUUID();
    await fx.sql`
      INSERT INTO core.organizations (id, legal_name, jurisdiction)
      VALUES (${orgId}, ${`Org ${label}`}, 'MNG')
    `;
    return { orgId };
  }

  afterEach(async () => {
    if (!isolated || !shared) return;
    await isolated.app.close();
    await isolated.registry.close();
    ({ fx, app } = shared);
    isolated = null;
    shared = null;
  });

  async function seedPerson(
    orgId: string,
    label: string,
    role: string,
    assurance = "high_assurance",
    jurisdiction: string[] | null = null,
  ): Promise<Person> {
    const account = newAccount();
    const subjectId = randomUUID();
    const walletId = randomUUID();
    const bindingId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, kind, display_name)
      VALUES (${subjectId}, 'person', ${label})
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${walletId}, ${subjectId}, ${account.address}, 31337, ${assurance}, now()
      )
    `;
    await syncSubjectAssurance(fx.sql);
    await fx.sql`
      INSERT INTO core.role_bindings (id, subject_id, organization_id, role, jurisdiction)
      VALUES (${bindingId}, ${subjectId}, ${orgId}, ${role}, ${jurisdiction}::text[])
    `;
    return { subjectId, bindingId, walletId, account };
  }

  /** A person holding a role — the usual revocation target. */
  function seedTarget(label: string): Promise<Person> {
    return seedPerson(fx.orgA, label, "administrator", "high_assurance");
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);
    operatorBToken = await signIn(app, fx.operatorB);
    const security = await seedPerson(fx.orgA, "Security Second", "administrator");
    securityToken = await signIn(app, security.account);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function post(token: string, url: string, payload: unknown, ifMatch?: string) {
    return app.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        ...(ifMatch ? { "if-match": ifMatch } : {}),
      },
      payload: payload as never,
    });
  }

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  function propose(token: string, roleBindingId: string) {
    return post(token, "/api/v1/admin/role-revocations", {
      roleBindingId,
      reasonCode: "duty_change",
      reason: "moved to another team",
    });
  }

  function decide(token: string, revocation: Revocation, decision: "approve" | "reject") {
    return post(
      token,
      `/api/v1/admin/role-revocations/${revocation.id}/decision`,
      { decision, reason: "confirmed with the team lead" },
      `"${revocation.version}"`,
    );
  }

  async function proposed(token: string, roleBindingId: string): Promise<Revocation> {
    const response = await propose(token, roleBindingId);
    expect(response.statusCode).toBe(200);
    return response.json() as Revocation;
  }

  /** Waits until this many application connections are waiting on a lock. */
  async function waitForBlockedAppTransactions(count: number): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const [row] = await fx.sql<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE usename = 'mpc_app_login' AND wait_event_type = 'Lock'
      `;
      if (row!.waiting >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`${count} application transactions never blocked`);
  }

  async function revokedAt(bindingId: string): Promise<Date | null> {
    const [row] = await fx.sql<{ revoked_at: Date | null }[]>`
      SELECT revoked_at FROM core.role_bindings WHERE id = ${bindingId}
    `;
    return row!.revoked_at;
  }

  it("a proposal alone revokes nothing", async () => {
    const target = await seedTarget("pending target");
    const targetToken = await signIn(app, target.account);

    const revocation = await proposed(operatorAToken, target.bindingId);

    expect(revocation.state).toBe("pending");
    expect(await revokedAt(target.bindingId)).toBeNull();
    expect((await get(targetToken, "/api/v1/admin/subjects")).statusCode).toBe(200);
  });

  it("lets the proposer approve their own proposal", async () => {
    const target = await seedTarget("self approval target");
    const revocation = await proposed(operatorAToken, target.bindingId);

    const self = await decide(operatorAToken, revocation, "approve");

    expect(self.statusCode, self.body).toBe(200);
    expect(await revokedAt(target.bindingId)).not.toBeNull();
  });

  it("a revoked binding stops authorizing on the next request, and the row is kept", async () => {
    const target = await seedTarget("revoked administrator");
    const targetToken = await signIn(app, target.account);
    // Before: the administrator role reads the admin screen.
    expect((await get(targetToken, "/api/v1/admin/subjects")).statusCode).toBe(200);

    const revocation = await proposed(operatorAToken, target.bindingId);
    const decided = await decide(securityToken, revocation, "approve");

    expect(decided.statusCode).toBe(200);
    expect(decided.json().state).toBe("approved");
    expect(decided.headers.etag).toBe(`"${revocation.version + 1}"`);

    // Same token, next request. Sessions are re-resolved per request, so nothing stale survives.
    const after = await get(targetToken, "/api/v1/admin/subjects");
    expect(after.statusCode).toBe(403);
    expect(after.json().code).toBe("AUTHORIZATION_DENIED");

    // Ended, not deleted — the history of who held what stays readable.
    expect(await revokedAt(target.bindingId)).not.toBeNull();
    const listed = (await get(operatorAToken, "/api/v1/admin/subjects")).json() as {
      items: { id: string; roles: { id: string; revokedAt: string | null }[] }[];
    };
    const role = listed.items
      .find((item) => item.id === target.subjectId)!
      .roles.find((item) => item.id === target.bindingId)!;
    expect(role.revokedAt).not.toBeNull();
  });

  it("a rejected proposal leaves the binding in force", async () => {
    const target = await seedTarget("rejection target");
    const targetToken = await signIn(app, target.account);
    const revocation = await proposed(operatorAToken, target.bindingId);

    const decided = await decide(securityToken, revocation, "reject");

    expect(decided.statusCode).toBe(200);
    expect(decided.json().state).toBe("rejected");
    expect(await revokedAt(target.bindingId)).toBeNull();
    expect((await get(targetToken, "/api/v1/admin/subjects")).statusCode).toBe(200);
  });

  it("does not allow a second open proposal for the same binding", async () => {
    const target = await seedTarget("duplicate target");
    await proposed(operatorAToken, target.bindingId);

    // Two open proposals blur which one the approver approved.
    const second = await propose(securityToken, target.bindingId);

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("ROLE_REVOCATION_ALREADY_PENDING");
  });

  it("does not propose revoking a binding that is already revoked", async () => {
    const target = await seedTarget("already revoked target");
    const revocation = await proposed(operatorAToken, target.bindingId);
    await decide(securityToken, revocation, "approve");

    const again = await propose(operatorAToken, target.bindingId);

    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe("ROLE_BINDING_ALREADY_REVOKED");
  });

  it("requires If-Match on the decision and refuses a stale version", async () => {
    const target = await seedTarget("concurrency target");
    const revocation = await proposed(operatorAToken, target.bindingId);
    const url = `/api/v1/admin/role-revocations/${revocation.id}/decision`;
    const body = { decision: "approve", reason: "confirmed" };

    const missing = await post(securityToken, url, body);
    expect(missing.statusCode).toBe(428);

    const stale = await post(securityToken, url, body, `"${revocation.version + 5}"`);
    expect(stale.statusCode).toBe(412);
    expect(await revokedAt(target.bindingId)).toBeNull();
  });

  describe("the last approver cannot be revoked", () => {
    it("refuses at proposal time when no other approver would remain", async () => {
      const { orgId } = await isolatedRegistry("Solo");
      const solo = await seedPerson(orgId, "Solo Operator", "administrator");
      const soloToken = await signIn(app, solo.account);

      const response = await propose(soloToken, solo.bindingId);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
    });

    it("does not count an approver whose subject falls short of the role's assurance", async () => {
      const { orgId } = await isolatedRegistry("Weak");
      const strong = await seedPerson(orgId, "Weak Strong", "administrator");
      // Holds the role, but administrator needs high_assurance: every request would be refused.
      const weak = await seedPerson(orgId, "Weak Bound", "administrator", "identity_bound");
      await signIn(app, weak.account);
      const strongToken = await signIn(app, strong.account);

      const response = await propose(strongToken, strong.bindingId);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
    });

    it("keeps counting an account approver after their last wallet is disabled", async () => {
      const { orgId } = await isolatedRegistry("Pair");
      const proposer = await seedPerson(orgId, "Pair Proposer", "administrator");
      const decider = await seedPerson(orgId, "Pair Decider", "administrator");
      const proposerToken = await signIn(app, proposer.account);
      const deciderToken = await signIn(app, decider.account);

      // Allowed when proposed: the proposer remains.
      const revocation = await proposed(proposerToken, decider.bindingId);

      // A holder-proven signing key does not supply identity assurance. Disabling it
      // must preserve the independently assigned subject assurance and account login.
      await fx.sql`UPDATE core.wallet_identities SET bound_via = 'proof' WHERE id = ${proposer.walletId}`;
      const cut = await post(
        deciderToken,
        `/api/v1/admin/wallets/${proposer.walletId}/disable`,
        { reasonCode: "key_compromised", detail: "phishing report" },
        `"1"`,
      );
      expect(cut.statusCode).toBe(200);

      const decided = await decide(deciderToken, revocation, "approve");

      expect(decided.statusCode).toBe(200);
      expect(await revokedAt(decider.bindingId)).not.toBeNull();
    });

    it("walletless email and passkey administrators can revoke another administrator", async () => {
      const { orgId } = await isolatedRegistry("Walletless");
      const people = await Promise.all(["Proposer", "Decider", "Target"].map(
        (label) => seedPerson(orgId, label, "administrator"),
      ));
      const tokens: string[] = [];
      for (const person of people) {
        tokens.push(await issueTestSession(fx.appSql, person.subjectId, {
          firstFactor: "email_code", secondFactor: "passkey",
        }));
        await fx.sql`DELETE FROM core.wallet_identities WHERE id = ${person.walletId}`;
      }
      const revocation = await proposed(tokens[0]!, people[2]!.bindingId);
      const result = await decide(tokens[1]!, revocation, "approve");
      expect(result.statusCode).toBe(200);
      expect(await revokedAt(people[2]!.bindingId)).not.toBeNull();
    });

    it.each([false, true])("counts only live OIDC sign-in methods (revoked: %s)", async (revoked) => {
      const { orgId } = await isolatedRegistry("OIDC only");
      const target = await seedPerson(orgId, "Target", "administrator");
      const other = await seedPerson(orgId, "OIDC holder", "administrator");
      const targetToken = await signIn(app, target.account);
      await issueTestSession(fx.appSql, other.subjectId, {
        firstFactor: "google", secondFactor: "passkey",
      });
      await fx.sql`UPDATE core.subjects SET email = NULL WHERE id = ${other.subjectId}`;
      await fx.sql`DELETE FROM core.wallet_identities WHERE id = ${other.walletId}`;
      if (revoked) {
        await fx.sql`UPDATE core.external_identities SET revoked_at = now(), revoked_reason = 'unlinked_by_holder' WHERE subject_id = ${other.subjectId}`;
      }
      const response = await propose(targetToken, target.bindingId);
      expect(response.statusCode).toBe(revoked ? 422 : 200);
      if (revoked) expect(response.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
    });

    it.each(["no_login", "no_passkey", "suspended", "revoked_passkey"])("evaluates remaining administrator access with %s", async (missing) => {
      const { orgId } = await isolatedRegistry(missing);
      const target = await seedPerson(orgId, "Target", "administrator");
      const other = await seedPerson(orgId, "Unavailable", "administrator");
      const token = await signIn(app, target.account);
      if (missing === "no_login") {
        await fx.sql`
          INSERT INTO core.webauthn_credentials (
            id, subject_id, credential_id, public_key, aaguid,
            user_verified, device_type, backed_up, name
          ) VALUES (
            ${randomUUID()}, ${other.subjectId}, ${randomUUID().replaceAll("-", "")},
            ${Buffer.alloc(32)}, ${randomUUID()}, true, 'singleDevice', false, 'Unused passkey'
          )
        `;
      } else {
        await issueTestSession(fx.appSql, other.subjectId, {
          firstFactor: "email_code", secondFactor: missing === "no_passkey" ? "totp" : "passkey",
        });
        if (missing === "suspended") {
          // A synthetic inconsistent row isolates suspension from factor revocation.
          await fx.sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${other.subjectId}`;
        } else if (missing === "revoked_passkey") {
          await fx.sql`UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'holder_removed' WHERE subject_id = ${other.subjectId}`;
        }
      }
      const response = await propose(token, target.bindingId);
      const unavailable = missing === "no_login" || missing === "suspended";
      expect(response.statusCode).toBe(unavailable ? 422 : 200);
      if (unavailable) expect(response.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
    });

    it("rechecks the remaining holder's suspension at decision time", async () => {
      const { orgId } = await isolatedRegistry("Lost factor");
      const proposer = await seedPerson(orgId, "Proposer", "administrator");
      const decider = await seedPerson(orgId, "Decider", "administrator");
      const proposerToken = await signIn(app, proposer.account);
      const deciderToken = await signIn(app, decider.account);
      const revocation = await proposed(proposerToken, decider.bindingId);
      await fx.sql`UPDATE core.subjects SET suspended_at=now() WHERE id=${proposer.subjectId}`;
      const result = await decide(deciderToken, revocation, "approve");
      expect(result.statusCode).toBe(422);
      expect(result.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
      expect(await revokedAt(decider.bindingId)).toBeNull();
    });

    it("two opposite revocations cannot both pass when a third administrator is jurisdiction-limited", async () => {
      const { orgId } = await isolatedRegistry("Race");
      const x = await seedPerson(orgId, "Race X", "administrator");
      const y = await seedPerson(orgId, "Race Y", "administrator");
      const xToken = await signIn(app, x.account);
      const yToken = await signIn(app, y.account);
      const regional = await seedPerson(orgId, "Regional", "administrator", "high_assurance", ["MNG"]);
      const regionalToken = await signIn(app, regional.account);
      expect((await propose(regionalToken,x.bindingId)).statusCode).toBe(403);

      // Each proposes revoking the other; each is allowed alone, because the proposer remains.
      const revokeY = await proposed(xToken, y.bindingId);
      const revokeX = await proposed(yToken, x.bindingId);

      /**
       * Makes the two decisions overlap for certain. An outside transaction holds both bindings
       * until both requests are blocked, then releases them together. Without the Registry-wide
       * lock, each would then count the other as still holding the role, both would pass, and
       * the Registry would have no approver left.
       */
      let decisions!: Promise<Awaited<ReturnType<typeof decide>>[]>;
      await fx.sql.begin(async (hold) => {
        await hold`
          SELECT id FROM core.role_bindings WHERE id IN (${x.bindingId}, ${y.bindingId}) FOR UPDATE
        `;
        decisions = Promise.all([
          decide(yToken, revokeY, "approve"),
          decide(xToken, revokeX, "approve"),
        ]);
        await waitForBlockedAppTransactions(2);
      });
      const results = await decisions;

      expect(results.map((result) => result.statusCode).sort()).toEqual([200, 422]);
      const refused = results.find((result) => result.statusCode === 422)!;
      expect(refused.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
      const stillHeld = [await revokedAt(x.bindingId), await revokedAt(y.bindingId)];
      expect(stillHeld.filter((value) => value === null)).toHaveLength(1);
    });
  });

  it("another company's organization-scoped administrator cannot see, propose on, or decide a proposal", async () => {
    const target = await seedTarget("cross company target");
    const revocation = await proposed(operatorAToken, target.bindingId);

    // Revocation is a Registry-wide action; an organization-scoped administrator is refused.
    const listed = await get(operatorBToken, "/api/v1/admin/role-revocations");
    expect(listed.statusCode).toBe(403);
    expect(JSON.stringify(listed.json())).not.toContain(revocation.id);

    expect((await propose(operatorBToken, target.bindingId)).statusCode).toBe(403);
    expect((await decide(operatorBToken, revocation, "approve")).statusCode).toBe(403);
    expect(await revokedAt(target.bindingId)).toBeNull();

    // Role bindings are Registry-level records (no project), readable by any live actor as they
    // were by any member of the single tenant. Revoking one is a Registry-wide action, so the
    // route's Registry scope is the boundary checked above.
  });

  it("records who proposed and who decided, each with the role that allowed it", async () => {
    const target = await seedTarget("audited target");
    const revocation = await proposed(operatorAToken, target.bindingId);
    await decide(securityToken, revocation, "approve");

    const events = await fx.sql<
      { command: string; effective_role: string; actor_subject_id: string | null }[]
    >`
      SELECT command, effective_role, actor_subject_id
      FROM audit.events
      WHERE resource_type = 'role_revocation_request' AND resource_id = ${revocation.id}
      ORDER BY id
    `;

    expect(events.map((event) => [event.command, event.effective_role])).toEqual([
      ["admin.role_revocation.proposed", "administrator"],
      ["admin.role_revocation.approved", "administrator"],
    ]);
    expect(events[0]!.actor_subject_id).toBe(fx.operatorSubjectA);
    expect(events[1]!.actor_subject_id).not.toBe(fx.operatorSubjectA);
  });

  /**
   * Paths that bypass the route.
   *
   * These run on the superuser connection: it ignores RLS and grants, so what still blocks
   * it is the constraint or trigger itself.
   */
  describe("DB enforcement", () => {
    async function pendingRow(label: string): Promise<{ id: string; requestedBy: string }> {
      const target = await seedTarget(label);
      const revocation = await proposed(operatorAToken, target.bindingId);
      return { id: revocation.id, requestedBy: fx.operatorSubjectA };
    }

    it("a decided proposal cannot be reopened or deleted", async () => {
      const row = await pendingRow("db reopen target");
      const [current] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.role_revocation_requests WHERE id = ${row.id}
      `;
      await decide(securityToken, { id: row.id, version: current!.version, state: "pending" }, "reject");

      await expect(
        fx.sql`
          UPDATE core.role_revocation_requests
          SET state = 'pending', decided_by_subject_id = NULL, decided_at = NULL
          WHERE id = ${row.id}
        `,
      ).rejects.toThrow(/decided proposal cannot be changed/);
      await expect(
        fx.sql`DELETE FROM core.role_revocation_requests WHERE id = ${row.id}`,
      ).rejects.toThrow(/cannot be deleted/);
    });

    it("a revoked binding cannot be brought back — re-granting takes a new proposal", async () => {
      const target = await seedTarget("db unrevoke target");
      const revocation = await proposed(operatorAToken, target.bindingId);
      await decide(securityToken, revocation, "approve");

      await expect(
        fx.sql`UPDATE core.role_bindings SET revoked_at = NULL WHERE id = ${target.bindingId}`,
      ).rejects.toThrow(/revoked binding cannot be changed/);
    });
  });
});
