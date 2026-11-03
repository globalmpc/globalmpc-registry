import { z } from "zod";
import { authenticationLevel, secondFactor } from "./auth.js";
import { ACCOUNT_RECOVERY_SEPARATION_REQUIRED, SUBJECT_SUSPENDED } from "./accounts.js";
import { isoDateTime } from "./common.js";
import type { RouteDefinition } from "./routes.js";

/**
 * Second factors — account authentication WP3 (passkey, TOTP, recovery codes, admin reset).
 *
 * A session is raised past `aal1` only by one of these ceremonies, and only by consuming its
 * evidence in the database (migration 0116): a WebAuthn challenge this session asked for, a TOTP
 * step not used before, or an unused recovery code. Nothing here lets a caller state a factor.
 *
 * Enrolment rules (enforced in the database, reported here as `MfaEnrolmentVerdict`):
 *
 * - an aal1 session may enrol a first passkey or TOTP only while the subject holds neither, and
 *   only within 24 hours of the subject's creation (invitation acceptance) or of an approved
 *   admin reset;
 * - otherwise adding a factor needs aal2, and adding a passkey when one exists needs aal3;
 * - removing a factor needs the level of the strongest factor held, never removes the last one,
 *   and ends every other session of the subject;
 * - regenerating recovery codes needs the level of the strongest factor held (aal3 while a
 *   passkey exists): a code can enrol a passkey, so a TOTP session must not mint one;
 * - a session restored by a recovery code may only enrol and sign out
 *   (`allowsRecoveryLimited`) until it proves a passkey or TOTP; proving one completes the
 *   recovery and ends every session of the subject, that one included (`sessionEnded`): the
 *   person signs in again with the new factor (plan journey 5).
 */

export const MFA_ENROLMENT_VERDICTS = [
  "allowed",
  "MFA_STEP_UP_REQUIRED",
  "MFA_ENROLMENT_WINDOW_CLOSED",
  "MFA_PASSKEY_REQUIRED",
  "MFA_TOTP_ALREADY_ENROLLED",
] as const;
export const mfaEnrolmentVerdict = z.enum(MFA_ENROLMENT_VERDICTS);
export type MfaEnrolmentVerdict = z.infer<typeof mfaEnrolmentVerdict>;

/** WebAuthn transports a browser may report (L3 `AuthenticatorTransport`). */
export const WEBAUTHN_TRANSPORTS = ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"] as const;

const base64url = (max: number) => z.string().min(1).max(max).regex(/^[A-Za-z0-9_-]+$/, "Must be base64url");

export const passkeyEntry = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: isoDateTime,
  lastUsedAt: isoDateTime.nullable(),
  transports: z.array(z.enum(WEBAUTHN_TRANSPORTS)),
  /** `multiDevice`: a synced passkey. Shown so a holder knows which one survives a lost device. */
  deviceType: z.enum(["singleDevice", "multiDevice"]),
  backedUp: z.boolean(),
});

export const mfaStatusResponse = z.object({
  passkeyEnrolled: z.boolean(),
  totpEnrolled: z.boolean(),
  /** Null for a first-factor or recovery-limited session: what it holds is not its business yet. */
  recoveryCodesRemaining: z.number().int().nonnegative().nullable(),
  /** The session used a recovery code and may only enrol a new factor or sign out. */
  recoveryLimited: z.boolean(),
  /** What this session may enrol now, or why not. */
  enrolment: z.object({ passkey: mfaEnrolmentVerdict, totp: mfaEnrolmentVerdict }),
  /** The subject's passkeys. Empty for a first-factor-only session: names say nothing it needs. */
  passkeys: z.array(passkeyEntry),
});

/** WebAuthn options for `navigator.credentials.create/get`, as `@simplewebauthn/browser` takes them. */
export const webauthnOptionsResponse = z.object({
  options: z.record(z.string(), z.unknown()),
  expiresAt: isoDateTime,
});

/** `RegistrationResponseJSON` (WebAuthn L3 `toJSON()`), bounded. */
export const passkeyRegistrationRequest = z.object({
  response: z.object({
    id: base64url(1400),
    rawId: base64url(1400),
    type: z.literal("public-key"),
    response: z.object({
      clientDataJSON: base64url(4096),
      attestationObject: base64url(16384),
      transports: z.array(z.string().max(32)).max(8).optional(),
    }).loose(),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  }),
  /** The holder's label. Defaults to "Passkey". */
  name: z.string().trim().min(1).max(64).optional(),
});

