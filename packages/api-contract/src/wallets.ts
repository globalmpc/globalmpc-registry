import { z } from "zod";
import { isoDateTime, walletAddress } from "./common.js";
import { assuranceLevel } from "./auth.js";
import { adminSubject, disableWalletRequest } from "./resources.js";
import type { RouteDefinition } from "./routes.js";

/**
 * Wallets as signing keys — account authentication WP5.
 *
 * A wallet never signs anyone in. It is a key a person holds to sign attestations and gate
 * decisions, and (decision D9) the source of governance vote weight once a token is configured.
 * An account holds **exactly one active wallet at a time**, and an active address belongs to one
 * account (migration 0130).
 *
 * - **Binding** is the holder's own act: from their account session, at the level of the
 *   strongest factor they hold (aal3 while a passkey is active, else aal2), they ask for a
 *   challenge and sign it with the wallet (EIP-712, `WALLET_BINDING_EIP712_TYPES`). The message
 *   names the purpose, tenant, subject, wallet, chain and a single-use nonce; it lives five
 *   minutes. An address active on any account is refused with one code, `WALLET_UNAVAILABLE`; a
 *   disabled address can be bound again, by the same person or a new holder — unless it was ever
 *   disabled as compromised (directly or as a replace cause) or by an admin, which is refused
 *   with the same code. A lost key comes back only to the account that lost it; a key retired
 *   for rotation or offboarding can be bound by anyone who proves it.
 * - **Replacing** is the same ceremony. When the account already has a wallet the challenge says
 *   so (`replaces`), and the bind disables the old wallet and binds the new one in one
 *   transaction — never zero, never two. Sessions stay; the old key stops signing at once. The
 *   holder says why (`replaceReason`, `rotation` by default); `key_compromised` keeps the old key
 *   from ever being bound again. Replacing an operator-verified wallet lowers the identity
 *   assurance to `wallet_only` until an admin verifies the person again.
 * - **An admin cannot bind** a wallet to anyone (plan §5, acceptance 9): the route is gone and
 *   the database refuses the application role an insert. An admin still disables one (AC-27).
 * - **Disabling one's own wallet** needs aal2 and ends every session of the person (AC-27); the
 *   account then has no signing wallet until it binds one.
 * - **Signatures** are accepted only from the signing subject's active wallet on the API's
 *   chain; the recovered address is what the audit row records as the signer, and signatures made
 *   before a replace stay attributed to the wallet that made them.
 * - **Governance (D9)**: the active wallet is the governance wallet; there is nothing to designate.
 */

/** The one refusal for an address that cannot be bound, wherever it is bound already. */
export const WALLET_UNAVAILABLE = "WALLET_UNAVAILABLE";

/** The `purpose` field of every binding message. A different purpose is a different statement. */
export const WALLET_BINDING_PURPOSE = "bind-wallet";

/**
 * EIP-712 types of the binding message. The domain is `MPC Wallet Binding` v1 with the API's
 * chain id and a fixed salt, separate from attestations and gate decisions, so no other
 * signature can be replayed as a binding.
 */
export const WALLET_BINDING_EIP712_TYPES = {
  WalletBinding: [
    { name: "purpose", type: "string" },
    { name: "tenantId", type: "bytes32" },
    { name: "subjectId", type: "bytes32" },
    { name: "wallet", type: "address" },
    { name: "chainId", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "expiresAt", type: "uint64" },
  ],
} as const;

export const walletBindingChallengeRequest = z.object({
  walletAddress: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .transform((value) => value.toLowerCase()),
});

/** The account's active wallet a binding disables, as the challenge and the bind state it. */
export const replacedWallet = z.object({
  id: z.string(),
  walletAddress,
  chainId: z.number().int(),
});

export const walletBindingChallengeResponse = z.object({
  challengeId: z.string(),
  walletAddress,
  chainId: z.number().int().positive(),
  /**
   * The account's current wallet, which this binding will replace, or null for a first binding.
   * Show it before the wallet opens ("this will replace 0xabc…"). If the account's wallet
   * changes before the bind, the challenge is refused as stale.
   */
  replaces: replacedWallet.nullable(),
  /** What the wallet screen should say before it opens. */
  humanReadablePayload: z.string(),
  typedData: z.object({
    domain: z.object({
      name: z.literal("MPC Wallet Binding"),
      version: z.string(),
      chainId: z.number().int().positive(),
      salt: z.string(),
    }),
    primaryType: z.literal("WalletBinding"),
    types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
    /** `chainId`, `issuedAt` and `expiresAt` are decimal strings; the wallet signs them as integers. */
    message: z.record(z.string(), z.unknown()),
  }),
  expiresAt: isoDateTime,
  requestId: z.string(),
  asOf: isoDateTime,
});

