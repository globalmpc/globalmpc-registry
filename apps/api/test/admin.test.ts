import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { TestAccount } from "./helpers/db.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { withActor } from "@mpc/db";
import { bearer, idempotencyKey, issueTestSession, setupFixture, signIn, testEnv, type TestFixture, syncSubjectAssurance } from "./helpers/db.js";
import { bindWalletByProof } from "./helpers/wallets.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Platform administration — the two-person rule for role grants, and key recovery (AC-27).
 *
 * This file guards three things.
 *
 * 1. **People can be added without the bootstrap CLI.**
 * 2. **No one person can grant a role alone** — proposal and approval are split (02 §2.8).
 * 3. **A lost key can be cut off and the holder can bind a new one, and the cut key stops
 * working at once** (AC-27). An admin never attaches a key to an account (WP5): binding is the
 * holder's own proof of possession, and the identity level is set on the person instead.
 */
/** Throwaway signing account. Same shape as the one in `helpers/db.ts`. */
function newAccount(): TestAccount {
  const account = privateKeyToAccount(generatePrivateKey());
  return { address: account.address.toLowerCase() as `0x${string}`, account };
}

describeDb("platform administration", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  /** Both are administrator. Checks that the two-person rule splits by person, not by role. */
  let operatorAToken: string;
  let operatorBToken: string;
  let stewardToken: string;
  /** Subject of operatorBToken — a second Registry-wide admin of company A. */
  let operatorSubjectB: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);

    // operatorB is an organization admin of company B. A second Registry-wide admin is needed, so
    // create one more in company A — without the operator screens, this setup alone
    // was possible only through the CLI.
    const second = newAccount();
    const subjectId = randomUUID();
    operatorSubjectB = subjectId;
    await fx.sql`
      INSERT INTO core.subjects (id, kind, display_name)
      VALUES (${subjectId}, 'person', 'Operator Second')
    `;
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${subjectId}, ${second.address},
        31337, 'high_assurance', now()
      )
    `;
    await syncSubjectAssurance(fx.sql);
    await fx.sql`
      INSERT INTO core.role_bindings (id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${subjectId}, ${fx.orgA}, 'administrator')
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

  it("names each person's ways in, and locks only someone with none (WP6)", async () => {
    const withEmail = randomUUID();
    const withIdentityOnly = randomUUID();
    const withNothing = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, kind, display_name, email) VALUES
        (${withEmail}, 'person', 'Methods Email', ${`methods-${withEmail.slice(0, 8)}@example.com`}),
        (${withIdentityOnly}, 'person', 'Methods Identity', NULL),
        (${withNothing}, 'person', 'Methods None', NULL)
    `;
    // A live Google identity, a revoked one: only the live one is a way in.
    await fx.sql`
      INSERT INTO core.external_identities (
        id, subject_id, provider, issuer, subject_key, linked_via, revoked_at, revoked_reason
      ) VALUES
        (${randomUUID()}, ${withEmail}, 'google', 'https://accounts.google.com',
         ${`g-${withEmail}`}, 'link', NULL, NULL),
        (${randomUUID()}, ${withIdentityOnly}, 'google', 'https://accounts.google.com',
         ${`g-${withIdentityOnly}`}, 'link', NULL, NULL),
        (${randomUUID()}, ${withNothing}, 'google', 'https://accounts.google.com',
         ${randomUUID()}, 'link', now(), 'unlinked_by_holder')
    `;

    const response = await get(operatorAToken, "/api/v1/admin/subjects");
    expect(response.statusCode).toBe(200);
    const items = response.json().items as { id: string; signInMethods: string[]; locked: boolean }[];
    const byId = (id: string) => items.find((item) => item.id === id)!;
    expect(byId(withEmail)).toMatchObject({ signInMethods: ["email", "google"], locked: false });
    expect(byId(withIdentityOnly)).toMatchObject({ signInMethods: ["google"], locked: false });
    expect(byId(withNothing)).toMatchObject({ signInMethods: [], locked: true });
  });

  it("the sign-in providers function answers live actors only", async () => {
    const subject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, kind, display_name) VALUES
        (${subject}, 'person', 'Methods person')
    `;
    await fx.sql`
      INSERT INTO core.external_identities (id, subject_id, provider, issuer, subject_key, linked_via)
      VALUES (${randomUUID()}, ${subject}, 'google', 'https://accounts.google.com', ${`g-${subject}`}, 'link')
    `;
    const seenBy = (subjectId: string) => withActor(fx.appSql, { subjectId }, (tx) =>
      tx<{ provider: string }[]>`SELECT provider FROM core.subject_sign_in_providers(${[subject]}::uuid[])`,
    );
    expect((await seenBy(fx.operatorSubjectA)).map((row) => row.provider)).toEqual(["google"]);
    expect(await seenBy(randomUUID())).toHaveLength(0);
    expect(await fx.appSql`SELECT provider FROM core.subject_sign_in_providers(${[subject]}::uuid[])`).toHaveLength(0);
  });

  it("rejects without admin permission", async () => {
    const response = await post(stewardToken, "/api/v1/admin/subjects", {
      displayName: "steward cannot create this",
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("administrator");
  });

  it("lets the proposer approve their own proposal", async () => {
    const subject = (
      await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "grant target A" })
    ).json();

    const grant = (
      await post(operatorAToken, "/api/v1/admin/role-grants", {
        subjectId: subject.id,
        role: "reviewer",
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

    expect(self.statusCode, self.body).toBe(200);
    expect(self.json().state).toBe("approved");
  });

  /**
   * A wallet bound the way bootstrap and the pre-WP5 admin bind did: over the migration
   * connection, `bound_via = 'operator'`. With `uiBound`, also the `admin.wallet.bound` audit row
   * the removed admin route wrote — such keys still exist on deployments.
   */
  async function operatorWallet(
    subjectId: string,
    level: "wallet_only" | "identity_bound" | "high_assurance",
    options: { account?: TestAccount; uiBound?: boolean } = {},
  ): Promise<{ id: string; account: TestAccount }> {
    const account = options.account ?? newAccount();
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (${id}, ${subjectId}, ${account.address}, 31337, ${level}, now())
    `;
    await syncSubjectAssurance(fx.sql);
    if (options.uiBound) {
      await fx.sql`
        INSERT INTO audit.events (
          actor_subject_id, command, resource_type, resource_id, correlation_id
        ) VALUES (
          ${fx.operatorSubjectA}, 'admin.wallet.bound', 'wallet_identity', ${id}, 'pre-wp5-bind'
        )
      `;
    }
    return { id, account };
  }

  async function walletRow(subjectId: string) {
    const listed = (await get(operatorAToken, "/api/v1/admin/subjects")).json() as {
      items: { id: string; assuranceLevel: string; locked: boolean; signInMethods: string[]; wallets: { id: string; version: number; disabledAt: string | null; boundVia: string }[] }[];
    };
    return listed.items.find((item) => item.id === subjectId)!;
  }

  /**
   * The admin bind refused subjects that already held a second-person role. Reversing the order
   * — bind an operator's key to a subject with no roles, then grant it such a role — passed it,
   * so the grant refuses a subject whose active key was bound from the admin UI. Those keys
   * outlive the removed route; a key the holder bound by proof (WP5) is theirs and blocks nothing.
   */
  describe("granting a second-person role to a subject with a UI-bound key", () => {
    async function uiBoundSubject(label: string): Promise<string> {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: label })
      ).json();
      await operatorWallet(subject.id, "high_assurance", { uiBound: true });
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
      const decided = await proposeAndApprove(subjectId, "reviewer");

      expect(decided.statusCode).toBe(422);
      expect(decided.json().code).toBe("ROLE_GRANT_UI_BOUND_SUBJECT");
    });

    it("still grants a role outside the second-person set", async () => {
      const subjectId = await uiBoundSubject("bound then voter");
      const decided = await proposeAndApprove(subjectId, "project_member");

      expect(decided.statusCode).toBe(200);
      expect(decided.json().state).toBe("approved");
    });

    it("grants a second-person role to a subject whose key the holder bound by proof", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "bound by own proof" })
      ).json();
      const own = await issueTestSession(fx.appSql, subject.id, {
        firstFactor: "email_code",
        secondFactor: "totp",
      });
      const bound = await bindWalletByProof(app, own, newAccount().account);
      expect(bound.statusCode, bound.body).toBe(200);

      const decided = await proposeAndApprove(subject.id, "reviewer");
      expect(decided.statusCode, decided.body).toBe(200);
    });
  });

  /**
   * Write skew between a key appearing and a grant being approved. The approval checks "no
   * UI-bound wallet" and inserts a role; a concurrent writer holding the subject row must make it
   * wait, then see the committed key and refuse.
   */
  describe("a concurrent bind and grant on one subject", () => {
    it("a grant approval waits for a concurrent bind and then refuses", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "grant racing bind" })
      ).json();
      const grant = (
        await post(operatorAToken, "/api/v1/admin/role-grants", {
          subjectId: subject.id,
          role: "reviewer",
          reason: "racing a bind",
        })
      ).json();
      expect(grant.state).toBe("pending");

      const walletId = randomUUID();
      let settled = false;
      const { pending } = await fx.sql.begin(async (tx) => {
        await tx`SELECT id FROM core.subjects WHERE id = ${subject.id} FOR NO KEY UPDATE`;
        await tx`
          INSERT INTO core.wallet_identities (
            id, subject_id, wallet_address, chain_id, assurance_level, bound_at
          ) VALUES (${walletId}, ${subject.id}, ${newAccount().address}, 31337, 'high_assurance', now())
        `;
        await tx`
          INSERT INTO audit.events (
            actor_subject_id, command, resource_type, resource_id, correlation_id
          ) VALUES (
            ${fx.operatorSubjectA}, 'admin.wallet.bound', 'wallet_identity', ${walletId}, 'race-test'
          )
        `;
        const started = post(
          operatorBToken,
          `/api/v1/admin/role-grants/${grant.id}/decision`,
          { decision: "approve", reason: "racing a bind" },
          `"${grant.version}"`,
        );
        void started.then(() => {
          settled = true;
        });
        await new Promise((resolve) => setTimeout(resolve, 300));
        return { pending: started };
      });

      expect(settled).toBe(false);
      const response = await pending;
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
        role: "reviewer",
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
    expect(target.roles.map((role: { role: string }) => role.role)).toContain("reviewer");
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
    const body = { subjectId: subject.id, role: "administrator", reason: "audit duty" };

    expect((await post(operatorAToken, "/api/v1/admin/role-grants", body)).statusCode).toBe(200);
    const second = await post(operatorAToken, "/api/v1/admin/role-grants", body);

    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe("ROLE_GRANT_ALREADY_PENDING");
  });

  /**
   * An admin cannot attach a key to someone else's account (plan §5, acceptance 9; WP5).
   *
   * Otherwise operator A binds their own wallet to operator B and signs as B — and, while
   * legacy wallet sign-in exists, logs in as B and approves their own proposal.
   */
  describe("a single operator cannot bypass the two-person rule", () => {
    it.each([
      ["another operator", () => fx.operatorSubjectA, () => operatorBToken],
      ["a person with no role", () => operatorSubjectB, () => operatorAToken],
    ])("has no route to bind a wallet to %s", async (_label, target, token) => {
      const attempted = newAccount().address;
      const response = await post(token(), `/api/v1/admin/subjects/${target()}/wallets`, {
        walletAddress: attempted,
        chainId: 31337,
        assuranceLevel: "high_assurance",
        justification: "attempt to attach my key to another account",
      });
      expect(response.statusCode).toBe(404);
      const [row] = await fx.sql<{ count: number }[]>`
        SELECT count(*)::int AS count FROM core.wallet_identities WHERE wallet_address = ${attempted}
      `;
      expect(row!.count).toBe(0);
    });

    /**
     * The route being gone is not the control: the application role cannot write a binding at
     * all (0122). Every way the API could attach a key — a new route, a bug, an injected
     * statement — fails at the grant.
     */
    it("the application role can neither insert a wallet nor move one to another subject", async () => {
      await expect(
        withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, (tx) => tx`
          INSERT INTO core.wallet_identities (id, subject_id, wallet_address, chain_id, bound_at)
          VALUES (${randomUUID()}, ${operatorSubjectB}, ${newAccount().address}, 31337, now())
        `),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, (tx) => tx`
          UPDATE core.wallet_identities SET subject_id = ${operatorSubjectB}
          WHERE wallet_address = ${fx.operatorA.address}
        `),
      ).rejects.toThrow(/permission denied/);
      await expect(
        withActor(fx.appSql, { subjectId: fx.operatorSubjectA }, (tx) => tx`
          UPDATE core.wallet_identities SET wallet_address = ${newAccount().address}
          WHERE wallet_address = ${fx.operatorA.address}
        `),
      ).rejects.toThrow(/permission denied/);
    });

    it("does not disable one's own wallet — the last operator cannot remove themselves", async () => {
      const own = (await walletRow(fx.operatorSubjectA)).wallets[0]!;

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
    it("cuts the key without locking the person, and the holder binds a new one by proof", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "person who lost a key" })
      ).json();
      const { id: walletId, account: lost } = await operatorWallet(subject.id, "identity_bound");
      /**
       * A key is never a way in (WP7): a person with only a key, and no address or identity, is
       * locked — the screen must say so rather than count the key.
       */
      const keyOnly = await walletRow(subject.id);
      expect(keyOnly).toMatchObject({ signInMethods: [], locked: true });

      // The person signs in to their account (this gives them an address) and holds a session.
      const account = await issueTestSession(fx.appSql, subject.id, {
        firstFactor: "email_code",
        secondFactor: "totp",
      });

      const beforeDisable = await walletRow(subject.id);
      expect(beforeDisable).toMatchObject({ signInMethods: ["email"], locked: false });
      const wallet = beforeDisable.wallets.find((w) => w.id === walletId)!;
      const disabled = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${wallet.id}/disable`,
        { reasonCode: "key_lost", detail: "reported lost along with a laptop" },
        `"${wallet.version}"`,
      );

      expect(disabled.statusCode).toBe(200);
      expect(disabled.json().wallets[0].disabledAt).not.toBeNull();
      // Cutting a signing key takes away no way in: the address is still one.
      expect(disabled.json().signInMethods).toEqual(["email"]);
      expect(disabled.json().locked).toBe(false);

      /**
       * Every session of the subject ends with the disable (0108): whoever may hold the key may
       * also hold the person's device, so no session keeps running for the rest of its TTL.
       */
      const held = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(account) });
      expect(held.json().authenticated).toBe(false);
      const reasons = await fx.sql<{ revoked_reason: string | null }[]>`
        SELECT revoked_reason FROM core.sessions WHERE subject_id = ${subject.id}
      `;
      expect(reasons.map((row) => row.revoked_reason)).toEqual(["wallet_disabled"]);

      /**
       * The cut key cannot act as anyone. There is no wallet sign-in to try (WP7), and the
       * address itself is not a credential.
       */
      await expect(signIn(app, lost)).rejects.toThrow(/not an active wallet of any person/);
      const siwe = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: lost.address, chainId: 31337 },
      });
      expect(siwe.statusCode).toBe(404);
      const denied = await app.inject({ method: "GET", url: "/api/v1/admin/subjects", headers: bearer(lost.address) });
      expect(denied.statusCode).toBe(401);

      // Recovery: the person signs in to their account again and binds a new key themselves.
      // If cutting worked but rebinding did not, it would be account destruction, not recovery.
      const again = await issueTestSession(fx.appSql, subject.id, {
        firstFactor: "email_code",
        secondFactor: "totp",
      });
      const replacement = newAccount();
      const requested = await post(again, "/api/v1/auth/wallet-recoveries", { walletAddress: replacement.address });
      expect(requested.statusCode, requested.body).toBe(200);
      const { id } = requested.json();
      const [mail] = await fx.sql`SELECT params FROM core.email_outbox WHERE template='wallet_recovery'
        AND recipient=(SELECT email FROM core.subjects WHERE id=${subject.id}) AND params->>'address'=${replacement.address}`;
      expect((await post(again, "/api/v1/auth/wallet-recoveries/confirm", { id, proof: mail!.params.code })).statusCode).toBe(200);
      expect((await post(operatorAToken, "/api/v1/admin/wallet-recoveries/approve", { id })).statusCode).toBe(200);
      const rebound = await bindWalletByProof(app, again, replacement.account);
      expect(rebound.statusCode, rebound.body).toBe(200);
      const row = await walletRow(subject.id);
      expect(row.locked).toBe(false);
      expect(row.wallets.find((w) => w.disabledAt === null)?.boundVia).toBe("proof");
    });

    it("records the reason for the cut", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "reason record target" })
      ).json();
      const { id } = await operatorWallet(subject.id, "wallet_only");
      const wallet = (await walletRow(subject.id)).wallets[0]!;

      await post(
        operatorAToken,
        `/api/v1/admin/wallets/${id}/disable`,
        { reasonCode: "key_compromised", detail: "phishing report received" },
        `"${wallet.version}"`,
      );

      // Loss, compromise, and departure have the same effect, but differ in how past
      // signatures must be read.
      const [event] = await fx.sql<{ reason_code: string; detail: string }[]>`
        SELECT reason_code, detail FROM core.wallet_disable_events WHERE wallet_identity_id = ${id}
      `;
      expect(event!.reason_code).toBe("key_compromised");
      expect(event!.detail).toContain("phishing");
    });

    it("does not disable an already disabled wallet again", async () => {
      const subject = (
        await post(operatorAToken, "/api/v1/admin/subjects", { displayName: "duplicate disable target" })
      ).json();
      const { id } = await operatorWallet(subject.id, "wallet_only");
      const wallet = (await walletRow(subject.id)).wallets[0]!;

      await post(
        operatorAToken,
        `/api/v1/admin/wallets/${id}/disable`,
        { reasonCode: "rotation", detail: "scheduled rotation" },
        `"${wallet.version}"`,
      );
      const again = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${id}/disable`,
        { reasonCode: "rotation", detail: "scheduled rotation" },
        `"${wallet.version + 1}"`,
      );

      expect(again.statusCode).toBe(422);
      expect(again.json().code).toBe("WALLET_ALREADY_DISABLED");
    });
  });

  /**
   * Identity assurance, set on the person with a stated basis (WP5).
   *
   * The admin bind used to carry it. A proof of possession says nothing about who holds a key,
   * so the level is set on the subject, by an admin, with the justification kept in the audit
   * record — and never by the person for themselves.
   */
  describe("identity assurance set with a justification", () => {
    async function subject(name: string): Promise<{ id: string }> {
      return (await post(operatorAToken, "/api/v1/admin/subjects", { displayName: name })).json();
    }
    const level = async (id: string) =>
      (await fx.sql<{ assurance_level: string }[]>`SELECT assurance_level FROM core.subjects WHERE id = ${id}`)[0]!
        .assurance_level;

    it("requires a justification", async () => {
      const target = await subject("justification target");
      const missing = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/assurance`, {
        assuranceLevel: "high_assurance",
      });
      expect(missing.statusCode).toBe(400);
      expect(missing.json().code).toBe("REQUEST_INVALID");
      expect(JSON.stringify(missing.json().details.issues)).toContain("justification");

      const blank = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/assurance`, {
        assuranceLevel: "high_assurance",
        justification: "   ",
      });
      expect(blank.statusCode).toBe(400);
      expect(await level(target.id)).toBe("wallet_only");
    });

    it("rejects a level outside the assurance table with 422", async () => {
      const target = await subject("invalid level target");
      const response = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/assurance`, {
        assuranceLevel: "super_admin",
        justification: "not a real level",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ASSURANCE_LEVEL_INVALID");
    });

    it("records the chosen level and the justification in the audit event", async () => {
      const target = await subject("audited level target");
      const justification = "Passport checked in person on 2026-09-14";
      const set = await post(operatorAToken, `/api/v1/admin/subjects/${target.id}/assurance`, {
        assuranceLevel: "high_assurance",
        justification,
      });

      expect(set.statusCode, set.body).toBe(200);
      expect(set.json().assuranceLevel).toBe("high_assurance");
      expect(await level(target.id)).toBe("high_assurance");

      const [event] = await fx.sql<{ detail: Record<string, unknown>; actor_subject_id: string }[]>`
        SELECT detail, actor_subject_id FROM audit.events
        WHERE command = 'admin.subject.assurance_set' AND resource_id = ${target.id}
      `;
      expect(event!.actor_subject_id).toBe(fx.operatorSubjectA);
      expect(event!.detail).toMatchObject({
        assuranceLevel: "high_assurance",
        previousAssuranceLevel: "wallet_only",
        justification,
      });
    });

    it("never for oneself, and never without admin authority", async () => {
      const self = await post(operatorAToken, `/api/v1/admin/subjects/${fx.operatorSubjectA}/assurance`, {
        assuranceLevel: "wallet_only",
        justification: "lowering myself",
      });
      expect(self.statusCode).toBe(422);
      expect(self.json().code).toBe("ASSURANCE_SELF");

      const upperSelf = await post(operatorAToken, `/api/v1/admin/subjects/${fx.operatorSubjectA.toUpperCase()}/assurance`, {
        assuranceLevel: "wallet_only",
        justification: "uppercase self-change attempt",
      });
      expect(upperSelf.statusCode).toBe(422);
      expect(upperSelf.json().code).toBe("ASSURANCE_SELF");
      expect(await level(fx.operatorSubjectA)).toBe("high_assurance");

      const target = await subject("steward cannot raise");
      const steward = await post(stewardToken, `/api/v1/admin/subjects/${target.id}/assurance`, {
        assuranceLevel: "high_assurance",
        justification: "not an admin",
      });
      expect(steward.statusCode).toBe(403);
      expect(await level(target.id)).toBe("wallet_only");
    });

    it("refuses a service subject: a service's reach is its token's scopes", async () => {
      const response = await post(operatorAToken, `/api/v1/admin/subjects/${fx.scanServiceSubjectA}/assurance`, {
        assuranceLevel: "wallet_only",
        justification: "services have no identity check",
      });
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ASSURANCE_PERSON_ONLY");
    });

    /**
     * Before WP5 the level travelled with operator-bound wallets, and disabling one still lowers
     * the subject to what its active wallets carry — a cut strong key must not leave its level
     * behind. An account holds one wallet (0130), so nothing remains and the level is the floor.
     */
    it("disabling a strong operator-bound wallet lowers the subject to the floor", async () => {
      const target = await subject("assurance across wallets");
      const strong = await operatorWallet(target.id, "high_assurance");
      expect(await level(target.id)).toBe("high_assurance");

      const row = (await walletRow(target.id)).wallets.find((w) => w.id === strong.id)!;
      const disabled = await post(
        operatorAToken,
        `/api/v1/admin/wallets/${strong.id}/disable`,
        { reasonCode: "key_compromised", detail: "strong key lost" },
        `"${row.version}"`,
      );
      expect(disabled.statusCode).toBe(200);
      expect(await level(target.id)).toBe("wallet_only");
      const [disableEvent] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'admin.wallet.disabled' AND resource_id = ${strong.id}
      `;
      expect(disableEvent!.detail).toMatchObject({
        subjectAssuranceLevel: "wallet_only",
        previousSubjectAssuranceLevel: "high_assurance",
      });
    });
  });
});
