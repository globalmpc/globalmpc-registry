import { createHash } from "node:crypto";
import { z } from "zod";
import {
  fingerprintSecret,
  parseSecretReference,
  resolveEmailTransportKind,
  resolveSecret,
} from "@mpc/config";
import type { SecretAudit } from "@mpc/config";
import {
  BSC_MAINNET_CHAIN_ID,
  describeChains,
  isSupportedChainId,
  SUPPORTED_CHAIN_IDS,
} from "@mpc/domain";

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
  "EDGE_PROXY_SECRET",
  "GOOGLE_CLIENT_SECRET",
  "MICROSOFT_CLIENT_SECRET",
] as const;
const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3001),
  DATABASE_URL: z.string().min(1),
  /**
   * The web app's origin (`https://dev-registry.globalmpc.tech`). Invitation links start with it,
   * and it is the WebAuthn origin and the OIDC redirect base unless those are set (they must
   * equal it). Required: it used to fall back to the SIWE URI, which is gone with wallet sign-in.
   */
  WEB_ORIGIN: z.string().url(),
  // Only BSC mainnet 56, the opBNB testnet 5611 for the dev deployment, and the local chain 31337
  // are allowed (`@mpc/domain` chains). Anchoring on another chain splits the Explorer's
  // verification path. Plain digits only, as in the anchor worker: coercion would also read
  // "0x15eb", " 56 " or "5.611e3" as a chain, and the two must agree on what a value means.
  CHAIN_ID: z
    .string()
    .transform((raw) => (/^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN))
    .refine((value) => isSupportedChainId(value), {
      message: `CHAIN_ID must be one of ${describeChains(SUPPORTED_CHAIN_IDS)}`,
    }),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * Removed with wallet (SIWE) sign-in (D3, WP7). Only `0` — what every deployment now gets — is
   * still accepted, so an environment that asks for wallet sign-in fails at startup instead of
   * running without what it asked for.
   */
  LEGACY_WALLET_LOGIN: z
    .string()
    .optional()
    .refine((raw) => raw === undefined || raw === "0", {
      message: "wallet sign-in was removed (WP7); unset LEGACY_WALLET_LOGIN",
    }),
  /**
   * **Test builds only.** Base URL of the E2E relay that stands in for Google and Microsoft: every
   * request the OIDC library makes to a provider host goes to `<relay>/<host><path>` instead
   * (`oidc-test-relay.ts`). Refused in production and on mainnet, like the demo keys.
   */
  OIDC_TEST_RELAY_URL: z.string().optional(),

  /**
   * WebAuthn relying party — passkeys (WP3).
   *
   * `WEBAUTHN_RP_ID` is the web host passkeys are bound to (`dev-registry.globalmpc.tech`): a
   * passkey made for one RP ID never signs for another, which is what makes it phishing-
   * resistant. `WEBAUTHN_ORIGIN` is the exact origin the browser reports
   * (`https://dev-registry.globalmpc.tech`); an assertion from any other origin is refused.
   * Required in production, where the origin must be https; development and tests default to
   * the web origin (`WEB_ORIGIN`) and its host. The ceremony runs on the page an
   * invitation link opens, so `WEBAUTHN_ORIGIN` must equal the web origin.
   */
  WEBAUTHN_RP_ID: z.string().optional(),
  WEBAUTHN_ORIGIN: z.string().optional(),

  /**
   * Request cap — 06 §6.9.
   *
   * Not hardcoded. Normal usage differs per deployment, and choosing between a cap so low that
   * users get blocked and one so high it is meaningless belongs to operations.
   *
   * **No value turns it off.** Allowing 0 turns "switch it off for a moment" into permanent.
   */
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  /**
   * Cap for the unauthenticated public routes (`/api/v1/public/*`) — 07 §7.1 "public and
   * authenticated APIs run with separate rate limits".
   *
   * Counted in its own pool per IP, so public browsing cannot use up a signed-in user's share
   * and the reverse. Unset, it takes `RATE_LIMIT_MAX`: splitting the pools must not by itself
   * change any number a deployment already runs with.
   */
  PUBLIC_RATE_LIMIT_MAX: z.coerce.number().int().positive().optional(),
  /**
   * Mail transport (`resend`, `smtp`, `log`). The API does not send — the jobs worker does — but
   * it refuses to start in production with anything other than `resend`, so a deployment that
   * would lose every sign-in code fails at both ends. `RESEND_API_KEY` and `EMAIL_FROM` are the
   * worker's settings and are not read here: the API never needs the key.
   */
  EMAIL_TRANSPORT: z.string().optional(),
  /**
   * Google and Microsoft sign-in (WP4). A provider is on when both its client id and secret are
   * set, and off when neither is. In production one without the other is refused at startup —
   * a deployment that meant to turn a provider on must not silently run without it.
   *
   * The secrets accept a reference (`file:`·`env:`), like the other secrets here.
   */
  GOOGLE_CLIENT_ID: z.string().max(256).optional(),
  GOOGLE_CLIENT_SECRET: z.string().max(512).optional(),
  MICROSOFT_CLIENT_ID: z.string().max(256).optional(),
  MICROSOFT_CLIENT_SECRET: z.string().max(512).optional(),
  /**
   * Microsoft directories (`tid`, comma-separated GUIDs) allowed to sign in. Unset: any work or
   * school directory — an identity still has to be linked or invited before it signs anyone in.
   */
  MICROSOFT_ALLOWED_TENANTS: z.string().optional(),
  /**
   * Origin the providers redirect to: `<OIDC_REDIRECT_BASE>/auth/oidc/{provider}/callback`, a web
   * page that posts the result to the API through the same-origin proxy. It must be the web
   * origin (`WEB_ORIGIN`) — the browser binding and the session cookie live there — and defaults
   * to it. Registered as the redirect URI with each
   * provider exactly.
   */
  OIDC_REDIRECT_BASE: z.string().optional(),
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
   * Rationale for the default of 1: the deploy platform's reverse proxy appends the client address it saw at the
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
   * Edge proxy path — the web app runs on a CDN whose egress addresses are not fixed.
   *
   * `TRUSTED_PROXY_CIDRS` cannot name such a peer, so `x-forwarded-for` from it is never trusted
   * and every visitor would share one requester address. Instead the web proxy attaches this
   * shared secret and the visitor address it saw, and the API takes that address only when the
   * secret matches. Unset means the path is closed: the headers are ignored.
   */
  EDGE_PROXY_SECRET: z.string().min(32).optional(),
  /**
   * Web origin allowed to call the streaming upload route directly, bypassing the edge proxy
   * (a proxied request there is cut by the CDN's proxy time cap before a large upload ends).
   * Exactly one origin; unset means no cross-origin access at all.
   */
  EDGE_WEB_ORIGIN: z.string().url().optional(),
  /**
   * Peer ranges that may read `/health/*` and `/metrics`. Those endpoints carry no auth; when
   * the API host itself is reachable from the internet they must not be. Peers outside these
   * ranges get the same 404 as an unknown path. The default is the private ranges — the
   * orchestrator and the collector sit on the container network.
   */
  OPS_ENDPOINT_CIDRS: z
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
  readonly chainId: number;
  readonly sessionSecret: string;
  readonly nodeEnv: "development" | "test" | "production";
  /** Origin of the web app, without a trailing slash. Invitation links start with it. */
  readonly webOrigin: string;
  /** The mail transport the deployment declares (validated; the jobs worker sends). */
  readonly emailTransport: "resend" | "smtp" | "log";
  /**
   * E2E only: the relay every provider request is sent to instead (`OIDC_TEST_RELAY_URL`, no
   * trailing slash). `null` everywhere else, and always in production.
   */
  readonly oidcTestRelayUrl: string | null;
  /** WebAuthn relying party: the RP ID and the one origin assertions must come from. */
  readonly webauthn: { readonly rpId: string; readonly origin: string };
  /** Google / Microsoft sign-in (WP4). A provider is `null` when it is turned off. */
  readonly oidc: OidcConfig;
  readonly rateLimitMax: number;
  readonly publicRateLimitMax: number;
  readonly authRateLimitMax: number;
  /** Proxy hops trusted when determining the requester. 0 means the header is not trusted. */
  readonly trustedProxyHops: number;
  /** Trust the header only when that hop is within these ranges. Empty means trust nobody. */
  readonly trustedProxyCidrs: readonly string[];
  /** Shared secret the web proxy attaches. `null` closes the edge path. */
  readonly edgeProxySecret: string | null;
  /** The one origin allowed to call the streaming upload route cross-origin. */
  readonly edgeWebOrigin: string | null;
  /** Peer ranges allowed on `/health/*` and `/metrics`. Others get 404. */
  readonly opsEndpointCidrs: readonly string[];
  /** Total request time cap (ms). Cannot be 0 — the schema requires a positive value. */
  readonly requestTimeoutMs: number;
  /** Socket idle cap (ms). Refreshed during transfer, so it does not cut large uploads. */
  readonly socketIdleTimeoutMs: number;
}

