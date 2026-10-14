import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { TestAccount } from "./helpers/db.js";
import { SECOND_PERSON_ROLES } from "@mpc/api-contract";
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
  /** Subject of operatorBToken — a second admin in tenant A. */
  let operatorSubjectB: string;

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
    operatorSubjectB = subjectId;
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subjectId}, ${fx.tenantA}, 'person', 'Operator Second')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${second.address},
        31337, 'high_assurance', now()
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

  it("does not let the target of a proposal approve their own grant", async () => {
    // Operator A proposes a role for operator B. If B could approve it, the "second person"
    // would be the beneficiary — one person deciding what they receive.
    const grant = (
      await post(operatorAToken, "/api/v1/admin/role-grants", {
        subjectId: operatorSubjectB,
        role: "auditor",
        reason: "audit duty for the second operator",
      })
    ).json();
    expect(grant.state).toBe("pending");

    const self = await post(
      operatorBToken,
      `/api/v1/admin/role-grants/${grant.id}/decision`,
      { decision: "approve", reason: "this is my own grant" },
      `"${grant.version}"`,
    );

    expect(self.statusCode).toBe(422);
    expect(self.json().code).toBe("ROLE_GRANT_SELF_TARGET");
  });

  it("the DB refuses a grant decided by its own target", async () => {
    const grant = (
      await post(operatorAToken, "/api/v1/admin/role-grants", {
        subjectId: operatorSubjectB,
        role: "data_steward",
        reason: "evidence duty for the second operator",
      })
    ).json();
    expect(grant.state).toBe("pending");

    await expect(
      fx.sql`
        UPDATE core.role_grant_requests
        SET state = 'rejected', decided_by_subject_id = ${operatorSubjectB}, decided_at = now(),
            decision_reason = 'bypassing the route'
        WHERE id = ${grant.id}
      `,
    ).rejects.toThrow(/role_grant_not_self_target/);
  });

  /**
   * The binding guard checks roles held at bind time. Reversing the order — bind an operator's
   * key to a subject with no roles, then grant it a second-person role — would pass it, so the
   * grant refuses a subject whose active key was bound from the UI.
   */
  describe("granting a second-person role to a subject with a UI-bound key", () => {
    async function uiBoundSubject(label: string): Promise<string> {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: label })
      ).json();
      const bound = await post(operatorAToken, `/api/v1/admin/subjects/${subject.id}/wallets`, {
        walletAddress: newAccount().address,
        chainId: 31337,
        assuranceLevel: "high_assurance",
        justification: "bound before any role",
      });
      expect(bound.statusCode).toBe(200);
      return subject.id as string;
    }

    async function proposeAndApprove(subjectId: string, role: string) {
      const grant = (
        await post(operatorAToken, "/api/v1/admin/role-grants", {
          subjectId,
          role,
          reason: "role after a UI binding",
        })
      ).json();
      expect(grant.state).toBe("pending");
      return post(
        operatorBToken,
        `/api/v1/admin/role-grants/${grant.id}/decision`,
        { decision: "approve", reason: "verified" },
        `"${grant.version}"`,
      );
    }

    it("refuses approving a second-person role", async () => {
      const subjectId = await uiBoundSubject("bound then promoted");
      const decided = await proposeAndApprove(subjectId, "disclosure_approver");

      expect(decided.statusCode).toBe(422);
      expect(decided.json().code).toBe("ROLE_GRANT_UI_BOUND_SUBJECT");
    });

    it("still grants a role outside the second-person set", async () => {
      const subjectId = await uiBoundSubject("bound then voter");
      const decided = await proposeAndApprove(subjectId, "protocol_voter");

      expect(decided.statusCode).toBe(200);
      expect(decided.json().state).toBe("approved");
    });
  });

  /**
   * Write skew between the two guards. Binding checks "no second-person role" and inserts a
   * wallet; approving checks "no UI-bound wallet" and inserts a role. Run together under READ
   * COMMITTED, each misses the other's uncommitted row and both pass.
   *
   * Each test plays one side in a transaction that holds the subject row, the lock both routes
   * take, and runs the other side through the API while it is open. The request must wait for
   * the lock, then see the committed row and refuse.
   */
  describe("concurrent binding and granting on one subject", () => {
    /** Starts `request` inside an open transaction and reports whether it settled before commit. */
    async function whileHeld(
      subjectId: string,
      writeOtherSide: (tx: typeof fx.sql) => Promise<unknown>,
      request: () => ReturnType<typeof post>,
    ) {
      let settled = false;
      const { pending } = await fx.sql.begin(async (tx) => {
        await tx`SELECT id FROM core.subjects WHERE id = ${subjectId} FOR NO KEY UPDATE`;
        await writeOtherSide(tx as unknown as typeof fx.sql);
        const started = request();
        void started.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { pending: started };
      });
      const settledBeforeCommit = settled;
      return { response: await pending, settledBeforeCommit };
    }

    it("a bind waits for a concurrent grant and then refuses", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "bind racing grant" })
      ).json();

      const { response, settledBeforeCommit } = await whileHeld(
        subject.id,
        (tx) => tx`
          INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
          VALUES (${randomUUID()}, ${fx.tenantA}, ${subject.id}, ${fx.orgA}, 'disclosure_approver')
        `,
        () =>
          post(operatorAToken, `/api/v1/admin/subjects/${subject.id}/wallets`, {
            walletAddress: newAccount().address,
            chainId: 31337,
            assuranceLevel: "high_assurance",
            justification: "racing a grant",
          }),
      );

      expect(settledBeforeCommit).toBe(false);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("WALLET_BIND_ADMIN_SUBJECT");
    });

    it("a grant approval waits for a concurrent bind and then refuses", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "grant racing bind" })
      ).json();
      const grant = (
        await post(operatorAToken, "/api/v1/admin/role-grants", {
          subjectId: subject.id,
          role: "disclosure_approver",
          reason: "racing a bind",
        })
      ).json();
      expect(grant.state).toBe("pending");

      const walletId = randomUUID();
      const { response, settledBeforeCommit } = await whileHeld(
        subject.id,
        async (tx) => {
          await tx`
            INSERT INTO core.wallet_identities (
              id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
            ) VALUES (
              ${walletId}, ${fx.tenantA}, ${subject.id}, ${newAccount().address},
              31337, 'high_assurance', now()
            )
          `;
          await tx`
            INSERT INTO audit.events (
              tenant_id, actor_subject_id, command, resource_type, resource_id, correlation_id
            ) VALUES (
              ${fx.tenantA}, ${fx.operatorSubjectA}, 'admin.wallet.bound', 'wallet_identity',
              ${walletId}, 'race-test'
            )
          `;
        },
        () =>
          post(
            operatorBToken,
            `/api/v1/admin/role-grants/${grant.id}/decision`,
            { decision: "approve", reason: "racing a bind" },
            `"${grant.version}"`,
          ),
      );

      expect(settledBeforeCommit).toBe(false);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ROLE_GRANT_UI_BOUND_SUBJECT");
    });
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
          chainId: 31337,
          assuranceLevel: "high_assurance",
          justification: "attempt to take over another operator",
        },
      );

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("WALLET_BIND_ADMIN_SUBJECT");
    });

    /**
     * The same collapse through the second person of any other two-person rule. An operator who
     * binds their key to a disclosure approver publishes their own draft; to a registry
     * approver, approves their own registry proposal; to a data steward, confirms a manual
     * receipt and second-reviews it as themselves.
     */
    it.each([...SECOND_PERSON_ROLES])(
      "does not bind a wallet from the screen to a subject holding %s",
      async (role) => {
        const subject = (
          await post(operatorAToken, "/api/v1/admin/subjects", { displayName: `holder of ${role}` })
        ).json();
        await fx.sql`
          INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
          VALUES (${randomUUID()}, ${fx.tenantA}, ${subject.id}, ${fx.orgA}, ${role})
        `;

        const response = await post(
          operatorAToken,
          `/api/v1/admin/subjects/${subject.id}/wallets`,
          {
            walletAddress: newAccount().address,
            chainId: 31337,
            assuranceLevel: "high_assurance",
            justification: "attempt to act as the second person",
          },
        );

        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe("WALLET_BIND_ADMIN_SUBJECT");
        expect(response.json().details.role).toBe(role);
      },
    );

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
        { walletAddress: lost.address, chainId: 31337, assuranceLevel: "identity_bound", justification: "recovery after a reported loss" },
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
        { walletAddress: replacement.address, chainId: 31337, assuranceLevel: "identity_bound", justification: "recovery after a reported loss" },
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
          chainId: 31337,
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
          chainId: 31337,
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
        chainId: 31337,
        assuranceLevel: "wallet_only",
        justification: "test binding",
      });

      // Moving it would make the address's past signatures read as someone else's.
      const moved = await post(operatorAToken, `/api/v1/admin/subjects/${second.id}/wallets`, {
        walletAddress: key.address,
        chainId: 31337,
        assuranceLevel: "wallet_only",
        justification: "test binding",
      });

      expect(moved.statusCode).toBe(409);
      expect(moved.json().code).toBe("WALLET_ALREADY_BOUND");
    });
  });

  /**
   * The operator chooses the assurance level and says why.
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
        chainId: 31337,
        assuranceLevel: "high_assurance",
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("REQUEST_INVALID");
      expect(JSON.stringify(missing.json().details.issues)).toContain("justification");

      const blank = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/wallets`, {
        walletAddress: newAccount().address,
        chainId: 31337,
        assuranceLevel: "high_assurance",
        justification: "   ",
      });
      expect(blank.statusCode).toBe(400);
    });

    it("rejects a level outside the assurance table with 422", async () => {
      const target = await subject("invalid level target");
      const response = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/wallets`, {
        walletAddress: newAccount().address,
        chainId: 31337,
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
        chainId: 31337,
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