/** Why the holder replaces their active wallet. Ignored when the account has none to replace. */
export const walletReplaceReason = z.enum(["rotation", "key_lost", "key_compromised"]);

export const bindWalletByProofRequest = z.object({
  challengeId: z.string().guid(),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/),
  replaceReason: walletReplaceReason.default("rotation"),
});

export const accountWallet = z.object({
  id: z.string(),
  walletAddress,
  chainId: z.number().int(),
  /** `proof`: bound by the holder's signature. `operator`: bound before WP5 or by bootstrap. */
  boundVia: z.enum(["operator", "proof"]),
  boundAt: isoDateTime.nullable(),
  /** Null for the account's one active wallet — which signs and is the governance wallet (D9). */
  disabledAt: isoDateTime.nullable(),
});

export const accountWalletsResponse = z.object({
  items: z.array(accountWallet),
  requestId: z.string(),
  asOf: isoDateTime,
});

export const accountWalletResponse = accountWallet.extend({
  requestId: z.string(),
  asOf: isoDateTime,
});

/** A bind: the new wallet, and the one it replaced (disabled in the same transaction) or null. */
export const bindAccountWalletResponse = accountWalletResponse.extend({
  replaced: replacedWallet.nullable(),
});

/** Same reason codes as the admin disable (AC-27). */
export const disableOwnWalletRequest = disableWalletRequest;

export const disableOwnWalletResponse = z.object({
  id: z.string(),
  disabledAt: isoDateTime,
  /** Every session of the person ended, this one included: sign in again. */
  revokedSessions: z.number().int().nonnegative(),
  requestId: z.string(),
});

/**
 * Identity assurance, set by an admin with a stated basis.
 *
 * Before WP5 the level travelled with an admin wallet bind. A wallet is now bound only by its
 * holder, and a proof of possession says nothing about who the person is, so the level is set on
 * the subject directly (plan §3: "per subject, admin with justification").
 */
export const setSubjectAssuranceRequest = z.object({
  assuranceLevel,
  justification: z.string().trim().min(1).max(1000),
});

/**
 * Self-service wallet routes act on the caller's own account: no role, no Idempotency-Key (as the
 * MFA routes). They need a person's account session.
 */
const self = {
  public: false,
  mutation: false,
  requiresIfMatch: false,
  action: null,
  implemented: true,
} as const;

export const WALLET_ROUTES: readonly RouteDefinition[] = [
  {
    ...self,
    method: "get",
    path: "/api/v1/auth/wallets",
    summary: "This account's signing wallet and the ones it replaced or disabled (history)",
    operationId: "listAccountWallets",
    responseSchema: accountWalletsResponse,
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/wallets/binding-challenges",
    summary:
      "Start binding or replacing the wallet — returns the message the wallet signs (5 minutes, single use) and the wallet it replaces",
    operationId: "createWalletBindingChallenge",
    requestSchema: walletBindingChallengeRequest,
    responseSchema: walletBindingChallengeResponse,
    refusals: ["WALLET_ALREADY_ACTIVE"],
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/wallets",
    summary:
      "Bind a wallet by its signature over a binding challenge (proof of possession); replaces the active wallet atomically",
    operationId: "bindAccountWallet",
    requestSchema: bindWalletByProofRequest,
    responseSchema: bindAccountWalletResponse,
    refusals: [WALLET_UNAVAILABLE, "WALLET_ALREADY_ACTIVE", "WALLET_CHALLENGE_INVALID", "SIGNATURE_SIGNER_MISMATCH"],
  },
  {
    ...self,
    method: "post",
    path: "/api/v1/auth/wallets/{walletId}/disable",
    summary:
      "Disable your wallet without a replacement — ends every session of the account (AC-27); the account then has no signing wallet",
    operationId: "disableAccountWallet",
    requestSchema: disableOwnWalletRequest,
    responseSchema: disableOwnWalletResponse,
  },
];

/** Admin route that replaces the level an admin wallet bind used to carry. */
export const ADMIN_ASSURANCE_ROUTE: RouteDefinition = {
  method: "post",
  path: "/api/v1/admin/subjects/{subjectId}/assurance",
  summary: "Set a person's identity assurance level — with the basis checked; never for yourself",
  operationId: "setAdminSubjectAssurance",
  public: false,
  mutation: true,
  requiresIfMatch: false,
  action: "admin.subject.manage",
  implemented: true,
  requestSchema: setSubjectAssuranceRequest,
  responseSchema: adminSubject,
};
