import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { TestAccount } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Platform administration — the two-person rule for role grants, and key recovery (AC-27).
 *
 * This file guards three things.
 *
 * 1. **People can be added without the bootstrap CLI.**
 * 2. **No one person can grant a role alone** — proposal and approval are split (02 §2.8).
 * 3. **A lost key can be cut off and a new key bound, and the cut key stops working at once**
 * (AC-27).
 */
/** Throwaway signing account. Same shape as the one in `helpers/db.ts`. */
function newAccount(): TestAccount {
  const account = privateKeyToAccount(generatePrivateKey());
  return { address: account.address.toLowerCase() as `0x${string}`, account };
}

describeDb("platform administration", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  /** Both are mpc_operator. Checks that the two-person rule splits by person, not by role. */
  let operatorAToken: string;
  let operatorBToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);

    // operatorB is in tenant B. A second admin in the same tenant is needed, so
    // create one more in tenant A — without the operator screens, this setup alone
    // was possible only through the CLI.
    const second = newAccount();
    const subjectId = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', 'Operator Second')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${second.address},
        97, 'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, 'mpc_operator')
    `;
    operatorBToken = await signIn(app, second);
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

  it("creates a subject without the bootstrap CLI", async () => {
    const response = await post(operatorAToken, "/api/v1/admin/subjects", {
      displayName: `Added by API ${randomUUID().slice(0, 6)}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().id).toBeTruthy();
    // No wallet yet. Whatever the role, the screen must first say that this subject
    // cannot log in.
    expect(response.json().locked).toBe(true);
  });

  it("rejects without admin permission", async () => {
    const response = await post(stewardToken, "/api/v1/admin/subjects", {
      displayName: "steward cannot create this",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("mpc_operator");
  });

  it("does not let the proposer approve their own proposal", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "grant target A" })
    ).json();

    const grant = (
      await post(operatorAToken, "/api/v1/admin/role-grants", {
        subjectId: subject.id,
        role: "data_steward",
        reason: "handles evidence registration",
      })
    ).json();
    expect(grant.state).toBe("pending");

    const self = await post(
      operatorAToken,
      `/api/v1/admin/role-grants/${grant.id}/decision`,
      { decision: "approve", reason: "I proposed this" },
      `"${grant.version}"`,
    );

    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe("ROLE_GRANT_SELF_APPROVAL");
  });

  it("grants the role once another person approves", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "grant target B" })
    ).json();

    const grant = (
      await post(operatorAToken, "/api/v1/admin/role-grants", {
        subjectId: subject.id,
        role: "data_steward",
        reason: "handles evidence registration",
      })
    ).json();

    const decided = await post(
      operatorBToken,
      `/api/v1/admin/role-grants/${grant.id}/decision`,
      { decision: "approve", reason: "verified" },
      `"${grant.version}"`,
    );

    expect(decided.statusCode).toBe(200);
    expect(decided.json().state).toBe("approved");

    const listed = (await get(operatorAToken, "/api/v1/admin/subjects")).json();
    const target = listed.items.find((item: { id: string }) => item.id === subject.id);
    expect(target.roles.map((role: { role: string }) => role.role)).toContain("data_steward");
  });

  it("rejects a role outside the permission table at proposal time", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "grant target C" })
    ).json();

    const response = await post(operatorAToken, "/api/v1/admin/role-grants", {
      subjectId: subject.id,
      role: "god_mode",
      reason: "nonexistent role",
    });

    // Failing at approval time leaves the approver unable to tell what went wrong.
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ROLE_UNKNOWN");
  });

  it("does not allow two pending proposals for the same target", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "grant target D" })
    ).json();
    const body = { subjectId: subject.id, role: "auditor", reason: "audit duty" };

    expect((await post(operatorAToken, "/api/v1/admin/role-grants", body)).statusCode).toBe(200);
    const second = await post(operatorAToken, "/api/v1/admin/role-grants", body);

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("ROLE_GRANT_ALREADY_PENDING");
  });

  /**
   * AC-27 — key recovery.
   *
   * this test did not exist, and before that **the path itself did not exist.** `disabled_at`
   * was only a column.
   */
  describe("a single operator cannot bypass the two-person rule", () => {
    it("does not bind a wallet from the screen to someone with operator permission", async () => {
      // Otherwise operator A binds their own wallet to operator B, logs in as B,
      // and approves their own proposal.
      const response = await post(
        operatorBToken,
        `/api/v1/admin/subjects/${fx.operatorSubjectA}/wallets`,
        {
          walletAddress: newAccount().address,
          chainId: 97,
          assuranceLevel: "high_assurance",
          justification: "attempt to take over another operator",
        },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("WALLET_BIND_ADMIN_SUBJECT");
    });

    it("does not disable one's own wallet — the last operator cannot remove themselves", async () => {
      const subjects = (await get(operatorAToken, "/api/v1/admin/subjects")).json() as {
        items: { id: string; wallets: { id: string; version: number }[] }[];
      };
      const own = subjects.items.find((subject) => subject.id === fx.operatorSubjectA)!.wallets[0]!;

      const response = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${own.id}/disable`,
        { reasonCode: "key_lost", detail: "self-disable attempt" },
        `"${own.version}"`,
      );

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("WALLET_DISABLE_SELF");
    });
  });

  describe("lost key recovery (AC-27)", () => {
    it("blocks the cut key and accepts the new key", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "person who lost a key" })
      ).json();

      const lost = newAccount();
      const bound = await post(
        operatorAToken,
        `/api/v1/admin/subjects/${subject.id}/wallets`,
        { walletAddress: lost.address, chainId: 97, assuranceLevel: "identity_bound", justification: "recovery after a reported loss" },
      );
      expect(bound.statusCode).toBe(200);
      expect(bound.json().locked).toBe(false);

      // Login works before the loss.
      const before = await signIn(app, lost);
      expect(before).toBeTruthy();

      const wallet = bound.json().wallets[0];
      const disabled = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${wallet.id}/disable`,
        { reasonCode: "key_lost", detail: "reported lost along with a laptop" },
        `"${wallet.version}"`,
      );

      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().wallets[0].disabledAt).not.toBeNull();
      // With every bound wallet disabled, login is impossible — the response says so.
      expect(disabled.json().locked).toBe(true);

      /**
       * The cut key cannot act **as that subject**.
       *
       * The SIWE signature itself is still valid, so a token is issued — a signature proves
       * possession of the key; whether we accept whose key it is is a separate matter. Session
       * resolution links only wallets with `disabled_at IS NULL` to a subject (0005). So the
       * token is issued but carries no tenant and no role.
       *
       * Checking for "login fails" misses this distinction.
       */
      const afterDisable = await signIn(app, lost);
      const orphan = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { authorization: `Bearer ${afterDisable}` },
      });
      expect(orphan.json().tenantId).toBeNull();
      expect(orphan.json().roleBindings ?? []).toEqual([]);

      // That token can do nothing in the workspace.
      const denied = await app.inject({
        method: "GET",
        url: "/api/v1/admin/subjects",
        headers: { authorization: `Bearer ${afterDisable}` },
      });
      expect([401, 403]).toContain(denied.statusCode);

      // Binding a new key lets them back in. If cutting worked but binding did not, it would
      // be account destruction, not recovery.
      const replacement = newAccount();
      const rebound = await post(
        operatorAToken,
        `/api/v1/admin/subjects/${subject.id}/wallets`,
        { walletAddress: replacement.address, chainId: 97, assuranceLevel: "identity_bound", justification: "recovery after a reported loss" },
      );
      expect(rebound.statusCode).toBe(200);
      expect(rebound.json().locked).toBe(false);

      const after = await signIn(app, replacement);
      expect(after).toBeTruthy();
    });

    it("records the reason for the cut", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "reason record target" })
      ).json();
      const key = newAccount();
      const bound = (
        await post(operatorAToken, `/api/v1/admin/subjects/${subject.id}/wallets`, {
          walletAddress: key.address,
          chainId: 97,
          assuranceLevel: "wallet_only",
          justification: "test binding",
        })
      ).json();

      await post(
        operatorAToken,
        `/api/v1/admin/wallets/${bound.wallets[0].id}/disable`,
        { reasonCode: "key_compromised", detail: "phishing report received" },
        `"${bound.wallets[0].version}"`,
      );

      // Loss, compromise, and departure have the same effect, but differ in how past
      // signatures must be read.
      const [event] = await fx.sql<{ reason_code: string; detail: string }[]>`
        SELECT reason_code, detail FROM core.wallet_disable_events
        WHERE wallet_identity_id = ${bound.wallets[0].id}
      `;
      expect(event!.reason_code).toBe("key_compromised");
      expect(event!.detail).toContain("phishing");
    });

    it("does not disable an already disabled wallet again", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "duplicate disable target" })
      ).json();
      const key = newAccount();
      const bound = (
        await post(operatorAToken, `/api/v1/admin/subjects/${subject.id}/wallets`, {
          walletAddress: key.address,
          chainId: 97,
          assuranceLevel: "wallet_only",
          justification: "test binding",
        })
      ).json();
      const wallet = bound.wallets[0];

      await post(
        operatorAToken,
        `/api/v1/admin/wallets/${wallet.id}/disable`,
        { reasonCode: "rotation", detail: "scheduled rotation" },
        `"${wallet.version}"`,
      );
      const again = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${wallet.id}/disable`,
        { reasonCode: "rotation", detail: "scheduled rotation" },
        `"${wallet.version + 1}"`,
      );

      expect(again.statusCode).toBe(422);
      expect(again.json().code).toBe("WALLET_ALREADY_DISABLED");
    });

    it("does not move an address already bound to another subject", async () => {
      const first = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "address holder" })
      ).json();
      const second = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "address claimant" })
      ).json();
      const key = newAccount();

      await post(operatorAToken, `/api/v1/admin/subjects/${first.id}/wallets`, {
        walletAddress: key.address,
        chainId: 97,
        assuranceLevel: "wallet_only",
        justification: "test binding",
      });

      // Moving it would make the address's past signatures read as someone else's.
      const moved = await post(operatorAToken, `/api/v1/admin/subjects/${second.id}/wallets`, {
        walletAddress: key.address,
        chainId: 97,
        assuranceLevel: "wallet_only",
        justification: "test binding",
      });

      expect(moved.statusCode).toBe(409);
      expect(moved.json().code).toBe("WALLET_ALREADY_BOUND");
    });
  });

  /**
   * Q-032 — the operator chooses the assurance level and says why.
   *
   * A fixed level left reviewer, gate approver, and issuance roles below their minimum on any
   * wallet bound from the screen. Letting the operator choose widens what one person can grant,
   * so the choice must carry a stated basis, and that basis is kept in the audit record.
   */
  describe("assurance level chosen with a justification", () => {
    async function subject(name: string): Promise<{ id: string }> {
      return (await post(operatorAToken, "/api/v1/admin/subjects", { displayName: name })).json();
    }

    it("requires a justification", async () => {
      const target = await subject("justification target");
      const missing = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/wallets`, {
        walletAddress: newAccount().address,
        chainId: 97,
        assuranceLevel: "high_assurance",
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("REQUEST_INVALID");
      expect(JSON.stringify(missing.json().details.issues)).toContain("justification");

      const blank = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/wallets`, {
        walletAddress: newAccount().address,
        chainId: 97,
        assuranceLevel: "high_assurance",
        justification: "   ",
      });
      expect(blank.statusCode).toBe(400);
    });

    it("rejects a level outside the assurance table with 422", async () => {
      const target = await subject("invalid level target");
      const response = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/wallets`, {
        walletAddress: newAccount().address,
        chainId: 97,
        assuranceLevel: "super_admin",
        justification: "not a real level",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ASSURANCE_LEVEL_INVALID");
    });

    it("records the chosen level and the justification in the audit event", async () => {
      const target = await subject("audited level target");
      const justification = "Passport checked in person on 2026-09-14";
      const bound = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/wallets`, {
        walletAddress: newAccount().address,
        chainId: 97,
        assuranceLevel: "high_assurance",
        justification,
      });

      expect(bound.statusCode).toBe(200);
      const wallet = bound.json().wallets[0];
      expect(wallet.assuranceLevel).toBe("high_assurance");

      const [event] = await fx.sql<{ detail: { assuranceLevel?: string; justification?: string } }[]>`
        SELECT detail FROM audit.events
        WHERE command = 'admin.wallet.bound' AND resource_id = ${wallet.id}
      `;
      expect(event!.detail.assuranceLevel).toBe("high_assurance");
      expect(event!.detail.justification).toBe(justification);
    });
  });
});
