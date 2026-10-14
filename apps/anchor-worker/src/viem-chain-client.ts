import {
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  feeCeilingOf,
  type AnchoredBatch,
  type ChainClient,
  type FeeQuote,
  type PreparedSend,
  type SendRootInput,
  type SubmitRootInput,
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

    async prepareSubmitRoot(input: SendRootInput): Promise<PreparedSend> {
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

      // Every field is fixed here and signed locally, so the hash and nonce are known before the
      // send and go into the ledger first. Nothing is left for the node to fill in:
      // - fees: the quote the cap check approved. Re-estimated, a spike between the check and
      //   the send would go out as is. The type follows the quote: a legacy node takes only
      //   `gasPrice`.
      // - gas: the configured limit. Gas limit × fee is the most this send can burn, which the
      //   daily cap reserves for it until its receipt.
      // - nonce: the pending count. The submitter serializes sends per chain, so two sends of this
      //   worker never read the same count.
      const nonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
      const base = {
        chainId: options.chainId,
        to: options.contractAddress,
        data: encodeFunctionData({ abi: SUBMIT_ROOT_ABI, functionName: "submitRoot", args: call.args }),
        nonce,
        gas: input.gasLimit,
      } as const;
      const raw =
        input.fees.type === "eip1559"
          ? await account.signTransaction({
              ...base,
              type: "eip1559",
              maxFeePerGas: input.fees.maxFeePerGas,
              maxPriorityFeePerGas: input.fees.maxPriorityFeePerGas,
            })
          : await account.signTransaction({ ...base, type: "legacy", gasPrice: input.fees.gasPrice });

      return {
        txHash: keccak256(raw).toLowerCase(),
        from: account.address.toLowerCase(),
        nonce,
        gasLimit: input.gasLimit,
        maxFeePerGas: feeCeilingOf(input.fees),
        raw,
      };
    },

    async broadcast(prepared: PreparedSend): Promise<string> {
      const hash = await publicClient.sendRawTransaction({
        serializedTransaction: prepared.raw as Hex,
      });
      return hash.toLowerCase();
    },

    async confirmedNonce(address: string, blockNumber: number): Promise<number> {
      return publicClient.getTransactionCount({
        address: address as Hex,
        blockNumber: BigInt(blockNumber),
      });
    },

    async blockGasLimit(): Promise<bigint> {
      return (await publicClient.getBlock()).gasLimit;
    },

    async observe(txHash: string): Promise<Observation> {
      // Only the node's answer "not found" becomes `pending` or `unknown`. Any other failure
      // throws: a send whose nonce is taken and whose lookup reads `unknown` is settled as never
      // mined, so a failed lookup read as `unknown` would drop a mined send's gas from the cap.
      let receipt;
      try {
        receipt = await publicClient.getTransactionReceipt({ hash: txHash as Hex });
      } catch (error) {
        if (!(error instanceof TransactionReceiptNotFoundError)) throw error;
      }
      if (receipt) {
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
      }

      // No receipt — still in the mempool, or unknown to the node. Telling the two apart
      // requires looking up the transaction itself.
      try {
        await publicClient.getTransaction({ hash: txHash as Hex });
        return { kind: "pending" };
      } catch (error) {
        if (error instanceof TransactionNotFoundError) return { kind: "unknown" };
        throw error;
      }
    },
  };
}

export function signerAddress(privateKey: Hex): string {
  return privateKeyToAccount(privateKey).address.toLowerCase();
}
