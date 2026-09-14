import { describe, expect, it } from "vitest";
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
  chainId: 97,
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
