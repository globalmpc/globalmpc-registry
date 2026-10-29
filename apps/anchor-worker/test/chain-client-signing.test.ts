import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeEventTopics, parseTransaction, keccak256 } from "viem";
const rpc = vi.hoisted(() => ({
  getBlockNumber: vi.fn(),
  getLogs: vi.fn(),
  estimateFeesPerGas: vi.fn(),
  getGasPrice: vi.fn(),
  readContract: vi.fn(),
  simulateContract: vi.fn(),
  getTransactionCount: vi.fn(),
  sendRawTransaction: vi.fn(),
  getBlock: vi.fn(),
  getTransactionReceipt: vi.fn(),
  getTransaction: vi.fn(),
}));
vi.mock("viem", async (importOriginal) => ({
  ...(await importOriginal<typeof import("viem")>()),
  createPublicClient: () => rpc,
}));
import {
  createViemChainClient,
  findSubmissionHash,
  l1FeeOf,
  RECONCILE_ABI,
  rootSubmissionsOf,
  rpcAnswersBlockTag,
  signerAddress,
  type LogSearchReader,
} from "../src/viem-chain-client.js";
import { GAS_PRICE_ORACLE_ADDRESS } from "../src/chain-profile.js";
const options = {
  rpcUrl: "http://rpc.test",
  chainId: 31337,
  contractAddress: `0x${"cc".repeat(20)}` as `0x${string}`,
  signerPrivateKey: `0x${"11".repeat(32)}` as `0x${string}`,
};
const input = {
  batchId: `0x${"11".repeat(32)}`,
  root: `0x${"22".repeat(32)}`,
  manifestHash: `0x${"33".repeat(32)}`,
  schemaVersion: "v1",
  recordCount: 3,
};
beforeEach(() => {
  for (const fn of Object.values(rpc)) fn.mockReset();
  rpc.getBlockNumber.mockResolvedValue(6000n);
  rpc.getTransactionCount.mockResolvedValue(4);
  rpc.simulateContract.mockResolvedValue({});
});
it("uses EIP-1559 fees where supported and legacy gas prices otherwise", async () => {
  const chain = createViemChainClient(options);
  rpc.estimateFeesPerGas
    .mockResolvedValueOnce({ maxFeePerGas: 10n, maxPriorityFeePerGas: 1n })
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("Unsupported"));
  rpc.getGasPrice.mockResolvedValue(7n);
  expect(await chain.estimateFees()).toEqual({
    type: "eip1559",
    maxFeePerGas: 10n,
    maxPriorityFeePerGas: 1n,
  });
  expect(await chain.estimateFees()).toEqual({ type: "legacy", gasPrice: 7n });
  expect(await chain.estimateFees()).toEqual({ type: "legacy", gasPrice: 7n });
});
it.each(["legacy", "eip1559"] as const)(
  "simulates and locally signs a %s transaction with fixed fees and nonce before broadcasting",
  async (type) => {
    const chain = createViemChainClient(options);
    const fees =
      type === "legacy"
        ? { type, gasPrice: 10n }
        : { type, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n };
    const prepared = await chain.prepareSubmitRoot({
      ...input,
      gasLimit: 200000n,
      fees,
    });
    expect(prepared.txHash).toBe(keccak256(prepared.raw as `0x${string}`));
    expect(prepared.from).toBe(signerAddress(options.signerPrivateKey));
    expect(prepared.nonce).toBe(4);
    const tx = parseTransaction(prepared.raw as `0x${string}`);
    expect(tx).toMatchObject({
      chainId: 31337,
      nonce: 4,
      gas: 200000n,
      to: options.contractAddress,
    });
    expect(tx.data).toBe(chain.encodeSubmitRoot(input).calldata);
    rpc.sendRawTransaction.mockResolvedValue("0xABC");
    expect(await chain.broadcast(prepared)).toBe("0xabc");
    expect(rpc.simulateContract).toHaveBeenCalledOnce();
    expect(rpc.sendRawTransaction).toHaveBeenCalledWith({
      serializedTransaction: prepared.raw,
    });
  },
);
it("does not sign or send a transaction when simulation rejects it", async () => {
  rpc.simulateContract.mockRejectedValue(new Error("BatchAlreadyExists"));
  await expect(
    createViemChainClient(options).prepareSubmitRoot({
      ...input,
      gasLimit: 200000n,
      fees: { type: "legacy", gasPrice: 1n },
    }),
  ).rejects.toThrow("BatchAlreadyExists");
  expect(rpc.getTransactionCount).not.toHaveBeenCalled();
  expect(rpc.sendRawTransaction).not.toHaveBeenCalled();
});
it("reconciles existing batches from a chunked event search on the contract it is asked about", async () => {
  const chain = createViemChainClient(options);
  const other = `0x${"dd".repeat(20)}`;
  // Block n has timestamp 2n: the head is newer than the batch.
  rpc.getBlock.mockImplementation(async ({ blockNumber }: { blockNumber: bigint }) => ({
    timestamp: blockNumber * 2n,
  }));
  rpc.readContract
    .mockResolvedValueOnce({ submittedAt: 0n })
    .mockResolvedValue({ submittedAt: 1n, root: "0xABC" });
  expect(await chain.anchoredBatch(input.batchId, other)).toBeNull();
  rpc.getLogs.mockResolvedValue([{ transactionHash: "0xDEF" }]);
  expect(await chain.anchoredBatch(input.batchId, other)).toEqual({
    root: "0xabc",
    txHash: "0xdef",
  });
  // Both reads go to the contract asked about, not the configured one.
  expect(rpc.readContract).toHaveBeenLastCalledWith(expect.objectContaining({ address: other }));
  // The newest chunk first, at the public-RPC range size.
  expect(rpc.getLogs).toHaveBeenCalledWith(
    expect.objectContaining({ address: other, fromBlock: 1001n, toBlock: 6000n }),
  );
});
it("throws when the log search cannot be finished, instead of reporting the hash unknown", async () => {
  // A refused range or a rate limit is not proof of absence; the caller waits and asks again.
  const chain = createViemChainClient(options);
  rpc.getBlock.mockResolvedValue({ timestamp: 10n });
  rpc.readContract.mockResolvedValue({ submittedAt: 1n, root: "0xABC" });
  rpc.getBlockNumber.mockResolvedValue(100n);
  rpc.getLogs.mockRejectedValue(new Error("429 Too Many Requests"));
  await expect(chain.anchoredBatch(input.batchId, options.contractAddress)).rejects.toThrow("429");
  rpc.getLogs.mockResolvedValue([]);
  rpc.getBlock.mockRejectedValue(new Error("429 Too Many Requests"));
  await expect(chain.anchoredBatch(input.batchId, options.contractAddress)).rejects.toThrow("429");
  // Completed and not found: null.
  rpc.getBlock.mockResolvedValue({ timestamp: 10n });
  await expect(chain.anchoredBatch(input.batchId, options.contractAddress)).resolves.toEqual({
    root: "0xabc",
    txHash: null,
  });
  expect(rpc.getLogs).toHaveBeenLastCalledWith(expect.objectContaining({ fromBlock: 0n }));
});
it("reads head, block gas limit and confirmed nonce at the requested block", async () => {
  const chain = createViemChainClient(options);
  rpc.getBlock.mockResolvedValue({ gasLimit: 30000000n });
  expect(await chain.headBlockNumber()).toBe(6000);
  expect(await chain.blockGasLimit()).toBe(30000000n);
  expect(await chain.confirmedNonce("0xabc", 40)).toBe(4);
  expect(rpc.getTransactionCount).toHaveBeenCalledWith({
    address: "0xabc",
    blockNumber: 40n,
  });
});
it("returns mined success and revert receipts without conflating them with pending", async () => {
  const chain = createViemChainClient(options);
  rpc.getTransactionReceipt.mockResolvedValue({
    status: "success",
    blockNumber: 5n,
    blockHash: "0xABC",
    gasUsed: 21000n,
    effectiveGasPrice: 3n,
  });
  expect(await chain.observe("0xtx")).toMatchObject({
    kind: "receipt",
    status: "success",
    blockNumber: 5,
  });
  rpc.getTransactionReceipt.mockResolvedValue({
    status: "reverted",
    blockNumber: 6n,
    blockHash: "0xDEF",
    gasUsed: 22000n,
    effectiveGasPrice: 4n,
  });
  expect(await chain.observe("0xtx")).toMatchObject({
    kind: "receipt",
    status: "reverted",
    blockNumber: 6,
  });
});

