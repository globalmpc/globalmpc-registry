import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../src/config.js";

const VALID = {
  PORT: "3001",
  DATABASE_URL: "postgres://postgres@localhost:5432/mpc_test",
  WEB_ORIGIN: "http://localhost:3000",
  CHAIN_ID: "31337",
  SESSION_SECRET: "a".repeat(32),
};

describe("loadConfig", () => {
  it("parses valid environment variables", () => {
    const config = loadConfig(VALID);
    expect(config.port).toBe(3001);
    expect(config.chainId).toBe(31337);
    expect(config.webOrigin).toBe("http://localhost:3000");
  });

  it("the public route cap defaults to the authenticated cap and can be set apart", () => {
    // Splitting the pools must not by itself change the numbers a deployment runs with.
    expect(loadConfig({ ...VALID, RATE_LIMIT_MAX: "120" }).publicRateLimitMax).toBe(120);
    expect(
      loadConfig({ ...VALID, RATE_LIMIT_MAX: "120", PUBLIC_RATE_LIMIT_MAX: "40" }),
    ).toMatchObject({ rateLimitMax: 120, publicRateLimitMax: 40 });
  });

  /**
   * Deploy platforms inject declared variables as empty strings even with no value. A compose-based
   * platform may inject the variable list extracted from compose into every container, so the
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
      GOOGLE_CLIENT_ID: "",
      GOOGLE_CLIENT_SECRET: "",
      MICROSOFT_ALLOWED_TENANTS: "",
      OIDC_REDIRECT_BASE: "",
    });

    expect(config.chainRpcUrl).toBeNull();
    expect(config.oidc.google).toBeNull();
    expect(config.governanceTokenAddress).toBeNull();
    expect(config.objectStore.endpoint).toBeUndefined();
    expect(config.objectStore.credentials).toBeUndefined();
  });

  it("reports a required variable given as an empty string as missing", () => {
    expect(() => loadConfig({ ...VALID, WEB_ORIGIN: "" })).toThrowError(/WEB_ORIGIN/);
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

  it("accepts only BSC mainnet, the opBNB testnet, and the local chain", () => {
    // 97 (BSC testnet) and 204 (opBNB mainnet) are near misses for the networks that are allowed.
    for (const value of ["1", "97", "204"]) {
      expect(() => loadConfig({ ...VALID, CHAIN_ID: value }), value).toThrowError(/CHAIN_ID/);
    }
    expect(loadConfig({ ...VALID, CHAIN_ID: "56" }).chainId).toBe(56);
    expect(loadConfig({ ...VALID, CHAIN_ID: "5611" }).chainId).toBe(5611);
    // Number() reads each of these as a supported chain; only plain digits name one.
    for (const value of ["0x15eb", " 56 ", "5.611e3"]) {
      expect(() => loadConfig({ ...VALID, CHAIN_ID: value }), value).toThrowError(/CHAIN_ID/);
    }
    expect(loadConfig({ ...VALID, CHAIN_ID: "31337" }).chainId).toBe(31337);
  });

  /**
   * Wallet sign-in was removed (D3, WP7). `LEGACY_WALLET_LOGIN` is refused rather than ignored
   * whenever it asks for wallet sign-in: a deployment that still sets `1` expected something that
   * no longer exists, and must find out at startup, not from a sign-in screen without the button.
   * `0` asks for what every deployment now gets, so it is accepted and changes nothing. The SIWE
   * variables are simply no longer read.
   */
  describe("wallet sign-in removed", () => {
    it("refuses LEGACY_WALLET_LOGIN unless it is 0", () => {
      for (const value of ["1", "true", "yes"]) {
        expect(() => loadConfig({ ...VALID, LEGACY_WALLET_LOGIN: value }), value).toThrowError(
          /LEGACY_WALLET_LOGIN: wallet sign-in was removed/,
        );
      }
      expect(loadConfig({ ...VALID, LEGACY_WALLET_LOGIN: "0" })).not.toHaveProperty("legacyWalletLogin");
      // A platform's empty placeholder is "unset", as for every other variable.
      expect(() => loadConfig({ ...VALID, LEGACY_WALLET_LOGIN: "" })).not.toThrow();
    });

    it("reads nothing from the SIWE variables", () => {
      const config = loadConfig({ ...VALID, SIWE_DOMAIN: "evil.example", SIWE_URI: "https://evil.example" });
      expect(config.webOrigin).toBe("http://localhost:3000");
      expect(JSON.stringify(config)).not.toContain("evil.example");
    });

    it("requires WEB_ORIGIN — it no longer falls back to SIWE_URI", () => {
      const { WEB_ORIGIN: _origin, ...withoutOrigin } = VALID;
      expect(() => loadConfig({ ...withoutOrigin, SIWE_URI: "http://localhost:3000" })).toThrowError(/WEB_ORIGIN/);
    });
  });

  /**
   * The E2E stand-in for Google and Microsoft (`OIDC_TEST_RELAY_URL`). Whoever sets it chooses
   * which server the API trusts for ID tokens, so it exists only where nothing real signs in.
   */
  describe("OIDC_TEST_RELAY_URL", () => {
    const production = {
      ...VALID,
      NODE_ENV: "production",
      OBJECT_STORE: "s3",
      OBJECT_BUCKET: "mpc-evidence",
      OBJECT_REGION: "ap-northeast-2",
      WEB_ORIGIN: "https://registry.example.com",
      WEBAUTHN_RP_ID: "registry.example.com",
      WEBAUTHN_ORIGIN: "https://registry.example.com",
    };

    it("is off unless set, and kept without a trailing slash", () => {
      expect(loadConfig(VALID).oidcTestRelayUrl).toBeNull();
      expect(loadConfig({ ...VALID, OIDC_TEST_RELAY_URL: "" }).oidcTestRelayUrl).toBeNull();
      expect(loadConfig({ ...VALID, OIDC_TEST_RELAY_URL: "http://127.0.0.1:4555/" }).oidcTestRelayUrl).toBe(
        "http://127.0.0.1:4555",
      );
      expect(loadConfig({ ...VALID, NODE_ENV: "test", OIDC_TEST_RELAY_URL: "https://localhost:4555/oidc" }).oidcTestRelayUrl).toBe(
        "https://localhost:4555/oidc",
      );
      expect(loadConfig({ ...VALID, OIDC_TEST_RELAY_URL: "http://[::1]:4555" }).oidcTestRelayUrl).toBe("http://[::1]:4555");
    });

    it("refuses a relay that is not this machine, even outside production", () => {
      for (const value of [
        "https://attacker.example",
        "http://127.0.0.1.attacker.example:4555",
        "http://localhost.attacker.example",
        "http://10.0.0.5:4555",
        "http://user:pass@127.0.0.1:4555",
      ]) {
        expect(() => loadConfig({ ...VALID, NODE_ENV: "test", OIDC_TEST_RELAY_URL: value }), value).toThrowError(
          /OIDC_TEST_RELAY_URL must name this machine/,
        );
      }
    });

    it("is refused in production and on mainnet", () => {
      expect(loadConfig(production).oidcTestRelayUrl).toBeNull();
      expect(() => loadConfig({ ...production, OIDC_TEST_RELAY_URL: "http://127.0.0.1:4555" })).toThrowError(
        /OIDC_TEST_RELAY_URL is for test builds only/,
      );
      expect(() => loadConfig({ ...VALID, CHAIN_ID: "56", OIDC_TEST_RELAY_URL: "http://127.0.0.1:4555" })).toThrowError(
        ConfigError,
      );
    });

    it("refuses anything but a plain http(s) URL", () => {
      for (const value of ["file:///etc/passwd", "javascript:alert(1)", "not a url", "ftp://relay.test", "http://relay.test/?x=1", "http://relay.test/#a"]) {
        expect(() => loadConfig({ ...VALID, OIDC_TEST_RELAY_URL: value }), value).toThrowError(/OIDC_TEST_RELAY_URL/);
      }
    });
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

  describe("edge proxy path", () => {
    it("is closed unless a secret is given", () => {
      const config = loadConfig(VALID);
      expect(config.edgeProxySecret).toBeNull();
      expect(config.edgeWebOrigin).toBeNull();
    });

    it("refuses a short secret — a guessable value would let anyone name its own address", () => {
      expect(() => loadConfig({ ...VALID, EDGE_PROXY_SECRET: "short" })).toThrowError(
        /EDGE_PROXY_SECRET/,
      );
      expect(loadConfig({ ...VALID, EDGE_PROXY_SECRET: "x".repeat(32) }).edgeProxySecret).toBe(
        "x".repeat(32),
      );
    });

    it("normalizes the web origin to what a browser sends in Origin", () => {
      expect(
        loadConfig({ ...VALID, EDGE_WEB_ORIGIN: "https://registry.example/" }).edgeWebOrigin,
      ).toBe("https://registry.example");
      expect(() => loadConfig({ ...VALID, EDGE_WEB_ORIGIN: "registry.example" })).toThrowError(
        /EDGE_WEB_ORIGIN/,
      );
    });

    it("defaults the ops endpoint peers to the private ranges and accepts an explicit list", () => {
      expect(loadConfig(VALID).opsEndpointCidrs).toContain("10.0.0.0/8");
      expect(loadConfig({ ...VALID, OPS_ENDPOINT_CIDRS: " 10.1.0.0/16 ,, " }).opsEndpointCidrs).toEqual([
        "10.1.0.0/16",
      ]);
    });
  });

  describe("TRUSTED_PROXY_HOPS", () => {
    it("defaults to 1 — assumes one reverse proxy in front", () => {
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
      WEB_ORIGIN: "http://localhost:3000",
      CHAIN_ID: "31337",
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

  /** The web and relying-party settings production requires (WP3), consistent with each other. */
  const WEBAUTHN_PRODUCTION = {
    WEB_ORIGIN: "https://registry.example.com",
    WEBAUTHN_RP_ID: "registry.example.com",
    WEBAUTHN_ORIGIN: "https://registry.example.com",
  };

  describe("account email (WP2)", () => {
    it("takes the invitation-link origin from WEB_ORIGIN, reduced to its origin", () => {
      expect(loadConfig(VALID).webOrigin).toBe("http://localhost:3000");
      expect(
        loadConfig({ ...VALID, WEB_ORIGIN: "https://app.example.com/some/path" }).webOrigin,
      ).toBe("https://app.example.com");
    });

    it("refuses a WEB_ORIGIN that is not http(s)", () => {
      expect(() => loadConfig({ ...VALID, WEB_ORIGIN: "javascript:alert(1)" })).toThrow(
        /WEB_ORIGIN/,
      );
    });

    it("sends through the test sink outside production and Resend in production by default", () => {
      expect(loadConfig(VALID).emailTransport).toBe("log");
      expect(
        loadConfig({ ...VALID, NODE_ENV: "production", OBJECT_STORE: "s3", OBJECT_BUCKET: "b", OBJECT_REGION: "r", ...WEBAUTHN_PRODUCTION })
          .emailTransport,
      ).toBe("resend");
    });

    it("refuses a test transport in production", () => {
      for (const transport of ["log", "smtp"]) {
        expect(() =>
          loadConfig({
            ...VALID,
            NODE_ENV: "production",
            OBJECT_STORE: "s3",
            OBJECT_BUCKET: "b",
            OBJECT_REGION: "r",
            ...WEBAUTHN_PRODUCTION,
            EMAIL_TRANSPORT: transport,
          }),
        ).toThrow(/cannot be used in production/);
      }
    });

    it("refuses an unknown transport", () => {
      expect(() => loadConfig({ ...VALID, EMAIL_TRANSPORT: "sendmail" })).toThrow(
        /EMAIL_TRANSPORT must be one of/,
      );
    });
  });

  /**
   * WebAuthn relying party (WP3). Passkeys are bound to the RP ID and every ceremony must come
   * from the one configured origin, so a missing or loose value would either break sign-in or
   * accept assertions made for another site.
   */
  describe("Google and Microsoft sign-in (WP4)", () => {
    const production = {
      ...VALID,
      NODE_ENV: "production",
      OBJECT_STORE: "s3",
      OBJECT_BUCKET: "mpc-evidence",
      OBJECT_REGION: "ap-northeast-2",
      ...WEBAUTHN_PRODUCTION,
    };
    const google = { GOOGLE_CLIENT_ID: "id.apps.example", GOOGLE_CLIENT_SECRET: "google-secret-value" };
    const microsoft = { MICROSOFT_CLIENT_ID: "5b4f3a2c-0000-4000-8000-00000000c1d1", MICROSOFT_CLIENT_SECRET: "ms-secret-value" };
    const TID = "11111111-1111-4111-8111-111111111111";

    it("is off unless a provider's id and secret are both set; the redirect base is the web origin", () => {
      expect(loadConfig(VALID).oidc).toEqual({ redirectBase: "http://localhost:3000", google: null, microsoft: null });
      const on = loadConfig({ ...production, ...google, ...microsoft }).oidc;
      expect(on.redirectBase).toBe("https://registry.example.com");
      expect(on.google).toEqual({ clientId: google.GOOGLE_CLIENT_ID, clientSecret: google.GOOGLE_CLIENT_SECRET });
      expect(on.microsoft).toMatchObject({ clientId: microsoft.MICROSOFT_CLIENT_ID, allowedTenants: null });
    });

    it("refuses half a client in production, and leaves the provider off elsewhere", () => {
      expect(() => loadConfig({ ...production, GOOGLE_CLIENT_ID: "id-only" })).toThrow(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
      expect(() => loadConfig({ ...production, MICROSOFT_CLIENT_SECRET: "secret-only" })).toThrow(/MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET/);
      expect(loadConfig({ ...VALID, GOOGLE_CLIENT_ID: "id-only" }).oidc.google).toBeNull();
    });

    it("accepts the redirect base only as the web origin itself", () => {
      expect(loadConfig({ ...production, OIDC_REDIRECT_BASE: "https://registry.example.com/" }).oidc.redirectBase)
        .toBe("https://registry.example.com");
      expect(() => loadConfig({ ...production, OIDC_REDIRECT_BASE: "https://evil.example.com" })).toThrow(/web origin/);
      expect(() => loadConfig({ ...production, OIDC_REDIRECT_BASE: "https://registry.example.com/cb" })).toThrow(/origin only/);
      expect(() => loadConfig({ ...production, OIDC_REDIRECT_BASE: "not a url" })).toThrow(/OIDC_REDIRECT_BASE/);
      expect(() =>
        loadConfig({ ...production, WEB_ORIGIN: "http://registry.example.com", WEBAUTHN_ORIGIN: "http://registry.example.com" }),
      ).toThrow(/https/);
    });

    it("reads the Microsoft allowlist as directory GUIDs, and refuses anything else", () => {
      const config = loadConfig({ ...VALID, ...microsoft, MICROSOFT_ALLOWED_TENANTS: ` ${TID.toUpperCase()} , ` });
      expect(config.oidc.microsoft?.allowedTenants).toEqual([TID]);
      expect(() => loadConfig({ ...VALID, ...microsoft, MICROSOFT_ALLOWED_TENANTS: "contoso.onmicrosoft.com" })).toThrow(/GUID/);
      expect(() => loadConfig({ ...VALID, ...microsoft, MICROSOFT_ALLOWED_TENANTS: "," })).toThrow(/GUID/);
    });

    it("keeps the client secrets out of the audit trail and error messages", () => {
      const config = loadConfig({ ...production, ...google, ...microsoft });
      const audit = JSON.stringify(config.secretAudit);
      expect(audit).toContain("GOOGLE_CLIENT_SECRET");
      expect(audit).toContain("MICROSOFT_CLIENT_SECRET");
      expect(audit).not.toContain(google.GOOGLE_CLIENT_SECRET);
      expect(audit).not.toContain(microsoft.MICROSOFT_CLIENT_SECRET);
      try {
        loadConfig({ ...production, GOOGLE_CLIENT_SECRET: "leaky-secret-value" });
        expect.unreachable();
      } catch (error) {
        expect(String(error)).not.toContain("leaky-secret-value");
      }
    });
  });

  describe("WEBAUTHN_RP_ID / WEBAUTHN_ORIGIN", () => {
    const production = {
      ...VALID,
      NODE_ENV: "production",
      OBJECT_STORE: "s3",
      OBJECT_BUCKET: "mpc-evidence",
      OBJECT_REGION: "ap-northeast-2",
      WEB_ORIGIN: "https://registry.example.com",
      WEBAUTHN_RP_ID: "registry.example.com",
      WEBAUTHN_ORIGIN: "https://registry.example.com",
    };

    it("defaults to localhost outside production", () => {
      expect(loadConfig(VALID).webauthn).toEqual({ rpId: "localhost", origin: "http://localhost:3000" });
    });

    it("is required in production", () => {
      expect(() => loadConfig({ ...production, WEBAUTHN_RP_ID: undefined })).toThrow(/WEBAUTHN_RP_ID/);
      expect(() => loadConfig({ ...production, WEBAUTHN_ORIGIN: undefined })).toThrow(/WEBAUTHN_ORIGIN/);
      expect(loadConfig(production).webauthn).toEqual({
        rpId: "registry.example.com",
        origin: "https://registry.example.com",
      });
    });

    it("accepts an origin on a subdomain of the RP ID", () => {
      expect(
        loadConfig({
          ...production,
          WEB_ORIGIN: "https://app.registry.example.com",
          WEBAUTHN_ORIGIN: "https://app.registry.example.com",
        }).webauthn.origin,
      ).toBe("https://app.registry.example.com");
    });

    it("must be the web origin the invitation links point at", () => {
      // Defaults follow the web origin outside production.
      expect(loadConfig({ ...VALID, WEB_ORIGIN: "https://app.example.com" }).webauthn).toEqual({
        rpId: "app.example.com",
        origin: "https://app.example.com",
      });
      expect(() =>
        loadConfig({
          ...production,
          WEB_ORIGIN: "https://registry.example.com",
          WEBAUTHN_ORIGIN: "https://app.registry.example.com",
        }),
      ).toThrow(/must equal the web origin/);
      expect(() => loadConfig({ ...production, WEB_ORIGIN: "http://localhost:3000" })).toThrow(
        /must equal the web origin \(WEB_ORIGIN\): http:\/\/localhost:3000/,
      );
    });

    it("refuses an origin that is not the RP ID or under it", () => {
      for (const origin of ["https://evil.example.com", "https://registry.example.com.evil.test", "https://xregistry.example.com"]) {
        expect(() => loadConfig({ ...production, WEBAUTHN_ORIGIN: origin })).toThrow(/subdomain/);
      }
    });

    it("refuses http in production and anything but a bare origin", () => {
      expect(() => loadConfig({ ...production, WEBAUTHN_ORIGIN: "http://registry.example.com" })).toThrow(/https/);
      expect(() => loadConfig({ ...production, WEBAUTHN_ORIGIN: "https://registry.example.com/app" })).toThrow(
        /origin only/,
      );
      expect(() => loadConfig({ ...production, WEBAUTHN_ORIGIN: "not a url" })).toThrow(/WEBAUTHN_ORIGIN/);
      expect(() => loadConfig({ ...production, WEBAUTHN_RP_ID: "https://registry.example.com" })).toThrow(
        /WEBAUTHN_RP_ID/,
      );
    });
  });

  describe("object storage (OD-17·OD-22)", () => {
    const base = {
      DATABASE_URL: "postgres://localhost/x",
      WEB_ORIGIN: "http://localhost:3000",
      CHAIN_ID: "31337",
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
