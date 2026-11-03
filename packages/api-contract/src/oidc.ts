import { z } from "zod";
import { sessionResponse } from "./auth.js";
import { displayName, invitationToken } from "./accounts.js";
import { isoDateTime } from "./common.js";
import type { RouteDefinition } from "./routes.js";

/**
 * Google and Microsoft sign-in — account authentication WP4 (decisions D1, D2, D6; plan §3).
 *
 * Rules the schemas below only describe, and the API and database (migrations 0120–0121)
 * enforce:
 *
 * - **An identity is matched only by its key**: Google `(iss, sub)`, Microsoft `(tid, oid)`.
 *   The email in a token never finds an account, so a provider account that merely claims a
 *   person's address signs nobody in (`OIDC_ACCOUNT_NOT_FOUND`, the same answer as for any
 *   identity that is not linked).
 * - **Sign-in only for a linked identity.** No account is created by signing in; accounts come
 *   from invitations (D5).
 * - **Linking** needs a session past its second factor (aal2+) and comes back to the same
 *   session. An identity linked anywhere — this account, another one, another tenant — answers
 *   the one code `OIDC_IDENTITY_UNAVAILABLE` (D6).
 * - **Accepting an invitation** with Google or Microsoft instead of an emailed code works only
 *   when the provider verified the invited address for this token (Google `email_verified`;
 *   Microsoft the `xms_edov` claim). The account starts with no role, as with a code.
 * - A Google or Microsoft session is first-factor only (`aal1`), like an email-code session.
 * - The flow is the authorization code flow with PKCE (S256), `state` and `nonce`. `start`
 *   returns, besides the provider URL, a `browserBinding` the client keeps (WP6: in an HttpOnly
 *   cookie on the web origin) and sends back with the callback; a callback carrying someone
 *   else's `state` and `code` without it is refused (login CSRF). One callback per `state`.
 * - The provider redirects to `<WEB_ORIGIN>/auth/oidc/{provider}/callback`, a web page that posts
 *   `state` and `code` (or the provider's `error`) to the matching callback route here. A
 *   provider's error text is never echoed.
 */

export const OIDC_PROVIDERS = ["google", "microsoft"] as const;
export const oidcProvider = z.enum(OIDC_PROVIDERS);
export type OidcProvider = z.infer<typeof oidcProvider>;

/** Minutes a started flow stays usable. */
export const OIDC_TRANSACTION_TTL_MINUTES = 10;

/** 32 random bytes, base64url without padding. */
const randomToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Must be a 43-character base64url token");

export const oidcProviderParams = z.object({ provider: oidcProvider });

export const oidcSignInStartRequest = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("sign_in") }),
  z.object({
    purpose: z.literal("invitation_accept"),
    invitationToken,
    displayName,
  }),
]);

export const oidcStartResponse = z.object({
  /** Where to send the browser. */
  authorizationUrl: z.string().url(),
  /**
   * Proof that the callback returns to the browser that started the flow. Keep it out of
   * script-readable storage where possible and send it back with the callback; never put it in
   * a URL.
   */
  browserBinding: randomToken,
  expiresAt: isoDateTime,
});

/** What the provider sent to the redirect page, forwarded as is (`state` and `code`). */
export const oidcCallbackRequest = z.union([
  z.object({
    state: randomToken,
    browserBinding: randomToken,
    code: z.string().min(1).max(4096).regex(/^[!-~]+$/, "Must be printable ASCII"),
    /** RFC 9207 `iss`, when the provider sends one. */
    iss: z.string().url().max(512).optional(),
  }),
  z.object({
    state: randomToken,
    browserBinding: randomToken,
    /**
     * The provider's `error` (RFC 6749 §4.1.2.1), e.g. `access_denied`. Only the code is taken;
     * its description is never forwarded or echoed.
     */
    error: z.string().regex(/^[a-z_]{1,64}$/, "Must be an OAuth error code"),
  }),
]);

export const externalIdentity = z.object({
  id: z.string(),
  provider: oidcProvider,
  /** The ID token issuer. For Microsoft it names the person's directory. */
  issuer: z.string(),
  /** Microsoft directory (`tid`). Null for Google. */
  idpTenant: z.string().nullable(),
  /** `link` from settings, or `invitation` when the account was created with it. */
  linkedVia: z.enum(["link", "invitation"]),
  createdAt: isoDateTime,
  lastUsedAt: isoDateTime.nullable(),
  /** Set once unlinked. An unlinked identity no longer signs in. */
  revokedAt: isoDateTime.nullable(),
});

