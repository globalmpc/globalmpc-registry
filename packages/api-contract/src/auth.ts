import { z } from "zod";
import { isoDateTime, walletAddress } from "./common.js";

/**
 * SIWE(EIP-4361) 로그인 — ADR-T06, OD-04.
 *
 * OD-04가 요구한 "nonce·domain·chain ID·expiry를 포함한 challenge 서명"은
 * EIP-4361의 정의 그 자체다. 커스텀 서명 스킴을 만들면 감사 대상만 늘고 지갑
 * 호환성이 떨어진다.
 *
 * 중요: wallet 서명만으로 부여되는 권한은 public read와 governance 참여뿐이다.
 * reviewer·issuer·gate approver·treasury signer·security operator는 검증된
 * identity/organization credential과 phishing-resistant MFA를 요구한다.
 */

export const assuranceLevel = z.enum(["wallet_only", "identity_bound", "high_assurance"]);
export type AssuranceLevel = z.infer<typeof assuranceLevel>;

export const siweNonceRequest = z.object({
  walletAddress,
  /**
   * 받지만 쓰지 않는다.
   *
   * 서명할 체인은 서버 설정이 정하고 응답의 `chainId`로 내려간다. 클라이언트가
   * 정하게 두면 웹과 서버의 값이 갈라졌을 때(웹 97 · stg·prod 56) 모든 로그인이
   * `SIWE_CHAIN_MISMATCH`로 끝난다. 예전 클라이언트가 보내던 값이라 거절하지 않는다.
   */
  chainId: z.number().int().positive().optional(),
});

export const siweNonceResponse = z.object({
  nonce: z.string().min(8),
  expiresAt: isoDateTime,
  domain: z.string(),
  /**
   * 서명 대상 `uri`. **서버가 정하고 서버가 검증한다.**
   *
   * 클라이언트가 자기 origin으로 채우면, 서버가 인정하는 대상과 지갑이 보여 준
   * 대상이 갈라졌을 때 그 사실이 로그인 실패로만 나타난다. 값을 여기서 내려
   * 두 쪽이 같은 문자열을 쓴다.
   */
  uri: z.string(),
  /**
   * 서명할 chain ID. **서버가 정하고 서버가 검증한다** — `uri`와 같은 이유다.
   *
   * 웹이 이 값을 박아 두었을 때(97) stg·prod(56)에서 실지갑 로그인이 0건
   * 성공했다. 두 쪽이 같은 숫자를 쓰게 여기서 내린다.
   */
  chainId: z.number().int().positive(),
  statement: z.string(),
});

export const siweVerifyRequest = z.object({
  /** EIP-4361 서명 대상 메시지 원문. 서버가 파싱해 필드를 재검증한다. */
  message: z.string(),
  signature: z.string().regex(/^0x[0-9a-f]+$/),
});

/**
 * 로그인 결과.
 *
 * 02 §2.9의 6계층 분리를 응답에 그대로 노출한다. 클라이언트가 "로그인했으니
 * 권한이 있다"고 가정하지 못하게 한다.
 */
export const sessionResponse = z.object({
  sessionToken: z.string(),
  expiresAt: isoDateTime,
  walletAddress,
  chainId: z.number().int().positive(),
  /** identity binding이 없으면 null. wallet만으로는 주체를 특정하지 못한다. */
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
  /** 자격은 role과 별개다. 보유가 곧 권한이 아니다. */
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
   * 이 세션의 역할로 허용되는 action.
   *
   * 화면이 메뉴를 거르는 데 쓴다. 역할→action 표를 웹이 따로 들고 있으면 두 표가
   * 갈라진다. 이것은 보이기의 근거일 뿐이고 판정은 요청마다 서버가 다시 한다(§2.1).
   */
  actions: z.array(z.string()).optional(),
});

/**
 * 역할별 최소 assurance level — 02 §2.2, OD-04.
 *
 * 이 표는 API·UI가 공유한다. 서버가 최종 판정하며 프론트엔드의 버튼 숨김은
 * 보안 통제가 아니다(§2.1).
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
  // 검사 서비스는 사람이 아니라 시스템 identity다. 자격증명 관리가 사람 계정과
  // 다르므로 assurance는 높게 잡는다.
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
 * EIP-712 attestation 서명 요청 — 07 §7.2.
 *
 * 서버는 private key를 보관하거나 대리 서명하지 않는다. frozen payload와
 * canonical bytes를 만들어 주고, 사용자가 자기 key로 서명한 결과를 재계산·검증만
 * 한다. signature request는 한 번만 사용한다.
 */
export const signatureRequestResponse = z.object({
  signatureRequestId: z.string(),
  /** 사람이 읽을 수 있는 서명 대상. 지갑에 표시된다. */
  humanReadablePayload: z.string(),
  /** EIP-712 typed data. 지갑이 이것에 서명한다. */
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
 * EIP-712 타입 정의 — 지갑과 서버가 같은 구조를 써야 한다.
 *
 * limitations·findings·citations는 payload 안에 있고 `payloadHash`가 커밋한다.
 * 전부를 typed data에 펼치면 지갑 화면이 읽을 수 없게 된다.
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
