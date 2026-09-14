import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { createSiweMessage } from "viem/siwe";
import { privateKeyToAccount } from "viem/accounts";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const other = privateKeyToAccount(`0x${"22".repeat(32)}`);

describeDb("SIWE authentication", () => {
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

  async function nonce(address = account.address) {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/auth/siwe/nonce",
      payload: { walletAddress: address.toLowerCase(), chainId: 97 },
    });
    return response.json() as { nonce: string; statement: string; expiresAt: string };
  }

  function message(overrides: Partial<Parameters<typeof createSiweMessage>[0]> = {}) {
    return createSiweMessage({
      address: account.address,
      chainId: 97,
      domain: "localhost:3000",
      nonce: "placeholder",
      statement: "s",
      uri: "http://localhost:3000",
      version: "1",
      issuedAt: new Date(),
      ...overrides,
    } as Parameters<typeof createSiweMessage>[0]);
  }

  function verify(payload: { message: string; signature: string }) {
    return app.inject({ method: "POST", url: "/api/v1/auth/siwe/verify", payload });
  }

  describe("nonce", () => {
    it("is issued", async () => {
      const body = await nonce();
      expect(body.nonce.length).toBeGreaterThanOrEqual(8);
      expect(body.statement).toContain("does not move assets or grant any approval");
    });

    it("differs every time", async () => {
      const [a, b] = [await nonce(), await nonce()];
      expect(a.nonce).not.toBe(b.nonce);
    });

    it("rejects a malformed address", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: "not-an-address", chainId: 97 },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("signature verification", () => {
    it("creates a session from a valid signature", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(200);

      const session = response.json();
      expect(session.walletAddress).toBe(account.address.toLowerCase());
      // The wallet is unregistered, so wallet_only. A signature alone grants no role (OD-04).
      expect(session.assuranceLevel).toBe("wallet_only");
      expect(session.subjectId).toBeNull();
      expect(session.roleBindings).toEqual([]);
    });

    it("issues a session token after signature verification", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });

      const session = (await verify({ message: text, signature })).json();
      // The token is not the wallet address. Using the address as a token lets anyone forge it.
      expect(session.sessionToken).toBeTruthy();
      expect(session.sessionToken).not.toBe(account.address.toLowerCase());
      expect(session.verifiedWalletAddress).toBe(account.address.toLowerCase());
    });

    it("does not store the raw token in the DB", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });
      const session = (await verify({ message: text, signature })).json();

      const rows = await fx.sql`
        SELECT token_hash FROM core.sessions WHERE token_hash = ${session.sessionToken}
      `;
      // What is stored is a hash. The raw token finds nothing.
      expect(rows).toHaveLength(0);
    });

    it("invalidates the token on logout", async () => {
      const token = await signIn(app, fx.operatorA);

      const before = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(before.json().authenticated).toBe(true);

      await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: { authorization: `Bearer ${token}` },
      });

      const after = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.json().authenticated).toBe(false);
    });

    it("does not authenticate a forged token", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { authorization: "Bearer forged-token-value" },
      });
      expect(response.json().authenticated).toBe(false);
    });

    it("gives a registered wallet its roles and tenant", async () => {
      const token = await signIn(app, fx.operatorA);
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { authorization: `Bearer ${token}` },
      });
      const session = response.json();
      expect(session.authenticated).toBe(true);
      expect(session.tenantId).toBe(fx.tenantA);
      expect(session.assuranceLevel).toBe("high_assurance");
      expect(session.roleBindings.map((b: { role: string }) => b.role)).toContain("mpc_operator");
    });

    it("rejects a forged signature", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });

      const response = await verify({ message: text, signature: `0x${"00".repeat(65)}` });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_SIGNATURE_INVALID");
    });

    it("rejects a signature from a different key", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await other.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_SIGNATURE_INVALID");
    });

    it("does not allow a nonce to be used twice", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });

      expect((await verify({ message: text, signature })).statusCode).toBe(200);

      const replay = await verify({ message: text, signature });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().code).toBe("SIWE_NONCE_ALREADY_USED");
    });

    it("rejects a nonce that was never issued", async () => {
      const text = message({ nonce: "neverissuednonce123", statement: "s" });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_NONCE_ALREADY_USED");
    });

    it("rejects a message for another domain — phishing defense", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement, domain: "evil.example", uri: "http://evil.example" });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_DOMAIN_MISMATCH");
    });

    it("rejects a message for another uri", async () => {
      /**
       * Checking only the domain lets through a signature steered to another origin on the
       * same host. What the wallet showed and what the server accepts must be the same target.
       */
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement, uri: "http://localhost:3000/other" });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_URI_MISMATCH");
    });

    it("rejects a message that is not yet valid", async () => {
      // Honors the signer's notBefore statement: "do not use before this time".
      const { nonce: value, statement } = await nonce();
      const text = message({
        nonce: value,
        statement,
        notBefore: new Date(Date.now() + 60 * 60 * 1000),
      });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_MESSAGE_NOT_YET_VALID");
    });

    it("returns the uri to sign in the nonce response", async () => {
      const body = (await nonce()) as unknown as { uri: string };
      expect(body.uri).toBe("http://localhost:3000");
    });

    /**
     * The server also states which chain to sign for.
     *
     * The web app hard-coded 97 while stg and prod use 56. The server rejects a different
     * chain, so real-wallet sign-in succeeded 0 times in those environments. The source of
     * truth is consolidated into a single server setting.
     */
    it("returns the chain ID to sign in the nonce response", async () => {
      const body = (await nonce()) as unknown as { chainId: number };
      expect(body.chainId).toBe(loadConfig(testEnv()).chainId);
    });

    it("issues from the server setting, not the client-sent chain ID", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: account.address.toLowerCase(), chainId: 1 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().chainId).toBe(loadConfig(testEnv()).chainId);
    });

    it("issues a nonce without a chain ID", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: account.address.toLowerCase() },
      });
      expect(response.statusCode).toBe(200);
    });

    it("rejects a message for another chain ID", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement, chainId: 1 });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_CHAIN_MISMATCH");
    });

    it("rejects an expired message", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({
        nonce: value,
        statement,
        issuedAt: new Date(Date.now() - 7200_000),
        expirationTime: new Date(Date.now() - 3600_000),
      });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_MESSAGE_EXPIRED");
    });

    it("rejects a string that is not SIWE format", async () => {
      const response = await verify({ message: "hello", signature: `0x${"11".repeat(65)}` });
      expect(response.statusCode).toBe(401);
    });

    it("rejects a signature over another address's nonce", async () => {
      const issued = await nonce(other.address);
      const text = message({ nonce: issued.nonce, statement: issued.statement });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_NONCE_ALREADY_USED");
    });
  });

  describe("session lookup", () => {
    it("returns authenticated=false without authentication", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
      expect(response.statusCode).toBe(200);
      expect(response.json().authenticated).toBe(false);
    });
  });
});

describeDb("authentication bypass defense (R1)", () => {
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

  it("does not authenticate a wallet address placed in the header", async () => {
    // The R0 development path was removed. The address is treated as a token and the lookup fails.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${fx.operatorA.address}` },
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * Production configuration.
   *
   * `OBJECT_STORE=memory` is rejected in production — raw evidence would vanish on every
   * restart. What this checks is the authentication path, so the store is filled with valid
   * values. Only the client is created; no network is used.
   */
  const productionEnv = () =>
    testEnv({
      NODE_ENV: "production",
      OBJECT_STORE: "s3",
      OBJECT_BUCKET: "test-bucket",
      OBJECT_REGION: "us-east-1",
    });

  it("starts normally in production — no dangerous switch exists", async () => {
    const app2 = await buildServer(loadConfig(productionEnv()), fx.appSql);
    expect(app2).toBeTruthy();
    await app2.close();
  });

  it("accepts tokens issued in production", async () => {
    const app2 = await buildServer(loadConfig(productionEnv()), fx.appSql);
    const token = await signIn(app2, fx.operatorA);
    const response = await app2.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.json().authenticated).toBe(true);
    await app2.close();
  });
});
