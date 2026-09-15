import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { createSafeClient } from "../src/safe-client.js";

/**
 * Safe Transaction Service client.
 *
 * The service is replaced by a double that keeps the two rules the real one enforces and a mock
 * would otherwise hide:
 *
 * - **Addresses must be EIP-55 checksummed.** The service answers 422 "Checksum address
 *   validation failed" for a lowercase address in the path and rejects a lowercase `to` in the
 *   body ("Address ... is not checksumed").
 * - **`GET /safes/{address}/` returns the on-chain nonce.** It does not count proposals still
 *   collecting signatures; only the multisig transaction list knows those.
 */

const SAFE = `0x${"ab".repeat(20)}`;
const CONTRACT = `0x${"cc".repeat(20)}`;
const PROPOSER_KEY = `0x${"11".repeat(32)}` as const;
const HASH_A = `0x${"a1".repeat(32)}`;
const HASH_B = `0x${"b2".repeat(32)}`;

interface ServiceTx {
  readonly safeTxHash: string;
  readonly nonce: number;
  readonly isExecuted: boolean;
  readonly isSuccessful: boolean | null;
  readonly transactionHash: string | null;
}

const isChecksummed = (address: string) => address === getAddress(address);

function fakeService(onChainNonce: number, transactions: ServiceTx[]) {
  const posted: Record<string, unknown>[] = [];
  const unprocessable = (address: string) =>
    new Response(
      JSON.stringify({ code: 1, message: "Checksum address validation failed", arguments: [address] }),
      { status: 422 },
    );

  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const safePath = /^\/api\/v1\/safes\/([^/]+)\/(multisig-transactions\/)?$/.exec(url.pathname);

    if (safePath) {
      const address = safePath[1]!;
      if (!isChecksummed(address)) return unprocessable(address);

      if (!safePath[2]) {
        // The service serializes the nonce as a string.
        return Response.json({ address, nonce: String(onChainNonce), threshold: 2 });
      }

      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (!isChecksummed(String(body["to"]))) {
          return Response.json({ to: [`Address ${String(body["to"])} is not checksumed`] }, { status: 422 });
        }
        posted.push(body);
        return new Response(null, { status: 201 });
      }

      const params = url.searchParams;
      const results = transactions
        .filter((tx) => !params.has("executed") || String(tx.isExecuted) === params.get("executed"))
        .filter((tx) => !params.has("nonce__gte") || tx.nonce >= Number(params.get("nonce__gte")))
        .filter((tx) => !params.has("nonce") || tx.nonce === Number(params.get("nonce")))
        .sort((a, b) => b.nonce - a.nonce)
        .slice(0, params.has("limit") ? Number(params.get("limit")) : undefined);
      return Response.json({ count: results.length, next: null, previous: null, results });
    }

    const detail = /^\/api\/v1\/multisig-transactions\/([^/]+)\/$/.exec(url.pathname);
    const tx = detail && transactions.find((candidate) => candidate.safeTxHash === detail[1]);
    if (!tx) return new Response("Not found", { status: 404 });
    return Response.json({
      ...tx,
      safe: getAddress(SAFE),
      confirmations: [{}],
      confirmationsRequired: 2,
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, posted };
}

function clientFor(service: ReturnType<typeof fakeService>) {
  return createSafeClient({
    serviceUrl: "https://safe.example",
    chainId: 56,
    proposerPrivateKey: PROPOSER_KEY,
    fetchImpl: service.fetchImpl,
  });
}

const pendingTx = (safeTxHash: string, nonce: number): ServiceTx => ({
  safeTxHash,
  nonce,
  isExecuted: false,
  isSuccessful: null,
  transactionHash: null,
});

describe("Safe client — next nonce", () => {
  it("skips nonces already held by proposals collecting signatures", async () => {
    // Two batches awaiting signatures at 7 and 8. Proposing the third at 7 would make it compete
    // with the first: only one of them can ever execute.
    const service = fakeService(7, [pendingTx(HASH_A, 7), pendingTx(HASH_B, 8)]);
    expect(await clientFor(service).nextNonce(SAFE)).toBe(9);
  });

  it("is the on-chain nonce when nothing is pending", async () => {
    // An unexecuted proposal below the on-chain nonce was replaced and can never execute.
    const service = fakeService(7, [pendingTx(HASH_A, 5)]);
    expect(await clientFor(service).nextNonce(SAFE)).toBe(7);
  });
});

describe("Safe client — proposal", () => {
  it("treats the service's empty 201 answer as a posted proposal", async () => {
    // The service creates the proposal and answers 201 with no body. Reading that as a failure
    // would retry at the same nonce and post the batch twice.
    const service = fakeService(3, []);
    const proposal = await clientFor(service).propose({
      safeAddress: SAFE,
      to: CONTRACT,
      data: "0xdeadbeef",
      nonce: 3,
    });

    expect(proposal.nonce).toBe(3);
    expect(service.posted).toHaveLength(1);
  });
});

describe("Safe client — address format", () => {
  it("sends checksummed addresses although configuration stores them lowercase", async () => {
    const service = fakeService(3, []);
    const client = clientFor(service);

    const nonce = await client.nextNonce(SAFE);
    await client.propose({ safeAddress: SAFE, to: CONTRACT, data: "0xdeadbeef", nonce });

    expect(service.posted).toHaveLength(1);
    expect(service.posted[0]!["to"]).toBe(getAddress(CONTRACT));
  });
});

describe("Safe client — status", () => {
  it("reports a proposal whose nonce another executed transaction used as replaced", async () => {
    // A rejection in the Safe UI executes a different transaction at the same nonce. Ours can
    // never execute after that; waiting on it would block forever.
    const service = fakeService(8, [
      pendingTx(HASH_A, 7),
      { ...pendingTx(HASH_B, 7), isExecuted: true, isSuccessful: true, transactionHash: `0x${"cd".repeat(32)}` },
    ]);

    expect(await clientFor(service).status(HASH_A)).toEqual({ kind: "replaced", replacedBy: HASH_B });
  });

  it("stays pending while no transaction at its nonce has executed", async () => {
    // The on-chain nonce can move before the service indexes the execution. Judging from the
    // on-chain nonce alone would mark our own executed proposal as replaced.
    const service = fakeService(8, [pendingTx(HASH_A, 7)]);

    expect(await clientFor(service).status(HASH_A)).toEqual({
      kind: "pending",
      confirmations: 1,
      threshold: 2,
    });
  });

  it("reports an executed proposal with its transaction hash", async () => {
    const executedHash = `0x${"EF".repeat(32)}`;
    const service = fakeService(8, [
      { ...pendingTx(HASH_A, 7), isExecuted: true, isSuccessful: true, transactionHash: executedHash },
    ]);

    expect(await clientFor(service).status(HASH_A)).toEqual({
      kind: "executed",
      transactionHash: executedHash.toLowerCase(),
    });
  });
});