describe("L1 data fee", () => {
  const fees = { type: "eip1559", maxFeePerGas: 10n, maxPriorityFeePerGas: 1n } as const;

  it("on opBNB reserves twice the oracle's quote for the transaction about to be signed", async () => {
    const chain = createViemChainClient({ ...options, chainId: 5611 });
    rpc.readContract.mockResolvedValue(1_000n);
    expect(await chain.l1FeeBound({ ...input, gasLimit: 200000n, fees })).toBe(2_000n);

    const call = rpc.readContract.mock.calls[0]![0] as { address: string; functionName: string; args: [`0x${string}`] };
    expect(call).toMatchObject({ address: GAS_PRICE_ORACLE_ADDRESS, functionName: "getL1Fee" });
    // Priced on the same calldata, gas limit and fees the send will carry.
    expect(parseTransaction(call.args[0])).toMatchObject({
      chainId: 5611,
      to: options.contractAddress,
      data: chain.encodeSubmitRoot(input).calldata,
      gas: 200000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
    });
  });

  it.each([56, 31337])("on chain %i is 0 without asking the node", async (chainId) => {
    const chain = createViemChainClient({ ...options, chainId });
    expect(await chain.l1FeeBound({ ...input, gasLimit: 200000n, fees })).toBe(0n);
    expect(rpc.readContract).not.toHaveBeenCalled();
  });

  it("propagates a failed quote instead of reserving nothing", async () => {
    rpc.readContract.mockRejectedValue(new Error("oracle unavailable"));
    await expect(
      createViemChainClient({ ...options, chainId: 5611 }).l1FeeBound({ ...input, gasLimit: 200000n, fees }),
    ).rejects.toThrow("oracle unavailable");
  });

  it("reads the receipt's l1Fee as a hex quantity or bigint", () => {
    expect(l1FeeOf({ l1Fee: "0x1f4" }, 5611)).toBe(500n);
    expect(l1FeeOf({ l1Fee: 7n }, 5611)).toBe(7n);
    // BSC and anvil receipts carry none: their cost is gas alone.
    expect(l1FeeOf({}, 56)).toBe(0n);
    expect(l1FeeOf({ l1Fee: null }, 31337)).toBe(0n);
  });

  it("refuses an opBNB receipt without a readable l1Fee instead of counting 0", () => {
    expect(() => l1FeeOf({}, 5611)).toThrow("Receipt on chain 5611 carries no l1Fee");
    expect(() => l1FeeOf({ l1Fee: "12" }, 5611)).toThrow("unreadable l1Fee");
    expect(() => l1FeeOf({ l1Fee: -1n }, 5611)).toThrow("unreadable l1Fee");
  });
});

