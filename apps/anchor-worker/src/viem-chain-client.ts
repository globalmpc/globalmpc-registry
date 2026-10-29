import {
  createPublicClient,
  encodeEventTopics,
  encodeFunctionData,
  http,
  keccak256,
  serializeTransaction,
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
import {
  chargesL1DataFee,
  defaultLogLookbackBlocks,
  GAS_PRICE_ORACLE_ADDRESS,
  L1_FEE_RESERVE_MULTIPLIER,
  LOG_SEARCH_CHUNK_BLOCKS,
} from "./chain-profile.js";

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

const ROOT_SUBMITTED_TOPIC = encodeEventTopics({ abi: RECONCILE_ABI, eventName: "RootSubmitted" })[0]!;

const GAS_PRICE_ORACLE_ABI = [
  {
    type: "function",
    name: "getL1Fee",
    stateMutability: "view",
    inputs: [{ name: "_data", type: "bytes" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/**
 * Nonce written into the transaction the L1 fee is priced on. The real one is read only when
 * signing; the fee grows with encoded size, and this encodes no shorter than any nonce the signer
 * will reach.
 */
const PRICING_NONCE = 0xffffffff;

export interface ViemChainClientOptions {
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly contractAddress: Hex;
  readonly signerPrivateKey: Hex;
  /**
   * How many blocks back to look for a `RootSubmitted` log (`ANCHOR_LOG_LOOKBACK_BLOCKS`).
   * Default: a day of the chain's blocks (`defaultLogLookbackBlocks`).
   */
  readonly logLookbackBlocks?: number;
}

/**
 * The `RootSubmitted` logs in a receipt, with the address that emitted each, lowercase.
 *
 * Not filtered by contract here: which contract counts is the tracked row's decision — the one
 * recorded with its hash, not this worker's current configuration — so the caller filters.
 */
export function rootSubmissionsOf(
  logs: readonly { readonly address: string; readonly topics: readonly (string | null)[] }[],
): { contract: string; batchId: string; root: string }[] {
  return logs
    .filter(
      (log) =>
        log.topics[0]?.toLowerCase() === ROOT_SUBMITTED_TOPIC.toLowerCase() &&
        typeof log.topics[1] === "string" &&
        typeof log.topics[2] === "string",
    )
    .map((log) => ({
      contract: log.address.toLowerCase(),
      batchId: log.topics[1]!.toLowerCase(),
      root: log.topics[2]!.toLowerCase(),
    }));
}

/**
 * The receipt's L1 data fee. viem's default receipt formatter passes unknown fields through, so
 * it arrives as a hex quantity; an OP-stack formatter would hand a bigint.
 *
 * On a chain that charges the fee, a receipt without it throws instead of reading 0: the daily
 * cap would undercount every send while nothing looked wrong.
 */
export function l1FeeOf(receipt: object, chainId: number): bigint {
  const raw = (receipt as { l1Fee?: unknown }).l1Fee;
  if (raw === undefined || raw === null) {
    if (chargesL1DataFee(chainId)) {
      throw new Error(`Receipt on chain ${chainId} carries no l1Fee`);
    }
    return 0n;
  }
  if (typeof raw === "bigint" && raw >= 0n) return raw;
  if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) return BigInt(raw);
  throw new Error(`Receipt on chain ${chainId} has an unreadable l1Fee`);
}

/** The reads `findSubmissionHash` makes; split out so the search can be tested on its own. */
export interface LogSearchReader {
  headBlockNumber(): Promise<bigint>;
  blockTimestamp(blockNumber: bigint): Promise<bigint>;
  /** Hashes of `RootSubmitted` logs for the batch in [fromBlock, toBlock]. */
  submissionHashes(fromBlock: bigint, toBlock: bigint): Promise<readonly string[]>;
}

/**
 * Hash of the transaction that stored a batch, from its `RootSubmitted` log; null only when a
 * completed search found none.
 *
 * Searches from the head backwards in `LOG_SEARCH_CHUNK_BLOCKS` ranges — public RPCs refuse wide
 * `eth_getLogs` ranges — and stops as soon as the log cannot be further back:
 *
 * - the contract stored the batch in a block with timestamp `submittedAt`, and timestamps never
 *   decrease, so once a searched range starts at a block older than that, the block was in it;
 * - at `lookbackBlocks`, a cost bound for a batch stored long ago.
 *
 * Absence is concluded only when the searched head is newer than `submittedAt`. Behind a load
 * balancer `getBatch` and `eth_getLogs` can reach different nodes; one that lags has not yet seen
 * the block that stored the batch, and several blocks can share a second (opBNB: four), so a head
 * at that very second may still precede it. Such a search throws, like a failed or refused read:
 * none of them is proof of absence, and the caller waits and asks again instead of handing a batch
 * that is on chain to a person.
 */
export async function findSubmissionHash(
  reader: LogSearchReader,
  submittedAt: bigint,
  lookbackBlocks: number,
): Promise<string | null> {
  const head = await reader.headBlockNumber();
  const span = BigInt(lookbackBlocks);
  const oldest = head >= span ? head - span + 1n : 0n;
  const chunk = BigInt(LOG_SEARCH_CHUNK_BLOCKS);
  const notFound = async (): Promise<null> => {
    if ((await reader.blockTimestamp(head)) <= submittedAt) {
      throw new Error(
        `RootSubmitted search incomplete: the node's head block ${head} is not newer than the batch`,
      );
    }
    return null;
  };
  let to = head;
  for (;;) {
    const from = to - chunk + 1n > oldest ? to - chunk + 1n : oldest;
    const [hash] = await reader.submissionHashes(from, to);
    if (hash) return hash.toLowerCase();
    if (from === oldest) return notFound();
    if ((await reader.blockTimestamp(from)) < submittedAt) return notFound();
    to = from - 1n;
  }
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
  const lookbackBlocks = options.logLookbackBlocks ?? defaultLogLookbackBlocks(options.chainId);

  /**
   * Hash of the transaction that stored `batchId` on `contract`, from its `RootSubmitted` log.
   * A failed read throws: a refused range is not proof of absence.
   */
  async function findSubmission(contract: Hex, batchId: Hex, submittedAt: bigint): Promise<string | null> {
    return findSubmissionHash(
      {
        headBlockNumber: () => publicClient.getBlockNumber(),
        blockTimestamp: async (blockNumber) => (await publicClient.getBlock({ blockNumber })).timestamp,
        submissionHashes: async (fromBlock, toBlock) =>
          (
            await publicClient.getLogs({
              address: contract,
              event: RECONCILE_ABI[1],
              args: { batchId },
              fromBlock,
              toBlock,
            })
          ).flatMap((log) => (log.transactionHash ? [log.transactionHash] : [])),
      },
      submittedAt,
      lookbackBlocks,
    );
  }

  return {
    async headBlockNumber() {
      return Number(await publicClient.getBlockNumber());
    },

    async finalizedBlockNumber(tag) {
      const block = await publicClient.getBlock({ blockTag: tag });
      // Only a pending block lacks a number. A node answering that for safe or finalized has no
      // usable answer, and confirming without one would fall back to depth alone.
      if (block.number === null) throw new Error(`The node returned no ${tag} block number`);
      return Number(block.number);
    },

    async l1FeeBound(input: SendRootInput): Promise<bigint> {
      if (!chargesL1DataFee(options.chainId)) return 0n;
      // The oracle prices the unsigned transaction and adds the signature's size itself. Same
      // calldata, gas limit and fees as the send, so the size it prices is the size sent.
      const base = {
        chainId: options.chainId,
        to: options.contractAddress,
        data: encodeFunctionData({
          abi: SUBMIT_ROOT_ABI,
          functionName: "submitRoot",
          args: [
            input.batchId as Hex,
            input.root as Hex,
            input.manifestHash as Hex,
            input.schemaVersion,
            input.recordCount,
          ],
        }),
        nonce: PRICING_NONCE,
        gas: input.gasLimit,
      } as const;
      const unsigned =
        input.fees.type === "eip1559"
          ? serializeTransaction({
              ...base,
              type: "eip1559",
              maxFeePerGas: input.fees.maxFeePerGas,
              maxPriorityFeePerGas: input.fees.maxPriorityFeePerGas,
            })
          : serializeTransaction({ ...base, type: "legacy", gasPrice: input.fees.gasPrice });
      const quote = await publicClient.readContract({
        address: GAS_PRICE_ORACLE_ADDRESS,
        abi: GAS_PRICE_ORACLE_ABI,
        functionName: "getL1Fee",
        args: [unsigned],
      });
      return quote * L1_FEE_RESERVE_MULTIPLIER;
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

    async anchoredBatch(batchId: string, contractAddress: string): Promise<AnchoredBatch | null> {
      // A failed read throws, here and in the log search: without an answer the caller must not
      // send, and must not hand a batch that may be on chain to a person either.
      const batch = await publicClient.readContract({
        address: contractAddress as Hex,
        abi: RECONCILE_ABI,
        functionName: "getBatch",
        args: [batchId as Hex],
      });
      if (batch.submittedAt === 0n) return null;
      return {
        root: batch.root.toLowerCase(),
        txHash: await findSubmission(contractAddress as Hex, batchId as Hex, batch.submittedAt),
      };
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
          l1Fee: l1FeeOf(receipt, options.chainId),
          rootSubmissions: rootSubmissionsOf(receipt.logs ?? []),
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

/** Chain id the endpoint reports (`eth_chainId`). Checked once at startup. */
export async function rpcChainId(rpcUrl: string): Promise<number> {
  return createPublicClient({ transport: http(rpcUrl) }).getChainId();
}

/**
 * Whether `address` holds contract code. Checked once at startup: sends to an address without
 * code succeed and store nothing, and a typo in `ANCHOR_CONTRACT_ADDRESS` would read as anchoring.
 */
export async function contractHasCode(rpcUrl: string, address: Hex): Promise<boolean> {
  const code = await createPublicClient({ transport: http(rpcUrl) }).getCode({ address });
  return code !== undefined && code !== "0x";
}

/**
 * Whether the endpoint answers `tag` with a numbered block. Checked once at startup when
 * `ANCHOR_FINALITY_TAG` is not `none`: an endpoint that cannot would hold every receipt short of
 * `confirmed`, which would surface only as rows waiting with `finality_read_failed`. A refused
 * read throws.
 */
export async function rpcAnswersBlockTag(rpcUrl: string, tag: "safe" | "finalized"): Promise<boolean> {
  const block = await createPublicClient({ transport: http(rpcUrl) }).getBlock({ blockTag: tag });
  return block.number !== null;
}

export function signerAddress(privateKey: Hex): string {
  return privateKeyToAccount(privateKey).address.toLowerCase();
}
