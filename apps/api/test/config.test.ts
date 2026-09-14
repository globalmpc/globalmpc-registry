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
  it("parses valid environment variables", () => {
    const config = loadConfig(VALID);
    expect(config.port).toBe(3001);
    expect(config.chainId).toBe(97);
    expect(config.siweDomain).toBe("localhost:3000");
  });

  /**
   * Deploy platforms inject declared variables as empty strings even with no value. Coolify
   * injects the variable list extracted from compose into every container, so the
   * `CHAIN_RPC_URL` left empty for the anchor worker reached the API as `""` and killed it
   * right after startup.
   */
  it("reads an optional variable given as an empty string as unset", () => {
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

  it("reports a required variable given as an empty string as missing", () => {
    expect(() => loadConfig({ ...VALID, SIWE_URI: "" })).toThrowError(/SIWE_URI/);
  });

  it("fails at startup when a required variable is missing", () => {
    const { DATABASE_URL, ...missing } = VALID;
    expect(() => loadConfig(missing)).toThrowError(ConfigError);
    expect(() => loadConfig(missing)).toThrowError(/DATABASE_URL/);
  });

  it("rejects a short session secret", () => {
    expect(() => loadConfig({ ...VALID, SESSION_SECRET: "short" })).toThrowError(
      /SESSION_SECRET/,
    );
  });

  it("rejects chain IDs other than BSC mainnet and testnet", () => {
    expect(() => loadConfig({ ...VALID, CHAIN_ID: "1" })).toThrowError(/CHAIN_ID/);
    expect(loadConfig({ ...VALID, CHAIN_ID: "56" }).chainId).toBe(56);
    expect(loadConfig({ ...VALID, CHAIN_ID: "97" }).chainId).toBe(97);
  });

  /**
   * Hop count used to identify the requester — must never silently become 0.
   *
   * 0 means "do not trust the header", so behind a proxy the cap becomes a site-wide total
   * again. That state runs without errors, so it goes unnoticed in deployment.
   * Pins that the empty string a deploy platform injects is not coerced to 0.
   */
  /**
   * Time caps.
   *
   * Fastify ships with both disabled. Measured: `requestTimeout` and `server.timeout` were
   * both 0. Pins both that a value exists and **that it cannot be disabled** — allowing 0
   * turns "disable it for now" into permanent.
   */
  describe("time caps", () => {
    it("has a value when unset", () => {
      const config = loadConfig(VALID);
      expect(config.requestTimeoutMs).toBe(300_000);
      expect(config.socketIdleTimeoutMs).toBe(60_000);
    });

    it("can be lowered in deployment", () => {
      const config = loadConfig({
        ...VALID,
        REQUEST_TIMEOUT_MS: "45000",
        SOCKET_IDLE_TIMEOUT_MS: "15000",
      });
      expect(config.requestTimeoutMs).toBe(45_000);
      expect(config.socketIdleTimeoutMs).toBe(15_000);
    });

    it("cannot be disabled with 0", () => {
      expect(() => loadConfig({ ...VALID, REQUEST_TIMEOUT_MS: "0" })).toThrowError(
        /REQUEST_TIMEOUT_MS/,
      );
      expect(() => loadConfig({ ...VALID, SOCKET_IDLE_TIMEOUT_MS: "0" })).toThrowError(
        /SOCKET_IDLE_TIMEOUT_MS/,
      );
    });

    it("reads an empty string as the default, not 0", () => {
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
    it("defaults to 1 — assumes one proxy (Coolify) in front", () => {
      expect(loadConfig(VALID).trustedProxyHops).toBe(1);
    });

    it("reads an empty string as the default, not 0", () => {
      expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "" }).trustedProxyHops).toBe(1);
    });

    it("can be raised when more front proxies are added", () => {
      expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "2" }).trustedProxyHops).toBe(2);
    });

    it("uses 0 only when explicit — trusts no header at all", () => {
      expect(loadConfig({ ...VALID, TRUSTED_PROXY_HOPS: "0" }).trustedProxyHops).toBe(0);
    });

    it("rejects negative and non-integer values", () => {
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

  it("keeps secret values out of error messages", () => {
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

describe("R1: the dev auth switch is removed", () => {
  it("has no allowInsecureDevAuth in config", () => {
    // R1 replaced header-based wallet-address auth with session tokens.
    // The setting is gone, so it cannot be enabled by mistake.
    expect(loadConfig(VALID)).not.toHaveProperty("allowInsecureDevAuth");
  });

  it("ignores a leftover environment variable", () => {
    // A value left in old deploy config does not block startup. It has no effect.
    expect(() => loadConfig({ ...VALID, ALLOW_INSECURE_DEV_AUTH: "true" })).not.toThrow();
  });

  it("defaults NODE_ENV to development", () => {
    expect(loadConfig(VALID).nodeEnv).toBe("development");
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(() => loadConfig({ ...VALID, NODE_ENV: "staging" })).toThrowError(ConfigError);
  });

  describe("secret references", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/x",
      SIWE_DOMAIN: "localhost:3000",
      SIWE_URI: "http://localhost:3000",
      CHAIN_ID: "97",
      SESSION_SECRET: "s".repeat(32),
    };

    it("still accepts plain values", () => {
      // Requiring a vault for local development would stop anyone from running it.
      const config = loadConfig(base as NodeJS.ProcessEnv);
      expect(config.sessionSecret).toBe("s".repeat(32));
      expect(config.secretAudit.find((s) => s.variableName === "SESSION_SECRET")?.scheme).toBe(
        "inline",
      );
    });

    it("can point to another environment variable", () => {
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

    it("does not mistake the colon in DATABASE_URL for a scheme", () => {
      // Truncating `postgres://user:pass@host` breaks the whole connection string.
      const config = loadConfig({
        ...base,
        DATABASE_URL: "postgres://u:p@localhost:5432/db",
      } as NodeJS.ProcessEnv);
      expect(config.databaseUrl).toBe("postgres://u:p@localhost:5432/db");
    });

    it("keeps values out of the audit record", () => {
      const secret = "s".repeat(32);
      const config = loadConfig(base as NodeJS.ProcessEnv);

      // In operations, "which key is in use" is answered by fingerprint. Answering with the
      // value turns logs into a leak path.
      const serialized = JSON.stringify(config.secretAudit);
      expect(serialized).not.toContain(secret);
      expect(config.secretAudit.every((entry) => entry.fingerprint.length === 12)).toBe(true);
    });

    it("does not start when the referenced variable is empty", () => {
      expect(() =>
        loadConfig({ ...base, SESSION_SECRET: "env:MISSING" } as NodeJS.ProcessEnv),
      ).toThrow();
    });
  });

  describe("object storage (OD-17·OD-22)", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/x",
      SIWE_DOMAIN: "localhost:3000",
      SIWE_URI: "http://localhost:3000",
      CHAIN_ID: "97",
      SESSION_SECRET: "s".repeat(32),
    };

    it("defaults to in-memory storage", () => {
      expect(loadConfig(base as NodeJS.ProcessEnv).objectStore.kind).toBe("memory");
    });

    it("rejects in-memory storage in production", () => {
      // Original evidence would vanish on every restart, with nothing showing it anywhere.
      expect(() =>
        loadConfig({ ...base, NODE_ENV: "production" } as NodeJS.ProcessEnv),
      ).toThrow(/OBJECT_STORE=memory/);
    });

    it("requires a region for s3", () => {
      // A default region means data lands somewhere nobody decided. This is where OD-17
      // is enforced in code.
      expect(() =>
        loadConfig({ ...base, OBJECT_STORE: "s3", OBJECT_BUCKET: "b" } as NodeJS.ProcessEnv),
      ).toThrow(/OBJECT_REGION/);
    });

    it("builds the s3 config when bucket and region are set", () => {
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

    it("sets credentials only when both are present", () => {
      // With only one, the SDK silently falls back to the default credential chain.
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
