import { randomBytes } from "node:crypto";
import { hashTypedData, recoverTypedDataAddress, type Hex as ViemHex } from "viem";
import { canonicalBytes, keccak256, type Hex } from "@mpc/canonical";
import { ATTESTATION_EIP712_TYPES } from "@mpc/api-contract";
import type { AppConfig } from "../config.js";

/**
 * EIP-712 attestation 서명 — ADR-T06, spec 07 §7.2.
 *
 * **서버는 private key를 보관하거나 대리 서명하지 않는다.** 서버가 하는 일은
 * 서명 대상(frozen payload)을 만들고, 사용자가 자기 key로 만든 서명을 재계산·
 * 검증하는 것뿐이다.
 *
 * signature request는 한 번만 쓰인다. nonce·expiry·expected version이
 * replay와 snapshot substitution을 막는다.
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
 * `verifyingContract`를 두지 않는다 — 이 서명은 오프체인 검증 대상이다.
 * 온체인 검증 요구가 실제로 생기면 domain version을 올린 v2로 처리한다.
 */
export function attestationDomain(config: AppConfig) {
  return {
    name: "MPC Verification Attestation",
    version: "1",
    chainId: config.chainId,
    salt: keccak256(new TextEncoder().encode("mpc-attestation-v1")) as ViemHex,
  } as const;
}

/** UUID를 bytes32로. EIP-712 타입이 bytes32를 요구한다. */
export function uuidToBytes32(uuid: string): ViemHex {
  const hex = uuid.replace(/-/g, "");
  return `0x${hex.padEnd(64, "0")}` as ViemHex;
}

/**
 * findings·citations·limitations의 커밋먼트.
 *
 * 본문 전체를 typed data에 펼치면 지갑 화면이 읽을 수 없게 된다. 대신
 * canonical 해시 하나로 커밋하고, 사람이 읽을 내용은 별도 문자열로 보여준다.
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
 * 서명자 주소를 복구한다.
 *
 * 서버는 "이 서명이 이 payload에 대한 것인가"만 확인한다. 그 주소가 assignment의
 * 검토자인지는 호출부가 별도로 대조한다 — 서명 유효성과 권한은 다른 사실이다
 * (불변조건 13).
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
 * 사람이 읽을 서명 대상.
 *
 * 지갑에 표시되는 문구다. 무엇에 서명하는지 모른 채 승인하지 않도록,
 * 검토 범위와 한계를 그대로 담는다.
 */
export function humanReadablePayload(input: {
  readonly projectKey: string;
  readonly attestationType: string;
  readonly claimCount: number;
  readonly limitations: string;
  readonly evidenceSnapshotHash: string;
}): string {
  return [
    `프로젝트: ${input.projectKey}`,
    `검토 유형: ${input.attestationType}`,
    `대상 claim 수: ${input.claimCount}`,
    `근거 snapshot: ${input.evidenceSnapshotHash}`,
    "",
    "검토의 범위와 한계:",
    input.limitations,
    "",
    "이 서명은 검토 결과에 대한 것이며 사실성·법률 효력·투자 적합성을 보증하지 않습니다.",
  ].join("\n");
}
