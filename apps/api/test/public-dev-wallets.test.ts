import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mnemonicToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { ANVIL_DEV_ADDRESSES, COMMITTED_FIXTURE_ADDRESSES } from "@mpc/config";
import { bootstrapOperator, BootstrapError } from "../src/bootstrap.js";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { issueSessionToken } from "../src/plugins/session-token.js";
import { bearer, idempotencyKey, newAccount, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const MNEMONIC = "test test test test test test test test test test test junk";
/** anvil/hardhat account 0 — its key is printed by every local node. */
const anvil0 = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });
/** Account 9, used where a test binds on the local chain, so it does not collide with others. */
const anvil9 = mnemonicToAccount(MNEMONIC, { addressIndex: 9 });

/**
 * Public development wallets on a shared chain.
 *
 * Anyone can sign as an anvil/hardhat account or a key committed to this repository. Bound on
 * 5611, its role belongs to whoever tries the key first. Bootstrap and the admin bind refuse to
 * create such a binding off the local chain, and sign-in refuses one that already exists. On
 * the local chain all three still work — local development depends on them.
 */
describeDb("public development wallets off the local chain", () => {
  let fx: TestFixture;
  let local: FastifyInstance;
  let testnet: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    local = await buildServer(loadConfig(testEnv({ CHAIN_ID: "31337" })), fx.appSql);
    testnet = await buildServer(loadConfig(testEnv({ CHAIN_ID: "5611" })), fx.appSql);
  });

  afterAll(async () => {
    await local.close();
    await testnet.close();
    await fx.close();
  });

  describe("bootstrap", () => {
    const input = (walletAddress: string, chainId: number) => {
      const suffix = randomUUID().slice(0, 8);
      return {
        tenantSlug: `devkey-${suffix}`,
        tenantName: `Dev key ${suffix}`,
        organizationName: `Dev key org ${suffix}`,
        jurisdiction: "MNG",
        subjectName: "First Operator",
        walletAddress,
        chainId,
        role: "mpc_operator",
        assuranceLevel: "high_assurance" as const,
      };
    };

    it("refuses a public development wallet on 5611, creating nothing", async () => {
      for (const address of [anvil0.address, ...COMMITTED_FIXTURE_ADDRESSES]) {
        const attempt = input(address, 5611);
        await expect(bootstrapOperator(fx.sql, attempt), address).rejects.toThrow(BootstrapError);
        await expect(bootstrapOperator(fx.sql, attempt), address).rejects.toThrow(/public development address/);
        // Validation runs before anything is written; a half-created tenant would need cleanup.
        const [tenant] = await fx.sql`SELECT 1 FROM core.tenants WHERE slug = ${attempt.tenantSlug}`;
        expect(tenant, address).toBeUndefined();
      }
    });

    it("accepts one on the local chain", async () => {
      // Earlier runs of this file share the database; the address may already be bound here.
      await fx.sql`
        DELETE FROM core.wallet_identities WHERE wallet_address = ${anvil9.address.toLowerCase()} AND chain_id = 31337`;
      await expect(bootstrapOperator(fx.sql, input(anvil9.address, 31337))).resolves.toMatchObject({
        created: true,
      });
    });
  });

  describe("admin wallet bind", () => {
    let operator: string;

    beforeAll(async () => {
      operator = await signIn(local, fx.operatorA);
    });

    async function bind(walletAddress: string, chainId: number) {
      const subject = await local.inject({
        method: "POST",
        url: "/api/v1/admin/subjects",
        headers: { ...bearer(operator), "idempotency-key": idempotencyKey() },
        payload: { displayName: `Dev key subject ${randomUUID().slice(0, 8)}` },
      });
      expect(subject.statusCode).toBe(200);
      return local.inject({
        method: "POST",
        url: `/api/v1/admin/subjects/${(subject.json() as { id: string }).id}/wallets`,
        headers: { ...bearer(operator), "idempotency-key": idempotencyKey() },
        payload: { walletAddress, chainId, assuranceLevel: "wallet_only", justification: "checked in person" },
      });
    }

    it("refuses a public development address on 5611", async () => {
      for (const address of [anvil0.address.toLowerCase(), ANVIL_DEV_ADDRESSES[3]!, ...COMMITTED_FIXTURE_ADDRESSES]) {
        const response = await bind(address, 5611);
        expect(response.statusCode, address).toBe(422);
        expect(response.json(), address).toMatchObject({ code: "WALLET_PUBLIC_DEV_ADDRESS" });
      }
    });

    it("accepts a freshly generated address on 5611", async () => {
      expect((await bind(newAccount().address, 5611)).statusCode).toBe(200);
    });
  });

  describe("sign-in", () => {
    async function siwe(app: FastifyInstance, chainId: number) {
      const nonce = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: anvil0.address.toLowerCase(), chainId },
      });
      expect(nonce.statusCode).toBe(200);
      const { nonce: value, statement, uri } = nonce.json() as { nonce: string; statement: string; uri: string };
      const message = createSiweMessage({
        address: anvil0.address,
        chainId,
        domain: "localhost:3000",
        nonce: value,
        statement,
        uri,
        version: "1",
        issuedAt: new Date(),
      });
      return app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/verify",
        payload: { message, signature: await anvil0.signMessage({ message }) },
      });
    }

    it("refuses a public development wallet against a 5611 API, even one already bound there", async () => {
      // A binding made before bootstrap and the admin bind refused it.
      const tenant = fx.tenantA;
      await fx.sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at)
        VALUES (${randomUUID()}, ${tenant}, ${fx.operatorSubjectA}, ${anvil0.address.toLowerCase()}, 5611, 'high_assurance', now())
        ON CONFLICT (wallet_address, chain_id) DO NOTHING`;
      try {
        const response = await siwe(testnet, 5611);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ code: "WALLET_PUBLIC_DEV_ADDRESS" });
        expect(JSON.stringify(response.json())).not.toContain("token");
      } finally {
        await fx.sql`
          DELETE FROM core.wallet_identities WHERE wallet_address = ${anvil0.address.toLowerCase()} AND chain_id = 5611`;
      }
    });

    it("refuses a session token already issued to one on 5611", async () => {
      const { token } = await issueSessionToken(fx.sql, anvil0.address.toLowerCase(), 5611);
      const response = await testnet.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "WALLET_PUBLIC_DEV_ADDRESS" });
    });

    it("accepts it against a local-chain API", async () => {
      expect((await siwe(local, 31337)).statusCode).toBe(200);
    });
  });

  /**
   * A session token is valid only on the chain it was issued for.
   *
   * The token row records the chain the SIWE message was signed for. Both APIs can share one
   * database, so a token issued by a local-chain API reaches a 5611 API. Resolved on its own
   * chain there, a local-chain token would carry its local roles — and a public development
   * wallet, allowed on the local chain, would pass the refusal above.
   */
  describe("session token chain", () => {
    /** anvil/hardhat account 5, bound on the local chain only by this block. */
    const anvil5 = mnemonicToAccount(MNEMONIC, { addressIndex: 5 }).address.toLowerCase();

    const createSubject = (app: FastifyInstance, token: string) =>
      app.inject({
        method: "POST",
        url: "/api/v1/admin/subjects",
        headers: { ...bearer(token), "idempotency-key": idempotencyKey() },
        payload: { displayName: `Chain probe ${randomUUID().slice(0, 8)}` },
      });

    beforeAll(async () => {
      // An operator binding for a public dev wallet on the local chain, as on a dev deployment.
      await fx.sql`
        DELETE FROM core.wallet_identities WHERE wallet_address = ${anvil5} AND chain_id = 31337`;
      await fx.sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${fx.operatorSubjectA}, ${anvil5}, 31337, 'high_assurance', now())`;
    });

    afterAll(async () => {
      await fx.sql`
        DELETE FROM core.wallet_identities WHERE wallet_address = ${anvil5} AND chain_id = 31337`;
    });

    it("refuses a local-chain token for a public dev wallet on a 5611 API write route", async () => {
      const { token } = await issueSessionToken(fx.sql, anvil5, 31337);
      const response = await createSubject(testnet, token);
      expect(response.statusCode).toBe(401);
      const session = await testnet.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
      expect(session.json()).toMatchObject({ authenticated: false });
    });

    it("gives a non-dev wallet's local-chain token no roles on a 5611 API", async () => {
      const { token } = await issueSessionToken(fx.sql, fx.operatorA.address.toLowerCase(), 31337);
      expect((await createSubject(testnet, token)).statusCode).toBe(401);
      const session = await testnet.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
      expect(session.statusCode).toBe(200);
      expect(session.json()).toMatchObject({ authenticated: false });
    });

    it("keeps both tokens working on the chain they were issued for", async () => {
      for (const wallet of [anvil5, fx.operatorA.address.toLowerCase()]) {
        const { token } = await issueSessionToken(fx.sql, wallet, 31337);
        expect((await createSubject(local, token)).statusCode, wallet).toBe(200);
        const session = await local.inject({ method: "GET", url: "/api/v1/auth/session", headers: bearer(token) });
        expect(session.json(), wallet).toMatchObject({ authenticated: true, chainId: 31337 });
      }
    });

    it("lets logout revoke a token issued for another chain", async () => {
      const { token } = await issueSessionToken(fx.sql, fx.operatorA.address.toLowerCase(), 31337);
      const logout = await testnet.inject({ method: "POST", url: "/api/v1/auth/logout", headers: bearer(token) });
      expect(logout.statusCode).toBe(200);
      expect(logout.json()).toMatchObject({ revoked: true });
      expect((await createSubject(local, token)).statusCode).toBe(401);
    });
  });
});
