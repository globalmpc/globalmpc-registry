import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  idempotencyKey,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Two-person role revocation — 02 §2.8, Q-031 remaining item 3.
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
 * 3. **The tenant cannot revoke its way out of administration.** A revocation that would leave
 *    no one able to approve role changes is refused; otherwise only the bootstrap CLI recovers it.
 * 4. **Tenants cannot see or touch each other's proposals.**
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
  /** tenant A · mpc_operator. Proposes. */
  let operatorAToken: string;
  /** tenant A · security_operator. Decides — a different person and a different role. */
  let securityToken: string;
  /** tenant B · mpc_operator. Must see nothing of tenant A. */
  let operatorBToken: string;

  async function seedTenant(label: string): Promise<{ tenantId: string; orgId: string }> {
    const tenantId = randomUUID();
    const orgId = randomUUID();
    await fx.sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`t-${tenantId.slice(0, 8)}`}, ${label})
    `;
    await fx.sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${orgId}, ${tenantId}, ${`Org ${label}`}, 'MNG')
    `;
    return { tenantId, orgId };
  }

  async function seedPerson(
    tenantId: string,
    orgId: string,
    label: string,
    role: string,
    assurance = "high_assurance",
  ): Promise<Person> {
    const account = newAccount();
    const subjectId = randomUUID();
    const walletId = randomUUID();
    const bindingId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${tenantId}, 'person', ${label})
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${walletId}, ${tenantId}, ${subjectId}, ${account.address}, 97, ${assurance}, now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${bindingId}, ${tenantId}, ${subjectId}, ${orgId}, ${role})
    `;
    return { subjectId, bindingId, walletId, account };
  }

  /** A tenant-A person with a non-admin role — the usual revocation target. */
  function seedTarget(label: string): Promise<Person> {
    return seedPerson(fx.tenantA, fx.orgA, label, "auditor", "identity_bound");
  }

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);
    operatorBToken = await signIn(app, fx.operatorB);
    const security = await seedPerson(fx.tenantA, fx.orgA, "Security Second", "security_operator");
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

  it("does not let the proposer approve their own proposal", async () => {
    const target = await seedTarget("self approval target");
    const revocation = await proposed(operatorAToken, target.bindingId);

    const self = await decide(operatorAToken, revocation, "approve");

    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe("ROLE_REVOCATION_SELF_APPROVAL");
    expect(await revokedAt(target.bindingId)).toBeNull();
  });

  it("a revoked binding stops authorizing on the next request, and the row is kept", async () => {
    const target = await seedTarget("revoked auditor");
    const targetToken = await signIn(app, target.account);
    // Before: the auditor role reads the admin screen.
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
      const { tenantId, orgId } = await seedTenant("Solo");
      const solo = await seedPerson(tenantId, orgId, "Solo Operator", "mpc_operator");
      const soloToken = await signIn(app, solo.account);

      const response = await propose(soloToken, solo.bindingId);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
    });

    it("does not count an approver whose wallets fall short of the role's assurance", async () => {
      const { tenantId, orgId } = await seedTenant("Weak");
      const strong = await seedPerson(tenantId, orgId, "Weak Strong", "mpc_operator");
      // Holds the role, but mpc_operator needs high_assurance: every request would be refused.
      await seedPerson(tenantId, orgId, "Weak Bound", "mpc_operator", "identity_bound");
      const strongToken = await signIn(app, strong.account);

      const response = await propose(strongToken, strong.bindingId);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
    });

    it("refuses at decision time when the only other approver can no longer sign in", async () => {
      const { tenantId, orgId } = await seedTenant("Pair");
      const proposer = await seedPerson(tenantId, orgId, "Pair Proposer", "mpc_operator");
      const decider = await seedPerson(tenantId, orgId, "Pair Decider", "mpc_operator");
      const proposerToken = await signIn(app, proposer.account);
      const deciderToken = await signIn(app, decider.account);

      // Allowed when proposed: the proposer remains.
      const revocation = await proposed(proposerToken, decider.bindingId);

      // Then the decider cuts the proposer's only wallet (a one-person action). A binding
      // without a usable wallet cannot approve anything.
      const cut = await post(
        deciderToken,
        `/api/v1/admin/wallets/${proposer.walletId}/disable`,
        { reasonCode: "key_compromised", detail: "phishing report" },
        `"1"`,
      );
      expect(cut.statusCode).toBe(200);

      const decided = await decide(deciderToken, revocation, "approve");

      expect(decided.statusCode).toBe(422);
      expect(decided.json().code).toBe("ROLE_REVOCATION_LAST_APPROVER");
      expect(await revokedAt(decider.bindingId)).toBeNull();
    });

    it("two opposite revocations decided at once cannot both pass", async () => {
      const { tenantId, orgId } = await seedTenant("Race");
      const x = await seedPerson(tenantId, orgId, "Race X", "mpc_operator");
      const y = await seedPerson(tenantId, orgId, "Race Y", "mpc_operator");
      const xToken = await signIn(app, x.account);
      const yToken = await signIn(app, y.account);

      // Each proposes revoking the other; each is allowed alone, because the proposer remains.
      const revokeY = await proposed(xToken, y.bindingId);
      const revokeX = await proposed(yToken, x.bindingId);

      /**
       * Makes the two decisions overlap for certain. An outside transaction holds both bindings
       * until both requests are blocked, then releases them together. Without the per-tenant
       * lock, each would then count the other as still holding the role, both would pass, and
       * the tenant would have no approver left.
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

  it("another tenant cannot see, propose on, or decide a proposal", async () => {
    const target = await seedTarget("cross tenant target");
    const revocation = await proposed(operatorAToken, target.bindingId);

    const listed = (await get(operatorBToken, "/api/v1/admin/role-revocations")).json() as {
      items: { id: string }[];
    };
    expect(listed.items.map((item) => item.id)).not.toContain(revocation.id);

    expect((await propose(operatorBToken, target.bindingId)).statusCode).toBe(404);
    expect((await decide(operatorBToken, revocation, "approve")).statusCode).toBe(404);
    expect(await revokedAt(target.bindingId)).toBeNull();

    // The same boundary below the route: RLS hides the row from tenant B's connection.
    const rows = await withTenant(fx.appSql, { tenantId: fx.tenantB }, (tx) => tx`
      SELECT id FROM core.role_revocation_requests WHERE id = ${revocation.id}
    `);
    expect(rows).toHaveLength(0);
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
      ["admin.role_revocation.proposed", "mpc_operator"],
      ["admin.role_revocation.approved", "security_operator"],
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

    it("cannot INSERT a proposal decided by its own proposer", async () => {
      const target = await seedTarget("db insert target");

      await expect(
        fx.sql`
          INSERT INTO core.role_revocation_requests (
            id, tenant_id, role_binding_id, reason_code, reason, requested_by_subject_id,
            state, decided_by_subject_id, decided_at, decision_reason
          ) VALUES (
            ${randomUUID()}, ${fx.tenantA}, ${target.bindingId}, 'duty_change', 'x',
            ${fx.operatorSubjectA}, 'approved', ${fx.operatorSubjectA}, now(), 'self'
          )
        `,
      ).rejects.toThrow(/role_revocation_two_person/);
    });

    it("cannot UPDATE a pending proposal into self-approval", async () => {
      const row = await pendingRow("db update target");

      await expect(
        fx.sql`
          UPDATE core.role_revocation_requests
          SET state = 'approved', decided_by_subject_id = ${row.requestedBy}, decided_at = now()
          WHERE id = ${row.id}
        `,
      ).rejects.toThrow(/role_revocation_two_person/);
    });

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
