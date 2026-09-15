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
import type {
  AnchoredBatch,
  ChainClient,
  FeeQuote,
  SendRootInput,
  SubmitRootInput,
} from "./anchor-submitter.js";
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

/** Read side used for reconciliation: `getBatch` and the `RootSubmitted` event. */
export const RECONCILE_ABI = [
  {
    type: "function",
    name: "getBatch",
    stateMutability: "view",
    inputs: [{ name: "batchId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "root", type: "bytes32" },
          { name: "manifestHash", type: "bytes32" },
          { name: "recordCount", type: "uint32" },
          { name: "submittedAt", type: "uint64" },
          { name: "revoked", type: "bool" },
          { name: "supersededBy", type: "bytes32" },
        ],
      },
    ],
  },
  {
    type: "event",
    name: "RootSubmitted",
    inputs: [
      { name: "batchId", type: "bytes32", indexed: true },
      { name: "root", type: "bytes32", indexed: true },
      { name: "manifestHash", type: "bytes32", indexed: false },
      { name: "schemaVersion", type: "string", indexed: false },
      { name: "recordCount", type: "uint32", indexed: false },
      { name: "submitter", type: "address", indexed: false },
    ],
  },
] as const;

/**
 * How far back to search for a `RootSubmitted` log.
 *
 * A lost send is looked for on the next attempts, seconds to minutes later, so a short window
 * suffices. Public RPCs refuse wide `eth_getLogs` ranges; a refused search reads as "not found"
 * and hands the batch to a person rather than guessing.
 */
const LOG_LOOKBACK_BLOCKS = 5_000n;

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

  /** Hash of the transaction that stored `batchId`, from its `RootSubmitted` log. */
  async function findSubmission(batchId: Hex): Promise<string | null> {
    try {
      const head = await publicClient.getBlockNumber();
      const logs = await publicClient.getLogs({
        address: options.contractAddress,
        event: RECONCILE_ABI[1],
        args: { batchId },
        fromBlock: head > LOG_LOOKBACK_BLOCKS ? head - LOG_LOOKBACK_BLOCKS : 0n,
        toBlock: head,
      });
      return logs[0]?.transactionHash?.toLowerCase() ?? null;
    } catch {
      // A refused range is not proof of absence. null hands the batch to a person.
      return null;
    }
  }

  return {
    async headBlockNumber() {
      return Number(await publicClient.getBlockNumber());
    },

    async estimateFees(): Promise<FeeQuote> {
      try {
        const fees = await publicClient.estimateFeesPerGas();
        if (fees.maxFeePerGas !== undefined && fees.maxPriorityFeePerGas !== undefined) {
          return {
            type: "eip1559",
            maxFeePerGas: fees.maxFeePerGas,
            maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
          };
        }
      } catch {
        // Some nodes lack EIP-1559 support. Fall back to the legacy gas price.
      }
      return { type: "legacy", gasPrice: await publicClient.getGasPrice() };
    },

    async anchoredBatch(batchId: string): Promise<AnchoredBatch | null> {
      // A failed read throws: without an answer the caller must not send.
      const batch = await publicClient.readContract({
        address: options.contractAddress,
        abi: RECONCILE_ABI,
        functionName: "getBatch",
        args: [batchId as Hex],
      });
      if (batch.submittedAt === 0n) return null;
      return { root: batch.root.toLowerCase(), txHash: await findSubmission(batchId as Hex) };
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

    async submitRoot(input: SendRootInput) {
      const call = {
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
      } as const;

      // Simulate first. A call the contract would reject is caught before spending gas — the
      // revert reason surfaces here as is.
      await publicClient.simulateContract(call);

      // Send the quote the cap check approved. Left unset, viem estimates fees again here and a
      // spike between the check and this call would be sent as is. The type follows the quote:
      // a legacy node takes only `gasPrice`.
      return input.fees.type === "eip1559"
        ? walletClient.writeContract({
            ...call,
            chain,
            type: "eip1559",
            maxFeePerGas: input.fees.maxFeePerGas,
            maxPriorityFeePerGas: input.fees.maxPriorityFeePerGas,
          })
        : walletClient.writeContract({ ...call, chain, type: "legacy", gasPrice: input.fees.gasPrice });
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
