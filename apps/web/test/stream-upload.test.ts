import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { STREAM_UPLOAD_MAX_BYTES } from "@mpc/api-contract";
import { config } from "../src/proxy.js";
import { forwardStreamUpload, MULTIPART_FRAMING_BYTES } from "../src/lib/stream-upload.js";
import { POST } from "../src/app/api/v1/projects/[projectId]/uploads/stream/route.js";

const WEB = "http://localhost:3000";
const API = "http://api.internal:3001";
const PROJECT = "0b6f7c2e-3a41-4d5e-9f10-2c3d4e5f6a7b";
const STREAM = `/api/v1/projects/${PROJECT}/uploads/stream`;

/**
 * The streaming upload since WP6 (the data-room regression).
 *
 * The browser can only send a large file to the web origin, and the general `/api` proxy keeps
 * just the first 10 MiB of a body it handles. These pin the two halves of the fix: the proxy does
 * not handle the route, and the handler that does pipes the body on with the same cookie, CSRF and
 * edge-header rules as the proxy.
 */

describe("proxy matcher", () => {
  const matches = (path: string) => unstable_doesMiddlewareMatch({ config, url: `${WEB}${path}` });

  it("leaves the streaming upload to its route handler", () => {
    expect(matches(STREAM)).toBe(false);
    expect(matches("/api/v1/projects/00000000-0000-0000-0000-000000000001/uploads/stream")).toBe(false);
  });

  it("still handles every other API path, the base64 upload and sign-in included", () => {
    for (const path of [
      `/api/v1/projects/${PROJECT}/uploads`,
      `/api/v1/projects/${PROJECT}/uploads/stream/extra`,
      `/api/v1/projects/${PROJECT}/uploads/streamed`,
      "/api/v1/uploads/u-1/scan-result",
      "/api/v1/auth/session",
      "/api/v1/auth/email/verify",
      "/api/v1/projects",
    ]) {
      expect(matches(path), path).toBe(true);
    }
  });

  it("does not run on pages", () => {
    expect(matches("/w/projects")).toBe(false);
  });
});

interface Sent {
  readonly url: string;
  readonly init: RequestInit & { duplex?: string };
  readonly bytes: number;
}

function mockApi(answer: () => Response | Promise<Response>): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init: RequestInit & { duplex?: string }) => {
      let bytes = 0;
      if (init.body instanceof ReadableStream) {
        const reader = init.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += (value as Uint8Array).byteLength;
        }
      }
      sent.push({ url: String(url), init, bytes });
      return answer();
    }),
  );
  return sent;
}

function upload(headers: Record<string, string>, body: Uint8Array<ArrayBuffer> = new Uint8Array(16)): NextRequest {
  return new NextRequest(`${WEB}${STREAM}`, { method: "POST", headers, body });
}

