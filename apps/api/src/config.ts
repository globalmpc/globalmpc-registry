import { createHash } from "node:crypto";
import { z } from "zod";
import { fingerprintSecret, parseSecretReference, resolveSecret } from "@mpc/config";
import type { SecretAudit } from "@mpc/config";

/**
 * Environment variables are validated once at startup.
 *
 * Discovering a missing value mid-runtime means requests were already accepted. The secret
 * management requirement in 06 §6.4 includes "verify presence at startup".
 *
 * Secrets may be given as a **reference** instead of a value (`file:`·`env:`·`plain:`).
 * Deployments read mounted files; local and CI use plain values. Both paths run the same code,
 * so no section "behaves differently only in deployment".
 */

/** Variables that accept a reference. The rest are not secrets. */
const SECRET_VARIABLES = [
  "DATABASE_URL",
  "SESSION_SECRET",
  "OBJECT_SECRET_ACCESS_KEY",
] as const;
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  SIWE_DOMAIN: z.string().min(1),
  SIWE_URI: z.string().url(),
  // Only BSC mainnet 56 / testnet 97 are allowed. Anchoring on another chain splits the
  // Explorer's verification path.
  CHAIN_ID: z.coerce.number().refine((value) => value === 56 || value === 97, {
    message: "CHAIN_ID must be 56 (BSC mainnet) or 97 (BSC testnet)",
  }),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Request cap — 06 §6.9.
   *
   * Not hardcoded. Normal usage differs per deployment, and choosing between a cap so low that
   * users get blocked and one so high it is meaningless belongs to operations.
   *
   * **No value turns it off.** Allowing 0 turns "switch it off for a moment" into permanent.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /** Cap for the login path. Much narrower: it creates rows or verifies signatures without auth. */
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),

  /**
   * Total request time cap.
   *
   * Fastify is built with this **turned off** (`requestTimeout: 0`). So a single request could
   * stay open forever, and that surface is reachable from the internet.
   *
   * The default is 300 s **because streaming upload lives on the same server**
   * (`/uploads/stream`, up to 2 GiB). Tightening this to 30 s cuts legitimate uploads on slow
   * links. To narrow short requests further, lower this value in deployment and move uploads
   * to a separate path — that split depends on the service-split decision.
   *
   * **No value turns it off.** Allowing 0 would restore the unbounded state.
   */
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  /**
   * Socket idle cap.
   *
   * Blocks something different from `requestTimeout`: it cuts **connections that send
   * nothing**. It is refreshed while data flows, so it does not cut large uploads —
   * which is why it can be much narrower than the total-time cap.
   *
   * Fastify's default is also 0 (unlimited). `headersTimeout` 60 s covers headers only.
   */
  SOCKET_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),

  /**
   * Number of proxy hops trusted when determining the requester.
   *
   * In deployment the API is reached only through `web`'s `/api/*` proxy. The socket address is
   * always the web container, so capping on it makes **the unauthenticated-path cap a site-wide
   * total** — once one person uses up the login share, nobody else can log in for that
   * minute.
   *
   * So the requester is the `x-forwarded-for` value reached by skipping this many hops **from the
   * right**. Left entries are not counted because the requester can fill them freely —
   * overstating the hop count makes the cap forgeable at once.
   *
   * Rationale for the default of 1: Traefik (Coolify) appends the client address it saw at the
   * right end, and Next's proxy **passes the received header through unchanged** (it adds no
   * entry). So the only trusted hop is web.
   *
   * The Next side is measured — verified by attaching an echo server to `next start` (Next 16.3.0).
   * Sending `x-forwarded-for: 9.9.9.9, 203.0.113.7` arrives unchanged; the peer address is filled
   * in only when the header is absent. **Re-check this behavior when upgrading Next** —
   * if Next starts appending an entry, the right end becomes the web container address and
   * this value silently becomes wrong.
   *
   * Raise it for each additional proxy (a CDN in front, etc.). 0 ignores the header entirely and
   * uses the socket address — correct only when exposed directly without a proxy.
   */
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).default(1),

  /**
   * **Peer addresses** whose `x-forwarded-*` is trusted. Comma-separated list of IPs and CIDRs.
   *
   * fastify 5.12.1 removed trust based on hop count alone (GHSA-97wr-x83h-mw3v family).
   * The reason is precise — a hop count **does not check who the immediate peer is**, so
   * a request arriving directly, bypassing the proxy, can fill `x-forwarded-for` itself and
   * forge the requester address. That bypasses the unauthenticated-path cap.
   *
   * The default is the private ranges. In deployment this API is reachable only through `web`
   * on the same network, so headers on requests arriving directly from public addresses are not
   * trusted. If there are more layers in front (a CDN, etc.), list their ranges here.
   */
  TRUSTED_PROXY_CIDRS: z
    .string()
    .default("127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7"),

  /**
   * Object storage — OD-22.
   *
   * `memory` is lost when the process dies. Choosing it in production loses evidence originals
   * on every restart, and that fact surfaces nowhere.
   */
  OBJECT_STORE: z.enum(["memory", "s3"]).default("memory"),
  OBJECT_BUCKET: z.string().optional(),
  /**
   * Storage region. **No default** — until OD-17 (jurisdiction for original storage) is decided,
   * no region is a "reasonable default". A default would become the decision.
   */
  OBJECT_REGION: z.string().optional(),
  OBJECT_ENDPOINT: z.string().url().optional(),
  /**
   * Public endpoint for presigned URLs.
   *
   * Set when the address the server uses to reach storage differs from the one the browser
   * can reach. Falls back to `OBJECT_ENDPOINT` when empty.
   */
  OBJECT_PUBLIC_ENDPOINT: z.string().url().optional(),
  OBJECT_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
  /**
   * Server-side encryption mode.
   *
   * `none` is **for local MinIO only**. MinIO rejects SSE requests without KMS, and if that
   * keeps the encryption path from running locally, deployment is where it first shows up.
   * `none` is rejected in production — originals would stay in plaintext.
   */
  OBJECT_SSE: z.enum(["none", "aes256", "kms"]).default("aes256"),
  /** KMS key. Required when `OBJECT_SSE=kms`. Per-tenant separation depends on OD-18. */
  OBJECT_KMS_KEY_ID: z.string().optional(),
  OBJECT_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_SECRET_ACCESS_KEY: z.string().optional(),

  /**
   * Governance vote weight — 04 §4.5.
   *
   * Without a token address no snapshot is taken and weight falls back to manual. Before the
   * token is deployed there is no balance to read, and recording an empty value as 0 silently
   * takes away voting power.
   */
  CHAIN_RPC_URL: z.string().url().optional(),
  GOVERNANCE_TOKEN_ADDRESS: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** Snapshot block depth. The head can be reorganized, so it steps back. */
  GOVERNANCE_CONFIRMATIONS: z.coerce.number().int().min(1).default(12),
});

