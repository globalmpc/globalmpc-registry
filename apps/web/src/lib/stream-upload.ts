import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { STREAM_UPLOAD_MAX_BYTES } from "@mpc/api-contract";
import { cookieMode, crossSiteRefusal, pathRefusal, withoutCredentials } from "./bff";
import { edgeRequestHeaders } from "../proxy";

/**
 * The streaming upload, passed through the web origin without buffering (WP6).
 *
 * Since WP6 the session is an HttpOnly cookie on this origin, so the browser can send a large
 * evidence file nowhere but here — it holds no token it could send to the API host. The general
 * `/api` proxy (`proxy.ts`) cannot carry it: Next.js buffers the body of every request a proxy
 * handles and keeps only the first `proxyClientMaxBodySize` (10 MiB) of it, so a larger file
 * reached the API cut off mid-part and the upload never completed. The proxy's matcher therefore
 * leaves this one route out, and this route handler pipes the body on as it arrives.
 *
 * It applies what the proxy applies, and nothing more:
 * - **Cross-site refusal.** The same `Sec-Fetch-Site` / `Origin` rule (`crossSiteRefusal`), before
 *   a byte is forwarded.
 * - **The credential.** The cookie's token becomes the bearer; a request with its own
 *   `Authorization` (a service or test client) is forwarded as sent and the cookie is not used.
 *   The cookie itself never reaches the API.
 * - **Edge headers.** Stripped from what the visitor sent and re-added only with the secret.
 * - **Size.** A declared length that cannot fit `STREAM_UPLOAD_MAX_BYTES` plus the multipart
 *   framing is refused here; the API still enforces the exact cap on the file part itself, which
 *   also covers a body sent without a length.
 *
 * No new credential exists: the upload rides the same session, with the same roles, as any other
 * request from this browser.
 */

/** Room for the multipart boundary, part headers and file name around the file itself. */
export const MULTIPART_FRAMING_BYTES = 1024 * 1024;

/**
 * The one path this handler serves. The project id is a UUID; the path sent on is rebuilt from it,
 * never copied from the request (an encoded `..` would otherwise resolve upstream, review L1).
 */
export const STREAM_UPLOAD_ROUTE =
  /^\/api\/v1\/projects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/uploads\/stream$/i;

/** Request headers that describe the browser's connection, not the one opened to the API. */
const CONNECTION_HEADERS = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "cookie"];

/** Headers of the API's answer worth passing on to the page. */
const PASSED_HEADERS = ["x-request-id", "x-correlation-id", "retry-after"] as const;

function envelope(status: number, code: string, message: string, retryable: boolean, details?: Record<string, unknown>) {
  return NextResponse.json(
    { code, message, retryable, correlationId: crypto.randomUUID(), ...(details ? { details } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function forwardStreamUpload(
  request: NextRequest,
  apiOrigin = process.env.API_ORIGIN ?? "http://localhost:3001",
): Promise<Response> {
  const { pathname, search } = request.nextUrl;
  const unreadable = pathRefusal(pathname);
  if (unreadable || pathname.includes("%")) {
    return envelope(400, "PATH_ENCODING_REFUSED", "This address is not accepted in encoded form", false, {
      reason: unreadable ?? "encoded",
    });
  }
  const projectId = STREAM_UPLOAD_ROUTE.exec(pathname)?.[1];
  if (!projectId) {
    return envelope(404, "NOT_FOUND", "No such route", false);
  }
  const upstreamPath = `/api/v1/projects/${projectId.toLowerCase()}/uploads/stream`;

  const mode = cookieMode(request);
  const cookieToken = request.cookies.get(mode.session)?.value;
  const ridesOnCookie = !request.headers.has("authorization") && Boolean(cookieToken);

  const refusal = crossSiteRefusal(request, ridesOnCookie);
  if (refusal) {
    return envelope(403, "CROSS_SITE_REQUEST_REFUSED", "This request did not come from this site", false, {
      reason: refusal,
    });
  }

  const declared = Number(request.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > STREAM_UPLOAD_MAX_BYTES + MULTIPART_FRAMING_BYTES) {
    return envelope(413, "PAYLOAD_TOO_LARGE", "The request body is larger than the server accepts", false, {
      maxBytes: String(STREAM_UPLOAD_MAX_BYTES),
    });
  }

  const headers = edgeRequestHeaders(request, process.env.EDGE_PROXY_SECRET);
  for (const name of CONNECTION_HEADERS) headers.delete(name);
  if (ridesOnCookie) headers.set("authorization", `Bearer ${cookieToken}`);

  let upstream: Response;
  try {
    upstream = await fetch(new URL(`${upstreamPath}${search}`, apiOrigin), {
      method: "POST",
      headers,
      body: request.body,
      // Send the body as it arrives instead of reading it into memory first.
      duplex: "half",
      cache: "no-store",
      redirect: "manual",
      // The browser giving up (navigating away, cancelling) ends the request to the API too.
      signal: request.signal,
    } as RequestInit & { duplex: "half" });
  } catch {
    return envelope(502, "API_UNREACHABLE", "The registry API could not be reached. Try again", true);
  }

  const text = await upstream.text();
  const passed = new Headers({ "cache-control": "no-store" });
  for (const name of PASSED_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) passed.set(name, value);
  }
  if (text === "") return new NextResponse(null, { status: upstream.status, headers: passed });
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    return envelope(502, "API_UNREACHABLE", "The registry API answered something unreadable", true);
  }
  return NextResponse.json(withoutCredentials(body), { status: upstream.status, headers: passed });
}
