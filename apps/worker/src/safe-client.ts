import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Safe Transaction Service 연동 — spec 08 §8.9.
 *
 * 컨트랙트의 `ANCHOR_SUBMITTER_ROLE`은 Safe multisig가 보유한다. worker는 EOA로
 * 직접 올릴 수 없고 **제안만 만든다** — 서명 수집과 실행은 Safe 쪽에서 사람이
 * 한다.
 *
 * 제안을 올리려면 proposer가 Safe의 owner여야 하고 제안 자체에 서명해야 한다.
 * 그 서명은 실행 권한이 아니라 "이 제안을 내가 올렸다"는 표시다 — 실행에는
 * threshold만큼의 owner 서명이 따로 필요하다.
 *
 * **제안이 올라간 것은 실행된 것이 아니다.** 두 상태를 구분하지 않으면 "올렸다"고
 * 믿는 사이 체인에 아무것도 없는 상태가 된다.
 */

export interface SafeTransactionInput {
  readonly safeAddress: string;
  readonly to: string;
  readonly data: string;
  readonly nonce: number;
}

export interface SafeProposal {
  readonly safeTxHash: string;
  readonly nonce: number;
}

export interface SafeClient {
  /** Safe의 다음 nonce. 제안마다 달라야 한다. */
  nextNonce(safeAddress: string): Promise<number>;
  /** 제안을 올린다. 반환값은 Safe 측 식별자다. */
  propose(input: SafeTransactionInput): Promise<SafeProposal>;
  /** 제안 상태 조회. 실행됐으면 트랜잭션 해시가 온다. */
  status(safeTxHash: string): Promise<SafeProposalStatus>;
}

export type SafeProposalStatus =
  | { readonly kind: "pending"; readonly confirmations: number; readonly threshold: number }
  | { readonly kind: "executed"; readonly transactionHash: string }
  | { readonly kind: "rejected" }
  | { readonly kind: "unknown" };

/**
 * Safe 트랜잭션 해시 계산 — EIP-712.
 *
 * 서비스가 돌려주는 값을 그대로 믿지 않고 우리도 계산해 대조한다. 서비스가
 * 다른 calldata의 해시를 돌려주면 우리는 엉뚱한 것에 서명하게 된다.
 */
const SAFE_TX_TYPEHASH =
  "0xbb8310d486368db6bd6f849402fdd73ad53d316b5a4b2644ad6efe0f941286d8" as const;

const DOMAIN_SEPARATOR_TYPEHASH =
  "0x47e79534a245952e8b16893a336b85a3d9ea9fa8c573f3d803afb92a79469218" as const;

export function computeSafeTxHash(input: {
  readonly safeAddress: Hex;
  readonly chainId: number;
  readonly to: Hex;
  readonly data: Hex;
  readonly nonce: number;
}): Hex {
  const domainSeparator = keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [DOMAIN_SEPARATOR_TYPEHASH, BigInt(input.chainId), input.safeAddress],
    ),
  );

  const safeTxStructHash = keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "address" },
        { type: "uint256" },
        { type: "bytes32" },
        { type: "uint8" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        SAFE_TX_TYPEHASH,
        input.to,
        // anchor 제출에 이더를 보내지 않는다. value가 0이 아니면 자금 이동이다.
        0n,
        keccak256(input.data),
        // CALL(0). DELEGATECALL(1)은 Safe의 저장소를 바꿀 수 있어 쓰지 않는다.
        0,
        0n,
        0n,
        0n,
        "0x0000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000",
        BigInt(input.nonce),
      ],
    ),
  );

  // EIP-712: 0x19 0x01 ‖ domainSeparator ‖ structHash
  return keccak256(`0x1901${domainSeparator.slice(2)}${safeTxStructHash.slice(2)}` as Hex);
}

export interface SafeServiceOptions {
  /** Safe Transaction Service 기본 URL. 체인마다 다르다. */
  readonly serviceUrl: string;
  readonly chainId: number;
  /** 제안자 키. Safe의 owner여야 한다. 실행 권한과는 다르다. */
  readonly proposerPrivateKey: Hex;
}

export function createSafeClient(options: SafeServiceOptions): SafeClient {
  const proposer = privateKeyToAccount(options.proposerPrivateKey);

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${options.serviceUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Safe service ${response.status}: ${body.slice(0, 300)}`);
    }

    // 204는 본문이 없다. 제안 생성이 그렇다.
    return response.status === 204 ? null : response.json();
  }

  return {
    async nextNonce(safeAddress) {
      const info = (await request(`/api/v1/safes/${safeAddress}/`)) as { nonce: number };
      return info.nonce;
    },

    async propose(input) {
      const safeTxHash = computeSafeTxHash({
        safeAddress: input.safeAddress as Hex,
        chainId: options.chainId,
        to: input.to as Hex,
        data: input.data as Hex,
        nonce: input.nonce,
      });

      // 제안자 서명. 실행 권한이 아니라 "이 제안을 내가 올렸다"는 표시다.
      const signature = await proposer.sign({ hash: safeTxHash });

      await request(`/api/v1/safes/${input.safeAddress}/multisig-transactions/`, {
        method: "POST",
        body: JSON.stringify({
          to: input.to,
          value: "0",
          data: input.data,
          operation: 0,
          safeTxGas: "0",
          baseGas: "0",
          gasPrice: "0",
          gasToken: null,
          refundReceiver: null,
          nonce: input.nonce,
          contractTransactionHash: safeTxHash,
          sender: proposer.address,
          signature,
        }),
      });

      return { safeTxHash, nonce: input.nonce };
    },

    async status(safeTxHash) {
      try {
        const tx = (await request(`/api/v1/multisig-transactions/${safeTxHash}/`)) as {
          isExecuted: boolean;
          isSuccessful: boolean | null;
          transactionHash: string | null;
          confirmations?: unknown[];
          confirmationsRequired: number;
        };

        if (tx.isExecuted && tx.transactionHash) {
          // 실행됐다고 성공한 것은 아니다. 실패한 실행도 executed다.
          return tx.isSuccessful === false
            ? { kind: "rejected" }
            : { kind: "executed", transactionHash: tx.transactionHash.toLowerCase() };
        }

        return {
          kind: "pending",
          confirmations: tx.confirmations?.length ?? 0,
          threshold: tx.confirmationsRequired,
        };
      } catch {
        // 서비스가 모르는 해시다. 아직 전파되지 않았거나 제안이 사라졌다 —
        // 둘을 여기서 구분할 수 없으므로 자동으로 정리하지 않는다.
        return { kind: "unknown" };
      }
    },
  };
}
