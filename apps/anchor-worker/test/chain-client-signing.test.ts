import { beforeEach, expect, it, vi } from "vitest";
import { parseTransaction, keccak256 } from "viem";
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
  signerAddress,
} from "../src/viem-chain-client.js";
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
it("reconciles existing batches from a bounded event range and tolerates an unavailable log lookup", async () => {
  const chain = createViemChainClient(options);
  rpc.readContract
    .mockResolvedValueOnce({ submittedAt: 0n })
    .mockResolvedValue({ submittedAt: 1n, root: "0xABC" });
  expect(await chain.anchoredBatch(input.batchId)).toBeNull();
  rpc.getLogs.mockResolvedValue([{ transactionHash: "0xDEF" }]);
  expect(await chain.anchoredBatch(input.batchId)).toEqual({
    root: "0xabc",
    txHash: "0xdef",
  });
  expect(rpc.getLogs).toHaveBeenCalledWith(
    expect.objectContaining({ fromBlock: 1000n, toBlock: 6000n }),
  );
  rpc.getBlockNumber.mockResolvedValue(100n);
  rpc.getLogs.mockRejectedValue(new Error("Range refused"));
  expect(await chain.anchoredBatch(input.batchId)).toEqual({
    root: "0xabc",
    txHash: null,
  });
  expect(rpc.getLogs).toHaveBeenLastCalledWith(
    expect.objectContaining({ fromBlock: 0n }),
  );
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
