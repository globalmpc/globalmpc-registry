import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const VALID = {
  PORT: "3001",
  DATABASE_URL: "postgres://postgres@localhost:5432/mpc_test",
  SIWE_DOMAIN: "localhost:3000",
  SIWE_URI: "http://localhost:3000",
  CHAIN_ID: "97",
  SESSION_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("유효한 환경변수를 파싱한다", () => {
    const config = loadConfig(VALID);
    expect(config.port).toBe(3001);
    expect(config.chainId).toBe(97);
    expect(config.siweDomain).toBe("localhost:3000");
  });

  /**
   * 배포 플랫폼은 선언된 변수를 값이 없어도 빈 문자열로 넣는다. Coolify는 compose에서
   * 뽑은 변수 목록을 모든 컨테이너에 주입하므로, anchor worker용으로 비워 둔
   * `CHAIN_RPC_URL`이 API에도 `""`로 들어와 API가 시작 직후 죽었다.
   */
  it("빈 문자열로 들어온 선택 변수를 주지 않은 것으로 읽는다", () => {
    const config = loadConfig({
      ...VALID,
      CHAIN_RPC_URL: "",
      GOVERNANCE_TOKEN_ADDRESS: "",
      OBJECT_ENDPOINT: "",
      OBJECT_PUBLIC_ENDPOINT: "",
      OBJECT_KMS_KEY_ID: "",
      OBJECT_ACCESS_KEY_ID: "",
      OBJECT_SECRET_ACCESS_KEY: "",
    });

    expect(config.chainRpcUrl).toBeNull();
    expect(config.governanceTokenAddress).toBeNull();
    expect(config.objectStore.endpoint).toBeUndefined();
    expect(config.objectStore.credentials).toBeUndefined();
  });

  it("빈 문자열로 들어온 필수 변수는 누락으로 보고한다", () => {
    expect(() => loadConfig({ ...VALID, SIWE_URI: "" })).toThrowError(/SIWE_URI/);
  });

  it("필수 환경변수가 없으면 시작 시 실패한다", () => {
    const { DATABASE_URL, ...missing } = VALID;
    expect(() => loadConfig(missing)).toThrowError(ConfigError);
    expect(() => loadConfig(missing)).toThrowError(/DATABASE_URL/);
  });

  it("짧은 session secret을 거절한다", () => {
    expect(() => loadConfig({ ...VALID, SESSION_SECRET: "short" })).toThrowError(
      /SESSION_SECRET/,
    );
  });

  it("BSC mainnet·testnet 외의 chain ID를 거절한다", () => {
    expect(() => loadConfig({ ...VALID, CHAIN_ID: "1" })).toThrowError(/CHAIN_ID/);
    expect(loadConfig({ ...VALID, CHAIN_ID: "56" }).chainId).toBe(56);
    expect(loadConfig({ ...VALID, CHAIN_ID: "97" }).chainId).toBe(97);
  });

  /**
   * 요청자 판정에 쓰는 홉 수 — 값이 조용히 0이 되면 안 된다.
   *
   * 0은 "헤더를 믿지 않는다"이므로 프록시 뒤에서는 상한이 다시 사이트 전체
   * 합산이 된다. 그 상태는 오류 없이 동작하므로 배포에서 눈에 띄지 않는다.
   * 배포 플랫폼이 넣는 빈 문자열이 0으로 강제되지 않는다는 것을 고정한다.
   */
  /**
   * 시간 상한.
   *
   * Fastify는 둘 다 끈 채로 만든다. 실측에서 `requestTimeout`도 `server.timeout`도
   * 0이었다. 값이 있다는 것과 **끌 수 없다는 것**을 함께 고정한다 — 0을 허용하면
   * "잠깐 꺼 두자"가 영구가 된다.
   */
  describe("시간 상한", () => {
    it("주지 않아도 값이 있다", () => {
      const config = loadConfig(VALID);
      expect(config.requestTimeoutMs).toBe(300_000);
      expect(config.socketIdleTimeoutMs).toBe(60_000);
    });

    it("배포에서 낮출 수 있다", () => {
      const config = loadConfig({
        ...VALID,
        REQUEST_TIMEOUT_MS: "45000",
        SOCKET_IDLE_TIMEOUT_MS: "15000",
      });
      expect(config.requestTimeoutMs).toBe(45_000);
      expect(config.socketIdleTimeoutMs).toBe(15_000);
    });

    it("0으로 끌 수 없다", () => {
      expect(() => loadConfig({ ...VALID, REQUEST_TIMEOUT_MS: "0" })).toThrowError(
        /REQUEST_TIMEOUT_MS/,
      );
      expect(() => loadConfig({ ...VALID, SOCKET_IDLE_TIMEOUT_MS: "0" })).toThrowError(
        /SOCKET_IDLE_TIMEOUT_MS/,
      );
    });

    it("빈 문자열은 0이 아니라 기본값으로 읽는다", () => {
      const config = loadConfig({
        ...VALID,
        REQUEST_TIMEOUT_MS: "",
        SOCKET_IDLE_TIMEOUT_MS: "",
      });
      expect(config.requestTimeoutMs).toBe(300_000);
      expect(config.socketIdleTimeoutMs).toBe(60_000);
    });
  });

  describe("TRUSTED_PROXY_HOPS", () => {
    it("주지 않으면 1이다 — 프록시 하나(Coolify) 뒤라는 전제", () => {
      expect(loadConfig(VALID).trustedProxyHops).toBe(1);
    });

    it("빈 문자열은 0이 아니라 기본값으로 읽는다", () => {
      expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "" }).trustedProxyHops).toBe(1);
    });

    it("앞단 프록시가 늘면 올릴 수 있다", () => {
      expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "2" }).trustedProxyHops).toBe(2);
    });

    it("0은 명시했을 때만 — 헤더를 아예 믿지 않는다", () => {
      expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops).toBe(0);
    });

    it("음수·정수가 아닌 값을 거절한다", () => {
      expect(() => loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "-1" })).toThrowError(
        /TRUSTED_PROXY_HOPS/,
      );
      expect(() => loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "1.5" })).toThrowError(
        /TRUSTED_PROXY_HOPS/,
      );
      expect(() => loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "many" })).toThrowError(
        /TRUSTED_PROXY_HOPS/,
      );
    });
  });

  it("오류 메시지에 secret 값을 넣지 않는다", () => {
    try {
      loadConfig({ ...VALID, PORT: "not-a-number" });
      expect.unreachable();
    } catch (error) {
      const text = String(error);
      expect(text).not.toContain(VALID.SESSION_SECRET);
      expect(text).not.toContain(VALID.DATABASE_URL);
    }
  });
});

