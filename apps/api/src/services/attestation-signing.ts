import { randomBytes } from "node:crypto";
import { hashTypedData, recoverTypedDataAddress, type Hex as ViemHex } from "viem";
import { canonicalBytes, keccak256, type Hex } from "@mpc/canonical";
import { ATTESTATION_EIP712_TYPES } from "@mpc/api-contract";
import type { AppConfig } from "../config.js";

/**
 * EIP-712 attestation signing — ADR-T06, spec 07 §7.2.
 *
 * **The server neither holds private keys nor signs on anyone's behalf.** It only builds the
 * signing target (frozen payload) and recomputes and verifies the signature the user made
 * with their own key.
 *
 * A signature request is used once. Nonce, expiry, and expected version prevent
 * replay and snapshot substitution.
 */

export interface AttestationMessage {
  readonly attestationId: ViemHex;
  readonly schemaId: ViemHex;
  readonly schemaVersion: number;
  readonly evidenceSnapshotHash: ViemHex;
  readonly assignmentId: ViemHex;
  readonly credentialId: ViemHex;
  readonly payloadHash: ViemHex;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly nonce: ViemHex;
}

/**
 * EIP-712 domain.
 *
 * No `verifyingContract` — this signature is verified off-chain.
 * If an on-chain verification need actually arises, handle it as v2 with a bumped domain version.
 */
export function attestationDomain(config: AppConfig) {
  return {
    name: "MPC Verification Attestation",
    version: "1",
    chainId: config.chainId,
    salt: keccak256(new TextEncoder().encode("mpc-attestation-v1")) as ViemHex,
  } as const;
}

/** UUID to bytes32. The EIP-712 type requires bytes32. */
export function uuidToBytes32(uuid: string): ViemHex {
  const hex = uuid.replace(/-/g, "");
  return `0x${hex.padEnd(64, "0")}` as ViemHex;
}

/**
 * Commitment to findings, citations, and limitations.
 *
 * Spreading the whole body into typed data makes the wallet screen unreadable. Instead it
 * commits to one canonical hash and shows the human-readable content as a separate string.
 */
export function hashAttestationPayload(payload: {
  readonly findings: readonly Record<string, string>[];
  readonly citations: readonly Record<string, string>[];
  readonly limitations: string;
  readonly claimScope: readonly string[];
}): Hex {
  return keccak256(
    canonicalBytes({
      findings: payload.findings.map((finding) => ({ ...finding })),
      citations: payload.citations.map((citation) => ({ ...citation })),
      limitations: payload.limitations,
      claimScope: [...payload.claimScope].sort(),
    }),
  );
}

export function newSignatureNonce(): ViemHex {
  return `0x${randomBytes(32).toString("hex")}` as ViemHex;
}

export function buildTypedData(config: AppConfig, message: AttestationMessage) {
  return {
    domain: attestationDomain(config),
    types: ATTESTATION_EIP712_TYPES,
    primaryType: "Attestation" as const,
    message,
  };
}

export function attestationDigest(config: AppConfig, message: AttestationMessage): ViemHex {
  return hashTypedData(buildTypedData(config, message));
}

/**
 * Recovers the signer address.
 *
 * The server only checks "is this signature over this payload". Whether that address is the
 * assignment's reviewer is checked separately by the caller — signature validity and authority
 * are different facts (invariant 13).
 */
export async function recoverAttestationSigner(
  config: AppConfig,
  message: AttestationMessage,
  signature: ViemHex,
): Promise<string> {
  const address = await recoverTypedDataAddress({
    ...buildTypedData(config, message),
    signature,
  });
  return address.toLowerCase();
}

/**
 * Human-readable signing target.
 *
 * The text shown in the wallet. It carries the review scope and limitations verbatim so that
 * nobody approves without knowing what they sign.
 */
export function humanReadablePayload(input: {
  readonly projectKey: string;
  readonly attestationType: string;
  readonly claimCount: number;
  readonly limitations: string;
  readonly evidenceSnapshotHash: string;
}): string {
  return [
    `Project: ${input.projectKey}`,
    `Review type: ${input.attestationType}`,
    `Claims in scope: ${input.claimCount}`,
    `Evidence snapshot: ${input.evidenceSnapshotHash}`,
    "",
    "Review scope and limitations:",
    input.limitations,
    "",
    "This signature covers the review result and does not guarantee factual accuracy, legal effect, or investment suitability.",
  ].join("\n");
}
