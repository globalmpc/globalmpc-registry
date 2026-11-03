import { z } from "zod";
import { isoDateTime } from "./common.js";
import { sessionResponse } from "./auth.js";
import type { ActionPolicy } from "./authorization.js";
import type { RouteDefinition } from "./routes.js";

/**
 * Accounts: invitations, emailed sign-in codes and email change — account authentication WP2.
 *
 * Rules that the schemas below only describe, and the API and database enforce:
 *
 * - **No passwords** (D1). The first factor is a code mailed to the account's address.
 * - **Sign-up by invitation only** (D5). An invitation names one address, one organisation and
 *   **no roles**; roles come only through the two-person role grant.
 * - One address belongs to one subject in one tenant (D6). Every refusal to invite an address that
 *   is taken returns the one code `INVITATION_EMAIL_UNAVAILABLE`.
 * - Asking for a sign-in code always answers the same way, whether or not the address has an
 *   account (plan §5, enumeration).
 * - A code session is first-factor only (`aal1`): it reaches its own session view, logout and the
 *   MFA routes, nothing else.
 */

/** Length and alphabet of an emailed code. 8 random digits (plan §5). */
export const EMAIL_CODE_DIGITS = 8;
/** Minutes an emailed code stays valid. */
export const EMAIL_CODE_TTL_MINUTES = 10;
/** Wrong answers a code takes before it stops working. */
export const EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Hours an invitation stays valid. */
export const INVITATION_TTL_HOURS = 72;

/**
 * Normalises an address the way the database does (`core.normalize_email`, migration 0112):
 * trimmed, lower-cased, NFC. `null` when it is not one address with one `@` and a dotted domain.
 */
export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase().normalize("NFC");
  if (value.length > 254) return null;
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts as [string, string];
  if (!/^[^\s\u0000-\u001f\u007f]+$/u.test(local)) return null;
  if (!/^[^.\s\u0000-\u001f\u007f]+(\.[^.\s\u0000-\u001f\u007f]+)+$/u.test(domain)) return null;
  return value;
}

export const emailAddress = z
  .string()
  .max(320)
  .refine((value) => normalizeEmail(value) !== null, "Must be one email address");

export const emailCode = z
  .string()
  .regex(new RegExp(`^[0-9]{${EMAIL_CODE_DIGITS}}$`), `Must be ${EMAIL_CODE_DIGITS} digits`);

/** An invitation token as mailed in the link (base64url, 32 random bytes). */
export const invitationToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Must be an invitation token");

export const displayName = z
  .string()
  .trim()
  .min(1)
  .max(200)
  // A name is shown to other people; control characters would let it rewrite what they see.
  .regex(/^[^\u0000-\u001f\u007f]+$/u, "Must not contain control characters");

// --- Sign-in --------------------------------------------------------------

export const emailCodeStartRequest = z.object({ email: emailAddress });

/**
 * The one answer to "send me a code" — identical for an address with an account and one
 * without, so it cannot be used to find out who has an account.
 */
export const emailCodeStartResponse = z.object({
  accepted: z.literal(true),
  message: z.string(),
  /** Minutes a code would stay valid. */
  expiresInMinutes: z.number().int().positive(),
  requestId: z.string(),
});

export const emailCodeVerifyRequest = z.object({ email: emailAddress, code: emailCode });

/**
 * Which ways in this deployment offers — WP6. Public, so the sign-in screen shows a Google or
 * Microsoft button only where the provider is configured. It says nothing about any account.
 */
export const authMethodsResponse = z.object({
  /** Always true: the emailed code is the one first factor every account has. */
  emailCode: z.literal(true),
  google: z.boolean(),
  microsoft: z.boolean(),
  /** Digits in an emailed code and minutes it lives, so the screen does not restate them. */
  emailCodeDigits: z.number().int().positive(),
  emailCodeTtlMinutes: z.number().int().positive(),
  requestId: z.string(),
});

// --- Invitations ----------------------------------------------------------

export const createInvitationRequest = z.object({
  email: emailAddress,
  /** The organisation the person joins. Roles are **not** part of an invitation. */
  organizationId: z.string().guid(),
});

export const invitationState = z.enum(["pending", "accepted", "revoked", "expired"]);