const sameSite = { "sec-fetch-site": "same-origin", cookie: "mpc_session=cookie-token" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("streaming upload pass-through", () => {
  it("pipes every byte of a body over the proxy's cap to the API with the cookie as bearer", async () => {
    const sent = mockApi(() => Response.json({ id: "u-1", byteSize: 12 }, { headers: { "x-request-id": "r-1" } }));
    const size = 12 * 1024 * 1024;
    const response = await forwardStreamUpload(
      upload(
        { ...sameSite, "content-type": "multipart/form-data; boundary=b", "idempotency-key": "k-1" },
        new Uint8Array(size),
      ),
      API,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "u-1", byteSize: 12 });
    expect(response.headers.get("x-request-id")).toBe("r-1");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const [call] = sent;
    expect(call!.url).toBe(`${API}${STREAM}`);
    expect(call!.bytes).toBe(size);
    expect(call!.init.duplex).toBe("half");
    const headers = new Headers(call!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer cookie-token");
    expect(headers.get("content-type")).toBe("multipart/form-data; boundary=b");
    expect(headers.get("idempotency-key")).toBe("k-1");
    // The API reads no cookie; forwarding it would copy the token into its logs.
    expect(headers.get("cookie")).toBeNull();
  });

  it("is what the route serves", async () => {
    const sent = mockApi(() => Response.json({ id: "u-2" }));
    vi.stubEnv("API_ORIGIN", API);
    const response = await POST(upload(sameSite));
    expect(response.status).toBe(200);
    expect(sent[0]!.url).toBe(`${API}${STREAM}`);
  });

  it("forwards a request's own Authorization and does not use the cookie", async () => {
    const sent = mockApi(() => Response.json({}));
    await forwardStreamUpload(upload({ ...sameSite, authorization: "Bearer service-token" }), API);
    expect(new Headers(sent[0]!.init.headers).get("authorization")).toBe("Bearer service-token");
  });

  it("sends no credential when there is no session", async () => {
    const sent = mockApi(() => Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
    const response = await forwardStreamUpload(upload({ "sec-fetch-site": "same-origin" }), API);
    expect(response.status).toBe(401);
    expect(new Headers(sent[0]!.init.headers).get("authorization")).toBeNull();
  });

  it.each([
    [{ "sec-fetch-site": "cross-site" }, "sec-fetch-site:cross-site"],
    [{ origin: "https://evil.example" }, "origin"],
    [{}, "no-origin"],
  ])("refuses a cross-site upload before forwarding a byte (%o)", async (signal, reason) => {
    const sent = mockApi(() => Response.json({}));
    const response = await forwardStreamUpload(upload({ cookie: "mpc_session=cookie-token", ...signal }), API);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "CROSS_SITE_REQUEST_REFUSED", details: { reason } });
    expect(sent).toHaveLength(0);
  });

  it("refuses a declared length that cannot fit the cap, and admits one that can", async () => {
    const sent = mockApi(() => Response.json({}));
    const over = String(STREAM_UPLOAD_MAX_BYTES + MULTIPART_FRAMING_BYTES + 1);
    const refused = await forwardStreamUpload(upload({ ...sameSite, "content-length": over }), API);
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ code: "PAYLOAD_TOO_LARGE" });
    expect(sent).toHaveLength(0);

    // `content-length` describes the browser's connection; the API connection gets its own.
    const fits = await forwardStreamUpload(upload({ ...sameSite, "content-length": "16" }), API);
    expect(fits.status).toBe(200);
    expect(new Headers(sent[0]!.init.headers).get("content-length")).toBeNull();
  });

  it("strips visitor-sent edge headers and vouches only with the secret", async () => {
    const sent = mockApi(() => Response.json({}));
    await forwardStreamUpload(
      upload({ ...sameSite, "x-mpc-edge-secret": "forged", "x-mpc-client-ip": "6.6.6.6", "x-real-ip": "1.2.3.4" }),
      API,
    );
    let headers = new Headers(sent[0]!.init.headers);
    expect(headers.get("x-mpc-edge-secret")).toBeNull();
    expect(headers.get("x-mpc-client-ip")).toBeNull();

    vi.stubEnv("EDGE_PROXY_SECRET", "edge-secret");
    await forwardStreamUpload(upload({ ...sameSite, "x-real-ip": "1.2.3.4" }), API);
    headers = new Headers(sent[1]!.init.headers);
    expect(headers.get("x-mpc-edge-secret")).toBe("edge-secret");
    expect(headers.get("x-mpc-client-ip")).toBe("1.2.3.4");
  });

  it("never hands page script a credential field from the answer", async () => {
    mockApi(() => Response.json({ id: "u-3", sessionToken: "leak", browserBinding: "leak" }));
    const response = await forwardStreamUpload(upload(sameSite), API);
    expect(await response.json()).toEqual({ id: "u-3" });
  });

  it("answers 502 when the API is unreachable or unreadable", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    const down = await forwardStreamUpload(upload(sameSite), API);
    expect(down.status).toBe(502);
    expect(await down.json()).toMatchObject({ code: "API_UNREACHABLE", retryable: true });

    mockApi(() => new Response("<html>gateway</html>", { status: 504 }));
    const garbled = await forwardStreamUpload(upload(sameSite), API);
    expect(garbled.status).toBe(502);
  });

  it("passes an empty answer on with its status", async () => {
    mockApi(() => new Response(null, { status: 204 }));
    const response = await forwardStreamUpload(upload(sameSite), API);
    expect(response.status).toBe(204);
  });

  /**
   * Review L1: the path sent on was the request's own, and URL parsing resolved an encoded `..`
   * in it — `/api/v1/projects/%2e%2e/uploads/stream` went upstream as `/api/v1/uploads/stream`.
   * The path is now rebuilt from a project id that must be a UUID.
   */
  it("forwards only a path rebuilt from a UUID project id", async () => {
    const sent = mockApi(() => Response.json({}));
    const refused: number[] = [];
    for (const path of [
      "/api/v1/projects/%2e%2e/uploads/stream",
      "/api/v1/projects/%2E%2E/uploads/stream",
      "/api/v1/projects/not-a-uuid/uploads/stream",
      `/api/v1/projects/${PROJECT.slice(0, -1)}%62/uploads/stream`,
      "/api/v1/projects/%zz/uploads/stream",
    ]) {
      // `forwardStreamUpload` reads `nextUrl`, so the raw form is what a route handler can be given.
      const request = upload(sameSite);
      Object.defineProperty(request, "nextUrl", { value: Object.assign(new URL(`${WEB}${STREAM}`), {}) });
      Object.defineProperty(request.nextUrl, "pathname", { value: path });
      refused.push((await forwardStreamUpload(request, API)).status);
    }
    expect(refused).toEqual([400, 400, 404, 400, 400]);
    expect(sent).toHaveLength(0);

    await forwardStreamUpload(
      new NextRequest(`${WEB}/api/v1/projects/${PROJECT.toUpperCase()}/uploads/stream?x=1`, {
        method: "POST",
        headers: sameSite,
        body: new Uint8Array(4),
      }),
      API,
    );
    expect(sent[0]!.url).toBe(`${API}${STREAM}?x=1`);
  });

  it("serves only the streaming upload path", async () => {
    const sent = mockApi(() => Response.json({}));
    const response = await forwardStreamUpload(
      new NextRequest(`${WEB}/api/v1/projects/${PROJECT}/uploads`, { method: "POST", headers: sameSite, body: "{}" }),
      API,
    );
    expect(response.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});
