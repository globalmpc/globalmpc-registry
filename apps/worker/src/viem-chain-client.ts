import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  keccak256,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { ChainClient, SubmitRootInput } from "./anchor-submitter.js";
import type { Observation } from "./anchor-state.js";

/**
 * viem으로 구현한 ChainClient.
 *
 * ABI는 `RegistryAnchorV1.submitRoot`의 시그니처만 갖는다. 전체 ABI를 들고 오면
 * 컨트랙트가 바뀔 때 이 파일도 따라 바뀌어야 하고, worker가 호출하지 않는 함수까지
 * 노출된다.
 *
 * **개인키는 이 모듈 밖으로 나가지 않는다.** 반환값·로그·오류 메시지 어디에도
 * 넣지 않는다.
 */

export const SUBMIT_ROOT_ABI = [
  {
    type: "function",
    name: "submitRoot",
    stateMutability: "nonpayable",
    inputs: [
      { name: "batchId", type: "bytes32" },
      { name: "root", type: "bytes32" },
      { name: "manifestHash", type: "bytes32" },
      { name: "schemaVersion", type: "string" },
      { name: "recordCount", type: "uint32" },
    ],
    outputs: [],
  },
] as const;

export interface ViemChainClientOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly contractAddress: Hex;
  readonly signerPrivateKey: Hex;
}

export function createViemChainClient(options: ViemChainClientOptions): ChainClient {
  const account = privateKeyToAccount(options.signerPrivateKey);
  const transport = http(options.rpcUrl);

  // chain 객체를 직접 만든다. viem의 프리셋 체인 목록에 로컬 노드가 없고,
  // 프리셋을 쓰면 RPC URL이 조용히 공개 엔드포인트로 바뀔 수 있다.
  const chain = {
    id: options.chainId,
    name: `chain-${options.chainId}`,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [options.rpcUrl] } },
  } as const;

  const publicClient: PublicClient = createPublicClient({ transport, chain });
  const walletClient: WalletClient = createWalletClient({ account, transport, chain });

  return {
    async headBlockNumber() {
      return Number(await publicClient.getBlockNumber());
    },

    async estimateMaxFeePerGas() {
      try {
        const fees = await publicClient.estimateFeesPerGas();
        return fees.maxFeePerGas ?? (await publicClient.getGasPrice());
      } catch {
        // EIP-1559를 지원하지 않는 노드가 있다. legacy gas price로 떨어진다.
        return publicClient.getGasPrice();
      }
    },

    encodeSubmitRoot(input: SubmitRootInput) {
      const calldata = encodeFunctionData({
        abi: SUBMIT_ROOT_ABI,
        functionName: "submitRoot",
        args: [
          input.batchId as Hex,
          input.root as Hex,
          input.manifestHash as Hex,
          input.schemaVersion,
          input.recordCount,
        ],
      });

      // 서명자가 Safe UI에서 본 것과 우리가 만든 것이 같은지 대조할 값이다.
      // calldata 전체를 눈으로 비교하는 것은 실질적으로 불가능하다.
      return { calldata, calldataHash: keccak256(calldata) };
    },

    async submitRoot(input: SubmitRootInput) {
      // 시뮬레이션을 먼저 돌린다. 컨트랙트가 거절할 호출이면 가스를 쓰기 전에
      // 알 수 있다 — revert 사유가 여기서 그대로 나온다.
      const { request } = await publicClient.simulateContract({
        address: options.contractAddress,
        abi: SUBMIT_ROOT_ABI,
        functionName: "submitRoot",
        account,
        args: [
          input.batchId as Hex,
          input.root as Hex,
          input.manifestHash as Hex,
          input.schemaVersion,
          input.recordCount,
        ],
      });

      return walletClient.writeContract(request);
    },

    async observe(txHash: string): Promise<Observation> {
      try {
        const receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
        return {
          kind: "receipt",
          status: receipt.status === "success" ? "success" : "reverted",
          blockNumber: Number(receipt.blockNumber),
          blockHash: receipt.blockHash.toLowerCase(),
          // 일일 상한이 이 둘의 곱을 합산한다. bigint 그대로 넘긴다 —
          // number로 좁히면 wei 단위에서 정밀도가 깨진다.
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
        };
      } catch {
        // 영수증이 없다 — 아직 mempool이거나 노드가 모른다. 두 경우를 여기서
        // 구분하려면 트랜잭션 자체를 다시 조회해야 한다.
        try {
          await publicClient.getTransaction({ hash: txHash as Hex });
          return { kind: "pending" };
        } catch {
          return { kind: "unknown" };
        }
      }
    },
  };
}

export function signerAddress(privateKey: Hex): string {
  return privateKeyToAccount(privateKey).address.toLowerCase();
}