export interface ObjectStoreConfig {
  readonly kind: "memory" | "s3";
  readonly bucket?: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly publicEndpoint?: string;
  readonly forcePathStyle: boolean;
  readonly sse: "none" | "aes256" | "kms";
  readonly kmsKeyId?: string;
  readonly credentials?: { accessKeyId: string; secretAccessKey: string };
}

export interface AppConfig {
  /** Which secret was read via which path. Holds no values. */
  readonly secretAudit: readonly SecretAudit[];
  readonly objectStore: ObjectStoreConfig;
  readonly chainRpcUrl: string | null;
  readonly governanceTokenAddress: string | null;
  readonly governanceConfirmationDepth: number;
  readonly port: number;
  readonly databaseUrl: string;
  readonly siweDomain: string;
  readonly siweUri: string;
  readonly chainId: number;
  readonly sessionSecret: string;
  readonly nodeEnv: "development" | "test" | "production";
  readonly rateLimitMax: number;
  readonly authRateLimitMax: number;
  /** Proxy hops trusted when determining the requester. 0 means the header is not trusted. */
  readonly trustedProxyHops: number;
  /** Trust the header only when that hop is within these ranges. Empty means trust nobody. */
  readonly trustedProxyCidrs: readonly string[];
  /** Total request time cap (ms). Cannot be 0 — the schema requires a positive value. */
  readonly requestTimeoutMs: number;
  /** Socket idle cap (ms). Refreshed during transfer, so it does not cut large uploads. */
  readonly socketIdleTimeoutMs: number;
}

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
}

/**
 * Reads an empty string as "not given".
 *
 * Deployment platforms inject declared variables as empty strings even without a value.
 * Coolify puts the variable list parsed from the compose file into **every container**, so
 * `CHAIN_RPC_URL`, left empty for the anchor worker, reaches the API as `""` too.
 * `.url().optional()` accepts undefined but rejects an empty string, so the API dies at start.
 *
 * This config has no reason to distinguish an omitted value from an empty one. Required fields
 * fail as "Required" once empty strings are removed, which makes the reason more accurate.
 */