describe("R1: 개발용 인증 스위치가 제거됐다", () => {
  it("설정에 allowInsecureDevAuth가 없다", () => {
    // wallet 주소를 헤더에 넣어 인증하던 경로는 R1에서 세션 토큰으로 대체됐다.
    // 설정 자체가 사라졌으므로 실수로 켤 수 없다.
    expect(loadConfig(VALID)).not.toHaveProperty("allowInsecureDevAuth");
  });

  it("남아 있는 환경변수는 무시된다", () => {
    // 옛 배포 설정에 값이 남아 있어도 기동을 막지 않는다. 다만 아무 효과도 없다.
    expect(() => loadConfig({ ...VALID, ALLOW_INSECURE_DEV_AUTH: "true" })).not.toThrow();
  });

  it("NODE_ENV 기본값은 development다", () => {
    expect(loadConfig(VALID).nodeEnv).toBe("development");
  });

  it("알 수 없는 NODE_ENV를 거절한다", () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: "staging" })).toThrowError(ConfigError);
  });

  describe("시크릿 참조", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/x",
      SIWE_DOMAIN: "localhost:3000",
      SIWE_URI: "http://localhost:3000",
      CHAIN_ID: "97",
      SESSION_SECRET: "s".repeat(32),
    };

    it("값 그대로도 계속 받는다", () => {
      // 로컬 개발까지 vault를 요구하면 아무도 돌려보지 못한다.
      const config = loadConfig(base as NodeJS.ProcessEnv);
      expect(config.sessionSecret).toBe("s".repeat(32));
      expect(config.secretAudit.find((s) => s.variableName === "SESSION_SECRET")?.scheme).toBe(
        "inline",
      );
    });

    it("다른 환경변수를 가리킬 수 있다", () => {
      const config = loadConfig({
        ...base,
        SESSION_SECRET: "env:PLATFORM_SESSION_SECRET",
        PLATFORM_SESSION_SECRET: "p".repeat(32),
      } as NodeJS.ProcessEnv);

      expect(config.sessionSecret).toBe("p".repeat(32));
      expect(config.secretAudit.find((s) => s.variableName === "SESSION_SECRET")?.scheme).toBe(
        "env",
      );
    });

    it("DATABASE_URL의 콜론을 scheme으로 오인하지 않는다", () => {
      // `postgres://user:pass@host`가 잘리면 연결 문자열이 통째로 깨진다.
      const config = loadConfig({
        ...base,
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
      } as NodeJS.ProcessEnv);
      expect(config.databaseUrl).toBe("postgres://u:p@localhost:5432/db");
    });

    it("감사 기록에 값이 들어가지 않는다", () => {
      const secret = "s".repeat(32);
      const config = loadConfig(base as NodeJS.ProcessEnv);

      // 운영에서 "어떤 키를 쓰고 있나"는 지문으로 답한다. 값으로 답하면 로그가
      // 유출 경로가 된다.
      const serialized = JSON.stringify(config.secretAudit);
      expect(serialized).not.toContain(secret);
      expect(config.secretAudit.every((entry) => entry.fingerprint.length === 12)).toBe(true);
    });

    it("가리킨 환경변수가 비면 시작하지 않는다", () => {
      expect(() =>
        loadConfig({ ...base, SESSION_SECRET: "env:MISSING" } as NodeJS.ProcessEnv),
      ).toThrow();
    });
  });

  describe("객체 저장 (OD-17·OD-22)", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/x",
      SIWE_DOMAIN: "localhost:3000",
      SIWE_URI: "http://localhost:3000",
      CHAIN_ID: "97",
      SESSION_SECRET: "s".repeat(32),
    };

    it("기본은 메모리 저장소다", () => {
      expect(loadConfig(base as NodeJS.ProcessEnv).objectStore.kind).toBe("memory");
    });

    it("production에서 메모리 저장소를 거절한다", () => {
      // 증빙 원문이 재시작마다 사라지는데 그 사실이 아무 데도 드러나지 않는다.
      expect(() =>
        loadConfig({ ...base, NODE_ENV: "production" } as NodeJS.ProcessEnv),
      ).toThrow(/OBJECT_STORE=memory/);
    });

    it("s3에는 리전을 반드시 요구한다", () => {
      // 기본 리전을 두면 아무도 결정하지 않은 채 어딘가에 저장된다. OD-17을
      // 코드로 강제하는 지점이다.
      expect(() =>
        loadConfig({ ...base, OBJECT_STORE: "s3", OBJECT_BUCKET: "b" } as NodeJS.ProcessEnv),
      ).toThrow(/OBJECT_REGION/);
    });

    it("bucket과 region이 있으면 s3 설정을 만든다", () => {
      const config = loadConfig({
        ...base,
        OBJECT_STORE: "s3",
        OBJECT_BUCKET: "mpc-evidence",
        OBJECT_REGION: "ap-northeast-2",
        OBJECT_KMS_KEY_ID: "arn:aws:kms:...:key/abc",
      } as NodeJS.ProcessEnv);

      expect(config.objectStore.kind).toBe("s3");
      expect(config.objectStore.region).toBe("ap-northeast-2");
      expect(config.objectStore.kmsKeyId).toBe("arn:aws:kms:...:key/abc");
    });

    it("자격증명은 둘 다 있을 때만 설정한다", () => {
      // 한쪽만 있으면 SDK가 기본 credential chain으로 조용히 떨어진다.
      const config = loadConfig({
        ...base,
        OBJECT_STORE: "s3",
        OBJECT_BUCKET: "b",
        OBJECT_REGION: "r",
        OBJECT_ACCESS_KEY_ID: "only-id",
      } as NodeJS.ProcessEnv);
      expect(config.objectStore.credentials).toBeUndefined();
    });
  });
});
