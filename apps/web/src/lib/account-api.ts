import { ApiError, apiFetch, type ApiErrorEnvelope, type AuthenticationLevel } from "./api";

/**
 * Account API client — WP2 (email codes, invitations, email change), WP3 (second factors),
 * WP4 (Google / Microsoft) and WP5 (wallets as signing keys).
 *
 * Every call is same-origin and carries no credential of its own: the web server attaches the
 * session from its HttpOnly cookie (`proxy.ts`). The answers that issue a session or start a
 * provider flow reach this code without the token or the browser binding — the server keeps
 * those as cookies.
 */

async function parse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = (text === "" ? null : JSON.parse(text)) as unknown;
  if (!response.ok) throw new ApiError(response.status, body as ApiErrorEnvelope);
  return body as T;
}

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return apiFetch(path, {
    method: "POST",
    headers: body === undefined ? headers : { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function get(path: string): Promise<Response> {
  return apiFetch(path, { cache: "no-store" });
}

// --- Sign-in methods and first factor -------------------------------------------------------

export interface AuthMethods {
  emailCode: true;
  google: boolean;
  microsoft: boolean;
  emailCodeDigits: number;
  emailCodeTtlMinutes: number;
}

export async function getAuthMethods(): Promise<AuthMethods> {
  return parse<AuthMethods>(await get("/api/v1/auth/methods"));
}

export interface CodeSent {
  accepted: true;
  message: string;
  expiresInMinutes: number;
}

/** Same answer whether or not the address has an account. */
export async function startEmailSignIn(email: string): Promise<CodeSent> {
  return parse<CodeSent>(await post("/api/v1/auth/email/start", { email }));
}

/** The issued session, as the session route shows it. The token became a cookie on the way. */
export interface IssuedSession {
  expiresAt: string;
  aal: AuthenticationLevel;
  subjectId: string | null;
  recoveryLimited?: boolean;
}

export async function verifyEmailSignIn(email: string, code: string): Promise<IssuedSession> {
  return parse<IssuedSession>(await post("/api/v1/auth/email/verify", { email, code }));
}

export async function startInvitationAcceptance(token: string): Promise<{ expiresInMinutes: number }> {
  return parse<{ expiresInMinutes: number }>(
    await post("/api/v1/auth/invitations/accept/start", { token }),
  );
}

export async function verifyInvitationAcceptance(
  token: string,
  code: string,
  displayName: string,
): Promise<IssuedSession> {
  return parse<IssuedSession>(
    await post("/api/v1/auth/invitations/accept/verify", { token, code, displayName }),
  );
}

export async function startEmailChangeVerification(email: string): Promise<CodeSent> {
  return parse<CodeSent>(await post("/api/v1/auth/email-change/start", { email }));
}

export async function verifyEmailChange(
  email: string,
  code: string,
): Promise<{ completed: true; sessionsRevoked: true }> {
  return parse<{ completed: true; sessionsRevoked: true }>(
    await post("/api/v1/auth/email-change/verify", { email, code }),
  );
}

// --- Google / Microsoft ---------------------------------------------------------------------

export type OidcProvider = "google" | "microsoft";

export type OidcStart =
  | { purpose: "sign_in" }
  | { purpose: "invitation_accept"; invitationToken: string; displayName: string };

/** Where to send the browser. The binding is kept by the web server as an HttpOnly cookie. */
export async function startOidc(
  provider: OidcProvider,
  start: OidcStart,
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  return parse<{ authorizationUrl: string; expiresAt: string }>(
    await post(`/api/v1/auth/oidc/${provider}/start`, start),
  );
}

export async function startOidcLink(
  provider: OidcProvider,
): Promise<{ authorizationUrl: string; expiresAt: string }> {
  return parse<{ authorizationUrl: string; expiresAt: string }>(
    await post(`/api/v1/auth/oidc/${provider}/link/start`),
  );
}

export type OidcCallbackInput =
  | { state: string; code: string; iss?: string }
  | { state: string; error: string };

/**
 * Finishes the flow this browser started. The web server adds the binding from its cookie and
 * picks the sign-in or the link route by the purpose it kept; `purpose` says which one ran.
 */
export async function completeOidc(
  provider: OidcProvider,
  input: OidcCallbackInput,
): Promise<{ purpose: "sign_in" | "invitation_accept" | "link" }> {
  const response = await post(`/api/v1/auth/oidc/${provider}/callback`, input);
  await parse<unknown>(response);
  const purpose = response.headers.get("x-mpc-oidc-purpose");
  return {
    purpose: purpose === "link" || purpose === "invitation_accept" ? purpose : "sign_in",
  };
}

export interface ExternalIdentity {
  id: string;
  provider: OidcProvider;
  issuer: string;
  idpTenant: string | null;
  linkedVia: "link" | "invitation";
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export async function listIdentities(): Promise<{ items: ExternalIdentity[] }> {
  return parse<{ items: ExternalIdentity[] }>(await get("/api/v1/auth/identities"));
}

export async function unlinkIdentity(
  identityId: string,
): Promise<{ revokedSessions: number; currentSessionEnded: boolean }> {
  return parse<{ revokedSessions: number; currentSessionEnded: boolean }>(
    await post(`/api/v1/auth/identities/${identityId}/unlink`),
  );
}

// --- Second factors -------------------------------------------------------------------------

export type EnrolmentVerdict =
  | "allowed"
  | "MFA_STEP_UP_REQUIRED"
  | "MFA_ENROLMENT_WINDOW_CLOSED"
  | "MFA_PASSKEY_REQUIRED"
  | "MFA_TOTP_ALREADY_ENROLLED";

export interface Passkey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  transports: string[];
  deviceType: "singleDevice" | "multiDevice";
  backedUp: boolean;
}

export interface MfaStatus {
  passkeyEnrolled: boolean;
  totpEnrolled: boolean;
  recoveryCodesRemaining: number | null;
  recoveryLimited: boolean;
  enrolment: { passkey: EnrolmentVerdict; totp: EnrolmentVerdict };
  passkeys: Passkey[];
}

export async function getMfaStatus(): Promise<MfaStatus> {
  return parse<MfaStatus>(await get("/api/v1/auth/mfa"));
}

export interface FactorResult {
  aal: AuthenticationLevel;
  secondFactor: "passkey" | "totp" | "recovery_code" | null;
  /** The first set only, shown once. */
  recoveryCodes: string[] | null;
  /** A recovery completed: every session ended, this one too. Sign in again. */
  sessionEnded: boolean;
}

export async function passkeyRegistrationOptions(): Promise<{ options: Record<string, unknown> }> {
  return parse<{ options: Record<string, unknown> }>(
    await post("/api/v1/auth/mfa/passkeys/registration/options"),
  );
}

export async function verifyPasskeyRegistration(
  response: unknown,
  name?: string,
): Promise<FactorResult> {
  return parse<FactorResult>(
    await post("/api/v1/auth/mfa/passkeys/registration/verify", {
      response,
      ...(name ? { name } : {}),
    }),
  );
}

export async function passkeyAuthenticationOptions(): Promise<{ options: Record<string, unknown> }> {
  return parse<{ options: Record<string, unknown> }>(
    await post("/api/v1/auth/mfa/passkeys/authentication/options"),
  );
}

export async function verifyPasskeyAuthentication(response: unknown): Promise<FactorResult> {
  return parse<FactorResult>(
    await post("/api/v1/auth/mfa/passkeys/authentication/verify", { response }),
  );
}

export async function renamePasskey(passkeyId: string, name: string): Promise<Passkey> {
  return parse<Passkey>(
    await apiFetch(`/api/v1/auth/mfa/passkeys/${passkeyId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    }),
  );
}

export interface RemovedFactor {
  revokedSessions: number;
  currentSessionEnded: boolean;
}

export async function removePasskey(passkeyId: string): Promise<RemovedFactor> {
  return parse<RemovedFactor>(await post(`/api/v1/auth/mfa/passkeys/${passkeyId}/removal`));
}

export async function setupTotp(): Promise<{ otpauthUri: string; secret: string; expiresAt: string }> {
  return parse<{ otpauthUri: string; secret: string; expiresAt: string }>(
    await post("/api/v1/auth/mfa/totp/setup"),
  );
}

export async function confirmTotp(code: string): Promise<FactorResult> {
  return parse<FactorResult>(await post("/api/v1/auth/mfa/totp/confirm", { code }));
}

export async function verifyTotp(code: string): Promise<FactorResult> {
  return parse<FactorResult>(await post("/api/v1/auth/mfa/totp/verify", { code }));
}

export async function removeTotp(): Promise<RemovedFactor> {
  return parse<RemovedFactor>(await post("/api/v1/auth/mfa/totp/removal"));
}

export async function redeemRecoveryCode(
  code: string,
): Promise<{ aal: AuthenticationLevel; recoveryLimited: true; revokedSessions: number }> {
  return parse<{ aal: AuthenticationLevel; recoveryLimited: true; revokedSessions: number }>(
    await post("/api/v1/auth/mfa/recovery-codes/verify", { code }),
  );
}

export async function regenerateRecoveryCodes(): Promise<{ recoveryCodes: string[] }> {
  return parse<{ recoveryCodes: string[] }>(await post("/api/v1/auth/mfa/recovery-codes"));
}

// --- Wallets as signing keys ----------------------------------------------------------------

export interface AccountWallet {
  id: string;
  walletAddress: string;
  chainId: number;
  boundVia: "operator" | "proof";
  boundAt: string | null;
  /** Null for the account's one active wallet, which signs and is the governance wallet. */
  disabledAt: string | null;
}

export interface ReplacedWallet {
  id: string;
  walletAddress: string;
  chainId: number;
}

// --- Own sessions (WP7) -------------------------------------------------------------------------

/** One of the account's live sessions. No token: the list says where, never how to be signed in. */
export interface AccountSessionItem {
  id: string;
  firstFactor: string;
  secondFactor: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  current: boolean;
}

export async function listSessions(): Promise<{ items: AccountSessionItem[] }> {
  return parse<{ items: AccountSessionItem[] }>(await get("/api/v1/auth/sessions"));
}

/** Ends one of the account's own sessions. A session that is not the caller's answers 404. */
export async function revokeSession(
  sessionId: string,
): Promise<{ id: string; revoked: boolean; current: boolean }> {
  return parse(await post(`/api/v1/auth/sessions/${encodeURIComponent(sessionId)}/revocation`));
}

export async function listWallets(): Promise<{ items: AccountWallet[] }> {
  return parse<{ items: AccountWallet[] }>(await get("/api/v1/auth/wallets"));
}

export interface WalletBindingChallenge {
  challengeId: string;
  walletAddress: string;
  chainId: number;
  /** The account's current wallet this binding replaces, or null for a first binding. */
  replaces: ReplacedWallet | null;
  humanReadablePayload: string;
  typedData: {
    domain: Record<string, unknown>;
    primaryType: string;
    types: Record<string, { name: string; type: string }[]>;
    message: Record<string, unknown>;
  };
  expiresAt: string;
}

export async function createWalletBindingChallenge(walletAddress: string): Promise<WalletBindingChallenge> {
  return parse<WalletBindingChallenge>(
    await post("/api/v1/auth/wallets/binding-challenges", { walletAddress }),
  );
}

export type WalletReplaceReason = "rotation" | "key_lost" | "key_compromised";

export async function bindWallet(
  challengeId: string,
  signature: string,
  replaceReason?: WalletReplaceReason,
): Promise<AccountWallet & { replaced: ReplacedWallet | null }> {
  return parse<AccountWallet & { replaced: ReplacedWallet | null }>(
    await post("/api/v1/auth/wallets", { challengeId, signature, ...(replaceReason ? { replaceReason } : {}) }),
  );
}

export async function disableOwnWallet(
  walletId: string,
  input: { reasonCode: string; detail: string },
): Promise<{ id: string; disabledAt: string; revokedSessions: number }> {
  return parse<{ id: string; disabledAt: string; revokedSessions: number }>(
    await post(`/api/v1/auth/wallets/${walletId}/disable`, input),
  );
}

// --- Administration -------------------------------------------------------------------------

export interface Invitation {
  id: string;
  email: string;
  organizationId: string;
  state: "pending" | "accepted" | "revoked" | "expired";
  invitedBySubjectId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  acceptedSubjectId: string | null;
  revokedAt: string | null;
  /** `inviter_suspended`: the inviter's suspension closed it (`expired`), not its expiry. */
  closedReason: Extract<ClosedReason, "inviter_suspended"> | null;
  version: number;
}

/** Why a suspension closed a request (0132), or `null`: the request ended, or is open, by its own state. */
export type ClosedReason = "inviter_suspended" | "subject_suspended" | "proposer_suspended" | "approver_suspended";

export async function listInvitations(): Promise<{ items: Invitation[] }> {
  return parse<{ items: Invitation[] }>(await get("/api/v1/admin/invitations"));
}

export async function createInvitation(
  key: string,
  input: { email: string; organizationId: string },
): Promise<Invitation> {
  return parse<Invitation>(await post("/api/v1/admin/invitations", input, { "idempotency-key": key }));
}

export async function revokeInvitation(key: string, invitationId: string, version: number): Promise<Invitation> {
  return parse<Invitation>(
    await post(`/api/v1/admin/invitations/${invitationId}/revoke`, undefined, {
      "idempotency-key": key,
      "if-match": `"${version}"`,
    }),
  );
}

export interface EmailChange {
  id: string;
  subjectId: string;
  newEmail: string;
  reason: string;
  requestedBySubjectId: string;
  requestedAt: string;
  state: "pending" | "approved" | "rejected" | "completed" | "expired";
  decidedBySubjectId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  completedAt: string | null;
  /** A suspension of the person, the proposer or the approver closed it (`expired`). */
  closedReason: Exclude<ClosedReason, "inviter_suspended"> | null;
  version: number;
}

export async function listEmailChanges(): Promise<{ items: EmailChange[] }> {
  return parse<{ items: EmailChange[] }>(await get("/api/v1/admin/email-changes"));
}

export async function createEmailChange(
  key: string,
  input: { subjectId: string; newEmail: string; reason: string },
): Promise<EmailChange> {
  return parse<EmailChange>(await post("/api/v1/admin/email-changes", input, { "idempotency-key": key }));
}

export type Decision = { decision: "approve" | "reject"; reason: string };

export async function decideEmailChange(
  key: string,
  changeId: string,
  version: number,
  input: Decision,
): Promise<EmailChange> {
  return parse<EmailChange>(
    await post(`/api/v1/admin/email-changes/${changeId}/decision`, input, {
      "idempotency-key": key,
      "if-match": `"${version}"`,
    }),
  );
}

export interface MfaReset {
  id: string;
  subjectId: string;
  subjectName: string;
  reason: string;
  requestedBySubjectId: string;
  requestedAt: string;
  state: "pending" | "approved" | "rejected";
  decidedBySubjectId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  enrolmentWindowUntil: string | null;
  /**
   * A suspension closed it: the person's or the proposer's (`rejected`), or the approver's, which
   * leaves it `approved` but ends the window — so a set reason means no open window, whatever
   * `enrolmentWindowUntil` says.
   */
  closedReason: Exclude<ClosedReason, "inviter_suspended"> | null;
  version: number;
}

export async function listMfaResets(): Promise<{ items: MfaReset[] }> {
  return parse<{ items: MfaReset[] }>(await get("/api/v1/admin/mfa-resets"));
}

export async function createMfaReset(
  key: string,
  input: { subjectId: string; reason: string },
): Promise<MfaReset> {
  return parse<MfaReset>(await post("/api/v1/admin/mfa-resets", input, { "idempotency-key": key }));
}

// --- Suspension (AUTH-06, 0127) -------------------------------------------------------------------

export interface SubjectSuspension {
  id: string;
  subjectId: string;
  subjectName: string;
  action: "suspend" | "reinstate";
  reason: string;
  requestedBySubjectId: string;
  requestedAt: string;
  state: "pending" | "approved" | "rejected";
  decidedBySubjectId: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  enrolmentWindowUntil: string | null;
  /** `proposer_suspended`: the proposer's own suspension closed it (`rejected`). */
  closedReason: Extract<ClosedReason, "proposer_suspended"> | null;
  version: number;
}

export async function listSubjectSuspensions(): Promise<{ items: SubjectSuspension[] }> {
  return parse<{ items: SubjectSuspension[] }>(await get("/api/v1/admin/subject-suspensions"));
}

export async function createSubjectSuspension(
  key: string,
  input: { subjectId: string; action: SubjectSuspension["action"]; reason: string },
): Promise<SubjectSuspension> {
  return parse<SubjectSuspension>(await post("/api/v1/admin/subject-suspensions", input, { "idempotency-key": key }));
}

export async function decideSubjectSuspension(
  key: string,
  suspensionId: string,
  version: number,
  input: Decision,
): Promise<SubjectSuspension> {
  return parse<SubjectSuspension>(
    await post(`/api/v1/admin/subject-suspensions/${encodeURIComponent(suspensionId)}/decision`, input, {
      "idempotency-key": key,
      "if-match": `"${version}"`,
    }),
  );
}

export async function decideMfaReset(
  key: string,
  resetId: string,
  version: number,
  input: Decision,
): Promise<MfaReset> {
  return parse<MfaReset>(
    await post(`/api/v1/admin/mfa-resets/${resetId}/decision`, input, {
      "idempotency-key": key,
      "if-match": `"${version}"`,
    }),
  );
}
