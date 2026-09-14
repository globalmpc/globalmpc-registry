import { z } from "zod";
import { isoDateTime, walletAddress } from "./common.js";

/**
 * SIWE (EIP-4361) login — ADR-T06, OD-04.
 *
 * The "challenge signature including nonce, domain, chain ID, and expiry" that
 * OD-04 requires is exactly what EIP-4361 defines. A custom signature scheme
 * would only widen the audit surface and reduce wallet compatibility.
 *
 * Important: a wallet signature alone grants only public read and governance
 * participation. Reviewer, issuer, gate approver, treasury signer, and security
 * operator require a verified identity/organization credential and
 * phishing-resistant MFA.
 */

export const assuranceLevel = z.enum(["wallet_only", "identity_bound", "high_assurance"]);
export type AssuranceLevel = z.infer<typeof assuranceLevel>;

export const siweNonceRequest = z.object({
  walletAddress,
  /**
   * Accepted but unused.
   *
   * Server configuration decides the chain to sign on and returns it as
   * `chainId` in the response. If the client decided, every login would end in
   * `SIWE_CHAIN_MISMATCH` whenever web and server disagree (web 97 vs. stg/prod
   * 56). Older clients send this value, so it is not rejected.
   */
  chainId: z.number().int().positive().optional(),
});

export const siweNonceResponse = z.object({
  nonce: z.string().min(8),
  expiresAt: isoDateTime,
  domain: z.string(),
  /**
   * The `uri` to sign. **The server sets it and the server verifies it.**
   *
   * If the client filled in its own origin, a mismatch between the target the
   * server accepts and the target the wallet displayed would surface only as a
   * login failure. Returning the value here makes both sides use the same string.
   */
  uri: z.string(),
  /**
   * The chain ID to sign on. **The server sets it and the server verifies it** —
   * for the same reason as `uri`.
   *
   * When the web hardcoded this value (97), zero real-wallet logins succeeded on
   * stg/prod (56). Returning it here makes both sides use the same number.
   */
  chainId: z.number().int().positive(),
  statement: z.string(),
});

export const siweVerifyRequest = z.object({
  /** Raw EIP-4361 message to sign. The server parses it and re-verifies each field. */
  message: z.string(),
  signature: z.string().regex(/^0x[0-9a-f]+$/),
});

/**
 * Login result.
 *
 * Exposes the six-layer separation of 02 §2.9 directly in the response, so the
 * client cannot assume "logged in means authorized".
 */
export const sessionResponse = z.object({
  sessionToken: z.string(),
  expiresAt: isoDateTime,
  walletAddress,
  chainId: z.number().int().positive(),
  /** Null without an identity binding. A wallet alone does not identify a subject. */
  subjectId: z.string().nullable(),
  assuranceLevel,
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
  mfaSatisfied: z.boolean(),
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
  reviewer_cp_qp: "high_assurance",
  reviewer_lab: "high_assurance",
  reviewer_legal: "high_assurance",
  reviewer_assurance: "high_assurance",
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
    types: z.record(z.array(z.object({ name: z.string(), type: z.string() }))),
    message: z.record(z.unknown()),
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
