import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createViemChainClient } from "../src/viem-chain-client.js";

/**
 * Receipt lookup against a scripted JSON-RPC node.
 *
 * `unknown` means "the node does not know this transaction". The send ledger settles a send whose
 * nonce is taken and whose lookup says `unknown` — so an RPC failure read as `unknown` would
 * settle a send that was in fact mined, and its gas would never reach the ledger.
 */

type Answer = { result: unknown } | { error: { code: number; message: string } };

let answers: Record<string, Answer> = {};
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string };
      const answer = answers[call.method] ?? { error: { code: -32601, message: "not scripted" } };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, ...answer }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

const HASH = `0x${"44".repeat(32)}`;
const client = () =>
  createViemChainClient({
    rpcUrl: url,
    chainId: 31337,
    contractAddress: `0x${"cc".repeat(20)}`,
    signerPrivateKey: `0x${"11".repeat(32)}`,
  });

const failing: Answer = { error: { code: -32000, message: "upstream unavailable" } };

describe("observe", () => {
  it("is unknown only when the node answers that it has neither receipt nor transaction", async () => {
    answers = {
      eth_getTransactionReceipt: { result: null },
      eth_getTransactionByHash: { result: null },
    };
    await expect(client().observe(HASH)).resolves.toEqual({ kind: "unknown" });
  });

  it("throws when the receipt lookup fails, instead of reading it as unknown", async () => {
    answers = { eth_getTransactionReceipt: failing, eth_getTransactionByHash: { result: null } };
    await expect(client().observe(HASH)).rejects.toThrow();
  });

  it("throws when the transaction lookup fails, instead of reading it as unknown", async () => {
    answers = { eth_getTransactionReceipt: { result: null }, eth_getTransactionByHash: failing };
    await expect(client().observe(HASH)).rejects.toThrow();
  });
});

describe("observe on opBNB", () => {
  const contract = `0x${"cc".repeat(20)}` as const;
  const batch = `0x${"0b".repeat(32)}`;
  const root = `0x${"0c".repeat(32)}`;
  const opbnb = () =>
    createViemChainClient({
      rpcUrl: url,
      chainId: 5611,
      contractAddress: contract,
      signerPrivateKey: `0x${"11".repeat(32)}`,
    });
  /** A receipt as an opBNB node returns it, raw hex (trimmed to the fields viem reads). */
  const raw = (extra: Record<string, unknown>) => ({
    transactionHash: HASH,
    transactionIndex: "0x1",
    blockHash: `0x${"bb".repeat(32)}`,
    blockNumber: "0x10",
    from: `0x${"aa".repeat(20)}`,
    to: contract,
    cumulativeGasUsed: "0x30d40",
    gasUsed: "0x23a3e",
    effectiveGasPrice: "0xf4240",
    contractAddress: null,
    logsBloom: `0x${"00".repeat(256)}`,
    status: "0x1",
    type: "0x2",
    logs: [
      {
        address: contract,
        topics: ["0x" + "00".repeat(32), batch, root],
        data: "0x",
        blockNumber: "0x10",
        transactionHash: HASH,
        transactionIndex: "0x1",
        blockHash: `0x${"bb".repeat(32)}`,
        logIndex: "0x0",
        removed: false,
      },
    ],
    ...extra,
  });

  it("reads l1Fee through viem's default formatter and the contract's RootSubmitted", async () => {
    const { encodeEventTopics } = await import("viem");
    const { RECONCILE_ABI } = await import("../src/viem-chain-client.js");
    const topic = encodeEventTopics({ abi: RECONCILE_ABI, eventName: "RootSubmitted" })[0];
    const receipt = raw({ l1Fee: "0x1954fe7a00" });
    receipt.logs[0]!.topics[0] = topic;
    answers = { eth_getTransactionReceipt: { result: receipt } };
    await expect(opbnb().observe(HASH)).resolves.toMatchObject({
      kind: "receipt",
      gasUsed: 0x23a3en,
      effectiveGasPrice: 0xf4240n,
      l1Fee: 0x1954fe7a00n,
      rootSubmissions: [{ contract, batchId: batch, root }],
    });
  });

  it("throws on a receipt without l1Fee, so the send stays open rather than counted at gas alone", async () => {
    answers = { eth_getTransactionReceipt: { result: raw({}) } };
    await expect(opbnb().observe(HASH)).rejects.toThrow("carries no l1Fee");
  });
});
