import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import type { AppConfig } from "./config.js";
import type { GovernanceChain } from "./routes/governance.js";

/**
 * 거버넌스 투표 무게용 체인 접근 — 04 §4.5.
 *
 * ERC-20 `balanceOf`를 **과거 블록에서** 읽는다. 아카이브 노드가 필요하며,
 * 없으면 조회가 실패한다 — 그 실패를 잔고 0으로 읽지 않는 것이 중요하다.
 * 0은 "토큰이 없다"는 사실이고 실패는 "모른다"다.
 */

const BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * 정족수의 분모.
 *
 * 던진 표의 합이 아니라 **투표할 수 있었던 전체**다. 같은 스냅숏 블록에서
 * 읽어야 무게와 분모의 기준 시점이 어긋나지 않는다.
 */
const TOTAL_SUPPLY_ABI = [
  {
    type: "function",
    name: "totalSupply",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * 설정이 갖춰졌을 때만 만든다.
 *
 * 토큰 주소가 없으면 `undefined`를 반환하고, governance route는 수동 무게로
 * 떨어진다. 빈 클라이언트를 만들어 두면 "연동됐는데 값이 0"으로 보인다.
 */
export function createGovernanceChain(config: AppConfig): GovernanceChain | undefined {
  if (!config.governanceTokenAddress || !config.chainRpcUrl) return undefined;

  const rpcUrl = config.chainRpcUrl;
  const chain = {
    id: config.chainId,
    name: `chain-${config.chainId}`,
    nativeCurrency: { name: "native", symbol: "NATIVE", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  } as const;

  const client: PublicClient = createPublicClient({ transport: http(rpcUrl), chain });

  return {
    chainId: config.chainId,
    tokenAddress: config.governanceTokenAddress,
    confirmationDepth: config.governanceConfirmationDepth,

    async headBlockNumber() {
      return Number(await client.getBlockNumber());
    },

    async readBalance({ tokenAddress, walletAddress, blockNumber }) {
      // `blockNumber`를 지정하면 아카이브 조회다. 노드가 지원하지 않으면
      // 예외가 나고, 호출부가 그것을 "모른다"로 기록한다.
      return client.readContract({
        address: tokenAddress as Hex,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [walletAddress as Hex],
        blockNumber: BigInt(blockNumber),
      });
    },

    async readTotalSupply({ tokenAddress, blockNumber }) {
      // 실패를 0으로 읽으면 정족수가 무조건 통과한다. 잔고와 같은 원칙이다.
      return client.readContract({
        address: tokenAddress as Hex,
        abi: TOTAL_SUPPLY_ABI,
        functionName: "totalSupply",
        blockNumber: BigInt(blockNumber),
      });
    },
  };
}
