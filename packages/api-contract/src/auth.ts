import { z } from "zod";
import { isoDateTime } from "./common.js";

/**
 * Sessions, factors and authentication levels — account authentication.
 *
 * A person signs in with an account (emailed code, Google or Microsoft) and a second factor.
 * Wallets are signing keys bound to an account by proof of possession; no wallet signature
 * signs anyone in (decision D3, WP7).
 */

export const assuranceLevel = z.enum(["wallet_only", "identity_bound", "high_assurance"]);
export type AssuranceLevel = z.infer<typeof assuranceLevel>;

/**
 * What a session proved first — account authentication.
 *
 * The database type still holds `siwe_legacy` (PostgreSQL cannot drop an enum value in place),
 * but 0125 revoked every such session and refuses a live one, so no session the API resolves
 * carries it.
 */
export const firstFactor = z.enum(["email_code", "google", "microsoft"]);
export type FirstFactor = z.infer<typeof firstFactor>;

/** What a session proved second. A recovery code restores the second factor and counts as one. */
export const secondFactor = z.enum(["passkey", "totp", "recovery_code"]);
export type SecondFactor = z.infer<typeof secondFactor>;

/**
 * Authentication level (AAL) — **derived from what the session proved, never declared.**
 *
 * - `aal1`: first factor only. Reaches MFA enrolment, MFA challenge, logout and its own session.
 * - `aal2`: a second factor that is not phishing-resistant (TOTP, recovery code).
 * - `aal3`: a passkey.
 *
 * Separate from identity assurance (`AssuranceLevel`), which an admin sets on the subject. A
 * role is effective only when the session meets **both** minimums.
 */
export const authenticationLevel = z.enum(["aal1", "aal2", "aal3"]);
export type AuthenticationLevel = z.infer<typeof authenticationLevel>;

const AAL_RANK: Readonly<Record<AuthenticationLevel, number>> = { aal1: 1, aal2: 2, aal3: 3 };

export function satisfiesAuthenticationLevel(
  actual: AuthenticationLevel,
  required: AuthenticationLevel,
): boolean {
  return AAL_RANK[actual] >= AAL_RANK[required];
}

/** The AAL a session's factors give it. Every first factor alone is `aal1`. */
export function deriveAuthenticationLevel(input: {
  readonly firstFactor: FirstFactor;
  readonly secondFactor: SecondFactor | null;
}): AuthenticationLevel {
  if (input.secondFactor === "passkey") return "aal3";
  if (input.secondFactor === "totp" || input.secondFactor === "recovery_code") return "aal2";
  return "aal1";
}

/**
 * Roles only a service may hold — decision D7.
 *
 * Producing a scan result is the scanner's verdict, not a person's. A person bound to one of these
 * roles (by mistake or on purpose) never has it in effect, whatever the session proved; and a
 * service token makes **only** these roles effective, never a person role its subject holds.
 */
export const SERVICE_ONLY_ROLES: readonly string[] = ["scan_service", "cre_reporter"];

/**
 * The AAL a role needs to be effective in a person's session — decision D8.
 *
 * Derived from `ROLE_MINIMUM_ASSURANCE`, so there is one table: a role whose identity minimum is
 * `high_assurance` (the roles the contract marks "phishing-resistant MFA": reviewers, issuer,
 * gate approver, treasury signer, security operator, disclosure approver, operator, ERSP) needs a
 * passkey (`aal3`); every other role a person can hold needs `aal2`. A role missing from the
 * table — `break_glass`, or one added without an entry — is treated as `high_assurance`, the same
 * fail-closed default the decision formula uses.
 *
 * `null`: never effective in a person's session (`SERVICE_ONLY_ROLES`). `public_reader` is not a
 * binding but the fallback for a session with none, and needs nothing beyond signing in.
 */
export function requiredAuthenticationLevel(role: string): AuthenticationLevel | null {
  if (SERVICE_ONLY_ROLES.includes(role)) return null;
  if (role === "public_reader") return "aal1";
  return (ROLE_MINIMUM_ASSURANCE[role] ?? "high_assurance") === "high_assurance" ? "aal3" : "aal2";
}

/**
 * Service token scopes — decision D7.
 *
 * Each names one service route (`RouteDefinition.serviceScope`). A service token reaches only the
 * routes its scopes name; a route without a scope is a person route and refuses every service
 * token. The database checks the same list (migration 0109).
 */
