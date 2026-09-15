import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pinnedFetch, ResponseTooLargeError, type PinnedRequestInit } from "../src/pinned-fetch.js";

/**
 * Pinned transport for webhook delivery — W-087.
 *
 * Source calls are GETs; webhooks POST a signed body. The pinning and the no-redirect rule must
 * hold for both, and a webhook needs a much smaller response cap — it reads nothing back.
 */
describe("pinnedFetch for webhook requests", () => {
  let server: Server;
  let port: number;
  let seen: { method: string | undefined; length: string | undefined; body: string }[] = [];
  let respond: (write: (status: number, body: string, headers?: Record<string, string>) => void) => void;

  beforeAll(async () => {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          method: request.method,
          length: request.headers["content-length"],
          body: Buffer.concat(chunks).toString("utf8"),
        });
        respond((status, body, headers = {}) => {
          response.writeHead(status, { "content-type": "text/plain", ...headers });
          response.end(body);
        });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function call(extra: Partial<PinnedRequestInit>) {
    seen = [];
    // This name never resolves (.invalid). If the request arrives, it went to the pinned address.
    return pinnedFetch(
      new URL(`https://hooks.invalid:${port}/hook`),
      {
        headers: { "content-type": "application/json" },
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
        pinnedAddresses: ["127.0.0.1"],
        ...extra,
      },
      httpRequest,
    );
  }

  it("sends a POST with its body and length to the pinned address", async () => {
    respond = (write) => write(200, "");
    const body = JSON.stringify({ kind: "registry_revoked", summary: "Record revoked" });

    const response = await call({ method: "POST", body });

    expect(response.status).toBe(200);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.body).toBe(body);
    expect(seen[0]?.length).toBe(String(Buffer.byteLength(body)));
  });

  it("does not follow a redirect on POST", async () => {
    // A 307 would replay the signed body to wherever `location` points, unchecked.
    respond = (write) => write(307, "", { location: "http://169.254.169.254/latest" });

    const response = await call({ method: "POST", body: "{}" });

    expect(response.status).toBe(307);
    expect(seen).toHaveLength(1);
  });

  it("applies a per-call response cap", async () => {
    respond = (write) => write(200, "x".repeat(4096));

    await expect(call({ method: "POST", body: "{}", maxResponseBytes: 1024 })).rejects.toThrow(
      ResponseTooLargeError,
    );
  });

  it("keeps GET without a body as the default", async () => {
    respond = (write) => write(200, "ok");

    await call({});

    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.body).toBe("");
  });
});
