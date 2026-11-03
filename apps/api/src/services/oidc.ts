import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import * as client from "openid-client";
import { normalizeEmail, type OidcProvider } from "@mpc/api-contract";
import type { OidcConfig } from "../config.js";

/**
 * Google and Microsoft as OpenID Connect providers — WP4. No database here: who may start,
 * claim and complete a flow is the database's (migration 0121) and the route's (`routes/oidc.ts`).
 *
 * What this module guarantees about an identity it returns:
 *
 * - it came from an ID token that `openid-client` validated against the provider's discovered
 *   metadata and keys: signature, `iss`, `aud` (our client id), `exp` / `iat`, `nonce` (the one
 *   sealed for this flow), `azp` where present (checked here as well: the library only does
 *   when `aud` has several entries) — the signature against the provider's published keys
 *   (non-repudiation checks turned on: the library would otherwise trust TLS alone) — after a code exchange bound to this flow's
 *   PKCE verifier and redirect URI;
 * - Google: `iss` is exactly `https://accounts.google.com`; the key is `sub`;
 * - Microsoft (`organizations` endpoint — work and school directories only, plan D2): `iss` is
 *   exactly `https://login.microsoftonline.com/{tid}/v2.0` for the token's **own** `tid` (the
 *   library checks it against the templated issuer, and this module again); the key is
 *   `(tid, oid)`; a directory outside `MICROSOFT_ALLOWED_TENANTS` is refused;
 * - `verifiedEmail` is set only when the provider vouches for the address *now*: Google
 *   `email_verified` for a Gmail address, or for an address in the Workspace domain the token's
 *   `hd` names (for any other address a consumer Google account's `email_verified` dates from
 *   sign-up and outlives a change of hands — `emailCodeRequired` says so instead); Microsoft
 *   `xms_edov`. It is used for one thing: accepting an invitation
 *   sent to that address. It never finds an account.
 *
 * Network: discovery and keys are fetched with a timeout and cached per provider; a failed
 * discovery is not cached, so the next request tries again. Tests pass their own `fetch` (an
 * in-process provider); nothing here reaches the internet unless the deployment turns a
 * provider on.
 */

export const GOOGLE_ISSUER = "https://accounts.google.com";
/** Multi-tenant v2.0 endpoint for work and school accounts (no personal Microsoft accounts). */
export const MICROSOFT_AUTHORITY = "https://login.microsoftonline.com/organizations/v2.0";
/** The directory personal Microsoft accounts sign in from; never accepted. */
export const MICROSOFT_CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** HKDF `info` for the key that seals a flow's PKCE verifier and nonce (plan D10). */
export const OIDC_TX_KEY_INFO = "mpc/oidc-tx/v1";

const SCOPE = "openid email profile";
const DISCOVERY_TIMEOUT_SECONDS = 5;
const EXCHANGE_TIMEOUT_SECONDS = 10;
/** Discovery is refreshed this often; keys follow the library's own cache within it. */
const METADATA_TTL_MS = 60 * 60 * 1000;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUBJECT_KEY = /^[!-~]{1,255}$/;

/** What `openid-client` calls to reach a provider. Tests replace it; production uses `fetch`. */
export type OidcFetch = (url: string, options: client.CustomFetchOptions) => Promise<Response>;

export type OidcFailure =
  /** The provider could not be reached or answered with something other than a token. */
  | "provider_unavailable"
  /** The code exchange or the ID token failed validation. */
  | "token_invalid"
  /** A Microsoft directory outside the allowlist, or a personal account. */
  | "tenant_not_allowed";

export class OidcError extends Error {
  constructor(
    readonly failure: OidcFailure,
    /** A short code for logs and audit (`OAUTH_JWT_CLAIM_COMPARISON`, …). Never provider text. */
    readonly reason: string,
  ) {
    super(`${failure}: ${reason}`);
  }
}

export interface VerifiedIdentity {
  readonly provider: OidcProvider;
  /** The token's `iss`, exactly. */
  readonly issuer: string;
  /** Google `sub`, Microsoft `oid`. */
  readonly subjectKey: string;
  /** Microsoft `tid`; null for Google. */
  readonly idpTenant: string | null;
  /** Normalised address the provider verified, or null. Only for invitation acceptance. */
  readonly verifiedEmail: string | null;
  /** Normalised address the token reported, verified or not — kept only as a keyed hash. */
  readonly reportedEmail: string | null;
  /**
   * Google reported the address verified, but neither Gmail nor the Workspace domain in `hd`
   * holds it, so the verification may be years old and someone else's. An invitation to it is
   * accepted with the emailed code only.
   */
  readonly emailCodeRequired: boolean;
}

/** Addresses Google itself issues; `email_verified` for these is current. */
const GOOGLE_MAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

