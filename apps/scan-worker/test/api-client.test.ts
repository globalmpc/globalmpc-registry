import { describe, expect, it } from "vitest";
import { generatePrivateKey } from "viem/accounts";
import { createApiClient } from "../src/api-client.js";

/**
 * Timeout for worker → API calls.
 *
 * If the API stalls, the worker's request never ends. The outbox publisher and anchor submitter
 * call this client inside their loops, so one hang backs up every later event — it shows up as a
 * stall, not a failure.
 */

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const options = {
  baseUrl: "http://api.test",
  privateKey: PRIVATE_KEY as `0x${string}`,
  chainId: 31337,
  siweDomain: "api.test",
  siweUri: "http://api.test",
};

/** Login responds normally; only the main request goes to the given handler. */
function stubFetch(onTarget: (init: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/siwe/nonce")) {
      return Response.json({ nonce: "abcdef123456", statement: "sign in", domain: "api.test" });
    }
    if (url.endsWith("/auth/siwe/verify")) {
      return Response.json({ sessionToken: "tok" });
    }
    return onTarget(init);
  }) as typeof fetch;
}

describe("worker API client", () => {
  it("aborts with a timeout when no response arrives", async () => {
    const client = createApiClient(
      { ...options, timeoutMs: 50 },
      stubFetch(
        (init) =>
          new Promise<Response>((resolve, reject) => {
            // No signal means no timeout is set.
            // In that case just succeed, so this test fails.
            if (!init.signal) {
              resolve(Response.json({ ok: true }));
              return;
            }
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    await expect(client.post("/api/v1/anchor", {})).rejects.toThrow(/aborted/);
  });
});

it("refreshes an expired session once, keeps mutation headers and caches the new token", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  let logins = 0,
    sends = 0;
  const client = createApiClient(options, (async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/nonce"))
      return Response.json({ nonce: "abcdef123456", statement: "sign in" });
    if (url.endsWith("/verify"))
      return Response.json({ sessionToken: `token${++logins}` });
    return ++sends === 1
      ? new Response("", { status: 401 })
      : Response.json({ ok: true });
  }) as typeof fetch);
  expect(
    await client.post("/scan", undefined, {
      "if-match": '"2"',
      "idempotency-key": "scan1",
    }),
  ).toEqual({ ok: true });
  await client.post("/scan", {});
  expect(logins).toBe(2);
  const targets = calls.filter((c) => c.url.endsWith("/scan"));
  expect(targets).toHaveLength(3);
  expect(targets[1]!.init.headers).toMatchObject({
    authorization: "Bearer token2",
    "if-match": '"2"',
    "idempotency-key": "scan1",
  });
  expect(targets[0]!.init.body).toBe("{}");
});
it.each(["nonce", "verify", "target"])(
  "preserves %s authentication or request failures",
  async (stage) => {
    const client = createApiClient(options, (async (input) => {
      const url = String(input);
      if (url.endsWith("/nonce"))
        return stage === "nonce"
          ? new Response("", { status: 503 })
          : Response.json({ nonce: "abcdef123456", statement: "sign in" });
      if (url.endsWith("/verify"))
        return stage === "verify"
          ? Response.json({}, { status: 403 })
          : Response.json({ sessionToken: "token" });
      return new Response("not json", { status: 500 });
    }) as typeof fetch);
    await expect(client.post("/scan", {})).rejects.toMatchObject({
      code:
        stage === "nonce"
          ? "SIWE_NONCE_FAILED"
          : stage === "verify"
            ? "SIWE_VERIFY_FAILED"
            : "UNKNOWN",
      status: stage === "nonce" ? 503 : stage === "verify" ? 403 : 500,
    });
  },
);

describe("service identity key", () => {
  // anvil/hardhat account 1 — the key above. Public, so it may sign in only on the local chain.
  it("accepts a public development key on the local chain", () => {
    expect(createApiClient(options).walletAddress).toBe("0x70997970c51812dc3a010c7d01b50e0d17dc79c8");
  });

  it("refuses a public development key on a shared chain", () => {
    expect(() => createApiClient({ ...options, chainId: 5611 })).toThrowError(
      /^SCAN_SERVICE_PRIVATE_KEY is a public development key \(anvil\/hardhat or a committed fixture\)/,
    );
  });

  it("accepts a freshly generated key on the testnet", () => {
    expect(() =>
      createApiClient({ ...options, chainId: 5611, privateKey: generatePrivateKey() }),
    ).not.toThrow();
  });
});
