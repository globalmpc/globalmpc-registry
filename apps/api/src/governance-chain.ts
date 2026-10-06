import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import type { AppConfig } from "./config.js";
import type { GovernanceChain } from "./routes/governance.js";

/**
 * Chain access for governance vote weight — 04 §4.5.
 *
 * Reads ERC-20 `balanceOf` **at a past block**. Requires an archive node; without one the
 * lookup fails — it is essential not to read that failure as a zero balance.
 * 0 is the fact "holds no tokens"; failure is "unknown".
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
 * Quorum denominator.
 *
 * Not the sum of cast votes but **the total that could have voted**. It must be read at the
 * same snapshot block so weight and denominator share the same reference point.
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
 * Built only when config is complete.
 *
 * Without a token address it returns `undefined`, and governance routes fall back to manual
 * weight. Building an empty client would look like "connected, but the value is 0".
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
      // Specifying `blockNumber` makes it an archive lookup. If the node does not support it,
      // it throws, and the caller records that as "unknown".
      return client.readContract({
        address: tokenAddress as Hex,
        abi: BALANCE_OF_ABI,
        functionName: "balanceOf",
        args: [walletAddress as Hex],
        blockNumber: BigInt(blockNumber),
      });
    },

    async readTotalSupply({ tokenAddress, blockNumber }) {
      // Reading failure as 0 makes quorum pass unconditionally. Same principle as balances.
      return client.readContract({
        address: tokenAddress as Hex,
        abi: TOTAL_SUPPLY_ABI,
        functionName: "totalSupply",
        blockNumber: BigInt(blockNumber),
      });
    },
  };
}