/** `AuthenticationResponseJSON`, bounded. */
export const passkeyAuthenticationRequest = z.object({
  response: z.object({
    id: base64url(1400),
    rawId: base64url(1400),
    type: z.literal("public-key"),
    response: z.object({
      clientDataJSON: base64url(4096),
      authenticatorData: base64url(4096),
      /**
       * Sized for the largest algorithm the server offers at registration. On a runtime with
       * post-quantum support `@simplewebauthn/server` offers ML-DSA-44 first, whose 2420-byte
       * signature is 3227 base64url characters; a 1024 cap let such a passkey be enrolled and then
       * never used (found in the WP6 browser run with Chromium's virtual authenticator).
       */
      signature: base64url(4096),
      userHandle: base64url(128).optional(),
    }),
    clientExtensionResults: z.record(z.string(), z.unknown()),
    authenticatorAttachment: z.enum(["platform", "cross-platform"]).optional(),
  }),
});

/**
 * The result of a ceremony: the session's level afterwards, and — only when this enrolment
 * created the subject's first recovery code set — the ten codes, shown once and never again.
 *
 * `sessionEnded` is true when the ceremony completed a recovery: every session of the subject,
 * this one included, has ended, and the client signs in again with the factor just proved.
 */
export const mfaFactorResponse = z.object({
  aal: authenticationLevel,
  secondFactor: secondFactor.nullable(),
  recoveryCodes: z.array(z.string()).nullable(),
  sessionEnded: z.boolean(),
});

export const renamePasskeyRequest = z.object({ name: z.string().trim().min(1).max(64) });

export const totpSetupResponse = z.object({
  /** `otpauth://totp/...` for a QR code. Returned once; the secret is never readable again. */
  otpauthUri: z.string(),
  /** Base32 secret, for entering by hand. */
  secret: z.string(),
  /** The setup must be confirmed with a code before this. */
  expiresAt: isoDateTime,
});

export const totpCodeRequest = z.object({ code: z.string().trim().regex(/^\d{6}$/, "Six digits") });

/** Sixteen base32 characters, dashes and case ignored. */
export const recoveryCodeRequest = z.object({
  code: z.string().trim().max(32).regex(/^[A-Za-z2-7-]+$/, "A recovery code"),
});

export const recoveryCodeUseResponse = z.object({
  aal: authenticationLevel,
  recoveryLimited: z.literal(true),
  /** How many other sessions of the account ended. */
  revokedSessions: z.number().int().nonnegative(),
});

export const recoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()).length(10) });

export const removeAuthenticatorResponse = z.object({
  revokedSessions: z.number().int().nonnegative(),
  /** True when the removed authenticator was the one this session proved with: it ended too. */
  currentSessionEnded: z.boolean(),
});

export const mfaResetRequest = z.object({
  id: z.string(),
  subjectId: z.string(),
  subjectName: z.string(),
  reason: z.string(),
  requestedBySubjectId: z.string(),
  requestedAt: isoDateTime,
  state: z.enum(["pending", "approved", "rejected"]),
  decidedBySubjectId: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionReason: z.string().nullable(),
  /** Until when the subject may enrol a first factor from a first-factor-only session. */
  enrolmentWindowUntil: isoDateTime.nullable(),
  /**
   * Set when a suspension closed the request: the person's (`subject_suspended`) or the
   * proposer's (`proposer_suspended`), both `rejected`; or the approver's (`approver_suspended`),
   * which leaves the decision `approved` as made but ends its enrolment window.
   */
  closedReason: z.enum(["subject_suspended", "proposer_suspended", "approver_suspended"]).nullable(),
  version: z.number().int().positive(),
});

/** The list answer — an envelope like every other admin list, not a bare array. */
export const mfaResetList = z.object({
  items: z.array(mfaResetRequest),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const createMfaResetRequest = z.object({
  subjectId: z.string().guid(),
  reason: z.string().trim().min(1).max(2000),
});

export const decideMfaResetRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(2000),
});

/**
 * Self-service MFA routes act on the caller's own session: no role, no Idempotency-Key (as
 * logout). Removal is a POST to `…/removal`, like every other ending in this API: there are no
 * DELETE routes.
 */
