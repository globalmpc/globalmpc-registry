import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api-client.js";

/**
 * Worker → API client — a service token bearer (decision D7).
 *
 * Held here: every request carries the token and the caller's mutation headers; a request that
 * never answers is aborted; a refusal keeps the API's status and code; a 401 is not retried (the
 * token is revoked or expired, and the same token cannot fix that); and a value that is not a
 * service token is refused before the first request, without quoting it.
 */

// Synthetic bearer used only by the local fetch mock; never issued by a server.
const TOKEN = `mpcsvc_${Buffer.from("scan worker test token").toString("base64url")}`;
const options = { baseUrl: "http://api.test", serviceToken: TOKEN };

describe("worker API client", () => {
  it("aborts with a timeout when no response arrives", async () => {
    const client = createApiClient({ ...options, timeoutMs: 50 }, ((_input, init: RequestInit = {}) =>
      new Promise<Response>((resolve, reject) => {
        // No signal means no timeout is set. In that case just succeed, so this test fails.
        if (!init.signal) {
          resolve(Response.json({ ok: true }));
          return;
        }
        init.signal.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch);

    await expect(client.post("/api/v1/uploads/u1/scan-result", {})).rejects.toThrow(/aborted/);
  });

  it("sends the token with the caller's mutation headers, and an empty body as {}", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createApiClient(options, (async (input, init = {}) => {
      calls.push({ url: String(input), init });
      return Response.json({ ok: true });
    }) as typeof fetch);

    expect(
      await client.post("/api/v1/uploads/u1/scan-result", undefined, {
        "if-match": '"2"',
        "idempotency-key": "scan-u1-v2",
      }),
    ).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("http://api.test/api/v1/uploads/u1/scan-result");
    expect(calls[0]!.init).toMatchObject({
      method: "POST",
      body: "{}",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        "if-match": '"2"',
        "idempotency-key": "scan-u1-v2",
      },
    });
  });

  it("does not retry a 401: a revoked or expired token stays refused", async () => {
    let sends = 0;
    const client = createApiClient(options, (async () => {
      sends += 1;
      return Response.json({ code: "UNAUTHENTICATED", message: "no session" }, { status: 401 });
    }) as typeof fetch);
    await expect(client.post("/scan", {})).rejects.toMatchObject({ status: 401, code: "UNAUTHENTICATED" });
    expect(sends).toBe(1);
  });

  it("keeps the API's refusal, and reads a body that is not JSON as unknown", async () => {
    const refusing = createApiClient(options, (async () =>
      Response.json(
        { code: "SERVICE_TOKEN_SCOPE_DENIED", message: "out of scope" },
        { status: 403 },
      )) as typeof fetch);
    await expect(refusing.post("/scan", {})).rejects.toMatchObject({
      status: 403,
      code: "SERVICE_TOKEN_SCOPE_DENIED",
      message: "403 SERVICE_TOKEN_SCOPE_DENIED: out of scope",
    });

    const broken = createApiClient(options, (async () => new Response("not json", { status: 500 })) as typeof fetch);
    await expect(broken.post("/scan", {})).rejects.toMatchObject({ status: 500, code: "UNKNOWN" });
  });

  it("refuses a value that is not a service token, without quoting it", () => {
    for (const value of [
      "",
      // A wallet private key: what this variable held before.
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
      // A person's session token.
      "c2Vzc2lvbiB0b2tlbg",
    ]) {
      let message = "";
      try {
        createApiClient({ ...options, serviceToken: value });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message, value).toMatch(/^SCAN_SERVICE_TOKEN must be a service token/);
      if (value) expect(message).not.toContain(value);
    }
  });
});
