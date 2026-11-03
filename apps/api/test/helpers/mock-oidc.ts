import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from "jose";
import type { OidcFetch } from "../../src/services/oidc.js";

/**
 * An in-process OpenID provider that answers for Google and Microsoft — test builds only.
 *
 * The API is configured with the real issuer URLs (`https://accounts.google.com`,
 * `https://login.microsoftonline.com/organizations/v2.0`); this provider is plugged in as the
 * `fetch` `openid-client` uses, so discovery, the key set and the code exchange all run through
 * the library exactly as in production — including its Entra ID handling of the templated
 * `{tenantid}` issuer — and nothing reaches the internet. Any URL it does not serve throws.
 *
 * It signs ID tokens with its own RSA key and plays the provider's part honestly: a code is
 * redeemed once, only by the client it was issued to, only with the PKCE verifier whose S256
 * challenge was in the authorization request, and only for the redirect URI that request named.
 * Tests bend one thing at a time through `authorize(…, { claims, signWithRogueKey })`.
 */

export const TEST_GOOGLE_CLIENT = { id: "test-google-client.apps.example", secret: "test-google-client-secret" };
export const TEST_MICROSOFT_CLIENT = { id: "5b4f3a2c-0000-4000-8000-00000000c1d1", secret: "test-microsoft-client-secret" };

const GOOGLE = {
  issuer: "https://accounts.google.com",
  discovery: "https://accounts.google.com/.well-known/openid-configuration",
  authorization: "https://accounts.google.com/o/oauth2/v2/auth",
  token: "https://oauth2.googleapis.com/token",
  jwks: "https://www.googleapis.com/oauth2/v3/certs",
};
const MICROSOFT = {
  issuer: "https://login.microsoftonline.com/{tenantid}/v2.0",
  discovery: "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration",
  authorization: "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize",
  token: "https://login.microsoftonline.com/organizations/oauth2/v2.0/token",
  jwks: "https://login.microsoftonline.com/organizations/discovery/v2.0/keys",
};

type Provider = "google" | "microsoft";

interface PendingCode {
  readonly provider: Provider;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly claims: Record<string, unknown>;
  readonly rogue: boolean;
  redeemed: boolean;
}

export interface AuthorizeOptions {
  /** Merged over the default claims; a value of `undefined` removes the claim. */
  readonly claims?: Record<string, unknown>;
  /** Sign with a key that has the published `kid` but is not the published key. */
  readonly signWithRogueKey?: boolean;
}

export interface Authorized {
  readonly code: string;
  readonly state: string;
  readonly nonce: string;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function metadata(endpoints: typeof GOOGLE) {
  return {
    issuer: endpoints.issuer,
    authorization_endpoint: endpoints.authorization,
    token_endpoint: endpoints.token,
    jwks_uri: endpoints.jwks,
    response_types_supported: ["code"],
    subject_types_supported: ["public", "pairwise"],
    id_token_signing_alg_values_supported: ["RS256"],
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
    scopes_supported: ["openid", "email", "profile"],
  };
}

export class MockOidcProvider {
  /** Every URL fetched, in order. */
  readonly requests: string[] = [];
  /** While true every request fails as a network error. */
  down = false;
  private readonly codes = new Map<string, PendingCode>();

  private constructor(
    private readonly kid: string,
    private readonly key: CryptoKey,
    private readonly rogueKey: CryptoKey,
    private readonly jwk: JWK,
  ) {}

  static async create(): Promise<MockOidcProvider> {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const rogue = await generateKeyPair("RS256");
    const kid = randomUUID();
    const jwk = { ...(await exportJWK(publicKey)), kid, alg: "RS256", use: "sig" };
    return new MockOidcProvider(kid, privateKey, rogue.privateKey, jwk);
  }

  /** What the API's `openid-client` calls instead of the network. */
  readonly fetch: OidcFetch = async (url, options) => {
    this.requests.push(url);
    if (this.down) throw new TypeError("fetch failed");
    const method = (options.method ?? "GET").toUpperCase();
    if (method === "GET" && url === GOOGLE.discovery) return json(metadata(GOOGLE));
    if (method === "GET" && url === MICROSOFT.discovery) return json(metadata(MICROSOFT));
    if (method === "GET" && (url === GOOGLE.jwks || url === MICROSOFT.jwks)) return json({ keys: [this.jwk] });
    if (method === "POST" && (url === GOOGLE.token || url === MICROSOFT.token)) {
      return this.token(url === GOOGLE.token ? "google" : "microsoft", options.body);
    }
    throw new Error(`mock OIDC provider: no route for ${method} ${url} — tests never reach the internet`);
  };