export interface FlowSecrets {
  readonly codeVerifier: string;
  readonly nonce: string;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** A fresh `state`, browser binding, nonce or PKCE verifier: 32 random bytes, base64url. */
export function randomFlowToken(): string {
  return randomBytes(32).toString("base64url");
}

export function deriveOidcTxKey(sessionSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", sessionSecret, Buffer.alloc(0), OIDC_TX_KEY_INFO, 32));
}

function txAad(transactionId: string): Buffer {
  return Buffer.from(`mpc/oidc-tx/${transactionId}`, "utf8");
}

/** AES-256-GCM of the verifier and nonce, bound to the transaction row: `iv ‖ ciphertext ‖ tag`. */
export function sealFlowSecrets(key: Buffer, transactionId: string, secrets: FlowSecrets): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(txAad(transactionId));
  const body = Buffer.concat([cipher.update(JSON.stringify(secrets), "utf8"), cipher.final()]);
  return Buffer.concat([iv, body, cipher.getAuthTag()]);
}

/** Throws when the key, the row or the bytes are not the ones it was sealed with. */
export function openFlowSecrets(key: Buffer, transactionId: string, sealed: Uint8Array): FlowSecrets {
  const bytes = Buffer.from(sealed);
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  decipher.setAAD(txAad(transactionId));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  const plain = Buffer.concat([decipher.update(bytes.subarray(12, bytes.length - 16)), decipher.final()]);
  const parsed = JSON.parse(plain.toString("utf8")) as Partial<FlowSecrets>;
  if (typeof parsed.codeVerifier !== "string" || typeof parsed.nonce !== "string") {
    throw new Error("sealed flow secrets are malformed");
  }
  return { codeVerifier: parsed.codeVerifier, nonce: parsed.nonce };
}