export const SERVICE_SCOPES = ["scan_result", "cre_report"] as const;
export const serviceScope = z.enum(SERVICE_SCOPES);
export type ServiceScope = z.infer<typeof serviceScope>;

/**
 * Login result.
 *
 * Exposes the six-layer separation of 02 §2.9 directly in the response, so the
 * client cannot assume "logged in means authorized".
 */
export const sessionResponse = z.object({
  sessionToken: z.string(),
  expiresAt: isoDateTime,
  /** The subject the session belongs to. Every session has one. */
  subjectId: z.string(),
  /** Identity assurance of the subject, set by an admin. Not the authentication level. */
  assuranceLevel,
  firstFactor,
  secondFactor: secondFactor.nullable(),
  /** Derived from the factors above. See `authenticationLevel`. */
  aal: authenticationLevel,
  /**
   * Roles the subject holds that are **not effective in this session**, with the AAL each needs
   * (`null`: never in a person's session).
   *
   * Narrowed, never widened: these roles are absent from `roleBindings` and from `actions`. Shown
   * so a screen can say "sign in with a passkey to act as reviewer" instead of hiding the role.
   */
  narrowedRoles: z
    .array(z.object({ role: z.string(), requiredAal: authenticationLevel.nullable() }))
    .optional(),
  organizationIds: z.array(z.string()),
  roleBindings: z.array(
    z.object({
      role: z.string(),
      organizationId: z.string().nullable(),
      projectId: z.string().nullable(),
    }),
  ),
  /** Credentials are separate from roles. Holding one does not grant authority. */
  credentials: z.array(
    z.object({
      credentialId: z.string(),
      credentialType: z.string(),
      scope: z.array(z.string()),
      jurisdiction: z.array(z.string()),
      currentStatus: z.enum(["valid", "expired", "revoked", "suspended", "unknown"]),
      expiresAt: isoDateTime.nullable(),
    }),
  ),
  /** Whether the session is past the first factor (`aal` above `aal1`). */
  mfaSatisfied: z.boolean(),
  /**
   * The session was restored with a recovery code and may only enrol a new passkey or TOTP,
   * regenerate recovery codes and sign out until it proves one (WP3). Absent: false.
   */
  recoveryLimited: z.boolean().optional(),
  /**
   * Actions allowed for this session's roles.
   *
   * The UI uses this to filter menus. If the web kept its own role→action table,
   * the two tables would diverge. This only drives visibility; the server
   * re-decides on every request (§2.1).
   */
  actions: z.array(z.string()).optional(),
});

/**
 * One of the caller's own live sessions — `GET /api/v1/auth/sessions`. No token and no hash: the
 * list says where the account is signed in, never how to be.
 */
export const accountSession = z.object({
  id: z.string().guid(),
  firstFactor,
  secondFactor: secondFactor.nullable(),
  createdAt: isoDateTime,
  /** The last request this session made. Null until it made one after sign-in. */
  lastSeenAt: isoDateTime.nullable(),
  expiresAt: isoDateTime,
  /** The session making this request. */
  current: z.boolean(),
});
export type AccountSession = z.infer<typeof accountSession>;

export const accountSessionsResponse = z.object({
  items: z.array(accountSession),
  requestId: z.string(),
  asOf: isoDateTime,
});

/**
 * `POST /api/v1/auth/sessions/{sessionId}/revocation`. `revoked: false`: that session of yours had
 * already ended, and nothing changed. A session that is not yours answers 404, like one that
 * does not exist. `current: true`: you ended the session you are using — sign in again.
 */
export const revokeAccountSessionResponse = z.object({
  id: z.string().guid(),
  revoked: z.boolean(),
  current: z.boolean(),
  requestId: z.string(),
});

/**
 * Minimum assurance level per role — 02 §2.2, OD-04.
 *
 * The API and UI share this table. The server makes the final decision; hiding
 * buttons in the frontend is not a security control (§2.1).
 */
