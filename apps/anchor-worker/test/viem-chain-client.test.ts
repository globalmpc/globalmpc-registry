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

/** An answer, or one chosen by the call's params. */
type RpcMethod = "eth_getTransactionReceipt" | "eth_getTransactionByHash" | "eth_getCode" | "eth_getTransactionCount";
type ScriptedAnswer = Answer | ((params: unknown[]) => Answer);
let answers: Partial<Record<RpcMethod, ScriptedAnswer>> = {};
const notScripted: Answer = { error: { code: -32601, message: "not scripted" } };
const evaluate = (script: ScriptedAnswer | undefined, params: unknown[]): Answer =>
  (typeof script === "function" ? script(params) : script) ?? notScripted;

/** Remote method names never index a callable; each supported method has a fixed dispatch site. */
function answerFor(method: string, params: unknown[]): Answer {
  switch (method) {
    case "eth_getTransactionReceipt": return evaluate(answers.eth_getTransactionReceipt, params);
    case "eth_getTransactionByHash": return evaluate(answers.eth_getTransactionByHash, params);
    case "eth_getCode": return evaluate(answers.eth_getCode, params);
    case "eth_getTransactionCount": return evaluate(answers.eth_getTransactionCount, params);
    default: return notScripted;
  }
}
let server: Server;
let url: string;

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      const call = JSON.parse(body) as { id: number; method: string; params: unknown[] };
      const answer = answerFor(call.method, call.params);
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

describe("scripted RPC dispatch", () => {
  it.each(["constructor", "__proto__", "toString", "unknownRpc"])("rejects unrecognized method %s", async (method) => {
    answers = {};
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params: [] }),
    });
    expect(await response.json()).toEqual({
      jsonrpc: "2.0", id: 7, error: { code: -32601, message: "not scripted" },
    });
  });

  it("passes params to a test-owned callback for an allowed RPC method", async () => {
    let calls = 0;
    answers = { eth_getTransactionCount: (params) => {
      calls += 1;
      expect(params).toEqual(["0x1234", "pending"]);
      return { result: "0x9" };
    } };
    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "eth_getTransactionCount", params: ["0x1234", "pending"] }),
    });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 8, result: "0x9" });
    expect(calls).toBe(1);
  });
});

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

describe("hasCode", () => {
  const ADDRESS = `0x${"0c".repeat(20)}`;

  it("is true only for an address holding code", async () => {
    answers = { eth_getCode: { result: "0x6080" } };
    await expect(client().hasCode(ADDRESS)).resolves.toBe(true);
    answers = { eth_getCode: { result: "0x" } };
    await expect(client().hasCode(ADDRESS)).resolves.toBe(false);
  });

  it("throws when the code cannot be read", async () => {
    answers = { eth_getCode: failing };
    await expect(client().hasCode(ADDRESS)).rejects.toThrow();
  });
});

describe("signerHasPendingTransactions", () => {
  const counts = (pending: number, latest: number) => (params: unknown[]): Answer => ({
    result: `0x${(params[1] === "pending" ? pending : latest).toString(16)}`,
  });

  it("is true only when the pending nonce is above the latest", async () => {
    answers = { eth_getTransactionCount: counts(8, 7) };
    await expect(client().signerHasPendingTransactions()).resolves.toBe(true);
    answers = { eth_getTransactionCount: counts(7, 7) };
    await expect(client().signerHasPendingTransactions()).resolves.toBe(false);
  });

  it("throws when the count cannot be read", async () => {
    answers = { eth_getTransactionCount: failing };
    await expect(client().signerHasPendingTransactions()).rejects.toThrow();
  });
});
