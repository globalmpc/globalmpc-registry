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

describeDb("SIWE 인증", () => {
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
    it("발급된다", async () => {
      const body = await nonce();
      expect(body.nonce.length).toBeGreaterThanOrEqual(8);
      expect(body.statement).toContain("자산 이동이나 승인을 발생시키지 않습니다");
    });

    it("매번 다른 값이다", async () => {
      const [a, b] = [await nonce(), await nonce()];
      expect(a.nonce).not.toBe(b.nonce);
    });

    it("잘못된 주소 형식을 거절한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: "not-an-address", chainId: 97 },
      });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("서명 검증", () => {
    it("정상 서명으로 세션이 만들어진다", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(200);

      const session = response.json();
      expect(session.walletAddress).toBe(account.address.toLowerCase());
      // 미등록 wallet이므로 wallet_only다. 서명만으로 역할이 생기지 않는다(OD-04).
      expect(session.assuranceLevel).toBe("wallet_only");
      expect(session.subjectId).toBeNull();
      expect(session.roleBindings).toEqual([]);
    });

    it("서명 검증 후 세션 토큰이 발급된다", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });

      const session = (await verify({ message: text, signature })).json();
      // 토큰은 wallet 주소가 아니다. 주소를 토큰으로 쓰면 아무나 위조할 수 있다.
      expect(session.sessionToken).toBeTruthy();
      expect(session.sessionToken).not.toBe(account.address.toLowerCase());
      expect(session.verifiedWalletAddress).toBe(account.address.toLowerCase());
    });

    it("토큰 원문을 DB에 저장하지 않는다", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });
      const session = (await verify({ message: text, signature })).json();

      const rows = await fx.sql`
        SELECT token_hash FROM core.sessions WHERE token_hash = ${session.sessionToken}
      `;
      // 저장된 것은 해시다. 원문으로는 찾을 수 없다.
      expect(rows).toHaveLength(0);
    });

    it("로그아웃하면 토큰이 무효가 된다", async () => {
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

    it("위조 토큰은 인증되지 않는다", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/api/v1/auth/session",
        headers: { authorization: "Bearer forged-token-value" },
      });
      expect(response.json().authenticated).toBe(false);
    });

    it("등록된 wallet은 역할과 tenant를 받는다", async () => {
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

    it("위조 서명을 거절한다", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });

      const response = await verify({ message: text, signature: `0x${"00".repeat(65)}` });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_SIGNATURE_INVALID");
    });

    it("다른 키로 서명하면 거절한다", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await other.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_SIGNATURE_INVALID");
    });

    it("nonce를 두 번 쓸 수 없다", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement });
      const signature = await account.signMessage({ message: text });

      expect((await verify({ message: text, signature })).statusCode).toBe(200);

      const replay = await verify({ message: text, signature });
      expect(replay.statusCode).toBe(401);
      expect(replay.json().code).toBe("SIWE_NONCE_ALREADY_USED");
    });

    it("발급받지 않은 nonce를 거절한다", async () => {
      const text = message({ nonce: "neverissuednonce123", statement: "s" });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_NONCE_ALREADY_USED");
    });

    it("다른 도메인의 메시지를 거절한다 — 피싱 방어", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement, domain: "evil.example", uri: "http://evil.example" });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_DOMAIN_MISMATCH");
    });

    it("다른 uri의 메시지를 거절한다", async () => {
      /**
       * domain만 보면 같은 호스트의 다른 출처로 유도된 서명이 통과한다.
       * 지갑이 보여 준 대상과 서버가 인정하는 대상이 같아야 한다.
       */
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement, uri: "http://localhost:3000/other" });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_URI_MISMATCH");
    });

    it("아직 유효하지 않은 메시지를 거절한다", async () => {
      // 서명자가 notBefore로 "이 시점 전에는 쓰지 말라"고 밝힌 것을 지킨다.
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

    it("nonce 응답이 서명 대상 uri를 알려 준다", async () => {
      const body = (await nonce()) as unknown as { uri: string };
      expect(body.uri).toBe("http://localhost:3000");
    });

    /**
     * 서명할 체인도 서버가 알려 준다.
     *
     * 웹이 97을 박아 두었고 stg·prod는 56이다. 서버는 체인이 다르면 거절하므로 그
     * 환경에서 실지갑 로그인이 0건 성공했다. 기준을 서버 설정 하나로 모은다.
     */
    it("nonce 응답이 서명할 chain ID를 알려 준다", async () => {
      const body = (await nonce()) as unknown as { chainId: number };
      expect(body.chainId).toBe(loadConfig(testEnv()).chainId);
    });

    it("클라이언트가 보낸 chain ID가 아니라 서버 설정으로 발급한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: account.address.toLowerCase(), chainId: 1 },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().chainId).toBe(loadConfig(testEnv()).chainId);
    });

    it("chain ID 없이도 nonce를 받는다", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/auth/siwe/nonce",
        payload: { walletAddress: account.address.toLowerCase() },
      });
      expect(response.statusCode).toBe(200);
    });

    it("다른 chain ID의 메시지를 거절한다", async () => {
      const { nonce: value, statement } = await nonce();
      const text = message({ nonce: value, statement, chainId: 1 });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_CHAIN_MISMATCH");
    });

    it("만료된 메시지를 거절한다", async () => {
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

    it("SIWE 형식이 아닌 문자열을 거절한다", async () => {
      const response = await verify({ message: "hello", signature: `0x${"11".repeat(65)}` });
      expect(response.statusCode).toBe(401);
    });

    it("다른 주소의 nonce로 서명하면 거절한다", async () => {
      const issued = await nonce(other.address);
      const text = message({ nonce: issued.nonce, statement: issued.statement });
      const signature = await account.signMessage({ message: text });

      const response = await verify({ message: text, signature });
      expect(response.statusCode).toBe(401);
      expect(response.json().code).toBe("SIWE_NONCE_ALREADY_USED");
    });
  });

  describe("세션 조회", () => {
    it("인증 없이 조회하면 authenticated=false다", async () => {
      const response = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
      expect(response.statusCode).toBe(200);
      expect(response.json().authenticated).toBe(false);
    });
  });
});

describeDb("인증 우회 방어 (R1)", () => {
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

  it("wallet 주소를 헤더에 넣어도 인증되지 않는다", async () => {
    // R0의 개발용 경로는 제거됐다. 주소는 토큰으로 취급되어 조회에 실패한다.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${fx.operatorA.address}` },
    });
    expect(response.statusCode).toBe(401);
  });

  /**
   * production 설정.
   *
   * `OBJECT_STORE=memory`는 production에서 거절된다 — 증빙 원문이 재시작마다
   * 사라지기 때문이다. 여기서 확인하려는 것은 인증 경로이므로 저장소는 유효한
   * 값으로 채운다. 클라이언트만 만들고 네트워크는 쓰지 않는다.
   */
  const productionEnv = () =>
    testEnv({
      NODE_ENV: "production",
      OBJECT_STORE: "s3",
      OBJECT_BUCKET: "test-bucket",
      OBJECT_REGION: "us-east-1",
    });

  it("production에서도 정상 기동한다 — 위험한 스위치가 없다", async () => {
    const app2 = await buildServer(loadConfig(productionEnv()), fx.appSql);
    expect(app2).toBeTruthy();
    await app2.close();
  });

  it("production에서 발급된 토큰은 정상 동작한다", async () => {
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