export const externalIdentityList = z.object({
  items: z.array(externalIdentity),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const unlinkIdentityResponse = z.object({
  /** Other sessions that this identity had signed in, now ended. */
  revokedSessions: z.number().int().nonnegative(),
  /** True when this session was signed in with the identity: it ended too. */
  currentSessionEnded: z.boolean(),
});

// --- Refusal codes ----------------------------------------------------------

/** No live account is linked to this identity. Same answer whatever the token's email says. */
export const OIDC_ACCOUNT_NOT_FOUND = "OIDC_ACCOUNT_NOT_FOUND";
/** The identity is already linked — to this account or any other, in any tenant. */
export const OIDC_IDENTITY_UNAVAILABLE = "OIDC_IDENTITY_UNAVAILABLE";
/**
 * Google says the address is verified, but Google does not manage it — a consumer Google account
 * on an address that is not Gmail, whose verification dates from sign-up. Accept the invitation
 * with the emailed code instead.
 */
export const OIDC_EMAIL_CODE_REQUIRED = "OIDC_EMAIL_CODE_REQUIRED";

const publicOidcRoute = {
  public: true,
  mutation: false,
  requiresIfMatch: false,
  action: null,
  implemented: true,
} as const;

/**
 * Self-service routes act on the caller's own session: no role, no Idempotency-Key (as the MFA
 * routes). They are not reachable from a first-factor-only session: linking and unlinking need
 * aal2, and so does reading the list (it says how the account can be reached).
 */
const self = {
  public: false,
  mutation: false,
  requiresIfMatch: false,
  action: null,
  implemented: true,
} as const;

export const OIDC_ROUTES: readonly RouteDefinition[] = [
  {
    ...publicOidcRoute,
    method: "post",
    path: "/api/v1/auth/oidc/{provider}/start",
    summary: "Start Google / Microsoft sign-in, or accepting an invitation with it",
    operationId: "startOidcSignIn",
    paramsSchema: oidcProviderParams,
    requestSchema: oidcSignInStartRequest,
    responseSchema: oidcStartResponse,
    refusals: ["OIDC_PROVIDER_DISABLED", "INVITATION_INVALID", "RATE_LIMITED"],
  },
  {
    ...publicOidcRoute,
    method: "post",
    path: "/api/v1/auth/oidc/{provider}/callback",
    summary: "Finish Google / Microsoft sign-in — an aal1 session for a linked identity only",
    operationId: "completeOidcSignIn",
    paramsSchema: oidcProviderParams,
    requestSchema: oidcCallbackRequest,
    responseSchema: sessionResponse,
    refusals: [
      "OIDC_STATE_INVALID",
      "OIDC_TOKEN_INVALID",
      "OIDC_ACCESS_DENIED",
      "OIDC_PROVIDER_ERROR",
      OIDC_ACCOUNT_NOT_FOUND,
      OIDC_IDENTITY_UNAVAILABLE,
      "OIDC_EMAIL_NOT_VERIFIED",
      OIDC_EMAIL_CODE_REQUIRED,
      "OIDC_EMAIL_MISMATCH",
      "OIDC_TENANT_NOT_ALLOWED",
      "INVITATION_INVALID",
    ],
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/oidc/{provider}/link/start",
    summary: "Start linking a Google / Microsoft identity to this account — needs aal2",
    operationId: "startOidcLink",
    paramsSchema: oidcProviderParams,
    responseSchema: oidcStartResponse,
    refusals: ["OIDC_PROVIDER_DISABLED", "MFA_STEP_UP_REQUIRED", "RATE_LIMITED"],
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/oidc/{provider}/link/callback",
    summary: "Finish linking — on the session that started it",
    operationId: "completeOidcLink",
    paramsSchema: oidcProviderParams,
    requestSchema: oidcCallbackRequest,
    responseSchema: externalIdentity,
    refusals: [
      "OIDC_STATE_INVALID",
      "OIDC_TOKEN_INVALID",
      "OIDC_ACCESS_DENIED",
      "OIDC_PROVIDER_ERROR",
      OIDC_IDENTITY_UNAVAILABLE,
      "OIDC_PROVIDER_ALREADY_LINKED",
      "OIDC_TENANT_NOT_ALLOWED",
      "MFA_STEP_UP_REQUIRED",
    ],
  },
  {
    ...self,
    method: "get",
    path: "/api/v1/auth/identities",
    summary: "The Google / Microsoft identities linked to this account",
    operationId: "listExternalIdentities",
    responseSchema: externalIdentityList,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/identities/{identityId}/unlink",
    summary: "Unlink an identity — needs aal2; ends the sessions it signed in",
    operationId: "unlinkExternalIdentity",
    responseSchema: unlinkIdentityResponse,
    refusals: ["MFA_STEP_UP_REQUIRED", "OIDC_LAST_SIGN_IN_METHOD"],
  },
];