const self = {
  public: false,
  mutation: false,
  requiresIfMatch: false,
  action: null,
  implemented: true,
} as const;

export const MFA_ROUTES: readonly RouteDefinition[] = [
  {
    ...self,
    method: "get",
    path: "/api/v1/auth/mfa",
    summary: "What second factors the account holds and may enrol now",
    operationId: "getMfaStatus",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    responseSchema: mfaStatusResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/passkeys/registration/options",
    summary: "Start enrolling a passkey — subject to the enrolment rules",
    operationId: "createPasskeyRegistrationOptions",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    responseSchema: webauthnOptionsResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/passkeys/registration/verify",
    summary: "Finish enrolling a passkey; the session becomes aal3",
    operationId: "verifyPasskeyRegistration",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    requestSchema: passkeyRegistrationRequest,
    responseSchema: mfaFactorResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/passkeys/authentication/options",
    summary: "Start a passkey step-up of the current session",
    operationId: "createPasskeyAuthenticationOptions",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    responseSchema: webauthnOptionsResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/passkeys/authentication/verify",
    summary: "Finish a passkey step-up; the session becomes aal3",
    operationId: "verifyPasskeyAuthentication",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    requestSchema: passkeyAuthenticationRequest,
    responseSchema: mfaFactorResponse,
  },
  {
    ...self,
    method: "patch",
    path: "/api/v1/auth/mfa/passkeys/{passkeyId}",
    summary: "Rename one of the account's passkeys",
    operationId: "renamePasskey",
    requestSchema: renamePasskeyRequest,
    responseSchema: passkeyEntry,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/passkeys/{passkeyId}/removal",
    summary: "Remove a passkey — needs the strongest factor held; ends every other session",
    operationId: "removePasskey",
    responseSchema: removeAuthenticatorResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/totp/setup",
    summary: "Start enrolling an authenticator app — returns the secret once",
    operationId: "setupTotp",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    responseSchema: totpSetupResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/totp/confirm",
    summary: "Activate the authenticator app with its first code; the session becomes aal2",
    operationId: "confirmTotp",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    requestSchema: totpCodeRequest,
    responseSchema: mfaFactorResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/totp/verify",
    summary: "Step the current session up to aal2 with an authenticator app code",
    operationId: "verifyTotp",
    allowsFirstFactorOnly: true,
    allowsRecoveryLimited: true,
    requestSchema: totpCodeRequest,
    responseSchema: mfaFactorResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/totp/removal",
    summary: "Remove the authenticator app — needs the strongest factor held; ends every other session",
    operationId: "removeTotp",
    responseSchema: removeAuthenticatorResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/recovery-codes/verify",
    summary: "Use a recovery code — ends every other session and limits this one to re-enrolment",
    operationId: "useRecoveryCode",
    allowsFirstFactorOnly: true,
    requestSchema: recoveryCodeRequest,
    responseSchema: recoveryCodeUseResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/mfa/recovery-codes",
    summary: "Generate a new set of recovery codes — voids the unused ones",
    operationId: "regenerateRecoveryCodes",
    responseSchema: recoveryCodesResponse,
  },
  {
    method: "get",
    path: "/api/v1/admin/mfa-resets",
    summary: "List MFA reset requests",
    operationId: "listMfaResets",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: "admin.read",
    implemented: true,
    responseSchema: mfaResetList,
  },
  {
    method: "post",
    path: "/api/v1/admin/mfa-resets",
    summary: "Propose resetting a person's second factors — approved by someone else",
    operationId: "createMfaReset",
    public: false,
    mutation: true,
    requiresIfMatch: false,
    action: "admin.mfa_reset.propose",
    implemented: true,
    refusals: [ACCOUNT_RECOVERY_SEPARATION_REQUIRED, SUBJECT_SUSPENDED],
    requestSchema: createMfaResetRequest,
    responseSchema: mfaResetRequest,
  },
  {
    method: "post",
    path: "/api/v1/admin/mfa-resets/{resetId}/decision",
    summary: "Approve or reject an MFA reset — not by the proposer or the person reset",
    operationId: "decideMfaReset",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "admin.mfa_reset.approve",
    implemented: true,
    refusals: [ACCOUNT_RECOVERY_SEPARATION_REQUIRED, SUBJECT_SUSPENDED],
    requestSchema: decideMfaResetRequest,
    responseSchema: mfaResetRequest,
  },
];
