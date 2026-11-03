import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { mnemonicToAccount } from "viem/accounts";
import { ANVIL_DEV_ADDRESSES, COMMITTED_FIXTURE_ADDRESSES } from "@mpc/config";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { issueTestSession, newAccount, setupFixture, testEnv, type TestFixture } from "./helpers/db.js";
import { bindWalletByProof, requestBindingChallenge } from "./helpers/wallets.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const MNEMONIC = "test test test test test test test test test test test junk";
/** anvil/hardhat account 0 — its key is printed by every local node. */
const anvil0 = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });

/**
 * Public development wallets on a shared chain.
 *
 * Anyone can sign as an anvil/hardhat account or a key committed to this repository, so on 5611
 * such a key bound to a person would sign attestations and gate decisions for whoever tries it
 * first. Binding refuses one off the local chain. (Sign-in and bootstrap refused it too; both
 * are gone for wallets — no wallet signs anyone in and bootstrap binds none, WP7.)
 */
describeDb("public development wallets off the local chain", () => {
  let fx: TestFixture;
  let testnet: FastifyInstance;

  beforeAll(async () => {
    fx = await setupFixture();
    testnet = await buildServer(loadConfig(testEnv({ CHAIN_ID: "5611" })), fx.appSql);
  });

  afterAll(async () => {
    await testnet.close();
    await fx.close();
  });

  describe("wallet binding", () => {
    let account: string;

    beforeAll(async () => {
      // An account session: binding is the holder's own act (WP5), from an MFA session.
      account = await issueTestSession(fx.appSql, fx.tenantA, fx.stewardSubjectA, {
        firstFactor: "email_code",
        secondFactor: "totp",
      });
    });

    it("refuses a binding challenge for a public development address on 5611", async () => {
      for (const address of [anvil0.address.toLowerCase(), ANVIL_DEV_ADDRESSES[3]!, ...COMMITTED_FIXTURE_ADDRESSES]) {
        const response = await requestBindingChallenge(testnet, account, address);
        expect(response.statusCode, address).toBe(422);
        expect(response.json(), address).toMatchObject({ code: "WALLET_PUBLIC_DEV_ADDRESS" });
      }
    });

    it("binds a freshly generated address on 5611", async () => {
      const fresh = newAccount();
      const response = await bindWalletByProof(testnet, account, fresh.account);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ walletAddress: fresh.address, chainId: 5611, boundVia: "proof" });
    });
  });
});
