import { recoverTypedDataAddress, type Hex as ViemHex } from "viem";
import type postgres from "postgres";
import { keccak256 } from "@mpc/canonical";
import { SUBJECT_SUSPENDED, WALLET_BINDING_EIP712_TYPES, WALLET_BINDING_PURPOSE } from "@mpc/api-contract";
import type { AppConfig } from "../config.js";
import { badRequest, unprocessable } from "../errors.js";
import { uuidToBytes32 } from "./attestation-signing.js";

/**
 * Wallets as signing keys — account authentication WP5, one wallet per account (0130).
 *
 * A signature is accepted when the recovered address is **the** active wallet of the signing
 * subject, on this API's chain. An account holds at most one active wallet (a partial unique
 * index); after a replace only the new one signs. A session carries no wallet of its own, so no
 * signing path may read one from it. The recovered address is what gets recorded as the signer
 * (`actor_wallet`, `signer_wallet_address`) — a frozen fact: signatures made before a replace
 * stay attributed to the wallet that made them.
 */

/** The subject's active wallet on `chainId`, lower-case, or null. */
export async function subjectSigningWallet(
  tx: postgres.TransactionSql,
  subjectId: string,
  chainId: number,
): Promise<string | null> {
  const [row] = await tx<{ wallet_address: string }[]>`
    SELECT wallet_address FROM core.wallet_identities
    WHERE subject_id = ${subjectId} AND chain_id = ${chainId} AND disabled_at IS NULL
  `;
  return row ? row.wallet_address.toLowerCase() : null;
}

/**
 * New signatures require a live, non-suspended subject as well as their active wallet.
 * Hold the subject against suspension until the signature transaction commits: a relay's own
 * session says nothing about the signing person's status. Historical signature reads do not
 * call this check. Signature validity and authority remain separate facts (invariant 13).
 */
export async function assertSubjectSigner(
  tx: postgres.TransactionSql,
  input: { readonly subjectId: string; readonly chainId: number; readonly signer: string; readonly message: string },
): Promise<string> {
  const [subject] = await tx<{ suspended_at: Date | null }[]>`
    SELECT suspended_at FROM core.subjects
    WHERE id = ${input.subjectId} AND tenant_id = core.current_tenant()
    FOR SHARE
  `;
  if (!subject) throw badRequest("SIGNATURE_SIGNER_MISMATCH", input.message);
  if (subject.suspended_at !== null) {
    throw unprocessable(SUBJECT_SUSPENDED, "The signing person is suspended");
  }
  const signer = input.signer.toLowerCase();
  if ((await subjectSigningWallet(tx, input.subjectId, input.chainId)) !== signer) {
    throw badRequest("SIGNATURE_SIGNER_MISMATCH", input.message);
  }
  return signer;
}

// ---------------------------------------------------------------------------
// Binding message
// ---------------------------------------------------------------------------

export interface WalletBindingMessage {
  readonly purpose: typeof WALLET_BINDING_PURPOSE;
  readonly tenantId: ViemHex;
  readonly subjectId: ViemHex;
  readonly wallet: ViemHex;
  readonly chainId: bigint;
  readonly nonce: ViemHex;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
}

/**
 * Its own domain, so no attestation or gate-decision signature is ever a binding. The chain id is
 * the API's: a message signed for another chain recovers to another address and is refused.
 */
export function walletBindingDomain(config: AppConfig) {
  return {
    name: "MPC Wallet Binding",
    version: "1",
    chainId: config.chainId,
    salt: keccak256(new TextEncoder().encode("mpc-wallet-binding-v1")) as ViemHex,
  } as const;
}

/** The message, built from the challenge row — never from what the client sends back. */
export function walletBindingMessage(challenge: {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly nonce: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}): WalletBindingMessage {
  return {
    purpose: WALLET_BINDING_PURPOSE,
    tenantId: uuidToBytes32(challenge.tenantId),
    subjectId: uuidToBytes32(challenge.subjectId),
    wallet: challenge.walletAddress as ViemHex,
    chainId: BigInt(challenge.chainId),
    nonce: challenge.nonce as ViemHex,
    issuedAt: BigInt(Math.floor(challenge.issuedAt.getTime() / 1000)),
    expiresAt: BigInt(Math.floor(challenge.expiresAt.getTime() / 1000)),
  };
}

export function walletBindingTypedData(config: AppConfig, message: WalletBindingMessage) {
  return {
    domain: walletBindingDomain(config),
    types: WALLET_BINDING_EIP712_TYPES,
    primaryType: "WalletBinding" as const,
    message,
  };
}

/**
 * The address that signed the binding message, or null when the signature does not parse. EOA
 * signatures only, as for attestations and gate decisions: verifying a contract wallet (EIP-1271)
 * needs an RPC call no signing path makes today.
 */
export async function recoverWalletBindingSigner(
  config: AppConfig,
  message: WalletBindingMessage,
  signature: ViemHex,
): Promise<string | null> {
  try {
    const address = await recoverTypedDataAddress({ ...walletBindingTypedData(config, message), signature });
    return address.toLowerCase();
  } catch {
    return null;
  }
}

/** What the wallet screen says before it opens. States what the signature does not do. */
export function humanReadableWalletBinding(input: {
  readonly walletAddress: string;
  readonly chainId: number;
  readonly expiresAt: Date;
  /** The account's active wallet this binding disables, if it has one. */
  readonly replaces?: { readonly walletAddress: string; readonly chainId: number } | null;
}): string {
  return [
    `Bind wallet ${input.walletAddress} on chain ${input.chainId} to your MPC Registry account.`,
    ...(input.replaces
      ? [
          `This replaces your current signing wallet ${input.replaces.walletAddress} (chain ${input.replaces.chainId}):` +
            " it will stop signing for your account.",
        ]
      : []),
    `This request expires at ${input.expiresAt.toISOString()}.`,
    "",
    "After binding, signatures from this wallet can record your attestations and decisions.",
    "This signature does not sign you in, move assets, or grant any approval.",
  ].join("\n");
}
