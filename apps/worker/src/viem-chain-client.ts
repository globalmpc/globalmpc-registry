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
 * ChainClient implemented with viem.
 *
 * The ABI holds only the `RegistryAnchorV1.submitRoot` signature. Importing the full ABI would
 * force this file to change with every contract change and expose functions the worker never
 * calls.
 *
 * **The private key never leaves this module.** Not in return values, logs, or error messages.
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

  // Build the chain object by hand. viem's preset chain list has no local node, and a preset can
  // silently swap the RPC URL for a public endpoint.
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
        // Some nodes lack EIP-1559 support. Fall back to the legacy gas price.
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

      // Lets signers check that what they see in the Safe UI matches what we built. Comparing
      // full calldata by eye is not practical.
      return { calldata, calldataHash: keccak256(calldata) };
    },

    async submitRoot(input: SubmitRootInput) {
      // Simulate first. A call the contract would reject is caught before spending gas — the
      // revert reason surfaces here as is.
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
          // The daily spend cap sums the product of these two. Passed as bigint — narrowing to
          // number loses precision at wei scale.
          gasUsed: receipt.gasUsed,
          effectiveGasPrice: receipt.effectiveGasPrice,
        };
      } catch {
        // No receipt — still in the mempool, or unknown to the node. Telling the two apart
        // requires looking up the transaction itself.
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