export const ROLE_MINIMUM_ASSURANCE: Readonly<Record<string, AssuranceLevel>> = {
  public_reader: "wallet_only",
  protocol_voter: "wallet_only",
  project_voter: "wallet_only",
  protocol_proposer: "identity_bound",
  project_proposer: "identity_bound",
  data_steward: "identity_bound",
  project_admin: "identity_bound",
  project_sponsor_operator: "identity_bound",
  spv_representative: "identity_bound",
  execution_recorder: "identity_bound",
  auditor: "identity_bound",
  external_regulated_service_provider: "high_assurance",
  // The scan service is a system identity, not a person. Its credentials are
  // managed differently from human accounts, so assurance is set high.
  scan_service: "high_assurance",
  // The CRE workflow's identity (service token, D7). Same reasoning as the scan service.
  cre_reporter: "high_assurance",
  reviewer_cp_qp: "high_assurance",
  reviewer_lab: "high_assurance",
  reviewer_legal: "high_assurance",
  reviewer_assurance: "high_assurance",
  // Makes material public and anchored, which cannot be undone.
  disclosure_approver: "high_assurance",
  issuer_officer: "high_assurance",
  gate_approver: "high_assurance",
  mpc_operator: "high_assurance",
  treasury_signer: "high_assurance",
  security_operator: "high_assurance",
};

const ASSURANCE_RANK: Readonly<Record<AssuranceLevel, number>> = {
  wallet_only: 0,
  identity_bound: 1,
  high_assurance: 2,
};

export function satisfiesAssurance(actual: AssuranceLevel, required: AssuranceLevel): boolean {
  return ASSURANCE_RANK[actual] >= ASSURANCE_RANK[required];
}

/**
 * EIP-712 attestation signature request — 07 §7.2.
 *
 * The server never holds private keys or signs on anyone's behalf. It builds the
 * frozen payload and canonical bytes, then only recomputes and verifies the
 * signature the user makes with their own key. A signature request is single-use.
 */
export const signatureRequestResponse = z.object({
  signatureRequestId: z.string(),
  /** Human-readable signing target. Shown in the wallet. */
  humanReadablePayload: z.string(),
  /** EIP-712 typed data. The wallet signs this. */
  typedData: z.object({
    domain: z.object({
      name: z.literal("MPC Verification Attestation"),
      version: z.string(),
      chainId: z.number().int().positive(),
      salt: z.string(),
    }),
    primaryType: z.literal("Attestation"),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    message: z.record(z.string(), z.unknown()),
  }),
  payloadHash: z.string(),
  nonce: z.string(),
  expiresAt: isoDateTime,
  expectedResourceVersion: z.number().int().nonnegative(),
});

export const submitSignatureRequest = z.object({
  signatureRequestId: z.string(),
  signature: z.string().regex(/^0x[0-9a-f]+$/),
  signerKeyId: z.string(),
  algorithm: z.literal("eip712"),
  payloadHash: z.string(),
});

/**
 * EIP-712 type definitions — the wallet and server must use the same structure.
 *
 * limitations, findings, and citations live inside the payload and are committed
 * by `payloadHash`. Spreading all of them into the typed data would make the
 * wallet screen unreadable.
 */
export const ATTESTATION_EIP712_TYPES = {
  Attestation: [
    { name: "attestationId", type: "bytes32" },
    { name: "schemaId", type: "bytes32" },
    { name: "schemaVersion", type: "uint32" },
    { name: "evidenceSnapshotHash", type: "bytes32" },
    { name: "assignmentId", type: "bytes32" },
    { name: "credentialId", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/**
 * EIP-712 type of a gate decision — spec 11 §11.3.
 *
 * Rationale, assumptions and conditions are committed by `payloadHash`, as an attestation's
 * findings are. The decision value and the assessment it rests on stay readable in the wallet,
 * because those are what the approver must not sign by mistake.
 */
export const GATE_DECISION_EIP712_TYPES = {
  GateDecision: [
    { name: "projectId", type: "bytes32" },
    { name: "gateId", type: "string" },
    { name: "decision", type: "string" },
    { name: "inputAssessmentId", type: "bytes32" },
    { name: "evidenceSnapshotHash", type: "bytes32" },
    { name: "payloadHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export const gateDecisionSignatureRequestResponse = z.object({
  signatureRequestId: z.string(),
  /** Human-readable signing target. Shown before the wallet opens. */
  humanReadablePayload: z.string(),
  typedData: z.object({
    domain: z.object({
      name: z.literal("MPC Gate Decision"),
      version: z.string(),
      chainId: z.number().int().positive(),
      salt: z.string(),
    }),
    primaryType: z.literal("GateDecision"),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    message: z.record(z.string(), z.unknown()),
  }),
  payloadHash: z.string(),
  nonce: z.string(),
  expiresAt: isoDateTime,
});