export const invitation = z.object({
  id: z.string(),
  email: z.string(),
  organizationId: z.string(),
  /** `expired` once past `expiresAt`, even before anything recorded it. */
  state: invitationState,
  invitedBySubjectId: z.string(),
  createdAt: isoDateTime,
  expiresAt: isoDateTime,
  acceptedAt: isoDateTime.nullable(),
  acceptedSubjectId: z.string().nullable(),
  revokedAt: isoDateTime.nullable(),
  /** `inviter_suspended` when the inviter's suspension closed it (`expired`), not its expiry. */
  closedReason: z.enum(["inviter_suspended"]).nullable(),
  version: z.number().int().positive(),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const invitationList = z.object({
  items: z.array(invitation),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const invitationAcceptStartRequest = z.object({ token: invitationToken });

export const invitationAcceptStartResponse = z.object({
  accepted: z.literal(true),
  /** Minutes the code stays valid. */
  expiresInMinutes: z.number().int().positive(),
  requestId: z.string(),
});

export const invitationAcceptVerifyRequest = z.object({
  token: invitationToken,
  code: emailCode,
  displayName,
});

// --- Email change ---------------------------------------------------------

/**
 * Refused because the actor took part in another recovery flow for the same person within 30
 * days (migrations 0118, 0128): whoever proposed or decided one of an email change, an admin MFA
 * reset or a suspension / reinstatement of a person takes no part in the other two. Each flow is
 * two-person on its own; chained, the same two admins could otherwise move the address and then
 * open an enrolment window — a takeover. Rejections are never refused. Answered as 422 on the
 * propose and decide routes of all three flows.
 */
export const ACCOUNT_RECOVERY_SEPARATION_REQUIRED = "ACCOUNT_RECOVERY_SEPARATION_REQUIRED";

/**
 * Refused because the person is suspended (0128): their address does not change and their
 * factors are not reset until two admins reinstate them, which opens its own enrolment window.
 * Answered as 422 on the admin propose and decide routes only — the public email-change verify
 * answers a wrong code.
 */
export const SUBJECT_SUSPENDED = "SUBJECT_SUSPENDED";

/**
 * Refused because the person has no address to change (0118). A first address comes only from
 * accepting an invitation; a wallet-only person joins by invitation as a new account.
 */
export const EMAIL_CHANGE_NO_ADDRESS = "EMAIL_CHANGE_NO_ADDRESS";

export const createEmailChangeRequest = z.object({
  subjectId: z.string().guid(),
  newEmail: emailAddress,
  reason: z.string().trim().min(1).max(1000),
});

export const decideEmailChangeRequest = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(1).max(1000),
});

export const emailChangeRequest = z.object({
  id: z.string(),
  subjectId: z.string(),
  newEmail: z.string(),
  reason: z.string(),
  requestedBySubjectId: z.string(),
  requestedAt: isoDateTime,
  state: z.enum(["pending", "approved", "rejected", "completed", "expired"]),
  decidedBySubjectId: z.string().nullable(),
  decidedAt: isoDateTime.nullable(),
  decisionReason: z.string().nullable(),
  completedAt: isoDateTime.nullable(),
  /** Set when a suspension of the person, the proposer or the approver closed it (`expired`). */
  closedReason: z.enum(["subject_suspended", "proposer_suspended", "approver_suspended"]).nullable(),
  version: z.number().int().positive(),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const emailChangeRequestList = z.object({
  items: z.array(emailChangeRequest),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const emailChangeStartRequest = z.object({ email: emailAddress });
export const emailChangeVerifyRequest = z.object({ email: emailAddress, code: emailCode });

export const emailChangeVerifyResponse = z.object({
  completed: z.literal(true),
  /** Every session of the account ended; it signs in again with the new address. */
  sessionsRevoked: z.literal(true),
  requestId: z.string(),
});

// --- Authorization --------------------------------------------------------

/**
 * Admin actions for accounts. The same roles as the other `admin.*` actions — both are
 * high-assurance roles, so a passkey (`aal3`) session is needed to use them.
 *
 * Email change is two-person like role grants: proposing and deciding are separate actions held
 * by the same roles, and the database refuses a decision by the proposer or by the subject.
 */
export const ACCOUNT_ACTION_POLICIES: Readonly<Record<string, ActionPolicy>> = {
  "admin.invitation.manage": {
    action: "admin.invitation.manage",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  "admin.email_change.propose": {
    action: "admin.email_change.propose",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
  "admin.email_change.approve": {
    action: "admin.email_change.approve",
    secondPerson: "proposer ≠ decider ≠ subject (email_change_two_person, email_change_not_own_decision 0113)",
    allowedRoles: ["mpc_operator", "security_operator"],
  },
};

// --- Routes ---------------------------------------------------------------

const publicAccountRoute = {
  public: true,
  mutation: false,
  requiresIfMatch: false,
  action: null,
  implemented: true,
} as const;

export const ACCOUNT_ROUTES: readonly RouteDefinition[] = [
  {
    ...publicAccountRoute,
    method: "get",
    path: "/api/v1/auth/methods",
    summary: "The sign-in methods this deployment offers — the same answer for everyone",
    operationId: "getAuthMethods",
    responseSchema: authMethodsResponse,
  },
  {
    ...publicAccountRoute,
    method: "post",
    path: "/api/v1/auth/email/start",
    summary: "Ask for a sign-in code — the same answer whether or not the address has an account",
    operationId: "startEmailSignIn",
    requestSchema: emailCodeStartRequest,
    responseSchema: emailCodeStartResponse,
  },
  {
    ...publicAccountRoute,
    method: "post",
    path: "/api/v1/auth/email/verify",
    summary: "Sign in with an emailed code — issues a first-factor (aal1) session",
    operationId: "verifyEmailSignIn",
    requestSchema: emailCodeVerifyRequest,
    responseSchema: sessionResponse,
  },
  {
    ...publicAccountRoute,
    method: "post",
    path: "/api/v1/auth/invitations/accept/start",
    summary: "Send a code to the address an invitation names",
    operationId: "startInvitationAcceptance",
    requestSchema: invitationAcceptStartRequest,
    responseSchema: invitationAcceptStartResponse,
  },
  {
    ...publicAccountRoute,
    method: "post",
    path: "/api/v1/auth/invitations/accept/verify",
    summary: "Accept an invitation with its code — creates the account (no roles) and an aal1 session",
    operationId: "verifyInvitationAcceptance",
    requestSchema: invitationAcceptVerifyRequest,
    responseSchema: sessionResponse,
  },
  {
    ...publicAccountRoute,
    method: "post",
    path: "/api/v1/auth/email-change/start",
    summary: "Resend the code for an approved email change — the same answer for any address",
    operationId: "startEmailChangeVerification",
    requestSchema: emailChangeStartRequest,
    responseSchema: emailCodeStartResponse,
  },
  {
    ...publicAccountRoute,
    method: "post",
    path: "/api/v1/auth/email-change/verify",
    summary: "Complete an approved email change with the code sent to the new address — ends every session",
    operationId: "verifyEmailChange",
    requestSchema: emailChangeVerifyRequest,
    responseSchema: emailChangeVerifyResponse,
  },
  {
    method: "get",
    path: "/api/v1/admin/invitations",
    summary: "List invitations of this tenant",
    operationId: "listInvitations",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: "admin.read",
    implemented: true,
    responseSchema: invitationList,
  },
  {
    method: "post",
    path: "/api/v1/admin/invitations",
    summary: "Invite an address into an organisation — carries no role",
    operationId: "createInvitation",
    public: false,
    mutation: true,
    requiresIfMatch: false,
    action: "admin.invitation.manage",
    implemented: true,
    requestSchema: createInvitationRequest,
    responseSchema: invitation,
  },
  {
    method: "post",
    path: "/api/v1/admin/invitations/{invitationId}/revoke",
    summary: "Revoke a pending invitation — its link and any code sent for it stop working",
    operationId: "revokeInvitation",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "admin.invitation.manage",
    implemented: true,
    responseSchema: invitation,
  },
  {
    method: "get",
    path: "/api/v1/admin/email-changes",
    summary: "List email change requests of this tenant",
    operationId: "listEmailChangeRequests",
    public: false,
    mutation: false,
    requiresIfMatch: false,
    action: "admin.read",
    implemented: true,
    responseSchema: emailChangeRequestList,
  },
  {
    method: "post",
    path: "/api/v1/admin/email-changes",
    summary: "Propose a new address for another person — a second admin decides",
    operationId: "createEmailChangeRequest",
    public: false,
    mutation: true,
    requiresIfMatch: false,
    action: "admin.email_change.propose",
    implemented: true,
    refusals: [ACCOUNT_RECOVERY_SEPARATION_REQUIRED, EMAIL_CHANGE_NO_ADDRESS, SUBJECT_SUSPENDED],
    requestSchema: createEmailChangeRequest,
    responseSchema: emailChangeRequest,
  },
  {
    method: "post",
    path: "/api/v1/admin/email-changes/{changeId}/decision",
    summary: "Approve or reject an email change — not by the proposer or the person; approval mails a code to the new address",
    operationId: "decideEmailChangeRequest",
    public: false,
    mutation: true,
    requiresIfMatch: true,
    action: "admin.email_change.approve",
    implemented: true,
    refusals: [ACCOUNT_RECOVERY_SEPARATION_REQUIRED, SUBJECT_SUSPENDED],
    requestSchema: decideEmailChangeRequest,
    responseSchema: emailChangeRequest,
  },
];