/** Google sends `email_verified` as a boolean; older tokens used the string. */
function isTrue(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function stringClaim(claims: client.IDToken, name: string): string | null {
  const value = (claims as Record<string, unknown>)[name];
  return typeof value === "string" ? value : null;
}

function emailOf(claims: client.IDToken): string | null {
  const raw = stringClaim(claims, "email");
  return raw === null ? null : normalizeEmail(raw);
}

export class OidcProviders {
  private readonly cache = new Map<OidcProvider, { at: number; configuration: Promise<client.Configuration> }>();

  constructor(
    private readonly config: OidcConfig,
    private readonly fetchImpl: OidcFetch | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  enabled(provider: OidcProvider): boolean {
    return this.config[provider] !== null;
  }

  redirectUri(provider: OidcProvider): string {
    return `${this.config.redirectBase}/auth/oidc/${provider}/callback`;
  }

  private settings(provider: OidcProvider) {
    const settings = this.config[provider];
    if (settings === null) throw new Error(`OIDC provider ${provider} is not configured`);
    return settings;
  }

  /** The provider's discovered metadata and client, cached; a failure is retried next time. */
  private configuration(provider: OidcProvider): Promise<client.Configuration> {
    const cached = this.cache.get(provider);
    if (cached && this.now() - cached.at < METADATA_TTL_MS) return cached.configuration;

    const settings = this.settings(provider);
    const server = new URL(provider === "google" ? GOOGLE_ISSUER : MICROSOFT_AUTHORITY);
    const configuration = client
      .discovery(server, settings.clientId, settings.clientSecret, undefined, {
        timeout: DISCOVERY_TIMEOUT_SECONDS,
        ...(this.fetchImpl ? { [client.customFetch]: this.fetchImpl } : {}),
      })
      .then((discovered) => {
        discovered.timeout = EXCHANGE_TIMEOUT_SECONDS;
        if (this.fetchImpl) discovered[client.customFetch] = this.fetchImpl;
        // OIDC Core 3.1.3.7 lets a client skip the ID token's signature when it came straight
        // from the token endpoint over TLS, and `openid-client` does by default. We verify it
        // against the provider's published keys anyway: the token is the only evidence of who
        // signed in, and a TLS-terminating proxy or a misrouted token endpoint must not be
        // enough to forge it.
        client.enableNonRepudiationChecks(discovered);
        return discovered;
      });
    this.cache.set(provider, { at: this.now(), configuration });
    configuration.catch(() => {
      if (this.cache.get(provider)?.configuration === configuration) this.cache.delete(provider);
    });
    return configuration;
  }

  /** The URL to send the browser to: code flow, PKCE S256, `state` and `nonce`. */
  async authorizationUrl(
    provider: OidcProvider,
    flow: { readonly state: string; readonly nonce: string; readonly codeVerifier: string },
  ): Promise<string> {
    let configuration: client.Configuration;
    try {
      configuration = await this.configuration(provider);
    } catch (caught) {
      throw new OidcError("provider_unavailable", errorCode(caught));
    }
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: this.redirectUri(provider),
      response_type: "code",
      scope: SCOPE,
      state: flow.state,
      nonce: flow.nonce,
      code_challenge: await client.calculatePKCECodeChallenge(flow.codeVerifier),
      code_challenge_method: "S256",
      // Let the person choose the account rather than reuse whichever is signed in.
      prompt: "select_account",
    });
    return url.href;
  }

  /**
   * Exchanges the code and validates the ID token. `redirectUri` is the one stored with the
   * flow; it must be the one the code was issued for.
   */
  async exchange(
    provider: OidcProvider,
    flow: {
      readonly redirectUri: string;
      readonly state: string;
      readonly code: string;
      readonly iss?: string | undefined;
      readonly secrets: FlowSecrets;
    },
  ): Promise<VerifiedIdentity> {
    let configuration: client.Configuration;
    try {
      configuration = await this.configuration(provider);
    } catch (caught) {
      throw new OidcError("provider_unavailable", errorCode(caught));
    }

    const callback = new URL(flow.redirectUri);
    callback.searchParams.set("code", flow.code);
    callback.searchParams.set("state", flow.state);
    if (flow.iss !== undefined) callback.searchParams.set("iss", flow.iss);

    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(configuration, callback, {
        pkceCodeVerifier: flow.secrets.codeVerifier,
        expectedState: flow.state,
        expectedNonce: flow.secrets.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch (caught) {
      throw new OidcError(isUnreachable(caught) ? "provider_unavailable" : "token_invalid", errorCode(caught));
    }
    if (claims === undefined) throw new OidcError("token_invalid", "ID_TOKEN_MISSING");
    // The library compares `azp` only when `aud` lists several clients; a token minted for
    // another client of the same provider and naming it as `azp` is not ours either.
    const azp = (claims as Record<string, unknown>)["azp"];
    if (azp !== undefined && azp !== this.settings(provider).clientId) {
      throw new OidcError("token_invalid", "ID_TOKEN_AZP_MISMATCH");
    }

    return provider === "google" ? this.google(claims) : this.microsoft(claims);
  }

  private google(claims: client.IDToken): VerifiedIdentity {
    if (claims.iss !== GOOGLE_ISSUER || typeof claims.sub !== "string" || !SUBJECT_KEY.test(claims.sub)) {
      throw new OidcError("token_invalid", "GOOGLE_CLAIMS_INVALID");
    }
    const email = emailOf(claims);
    const verified = email !== null && isTrue((claims as Record<string, unknown>)["email_verified"]);
    const domain = email === null ? null : email.slice(email.lastIndexOf("@") + 1);
    const hd = stringClaim(claims, "hd")?.toLowerCase() ?? null;
    const managed = domain !== null && (GOOGLE_MAIL_DOMAINS.has(domain) || (hd !== null && hd === domain));
    return {
      provider: "google",
      issuer: GOOGLE_ISSUER,
      subjectKey: claims.sub,
      idpTenant: null,
      verifiedEmail: verified && managed ? email : null,
      reportedEmail: email,
      emailCodeRequired: verified && !managed,
    };
  }

  private microsoft(claims: client.IDToken): VerifiedIdentity {
    const tid = stringClaim(claims, "tid");
    const oid = stringClaim(claims, "oid");
    // The library already compared `iss` with the templated issuer filled in with this token's
    // `tid`; checked again here so the rule does not rest on a library detail. A token whose
    // `iss` names one directory and whose `tid` names another is someone else's directory.
    if (
      tid === null || !GUID.test(tid) || oid === null || !GUID.test(oid)
      || claims.iss !== `https://login.microsoftonline.com/${tid}/v2.0`
    ) {
      throw new OidcError("token_invalid", "MICROSOFT_CLAIMS_INVALID");
    }
    const allowed = this.settings("microsoft") as NonNullable<OidcConfig["microsoft"]>;
    if (tid === MICROSOFT_CONSUMER_TENANT || (allowed.allowedTenants !== null && !allowed.allowedTenants.includes(tid))) {
      throw new OidcError("tenant_not_allowed", "MICROSOFT_TENANT_NOT_ALLOWED");
    }
    const email = emailOf(claims);
    return {
      provider: "microsoft",
      issuer: claims.iss,
      subjectKey: oid,
      idpTenant: tid,
      // `email` in a Microsoft token is whatever the directory holds, which its admin can set to
      // anything; `xms_edov` says the domain owner verified it (optional claim on the app).
      verifiedEmail: email !== null && isTrue((claims as Record<string, unknown>)["xms_edov"]) ? email : null,
      reportedEmail: email,
      emailCodeRequired: false,
    };
  }
}

/** Network failure or timeout, as opposed to a token that failed a check. */
function isUnreachable(caught: unknown): boolean {
  const code = (caught as { code?: unknown } | null)?.code;
  if (code === "OAUTH_TIMEOUT" || code === "OAUTH_ABORT") return true;
  if (caught instanceof client.ResponseBodyError) return false;
  // `fetch` failures surface as a TypeError (possibly wrapped by the library).
  return caught instanceof TypeError || (caught as { cause?: unknown } | null)?.cause instanceof TypeError;
}

/** A short, provider-independent code for logs and audit. Never a message or response body. */
function errorCode(caught: unknown): string {
  const code = (caught as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "OIDC_ERROR";
}