function dropEmpty(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const kept: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() === "") continue;
    kept[name] = value;
  }
  return kept;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv): AppConfig {
  const env = dropEmpty(rawEnv);
  // Resolve references to values before running the schema. In the reverse order `file:/run/...`
  // fails URL validation with an error that does not say what is wrong.
  const resolved: NodeJS.ProcessEnv = { ...env };
  const secretAudit: SecretAudit[] = [];

  for (const name of SECRET_VARIABLES) {
    const raw = env[name];
    if (raw === undefined) continue;
    const value = resolveSecret(name, raw, undefined, env);
    resolved[name] = value;
    secretAudit.push({
      variableName: name,
      scheme: parseSecretReference(raw).scheme,
      fingerprint: fingerprintSecret(value, (input) =>
        createHash("sha256").update(input).digest("hex"),
      ),
    });
  }

  const parsed = schema.safeParse(resolved);

  if (!parsed.success) {
    // Report only keys and reasons, not values. Printing values leaves secrets in logs.
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new ConfigError(`Invalid environment variables — ${issues}`);
  }

  const value = parsed.data;

  // Choosing the memory store in production loses evidence originals on every restart.
  // Silent operation is the worst case, so startup itself is blocked.
  if (value.NODE_ENV === "production" && value.OBJECT_STORE === "memory") {
    throw new ConfigError("OBJECT_STORE=memory cannot be used in production");
  }

  if (value.OBJECT_STORE === "s3") {
    // Requiring a region is where OD-17 is enforced in code. With a default, data would be
    // stored somewhere without anyone deciding.
    if (!value.OBJECT_BUCKET || !value.OBJECT_REGION) {
      throw new ConfigError(
        "OBJECT_STORE=s3 requires OBJECT_BUCKET and OBJECT_REGION (the region is an OD-17 decision)",
      );
    }

    if (value.OBJECT_SSE === "kms" && !value.OBJECT_KMS_KEY_ID) {
      throw new ConfigError("OBJECT_SSE=kms requires OBJECT_KMS_KEY_ID");
    }
  }

  // Running with encryption off leaves evidence originals in plaintext. For local MinIO only.
  if (value.NODE_ENV === "production" && value.OBJECT_SSE === "none") {
    throw new ConfigError("OBJECT_SSE=none cannot be used in production");
  }

  const objectStore: ObjectStoreConfig = {
    kind: value.OBJECT_STORE,
    ...(value.OBJECT_BUCKET ? { bucket: value.OBJECT_BUCKET } : {}),
    ...(value.OBJECT_REGION ? { region: value.OBJECT_REGION } : {}),
    ...(value.OBJECT_ENDPOINT ? { endpoint: value.OBJECT_ENDPOINT } : {}),
    ...(value.OBJECT_PUBLIC_ENDPOINT ? { publicEndpoint: value.OBJECT_PUBLIC_ENDPOINT } : {}),
    forcePathStyle: value.OBJECT_FORCE_PATH_STYLE === "true",
    sse: value.OBJECT_SSE,
    ...(value.OBJECT_KMS_KEY_ID ? { kmsKeyId: value.OBJECT_KMS_KEY_ID } : {}),
    ...(value.OBJECT_ACCESS_KEY_ID && value.OBJECT_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: value.OBJECT_ACCESS_KEY_ID,
            secretAccessKey: value.OBJECT_SECRET_ACCESS_KEY,
          },
        }
      : {}),
  };

  return {
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    siweDomain: value.SIWE_DOMAIN,
    siweUri: value.SIWE_URI,
    chainId: value.CHAIN_ID,
    sessionSecret: value.SESSION_SECRET,
    nodeEnv: value.NODE_ENV,
    rateLimitMax: value.RATE_LIMIT_MAX,
    authRateLimitMax: value.AUTH_RATE_LIMIT_MAX,
    trustedProxyHops: value.TRUSTED_PROXY_HOPS,
    trustedProxyCidrs: value.TRUSTED_PROXY_CIDRS.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    requestTimeoutMs: value.REQUEST_TIMEOUT_MS,
    socketIdleTimeoutMs: value.SOCKET_IDLE_TIMEOUT_MS,
    secretAudit,
    objectStore,
    chainRpcUrl: value.CHAIN_RPC_URL ?? null,
    governanceTokenAddress: value.GOVERNANCE_TOKEN_ADDRESS?.toLowerCase() ?? null,
    governanceConfirmationDepth: value.GOVERNANCE_CONFIRMATIONS,
  };
}
