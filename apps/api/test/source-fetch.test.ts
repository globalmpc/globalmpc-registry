import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPinnedLookup,
  MAX_SOURCE_RESPONSE_BYTES,
  pinnedFetch,
  SourceResponseTooLargeError,
} from "../src/services/source-fetch.js";

/**
 * Pins the connection to the validated address — 2026-09-10 audit A2.
 *
 * Even if `assertEndpointReachable` resolves the name and filters private addresses, a
 * connection that re-resolves can get a different answer (DNS rebinding). The check only
 * means something if the connection uses the checked address.
 *
 * **TLS name verification stays intact.** Putting the address into the URL would make
 * the certificate mismatch the host name. Here the name stays and only `lookup`
 * changes — SNI and certificate checks use the host name.
 */
describe("createPinnedLookup", () => {
  it("returns the pinned address without resolving the name", async () => {
    const lookup = createPinnedLookup(["203.0.113.10"]);

    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("registry.example", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });

    expect(result).toEqual({ address: "203.0.113.10", family: 4 });
  });

  it("returns a list for the all option", async () => {
    const lookup = createPinnedLookup(["203.0.113.10", "2606:4700::1111"]);

    const result = await new Promise((resolve, reject) => {
      lookup("registry.example", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });

    expect(result).toEqual([
      { address: "203.0.113.10", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ]);
  });

  it("does not connect when there is no address to pin", async () => {
    // Falling back to name resolution on an empty list is the same as no pinning.
    const lookup = createPinnedLookup([]);

    await expect(
      new Promise((resolve, reject) => {
        lookup("registry.example", {}, (error, address) => {
          if (error) reject(error);
          else resolve(address);
        });
      }),
    ).rejects.toThrow(/No verified address/);
  });
});

describe("pinnedFetch", () => {
  let server: Server;
  let port: number;
  let seen: { host: string | undefined; url: string | undefined }[] = [];
  /** Next response. The test plays the source. */
  let respond: (write: (status: number, body: string) => void) => void;

  beforeAll(async () => {
    server = createServer((request, response) => {
      seen.push({ host: request.headers.host, url: request.url });
      respond((status, body) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(body);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function call(path: string, addresses: readonly string[]) {
    seen = [];
    // This name never resolves (.invalid). If the request still arrives,
    // the connection went to the pinned address.
    return pinnedFetch(
      new URL(`https://registry.invalid:${port}${path}`),
      {
        headers: { "x-test": "1" },
        signal: AbortSignal.timeout(5000),
        redirect: "manual",
        pinnedAddresses: addresses,
      },
      httpRequest,
    );
  }

  it("connects to the pinned address even for an unresolvable name", async () => {
    respond = (write) => write(200, JSON.stringify({ licenseId: "MN-1" }));

    const response = await call("/api?x=1", ["127.0.0.1"]);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ licenseId: "MN-1" }));
    // The Host header is the name, not the address — it must match the TLS-verified name.
    expect(seen[0]?.host).toBe(`registry.invalid:${port}`);
    expect(seen[0]?.url).toBe("/api?x=1");
  });

  it("does not follow redirects", async () => {
    // Following one 3xx would change the address after the check.
    respond = (write) => write(302, "");

    const response = await call("/api", ["127.0.0.1"]);
    expect(response.status).toBe(302);
  });

  it("does not buffer a response over the cap into memory", async () => {
    respond = (write) => write(200, "x".repeat(MAX_SOURCE_RESPONSE_BYTES + 1024));

    await expect(call("/api", ["127.0.0.1"])).rejects.toThrow(SourceResponseTooLargeError);
  });

  it("sends no request when there is no address to pin", async () => {
    respond = (write) => write(200, "{}");

    await expect(call("/api", [])).rejects.toThrow(/No verified address/);
    expect(seen).toHaveLength(0);
  });
});