export interface OidcClientConfig {
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface OidcConfig {
  /** The web origin the providers redirect to, without a trailing slash. */
  readonly redirectBase: string;
  readonly google: OidcClientConfig | null;
  /** `allowedTenants` null: any work or school directory. */
  readonly microsoft: (OidcClientConfig & { readonly allowedTenants: readonly string[] | null }) | null;
}

export class ConfigError extends Error {
  readonly code = "CONFIG_INVALID";
}

/**
 * Reads an empty string as "not given".
 *
 * Deployment platforms inject declared variables as empty strings even without a value.
 * A compose-based platform may put the variable list parsed from the compose file into **every container**, so
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

  const objectStore = configureObjectStore(value);

  return {
    port: value.PORT,
    databaseUrl: value.DATABASE_URL,
    chainId: value.CHAIN_ID,
    sessionSecret: value.SESSION_SECRET,
    nodeEnv: value.NODE_ENV,
    webOrigin: resolveWebOrigin(value),
    emailTransport: resolveEmailTransport(value),
    oidcTestRelayUrl: resolveOidcTestRelay(value),
    webauthn: resolveWebauthn(value, resolveWebOrigin(value)),
    oidc: resolveOidc(value, resolveWebOrigin(value)),
    rateLimitMax: value.RATE_LIMIT_MAX,
    publicRateLimitMax: value.PUBLIC_RATE_LIMIT_MAX ?? value.RATE_LIMIT_MAX,
    authRateLimitMax: value.AUTH_RATE_LIMIT_MAX,
    trustedProxyHops: value.TRUSTED_PROXY_HOPS,
    trustedProxyCidrs: value.TRUSTED_PROXY_CIDRS.split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
    edgeProxySecret: value.EDGE_PROXY_SECRET ?? null,
    // A trailing slash would never equal a browser `Origin` header; normalize once here.
    edgeWebOrigin: value.EDGE_WEB_ORIGIN ? new URL(value.EDGE_WEB_ORIGIN).origin : null,
    opsEndpointCidrs: value.OPS_ENDPOINT_CIDRS.split(",")
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

function resolveWebOrigin(value: z.infer<typeof schema>): string {
  const origin = new URL(value.WEB_ORIGIN);
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new ConfigError("WEB_ORIGIN must be an http(s) origin");
  }
  return origin.origin;
}

function resolveEmailTransport(value: z.infer<typeof schema>): "resend" | "smtp" | "log" {
  try {
    return resolveEmailTransportKind(value.EMAIL_TRANSPORT, value.NODE_ENV);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}

/**
 * The E2E provider relay, validated once. Whoever can set it decides which server the API takes
 * ID tokens and signing keys from, so it exists only where nothing real signs in: refused in
 * production and on mainnet whatever NODE_ENV says (a mainnet process is not made safe by its
 * label).
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "[::1]", "localhost"]);

function resolveOidcTestRelay(value: z.infer<typeof schema>): string | null {
  const raw = value.OIDC_TEST_RELAY_URL;
  if (raw === undefined) return null;
  if (value.NODE_ENV === "production" || value.CHAIN_ID === BSC_MAINNET_CHAIN_ID) {
    throw new ConfigError("OIDC_TEST_RELAY_URL is for test builds only; it cannot be set in production or on mainnet");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("OIDC_TEST_RELAY_URL must be an http(s) URL such as http://127.0.0.1:4555");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.search !== "" || url.hash !== "") {
    throw new ConfigError("OIDC_TEST_RELAY_URL must be an http(s) URL without query or fragment");
  }
  // Loopback only: the relay is the E2E run's own process. A host elsewhere would be a server the
  // API trusts for ID tokens and sends the client secret to, if a non-production deployment were
  // ever given the variable.
  if (!LOOPBACK_HOSTS.has(url.hostname) || url.username !== "" || url.password !== "") {
    throw new ConfigError("OIDC_TEST_RELAY_URL must name this machine (127.0.0.1, [::1] or localhost)");
  }
  return url.href.replace(/\/+$/, "");
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The WebAuthn relying party, validated once.
 *
 * The RP ID must be a bare host name, and the origin's host must be it or a subdomain of it — the
 * browser refuses anything else, so a mismatch would only surface as every passkey failing.
 *
 * The origin is also the web app's origin (`webOrigin`, where invitation links land and the
 * ceremony runs): two different values would mean either mail points at a page whose passkeys
 * the API refuses, or the API accepts ceremonies from a page it never links to.
 */
function resolveWebauthn(
  value: z.infer<typeof schema>,
  webOrigin: string,
): { rpId: string; origin: string } {
  const production = value.NODE_ENV === "production";
  if (production && (!value.WEBAUTHN_RP_ID || !value.WEBAUTHN_ORIGIN)) {
    throw new ConfigError("WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN are required in production");
  }
  const rpId = value.WEBAUTHN_RP_ID ?? new URL(webOrigin).hostname;
  const rawOrigin = value.WEBAUTHN_ORIGIN ?? webOrigin;
  if (!HOST_NAME.test(rpId)) {
    throw new ConfigError("WEBAUTHN_RP_ID must be a lower-case host name without scheme, port or path");
  }
  let origin: URL;
  try {
    origin = new URL(rawOrigin);
  } catch {
    throw new ConfigError("WEBAUTHN_ORIGIN must be an origin such as https://registry.example.com");
  }
  // The browser reports the origin exactly; anything beyond scheme, host and port could never match.
  if (origin.origin !== rawOrigin) {
    throw new ConfigError("WEBAUTHN_ORIGIN must be an origin only — scheme, host and optional port, no path");
  }
  if (origin.protocol !== "https:" && (production || origin.protocol !== "http:")) {
    throw new ConfigError("WEBAUTHN_ORIGIN must use https in production (http only for local development)");
  }
  if (origin.hostname !== rpId && !origin.hostname.endsWith(`.${rpId}`)) {
    throw new ConfigError("WEBAUTHN_ORIGIN's host must be WEBAUTHN_RP_ID or a subdomain of it");
  }
  if (origin.origin !== webOrigin) {
    throw new ConfigError(
      `WEBAUTHN_ORIGIN must equal the web origin (WEB_ORIGIN): ${webOrigin}`,
    );
  }
  return { rpId, origin: origin.origin };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The OIDC client settings, validated once (WP4).
 *
 * A provider needs its client id and secret together. Neither: the provider is off and its
 * routes answer `OIDC_PROVIDER_DISABLED`. One of the two: refused in production, off elsewhere.
 */
function resolveOidc(value: z.infer<typeof schema>, webOrigin: string): OidcConfig {
  const production = value.NODE_ENV === "production";
  const pair = (name: string, id: string | undefined, secret: string | undefined): OidcClientConfig | null => {
    if (id && secret) return { clientId: id, clientSecret: secret };
    if ((id || secret) && production) {
      throw new ConfigError(`${name}_CLIENT_ID and ${name}_CLIENT_SECRET must be set together`);
    }
    return null;
  };

  const rawBase = value.OIDC_REDIRECT_BASE ?? webOrigin;
  let base: URL;
  try {
    base = new URL(rawBase);
  } catch {
    throw new ConfigError("OIDC_REDIRECT_BASE must be an origin such as https://registry.example.com");
  }
  if (base.origin !== rawBase.replace(/\/$/, "")) {
    throw new ConfigError("OIDC_REDIRECT_BASE must be an origin only — scheme, host and optional port, no path");
  }
  if (base.origin !== webOrigin) {
    throw new ConfigError(`OIDC_REDIRECT_BASE must equal the web origin (WEB_ORIGIN): ${webOrigin}`);
  }
  if (production && base.protocol !== "https:") {
    throw new ConfigError("OIDC_REDIRECT_BASE must use https in production");
  }

  let allowedTenants: string[] | null = null;
  if (value.MICROSOFT_ALLOWED_TENANTS !== undefined) {
    allowedTenants = value.MICROSOFT_ALLOWED_TENANTS.split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter((entry) => entry.length > 0);
    if (allowedTenants.length === 0 || allowedTenants.some((entry) => !GUID.test(entry))) {
      throw new ConfigError("MICROSOFT_ALLOWED_TENANTS must be a comma-separated list of directory (tenant) GUIDs");
    }
  }

  const microsoft = pair("MICROSOFT", value.MICROSOFT_CLIENT_ID, value.MICROSOFT_CLIENT_SECRET);
  return {
    redirectBase: base.origin,
    google: pair("GOOGLE", value.GOOGLE_CLIENT_ID, value.GOOGLE_CLIENT_SECRET),
    microsoft: microsoft ? { ...microsoft, allowedTenants } : null,
  };
}

function configureObjectStore(value: z.infer<typeof schema>): ObjectStoreConfig {
  assertObjectStoreConfiguration(value);

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
  return objectStore;
}

function assertObjectStoreConfiguration(value: z.infer<typeof schema>): void {
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
}