describe("RootSubmitted in a receipt", () => {
  const topic = encodeEventTopics({ abi: RECONCILE_ABI, eventName: "RootSubmitted" })[0];
  const batch = `0x${"AB".repeat(32)}`;
  const root = `0x${"CD".repeat(32)}`;

  it("takes every RootSubmitted log with the address that emitted it, lowercase", () => {
    const logs = [
      { address: options.contractAddress.toUpperCase().replace("0X", "0x"), topics: [topic, batch, root] },
      // Same event from another contract: kept with its address, for the caller to judge.
      { address: `0x${"DD".repeat(20)}`, topics: [topic, `0x${"01".repeat(32)}`, root] },
      // Another event of ours (e.g. Safe's ExecutionFailure is from the Safe, but any other topic).
      { address: options.contractAddress, topics: [`0x${"ee".repeat(32)}`, batch, root] },
      { address: options.contractAddress, topics: [topic] },
    ];
    expect(rootSubmissionsOf(logs)).toEqual([
      { contract: options.contractAddress, batchId: batch.toLowerCase(), root: root.toLowerCase() },
      { contract: `0x${"dd".repeat(20)}`, batchId: `0x${"01".repeat(32)}`, root: root.toLowerCase() },
    ]);
  });
});

describe("finality tag read", () => {
  it("answers at startup whether the node serves the tag with a numbered block", async () => {
    rpc.getBlock.mockResolvedValueOnce({ number: 77n }).mockResolvedValueOnce({ number: null });
    expect(await rpcAnswersBlockTag(options.rpcUrl, "safe")).toBe(true);
    expect(rpc.getBlock).toHaveBeenLastCalledWith({ blockTag: "safe" });
    expect(await rpcAnswersBlockTag(options.rpcUrl, "finalized")).toBe(false);
    rpc.getBlock.mockRejectedValueOnce(new Error("unknown block tag"));
    await expect(rpcAnswersBlockTag(options.rpcUrl, "safe")).rejects.toThrow("unknown block tag");
  });

  it("asks the node for the tagged block", async () => {
    rpc.getBlock.mockResolvedValue({ number: 77n });
    expect(await createViemChainClient(options).finalizedBlockNumber("safe")).toBe(77);
    expect(rpc.getBlock).toHaveBeenCalledWith({ blockTag: "safe" });
  });

  it("throws when the node returns no number", async () => {
    rpc.getBlock.mockResolvedValue({ number: null });
    await expect(createViemChainClient(options).finalizedBlockNumber("finalized")).rejects.toThrow(
      "no finalized block number",
    );
  });
});

