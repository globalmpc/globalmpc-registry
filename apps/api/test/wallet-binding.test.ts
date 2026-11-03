import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { withTenant } from "@mpc/db";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  idempotencyKey,
  issueTestSession,
  newAccount,
  setupFixture,
  signIn,
  testEnv,
  type TestAccount,
  type TestFixture,
} from "./helpers/db.js";
import {
  bindWalletByProof,
  requestBindingChallenge,
  signBindingChallenge,
  submitBinding,
  type BindingChallenge,
} from "./helpers/wallets.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Wallets as signing keys — account authentication WP5 (plan §5, acceptance 7–9).
 *
 * A person binds a key to their own account by signing a challenge with it, from an account
 * session at the level of the strongest factor they hold. Nobody else can attach a key to an
 * account, a proof-bound key never signs anyone in, and a bound key is the person's to cut.
 *
 * Every case uses real keys: the property under test is that the signature covers exactly this
 * subject, tenant, address, chain and nonce, and nothing else passes.
 */
describeDb("wallet binding by proof of possession", () => {
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

  /** A fresh person in `tenantId` with no wallet and no role. */
  async function person(tenantId = fx.tenantA): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${id}, ${tenantId}, 'person', ${`wallet person ${id.slice(0, 8)}`})
    `;
    return id;
  }

  function totpSession(subjectId: string, tenantId = fx.tenantA): Promise<string> {
    return issueTestSession(fx.appSql, tenantId, subjectId, { firstFactor: "email_code", secondFactor: "totp" });
  }

  function passkeySession(subjectId: string, tenantId = fx.tenantA): Promise<string> {
    return issueTestSession(fx.appSql, tenantId, subjectId, { firstFactor: "email_code", secondFactor: "passkey" });
  }

  async function challengeFor(token: string, signer: TestAccount): Promise<BindingChallenge> {
    const response = await requestBindingChallenge(app, token, signer.address);
    expect(response.statusCode, response.body).toBe(200);
    return response.json() as BindingChallenge;
  }

  /** The one live session of a person who has signed in once. */
  async function sessionOf(subjectId: string): Promise<string> {
    const rows = await fx.sql<{ id: string }[]>`
      SELECT id FROM core.sessions WHERE subject_id = ${subjectId} AND revoked_at IS NULL
    `;
    expect(rows).toHaveLength(1);
    return rows[0]!.id;
  }

  describe("binding", () => {
    it("binds the signing key to the caller's own account, and records the signed act", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const key = newAccount();

      const challenge = await challengeFor(token, key);
      expect(challenge.typedData.primaryType).toBe("WalletBinding");
      expect(challenge.typedData.message).toMatchObject({ purpose: "bind-wallet", wallet: key.address });

      const bound = await submitBinding(app, token, {
        challengeId: challenge.challengeId,
        signature: await signBindingChallenge(key.account, challenge),
      });
      expect(bound.statusCode, bound.body).toBe(200);
      expect(bound.json()).toMatchObject({ walletAddress: key.address, chainId: 31337, boundVia: "proof", replaced: null });
      expect(challenge.replaces).toBeNull();

      const [row] = await fx.sql<{ subject_id: string; bound_via: string; assurance_level: string }[]>`
        SELECT subject_id, bound_via, assurance_level::text FROM core.wallet_identities WHERE wallet_address = ${key.address}
      `;
      // A proof says who holds the key, not who the person is.
      expect(row).toEqual({ subject_id: subjectId, bound_via: "proof", assurance_level: "wallet_only" });

      const [event] = await fx.sql<{ actor_subject_id: string; actor_wallet: string; effective_role: string }[]>`
        SELECT actor_subject_id, actor_wallet, effective_role FROM audit.events
        WHERE command = 'account.wallet.bound' AND resource_id = ${bound.json().id}
      `;
      expect(event).toMatchObject({ actor_subject_id: subjectId, actor_wallet: key.address });

      const listed = await app.inject({ method: "GET", url: "/api/v1/auth/wallets", headers: bearer(token) });
      expect(listed.json().items.map((w: { walletAddress: string }) => w.walletAddress)).toEqual([key.address]);
    });

    it("does not raise the person's identity assurance", async () => {
      const subjectId = await person();
      const response = await bindWalletByProof(app, await totpSession(subjectId), newAccount().account);
      expect(response.statusCode).toBe(200);
      const [subject] = await fx.sql<{ assurance_level: string }[]>`
        SELECT assurance_level::text FROM core.subjects WHERE id = ${subjectId}
      `;
      expect(subject!.assurance_level).toBe("wallet_only");
    });

    it.each([
      ["another chain", { domain: { chainId: 1 } }],
      ["another subject", { message: { subjectId: `0x${"11".repeat(32)}` } }],
      ["another tenant", { message: { tenantId: `0x${"22".repeat(32)}` } }],
      ["another nonce", { message: { nonce: `0x${"33".repeat(32)}` } }],
      ["another purpose", { message: { purpose: "sign-in" } }],
    ])("refuses a signature that covered %s", async (_label, overrides) => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const key = newAccount();
      const challenge = await challengeFor(token, key);

      const response = await submitBinding(app, token, {
        challengeId: challenge.challengeId,
        signature: await signBindingChallenge(key.account, challenge, overrides),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("SIGNATURE_SIGNER_MISMATCH");
      const [count] = await fx.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM core.wallet_identities WHERE wallet_address = ${key.address}
      `;
      expect(count!.n).toBe(0);
    });

    it("refuses a signature by a key other than the one named in the challenge", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const named = newAccount();
      const challenge = await challengeFor(token, named);

      const response = await submitBinding(app, token, {
        challengeId: challenge.challengeId,
        signature: await signBindingChallenge(newAccount().account, challenge),
      });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("SIGNATURE_SIGNER_MISMATCH");
    });

    it("refuses a replayed challenge", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const key = newAccount();
      const challenge = await challengeFor(token, key);
      const body = { challengeId: challenge.challengeId, signature: await signBindingChallenge(key.account, challenge) };

      expect((await submitBinding(app, token, body)).statusCode).toBe(200);
      const replay = await submitBinding(app, token, body);
      expect(replay.statusCode).toBe(401);
      expect(replay.json().code).toBe("WALLET_CHALLENGE_INVALID");
    });

    it("refuses an expired challenge", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const key = newAccount();
      const challenge = await challengeFor(token, key);
      const signature = await signBindingChallenge(key.account, challenge);
      await fx.sql`
        UPDATE core.wallet_binding_challenges
        SET issued_at = now() - interval '10 minutes', expires_at = now() - interval '6 minutes'
        WHERE id = ${challenge.challengeId}
      `;

      const response = await submitBinding(app, token, { challengeId: challenge.challengeId, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("WALLET_CHALLENGE_INVALID");
    });

    it("refuses another session's challenge, even the same person's", async () => {
      const subjectId = await person();
      const first = await totpSession(subjectId);
      const second = await totpSession(subjectId);
      const key = newAccount();
      const challenge = await challengeFor(first, key);

      const response = await submitBinding(app, second, {
        challengeId: challenge.challengeId,
        signature: await signBindingChallenge(key.account, challenge),
      });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("WALLET_CHALLENGE_INVALID");
    });

    it("gives one answer for an address active anywhere else", async () => {
      const holder = await person();
      const taken = newAccount();
      expect((await bindWalletByProof(app, await totpSession(holder), taken.account)).statusCode).toBe(200);

      // The holder's own active wallet: nothing to hide from them, nothing to replace.
      const own = await bindWalletByProof(app, await totpSession(holder), taken.account);
      expect(own.statusCode).toBe(409);
      expect(own.json().code).toBe("WALLET_ALREADY_ACTIVE");

      const tenantBPerson = await person(fx.tenantB);
      const cases: [string, string, TestAccount][] = [
        ["another subject", await totpSession(await person()), taken],
        ["another tenant", await totpSession(tenantBPerson, fx.tenantB), taken],
        ["an operator-bound key", await totpSession(await person()), fx.operatorA],
      ];
      for (const [label, token, key] of cases) {
        const response = await bindWalletByProof(app, token, key.account);
        expect(response.statusCode, label).toBe(409);
        expect(response.json().code, label).toBe("WALLET_UNAVAILABLE");
      }
      const [row] = await fx.sql<{ subject_id: string }[]>`
        SELECT subject_id FROM core.wallet_identities WHERE wallet_address = ${taken.address}
      `;
      expect(row!.subject_id).toBe(holder);
    });
  });

  describe("session strength", () => {
    it("refuses a first-factor-only session", async () => {
      const subjectId = await person();
      const token = await issueTestSession(fx.appSql, fx.tenantA, subjectId, { firstFactor: "email_code" });
      const response = await requestBindingChallenge(app, token, newAccount().address);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("MFA_REQUIRED");

      // The database refuses it too, whatever route reaches it.
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, async (tx) => tx`
          SELECT * FROM core.create_wallet_binding_challenge(
            ${await sessionOf(subjectId)}, ${randomUUID()}, ${newAccount().address}, 31337,
            ${`0x${randomBytes(32).toString("hex")}`}
          )
        `),
      ).rejects.toThrow(/MFA_STEP_UP_REQUIRED/);
    });

    it("asks a person holding a passkey to use it", async () => {
      const subjectId = await person();
      await passkeySession(subjectId);
      const totp = await totpSession(subjectId);

      const refused = await requestBindingChallenge(app, totp, newAccount().address);
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toMatchObject({ code: "MFA_PASSKEY_REQUIRED", details: { requiredAal: "aal3" } });

      const passkey = await passkeySession(subjectId);
      expect((await bindWalletByProof(app, passkey, newAccount().account)).statusCode).toBe(200);
    });

    it("refuses a session restored by a recovery code", async () => {
      const subjectId = await person();
      const token = await issueTestSession(fx.appSql, fx.tenantA, subjectId, {
        firstFactor: "email_code",
        secondFactor: "recovery_code",
      });
      const response = await requestBindingChallenge(app, token, newAccount().address);
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("MFA_RECOVERY_REENROLMENT_REQUIRED");

      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, async (tx) => tx`
          SELECT * FROM core.create_wallet_binding_challenge(
            ${await sessionOf(subjectId)}, ${randomUUID()}, ${newAccount().address}, 31337,
            ${`0x${randomBytes(32).toString("hex")}`}
          )
        `),
      ).rejects.toThrow(/MFA_RECOVERY_REENROLMENT_REQUIRED/);
    });

    it("refuses a service token", async () => {
      const response = await requestBindingChallenge(app, fx.scanServiceToken, newAccount().address);
      expect(response.statusCode).toBe(403);
    });
  });

  describe("a proof-bound key never signs anyone in", () => {
    it("opens no session with it: there is no wallet sign-in left to try", async () => {
      const subjectId = await person();
      await fx.sql`
        INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${fx.orgA}, 'data_steward')
      `;
      const key = newAccount();
      expect((await bindWalletByProof(app, await totpSession(subjectId), key.account)).statusCode).toBe(200);

      // Otherwise a TOTP session binds a key and the key signs in as the person with no second
      // factor. With SIWE removed (WP7) the key has no route to try, and its address is no token.
      const message = `localhost:3000 wants you to sign in with your Ethereum account:\n${key.account.address}`;
      const verify = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/verify",
        payload: { message, signature: await key.account.signMessage({ message }) },
      });
      expect(verify.statusCode).toBe(404);
      expect(verify.body).not.toContain("sessionToken");
      const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(key.address) });
      expect(session.json().authenticated).toBe(false);
    });
  });

  describe("disabling one's own wallet", () => {
    it("cuts the key, ends every session of the person, and records it", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const other = await totpSession(subjectId);
      const key = newAccount();
      const bound = (await bindWalletByProof(app, token, key.account)).json();

      const disabled = await app.inject({
        method: "POST",
        url: `/api/v1/auth/wallets/${bound.id}/disable`,
        headers: bearer(token),
        payload: { reasonCode: "key_compromised", detail: "phone stolen" },
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json().revokedSessions).toBe(2);

      // Whoever has the key may also hold a session; the person signs in again.
      for (const held of [token, other]) {
        const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(held) });
        expect(session.json().authenticated).toBe(false);
      }
      const [row] = await fx.sql<{ disabled_at: Date | null }[]>`
        SELECT disabled_at FROM core.wallet_identities WHERE id = ${bound.id}
      `;
      expect(row!.disabled_at).not.toBeNull();
      const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'account.wallet.disabled' AND resource_id = ${bound.id}
      `;
      expect(event!.detail).toMatchObject({ reasonCode: "key_compromised", boundVia: "proof", revokedSessions: 2 });
      const [reason] = await fx.sql<{ reason_code: string }[]>`
        SELECT reason_code FROM core.wallet_disable_events WHERE wallet_identity_id = ${bound.id}
      `;
      expect(reason!.reason_code).toBe("key_compromised");
    });

    it("cannot disable another person's wallet", async () => {
      const owner = await person();
      const bound = (await bindWalletByProof(app, await totpSession(owner), newAccount().account)).json();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/auth/wallets/${bound.id}/disable`,
        headers: bearer(await totpSession(await person())),
        payload: { reasonCode: "key_lost", detail: "not mine" },
      });
      expect(response.statusCode).toBe(404);
      const [row] = await fx.sql<{ disabled_at: Date | null }[]>`
        SELECT disabled_at FROM core.wallet_identities WHERE id = ${bound.id}
      `;
      expect(row!.disabled_at).toBeNull();
    });

    it("leaves the account with no signing wallet, and refuses a system reason", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const bound = (await bindWalletByProof(app, token, newAccount().account)).json();

      // `replaced` and `consolidated_single_wallet` are written by the system, never chosen.
      const system = await disable(token, bound.id, "replaced");
      expect(system.statusCode).toBe(400);
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, async (tx) => tx`
          SELECT * FROM core.disable_own_wallet(${await sessionOf(subjectId)}, ${bound.id}, 'replaced', 'x')
        `),
      ).rejects.toThrow(/WALLET_REASON_INVALID/);

      expect((await disable(token, bound.id)).statusCode).toBe(200);
      const fresh = await totpSession(subjectId);
      expect(await activeWallets(subjectId)).toEqual([]);
      // The next binding replaces nothing.
      expect((await challengeFor(fresh, newAccount())).replaces).toBeNull();
    });
  });

  function disable(token: string, walletId: string, reasonCode = "key_lost") {
    return app.inject({
      method: "POST",
      url: `/api/v1/auth/wallets/${walletId}/disable`,
      headers: bearer(token),
      payload: { reasonCode, detail: "test" },
    });
  }

  async function activeWallets(subjectId: string): Promise<string[]> {
    const rows = await fx.sql<{ wallet_address: string }[]>`
      SELECT wallet_address FROM core.wallet_identities WHERE subject_id = ${subjectId} AND disabled_at IS NULL
    `;
    return rows.map((row) => row.wallet_address);
  }

  async function sessionAlive(token: string): Promise<boolean> {
    const session = await app.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
    return session.json().authenticated === true;
  }

  /**
   * One active wallet per account (0130): binding while the account holds one replaces it, in one
   * transaction — never zero, never two.
   */
  describe("replacing the wallet", () => {
    it("replaces atomically, says so before the signature, keeps sessions, and audits both ids", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const other = await totpSession(subjectId);
      const first = newAccount();
      const old = (await bindWalletByProof(app, token, first.account)).json();

      const next = newAccount();
      const challenge = await challengeFor(token, next);
      // The screen can say "this will replace 0x…" before the wallet opens.
      expect(challenge.replaces).toEqual({ id: old.id, walletAddress: first.address, chainId: 31337 });
      expect(challenge.humanReadablePayload).toContain(`This replaces your current signing wallet ${first.address}`);

      const bound = await submitBinding(app, token, {
        challengeId: challenge.challengeId,
        signature: await signBindingChallenge(next.account, challenge),
      });
      expect(bound.statusCode, bound.body).toBe(200);
      expect(bound.json()).toMatchObject({
        walletAddress: next.address,
        disabledAt: null,
        replaced: { id: old.id, walletAddress: first.address },
      });

      expect(await activeWallets(subjectId)).toEqual([next.address]);
      const [oldRow] = await fx.sql<
        { disabled: boolean; reason_code: string; replace_cause: string; disabled_by_subject_id: string }[]
      >`
        SELECT w.disabled_at IS NOT NULL AS disabled, e.reason_code, e.replace_cause, e.disabled_by_subject_id
        FROM core.wallet_identities w JOIN core.wallet_disable_events e ON e.wallet_identity_id = w.id
        WHERE w.id = ${old.id}
      `;
      // No reason given: a planned rotation.
      expect(oldRow).toEqual({
        disabled: true,
        reason_code: "replaced",
        replace_cause: "rotation",
        disabled_by_subject_id: subjectId,
      });

      const [event] = await fx.sql<{ detail: Record<string, unknown>; actor_wallet: string }[]>`
        SELECT detail, actor_wallet FROM audit.events
        WHERE command = 'account.wallet.replaced' AND resource_id = ${bound.json().id}
      `;
      expect(event!.actor_wallet).toBe(next.address);
      expect(event!.detail).toMatchObject({
        oldWalletId: old.id,
        newWalletId: bound.json().id,
        replaceReason: "rotation",
        revokedSessions: 0,
      });

      // A replace ends no session: the old key stopped signing in the same transaction.
      expect(await sessionAlive(token)).toBe(true);
      expect(await sessionAlive(other)).toBe(true);

      const listed = await app.inject({ method: "GET", url: "/api/v1/auth/wallets", headers: bearer(token) });
      expect(listed.json().items.map((w: { id: string; disabledAt: string | null }) => [w.id, w.disabledAt === null])).toEqual([
        [bound.json().id, true],
        [old.id, false],
      ]);
    });

    it("a refused replacement leaves the old wallet active — never zero", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const mine = newAccount();
      expect((await bindWalletByProof(app, token, mine.account)).statusCode).toBe(200);
      const taken = newAccount();
      expect((await bindWalletByProof(app, await totpSession(await person()), taken.account)).statusCode).toBe(200);

      const refused = await bindWalletByProof(app, token, taken.account);
      expect(refused.statusCode).toBe(409);
      expect(refused.json().code).toBe("WALLET_UNAVAILABLE");
      expect(await activeWallets(subjectId)).toEqual([mine.address]);
      const [events] = await fx.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM core.wallet_disable_events e
        JOIN core.wallet_identities w ON w.id = e.wallet_identity_id WHERE w.subject_id = ${subjectId}
      `;
      expect(events!.n).toBe(0);
    });

    it("refuses a challenge issued before the account's wallet changed", async () => {
      const subjectId = await person();
      const first = await totpSession(subjectId);
      const second = await totpSession(subjectId);

      // No wallet when the first challenge was issued; one by the time it is signed.
      const late = newAccount();
      const stale = await challengeFor(first, late);
      expect(stale.replaces).toBeNull();
      const winner = newAccount();
      expect((await bindWalletByProof(app, second, winner.account)).statusCode).toBe(200);

      const refused = await submitBinding(app, first, {
        challengeId: stale.challengeId,
        signature: await signBindingChallenge(late.account, stale),
      });
      expect(refused.statusCode).toBe(401);
      expect(refused.json().code).toBe("WALLET_CHALLENGE_INVALID");
      expect(await activeWallets(subjectId)).toEqual([winner.address]);
    });

    it.each([
      ["with no wallet yet", false],
      ["replacing a wallet", true],
    ])("concurrent binds of one account leave exactly one active wallet (%s)", async (_label, hasWallet) => {
      const subjectId = await person();
      if (hasWallet) {
        expect((await bindWalletByProof(app, await totpSession(subjectId), newAccount().account)).statusCode).toBe(200);
      }
      const keys = [newAccount(), newAccount(), newAccount()];
      // Sessions and challenges are issued one after another; only the binds race.
      const tokens: string[] = [];
      const challenges: BindingChallenge[] = [];
      for (const key of keys) {
        const token = await totpSession(subjectId);
        tokens.push(token);
        challenges.push(await challengeFor(token, key));
      }
      const bodies = await Promise.all(
        keys.map(async (key, i) => ({
          challengeId: challenges[i]!.challengeId,
          signature: await signBindingChallenge(key.account, challenges[i]!),
        })),
      );

      const results = await Promise.all(bodies.map((body, i) => submitBinding(app, tokens[i]!, body)));
      const codes = results.map((r) => r.statusCode).sort();
      expect(codes).toEqual([200, 401, 401]);
      const winner = keys[results.findIndex((r) => r.statusCode === 200)]!;
      expect(await activeWallets(subjectId)).toEqual([winner.address]);
    });

    it("the database holds one active wallet per account and per address, even for the owner", async () => {
      const subjectId = await person();
      expect((await bindWalletByProof(app, await totpSession(subjectId), newAccount().account)).statusCode).toBe(200);
      await expect(fx.sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${newAccount().address}, 31337, now())
      `).rejects.toThrow(/wallet_identities_one_active_per_subject/);

      const taken = (await activeWallets(subjectId))[0]!;
      const other = await person();
      await expect(fx.sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${other}, ${taken}, 31337, now())
      `).rejects.toThrow(/wallet_identities_active_address_key/);
    });
  });

  describe("re-binding a disabled address", () => {
    it("binds it again for the same person, as a new row; the old row stays as it was", async () => {
      const subjectId = await person();
      const key = newAccount();
      const old = (await bindWalletByProof(app, await totpSession(subjectId), key.account)).json();
      expect((await disable(await totpSession(subjectId), old.id)).statusCode).toBe(200);
      const [before] = await fx.sql<{ disabled_at: Date; version: number }[]>`
        SELECT disabled_at, version FROM core.wallet_identities WHERE id = ${old.id}
      `;

      const again = await bindWalletByProof(app, await totpSession(subjectId), key.account);
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().id).not.toBe(old.id);
      expect(again.json().replaced).toBeNull();

      const [after] = await fx.sql<{ disabled_at: Date; version: number; subject_id: string }[]>`
        SELECT disabled_at, version, subject_id FROM core.wallet_identities WHERE id = ${old.id}
      `;
      expect(after).toEqual({ ...before, subject_id: subjectId });
      const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'account.wallet.bound' AND resource_id = ${again.json().id}
      `;
      expect(event!.detail).toMatchObject({ rebindOf: old.id, rebindSameSubject: true });
    });

    it("binds it for a new holder; earlier rows stay attributed to the earlier holder", async () => {
      const earlier = await person();
      const key = newAccount();
      const old = (await bindWalletByProof(app, await totpSession(earlier), key.account)).json();
      expect((await disable(await totpSession(earlier), old.id, "rotation")).statusCode).toBe(200);

      const holder = await person();
      const bound = await bindWalletByProof(app, await totpSession(holder), key.account);
      expect(bound.statusCode, bound.body).toBe(200);

      const rows = await fx.sql<{ id: string; subject_id: string; active: boolean }[]>`
        SELECT id, subject_id, disabled_at IS NULL AS active FROM core.wallet_identities
        WHERE wallet_address = ${key.address} ORDER BY created_at
      `;
      expect(rows).toEqual([
        { id: old.id, subject_id: earlier, active: false },
        { id: bound.json().id, subject_id: holder, active: true },
      ]);
      const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'account.wallet.bound' AND resource_id = ${bound.json().id}
      `;
      expect(event!.detail).toMatchObject({ rebindOf: old.id, rebindSameSubject: false });
      // The earlier holder does not see the new holder's row.
      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/auth/wallets",
        headers: bearer(await totpSession(earlier)),
      });
      expect(listed.json().items.map((w: { id: string }) => w.id)).toEqual([old.id]);
    });
  });

  describe("why a wallet is replaced, and what it does to assurance", () => {
    async function replaceCause(walletId: string): Promise<string | null> {
      const [row] = await fx.sql<{ replace_cause: string | null }[]>`
        SELECT replace_cause FROM core.wallet_disable_events WHERE wallet_identity_id = ${walletId}
      `;
      return row?.replace_cause ?? null;
    }

    it("records the holder's reason, and refuses one that is not a replace reason", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const old = (await bindWalletByProof(app, token, newAccount().account)).json();

      for (const bogus of ["offboarding", "replaced", "consolidated_single_wallet", "x"]) {
        const refused = await bindWalletByProof(app, token, newAccount().account, bogus);
        expect(refused.statusCode, bogus).toBe(400);
      }
      expect(await activeWallets(subjectId)).toEqual([old.walletAddress]);

      const bound = await bindWalletByProof(app, token, newAccount().account, "key_lost");
      expect(bound.statusCode, bound.body).toBe(200);
      expect(await replaceCause(old.id)).toBe("key_lost");
      const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'account.wallet.replaced' AND resource_id = ${bound.json().id}
      `;
      expect(event!.detail).toMatchObject({ replaceReason: "key_lost", revokedSessions: 0 });

      // A first bind replaces nothing and records no cause, whatever the request said.
      const fresh = await person();
      const first = await bindWalletByProof(app, await totpSession(fresh), newAccount().account, "key_compromised");
      expect(first.statusCode).toBe(200);
      expect(first.json().replaced).toBeNull();
    });

    it("replacing an operator-verified wallet lowers assurance to the floor, and says so in the audit", async () => {
      const subjectId = await person();
      await fx.sql`UPDATE core.subjects SET assurance_level = 'high_assurance' WHERE id = ${subjectId}`;
      const operatorKey = newAccount();
      const operatorWalletId = randomUUID();
      // Bound before WP5 by an operator, who verified the person with it.
      await fx.sql`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, bound_via
        ) VALUES (
          ${operatorWalletId}, ${fx.tenantA}, ${subjectId}, ${operatorKey.address}, 31337, 'high_assurance', now(), 'operator'
        )
      `;
      const token = await totpSession(subjectId);
      const bound = await bindWalletByProof(app, token, newAccount().account);
      expect(bound.statusCode, bound.body).toBe(200);
      expect(bound.json().replaced).toMatchObject({ id: operatorWalletId });

      const [subject] = await fx.sql<{ assurance_level: string }[]>`
        SELECT assurance_level::text FROM core.subjects WHERE id = ${subjectId}
      `;
      expect(subject!.assurance_level).toBe("wallet_only");
      const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'account.wallet.replaced' AND resource_id = ${bound.json().id}
      `;
      expect(event!.detail).toMatchObject({
        oldBoundVia: "operator",
        previousSubjectAssuranceLevel: "high_assurance",
        subjectAssuranceLevel: "wallet_only",
      });
      // Sessions still stay: the replace needed the strongest factor held.
      expect(await sessionAlive(token)).toBe(true);
    });

    it("replacing a proof-bound wallet leaves assurance as it is", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      expect((await bindWalletByProof(app, token, newAccount().account)).statusCode).toBe(200);
      // An admin verified the person (the assurance route), not a wallet.
      await fx.sql`UPDATE core.subjects SET assurance_level = 'identity_bound' WHERE id = ${subjectId}`;
      expect((await bindWalletByProof(app, token, newAccount().account)).statusCode).toBe(200);
      const [subject] = await fx.sql<{ assurance_level: string }[]>`
        SELECT assurance_level::text FROM core.subjects WHERE id = ${subjectId}
      `;
      expect(subject!.assurance_level).toBe("identity_bound");
    });
  });

  /**
   * A key that someone else may hold is never bound again (0130): one disabled as compromised —
   * directly or as the reason for a replace — or by an admin. The history is read in every tenant,
   * and the refusal is the one code an address active elsewhere gets.
   */
  describe("a compromised or admin-disabled key is never bound again", () => {
    async function expectUnavailable(token: string, key: TestAccount) {
      const refused = await bindWalletByProof(app, token, key.account);
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json().code).toBe("WALLET_UNAVAILABLE");
    }

    it("disabled as compromised: refused to the same person, a new holder, and another tenant", async () => {
      const subjectId = await person();
      const key = newAccount();
      const old = (await bindWalletByProof(app, await totpSession(subjectId), key.account)).json();
      expect((await disable(await totpSession(subjectId), old.id, "key_compromised")).statusCode).toBe(200);

      await expectUnavailable(await totpSession(subjectId), key);
      await expectUnavailable(await totpSession(await person()), key);
      await expectUnavailable(await totpSession(await person(fx.tenantB), fx.tenantB), key);
      const rows = await fx.sql`SELECT 1 FROM core.wallet_identities WHERE wallet_address = ${key.address}`;
      expect(rows).toHaveLength(1);
    });

    it("replaced because it was compromised: the old key is refused, to the holder and anyone else", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const key = newAccount();
      expect((await bindWalletByProof(app, token, key.account)).statusCode).toBe(200);
      const next = await bindWalletByProof(app, token, newAccount().account, "key_compromised");
      expect(next.statusCode, next.body).toBe(200);
      // The replace kept sessions; the old key is out for good.
      expect(await sessionAlive(token)).toBe(true);

      // Back to the old key, after disabling the new one: still refused.
      expect((await disable(token, next.json().id, "rotation")).statusCode).toBe(200);
      await expectUnavailable(await totpSession(subjectId), key);
      await expectUnavailable(await totpSession(await person(fx.tenantB), fx.tenantB), key);
    });

    it("disabled by an admin: refused even to the same person; a key the holder retired comes back", async () => {
      const subjectId = await person();
      const key = newAccount();
      const bound = (await bindWalletByProof(app, await totpSession(subjectId), key.account)).json();
      const [row] = await fx.sql<{ version: number }[]>`
        SELECT version FROM core.wallet_identities WHERE id = ${bound.id}
      `;
      const admin = await app.inject({
        method: "POST",
        url: `/api/v1/admin/wallets/${bound.id}/disable`,
        headers: {
          authorization: `Bearer ${await signIn(app, fx.operatorA)}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${row!.version}"`,
        },
        payload: { reasonCode: "offboarding", detail: "left the organization" },
      });
      expect(admin.statusCode, admin.body).toBe(200);
      await expectUnavailable(await totpSession(subjectId), key);

      // Retired by its holder for rotation, a key may come back — in another tenant too.
      const retired = newAccount();
      const mine = (await bindWalletByProof(app, await totpSession(subjectId), retired.account)).json();
      expect((await disable(await totpSession(subjectId), mine.id, "rotation")).statusCode).toBe(200);
      const elsewhere = await bindWalletByProof(
        app,
        await totpSession(await person(fx.tenantB), fx.tenantB),
        retired.account,
      );
      expect(elsewhere.statusCode, elsewhere.body).toBe(200);
      const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
        SELECT detail FROM audit.events WHERE command = 'account.wallet.bound' AND resource_id = ${elsewhere.json().id}
      `;
      // The earlier row is found across tenants.
      expect(event!.detail).toMatchObject({ rebindOf: mine.id, rebindSameSubject: false });
    });

    it("the application role cannot record a system reason, so it cannot forge a replace", async () => {
      const subjectId = await person();
      const bound = (await bindWalletByProof(app, await totpSession(subjectId), newAccount().account)).json();
      const forge = (reason: string, cause: string | null, decider: string | null) =>
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
          INSERT INTO core.wallet_disable_events (
            id, tenant_id, wallet_identity_id, reason_code, replace_cause, detail, disabled_by_subject_id
          ) VALUES (${randomUUID()}, ${fx.tenantA}, ${bound.id}, ${reason}, ${cause}, 'forged', ${decider})
        `);
      await expect(forge("replaced", "rotation", subjectId)).rejects.toThrow(/WALLET_REASON_INVALID/);
      await expect(forge("consolidated_single_wallet", null, null)).rejects.toThrow(/WALLET_REASON_INVALID/);
      // A replace cause belongs to a replace only.
      await expect(forge("rotation", "rotation", subjectId)).rejects.toThrow(/wallet_disable_events_replace_cause/);
    });

    it("a lost key comes back only to its own subject; a retired one to anyone", async () => {
      // Disabled as lost: the same person binds it again, nobody else does — in any tenant.
      const loser = await person();
      const lost = newAccount();
      const lostRow = (await bindWalletByProof(app, await totpSession(loser), lost.account)).json();
      expect((await disable(await totpSession(loser), lostRow.id, "key_lost")).statusCode).toBe(200);
      await expectUnavailable(await totpSession(await person()), lost);
      await expectUnavailable(await totpSession(await person(fx.tenantB), fx.tenantB), lost);
      expect((await bindWalletByProof(app, await totpSession(loser), lost.account)).statusCode).toBe(200);

      // Replaced because it was lost: the same rule.
      const replacer = await person();
      const token = await totpSession(replacer);
      const gone = newAccount();
      expect((await bindWalletByProof(app, token, gone.account)).statusCode).toBe(200);
      expect((await bindWalletByProof(app, token, newAccount().account, "key_lost")).statusCode).toBe(200);
      await expectUnavailable(await totpSession(await person()), gone);
      expect((await bindWalletByProof(app, token, gone.account)).statusCode).toBe(200);

      // Retired for offboarding: handed on, anyone who proves it binds it.
      const leaver = await person();
      const handed = newAccount();
      const handedRow = (await bindWalletByProof(app, await totpSession(leaver), handed.account)).json();
      expect((await disable(await totpSession(leaver), handedRow.id, "offboarding")).statusCode).toBe(200);
      const taker = await bindWalletByProof(app, await totpSession(await person(fx.tenantB), fx.tenantB), handed.account);
      expect(taker.statusCode, taker.body).toBe(200);
    });

    /** A disabled row and its event written as earlier code or data left them. */
    async function history(key: TestAccount, subjectId: string | null, event: { reason: string; decider: string | null } | null) {
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.wallet_identities (
          id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, bound_via, disabled_at
        ) VALUES (
          ${id}, ${fx.tenantA}, ${subjectId}, ${key.address}, 31337, 'wallet_only', now() - interval '2 days',
          'operator', now() - interval '1 day'
        )
      `;
      if (event) {
        await fx.sql`
          INSERT INTO core.wallet_disable_events (
            id, tenant_id, wallet_identity_id, reason_code, detail, disabled_by_subject_id
          ) VALUES (${randomUUID()}, ${fx.tenantA}, ${id}, ${event.reason}, 'history', ${event.decider})
        `;
      }
    }

    it("unknowns refuse: consolidated, no event, or no subject — only the wallet's own subject re-binds", async () => {
      // Consolidated by 0130 (no decider): it came from its own subject.
      const owner = await person();
      const consolidated = newAccount();
      await history(consolidated, owner, { reason: "consolidated_single_wallet", decider: null });
      await expectUnavailable(await totpSession(await person()), consolidated);
      expect((await bindWalletByProof(app, await totpSession(owner), consolidated.account)).statusCode).toBe(200);

      // Disabled with no event recorded: the reason is unknown, so as lost.
      const silent = newAccount();
      const quiet = await person();
      await history(silent, quiet, null);
      await expectUnavailable(await totpSession(await person()), silent);
      expect((await bindWalletByProof(app, await totpSession(quiet), silent.account)).statusCode).toBe(200);

      // A row with no subject: nobody is "its own subject", and a decider is never it.
      const orphan = newAccount();
      await history(orphan, null, { reason: "rotation", decider: await person() });
      await expectUnavailable(await totpSession(await person()), orphan);
      const orphanSilent = newAccount();
      await history(orphanSilent, null, null);
      await expectUnavailable(await totpSession(await person()), orphanSilent);
    });

    it("fails loudly, never narrowed to one tenant, when the function's owner does not bypass RLS", async () => {
      const subjectId = await person();
      const token = await totpSession(subjectId);
      const key = newAccount();
      const challenge = await challengeFor(token, key);
      const sessionId = await sessionOf(subjectId);

      // An owner the way a managed database's admin can be: it holds the tables' owner's
      // privileges (FORCE RLS applies to it) but neither superuser nor BYPASSRLS. Rolled back.
      const attempt = fx.sql.begin(async (tx) => {
        const [row] = await tx<{ owner: string }[]>`
          SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc
          WHERE oid = 'core.bind_wallet_by_proof(uuid, uuid, text, uuid, text)'::regprocedure
        `;
        const owner = row!.owner;
        const role = `wallet_owner_nobypass_${randomUUID().slice(0, 8)}`;
        await tx`CREATE ROLE ${tx(role)} NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE ${tx(owner)}`;
        await tx`ALTER FUNCTION core.bind_wallet_by_proof(uuid, uuid, text, uuid, text) OWNER TO ${tx(role)}`;
        await tx`SELECT set_config('app.current_tenant', ${fx.tenantA}, true)`;
        await tx`
          SELECT * FROM core.bind_wallet_by_proof(${sessionId}, ${challenge.challengeId}, ${key.address}, ${randomUUID()}, 'rotation')
        `;
      });
      await expect(attempt).rejects.toThrow(/row-level security/);
      // Nothing was bound, and the function is the owner's again.
      expect(await activeWallets(subjectId)).toEqual([]);
      const bound = await submitBinding(app, token, {
        challengeId: challenge.challengeId,
        signature: await signBindingChallenge(key.account, challenge),
      });
      expect(bound.statusCode, bound.body).toBe(200);
    });
  });

  describe("history never changes", () => {
    it("refuses any update of a disabled row, for the owner and the application role", async () => {
      const subjectId = await person();
      const old = (await bindWalletByProof(app, await totpSession(subjectId), newAccount().account)).json();
      expect((await disable(await totpSession(subjectId), old.id)).statusCode).toBe(200);

      await expect(fx.sql`UPDATE core.wallet_identities SET disabled_at = NULL WHERE id = ${old.id}`).rejects.toThrow(
        /WALLET_HISTORY_FROZEN/,
      );
      await expect(
        fx.sql`UPDATE core.wallet_identities SET subject_id = ${await person()} WHERE id = ${old.id}`,
      ).rejects.toThrow(/WALLET_HISTORY_FROZEN/);
      // The application role keeps `UPDATE (disabled_at, version)` for the admin disable; it
      // cannot use it to bring a wallet back.
      await expect(
        withTenant(fx.appSql, { tenantId: fx.tenantA }, (tx) => tx`
          UPDATE core.wallet_identities SET disabled_at = NULL, version = version + 1 WHERE id = ${old.id}
        `),
      ).rejects.toThrow(/WALLET_HISTORY_FROZEN/);
    });

    it("the application role cannot insert, move, or re-address a wallet", async () => {
      const subjectId = await person();
      const bound = (await bindWalletByProof(app, await totpSession(subjectId), newAccount().account)).json();
      for (const statement of [
        (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => tx`
          INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at)
          VALUES (${randomUUID()}, ${fx.tenantA}, ${subjectId}, ${newAccount().address}, 31337, now())
        `,
        (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => tx`
          UPDATE core.wallet_identities SET subject_id = ${subjectId} WHERE id = ${bound.id}
        `,
        (tx: Parameters<Parameters<typeof withTenant>[2]>[0]) => tx`
          UPDATE core.wallet_identities SET wallet_address = ${newAccount().address} WHERE id = ${bound.id}
        `,
      ]) {
        await expect(withTenant(fx.appSql, { tenantId: fx.tenantA }, statement)).rejects.toThrow(/permission denied/);
      }
      expect(await activeWallets(subjectId)).toEqual([bound.walletAddress]);
    });
  });
});