  /** How many times a discovery document was fetched. */
  discoveryFetches(provider: Provider): number {
    const url = provider === "google" ? GOOGLE.discovery : MICROSOFT.discovery;
    return this.requests.filter((entry) => entry === url).length;
  }

  /**
   * The person approves at the provider: takes the authorization URL the API produced and returns
   * a code for it, plus the `state` and `nonce` it carried. Default claims are an honest token
   * for a fresh Google `sub` / Microsoft `oid`; `options.claims` overrides them.
   */
  authorize(authorizationUrl: string, options: AuthorizeOptions = {}): Authorized {
    const url = new URL(authorizationUrl);
    const provider: Provider = url.origin + url.pathname === GOOGLE.authorization ? "google" : "microsoft";
    const expected = provider === "google" ? GOOGLE.authorization : MICROSOFT.authorization;
    if (url.origin + url.pathname !== expected) throw new Error(`not an authorization endpoint: ${url.href}`);

    const params = url.searchParams;
    const required = ["client_id", "redirect_uri", "state", "nonce", "code_challenge"];
    for (const name of required) if (!params.get(name)) throw new Error(`authorization request without ${name}`);
    if (params.get("response_type") !== "code") throw new Error("only the code flow is served");
    if (params.get("code_challenge_method") !== "S256") throw new Error("only S256 PKCE is served");

    const now = Math.floor(Date.now() / 1000);
    const clientId = params.get("client_id")!;
    const defaults: Record<string, unknown> = provider === "google"
      ? {
          iss: GOOGLE.issuer,
          aud: clientId,
          sub: `${randomBytes(10).readBigUInt64BE()}`,
          email: `someone-${randomUUID().slice(0, 8)}@gmail.example`,
          email_verified: true,
          iat: now,
          exp: now + 600,
          nonce: params.get("nonce"),
        }
      : (() => {
          const tid = "11111111-1111-4111-8111-111111111111";
          return {
            iss: `https://login.microsoftonline.com/${tid}/v2.0`,
            aud: clientId,
            sub: randomBytes(16).toString("base64url"),
            oid: randomUUID(),
            tid,
            email: `someone-${randomUUID().slice(0, 8)}@contoso.example`,
            iat: now,
            exp: now + 600,
            nonce: params.get("nonce"),
          };
        })();
    const claims: Record<string, unknown> = { ...defaults };
    for (const [name, value] of Object.entries(options.claims ?? {})) {
      if (value === undefined) delete claims[name];
      else claims[name] = value;
    }

    const code = randomBytes(24).toString("base64url");
    this.codes.set(code, {
      provider,
      clientId,
      redirectUri: params.get("redirect_uri")!,
      codeChallenge: params.get("code_challenge")!,
      claims,
      rogue: options.signWithRogueKey === true,
      redeemed: false,
    });
    return { code, state: params.get("state")!, nonce: params.get("nonce")! };
  }

  private async token(provider: Provider, body: unknown): Promise<Response> {
    const form = new URLSearchParams(typeof body === "string" ? body : (body as URLSearchParams | undefined)?.toString() ?? "");
    // What a provider says in `error_description` is attacker-influenced text from the API's
    // point of view; it must never reach a client.
    const refuse = (error: string) =>
      json({ error, error_description: "<script>alert('provider text')</script>" }, 400);

    const client = provider === "google" ? TEST_GOOGLE_CLIENT : TEST_MICROSOFT_CLIENT;
    if (form.get("client_id") !== client.id || form.get("client_secret") !== client.secret) {
      return refuse("invalid_client");
    }
    if (form.get("grant_type") !== "authorization_code") return refuse("unsupported_grant_type");
    const pending = this.codes.get(form.get("code") ?? "");
    if (!pending || pending.redeemed || pending.provider !== provider || pending.clientId !== client.id) {
      return refuse("invalid_grant");
    }
    pending.redeemed = true;
    if (form.get("redirect_uri") !== pending.redirectUri) return refuse("invalid_grant");
    const verifier = form.get("code_verifier") ?? "";
    if (createHash("sha256").update(verifier).digest("base64url") !== pending.codeChallenge) {
      return refuse("invalid_grant");
    }

    const idToken = await new SignJWT(pending.claims)
      .setProtectedHeader({ alg: "RS256", kid: this.kid, typ: "JWT" })
      .sign(pending.rogue ? this.rogueKey : this.key);
    return json({
      access_token: randomBytes(24).toString("base64url"),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
      id_token: idToken,
    });
  }
}