describe("RootSubmitted log search", () => {
  /** A chain whose block n has timestamp n, with the batch's log at `logBlock` (or none). */
  function reader(head: bigint, logBlock: bigint | null) {
    const ranges: [bigint, bigint][] = [];
    const timestamps: bigint[] = [];
    const r: LogSearchReader = {
      headBlockNumber: async () => head,
      blockTimestamp: async (n) => {
        timestamps.push(n);
        return n;
      },
      submissionHashes: async (from, to) => {
        ranges.push([from, to]);
        return logBlock !== null && logBlock >= from && logBlock <= to ? ["0xABC"] : [];
      },
    };
    return { r, ranges, timestamps };
  }

  it("walks back in 5,000-block ranges and returns the first hit", async () => {
    const { r, ranges } = reader(20_000n, 9_000n);
    expect(await findSubmissionHash(r, 9_000n, 100_000)).toBe("0xabc");
    expect(ranges).toEqual([
      [15_001n, 20_000n],
      [10_001n, 15_000n],
      [5_001n, 10_000n],
    ]);
  });

  it("stops once a range starts before the batch was stored", async () => {
    // Stored at timestamp 12,000 but the log is not served: past the range that holds that block,
    // older ranges cannot hold it either.
    const { r, ranges } = reader(20_000n, null);
    expect(await findSubmissionHash(r, 12_000n, 100_000)).toBeNull();
    expect(ranges).toEqual([
      [15_001n, 20_000n],
      [10_001n, 15_000n],
    ]);
  });

  it("stops at the lookback bound", async () => {
    const { r, ranges } = reader(20_000n, 1_000n);
    expect(await findSubmissionHash(r, 0n, 7_000)).toBeNull();
    expect(ranges).toEqual([
      [15_001n, 20_000n],
      [13_001n, 15_000n],
    ]);
  });

  it("does not report absence while the searched head is no newer than the batch", async () => {
    // getBatch answered from a node that has the block; getLogs from one behind it.
    const { r, ranges } = reader(10_000n, null);
    await expect(findSubmissionHash(r, 12_000n, 100_000)).rejects.toThrow("search incomplete");
    // Several blocks share a second, so a head at the batch's own second may precede it too.
    await expect(findSubmissionHash(reader(12_000n, null).r, 12_000n, 100_000)).rejects.toThrow(
      "search incomplete",
    );
    expect(ranges[0]).toEqual([5_001n, 10_000n]);
    // One block past it, a search that finds nothing is a completed one.
    await expect(findSubmissionHash(reader(12_001n, null).r, 12_000n, 100_000)).resolves.toBeNull();
  });

  it("propagates a failed range read instead of reporting absence", async () => {
    const { r } = reader(20_000n, null);
    r.submissionHashes = async () => {
      throw new Error("429 Too Many Requests");
    };
    await expect(findSubmissionHash(r, 12_000n, 100_000)).rejects.toThrow("429");
  });

  it("searches from genesis on a young chain", async () => {
    const { r, ranges } = reader(100n, null);
    expect(await findSubmissionHash(r, 0n, 100_000)).toBeNull();
    expect(ranges).toEqual([[0n, 100n]]);
  });
});
