import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";

/**
 * Transport layer for outbound calls to operator-set URLs — 2026-09-10 audit A2·A7, W-087.
 *
 * Used for source calls (`apps/api`) and notification webhooks (`apps/worker`). Two reasons
 * not to use `fetch` directly.
 *
 * 1. **The connection must be pinned to the checked address.** Even if `assertEndpointReachable`
 *    resolves the name and filters private addresses, `fetch` resolving it again lets the DNS
 *    answer change in between (rebinding). The checked and connected addresses then differ.
 *    `fetch` has no entry point for specifying the destination.
 * 2. **The response size needs a cap.** `response.text()` loads the whole body into memory.
 *    A peer slowly sending a large body is enough to take the process down.
 *
 * **The address is not put into the URL.** Calling `https://203.0.113.10/` makes the certificate
 * mismatch the hostname and breaks TLS name verification — preventing SSRF would then allow a
 * man-in-the-middle. The name stays and only `lookup` changes — SNI and certificate checks use
 * the hostname, and only the connection goes to the verified address.
 */

/**
 * Default response cap.
 *
 * Sized for a single registry lookup. Exceeding this means it is not a format we know or the
 * peer is sending something else — either way a person looks.
 */
export const DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ResponseTooLargeError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";
  constructor(limit: number) {
    super(`Response exceeded the cap (${limit} bytes)`);
    this.name = "ResponseTooLargeError";
  }
}

/**
 * Request shape for pinned calls.
 *
 * A subset of `RequestInit` plus `pinnedAddresses`. The remaining fields use the same names as
 * `fetch` so test doubles fit as is.
 */
export interface PinnedRequestInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** Redirects are not followed. A person checks 3xx. */
  readonly redirect: "manual";
  /** Destinations that passed the check. Connects only to these addresses. */
  readonly pinnedAddresses?: readonly string[];
  /** Defaults to GET (source lookups). Webhooks POST. */
  readonly method?: "GET" | "POST";
  /** Request body. Sent with an explicit `content-length`. */
  readonly body?: string;
  /** Response cap in bytes. Defaults to `DEFAULT_MAX_RESPONSE_BYTES`. */
  readonly maxResponseBytes?: number;
}

export type PinnedFetch = (url: URL, init: PinnedRequestInit) => Promise<Response>;

type LookupCallback = (
  error: Error | null,
  addressOrAddresses?: string | { address: string; family: number }[],
  family?: number,
) => void;

export type PinnedLookup = (
  hostname: string,
  options: { readonly all?: boolean },
  callback: LookupCallback,
) => void;

/**
 * A `lookup` that returns verified addresses without resolving the name.
 *
 * **Empty is an error.** Falling back to name resolution equals no pinning, and that path is
 * silent — a request that passed the check goes to an address that was never checked.
 */
export function createPinnedLookup(addresses: readonly string[]): PinnedLookup {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));

  return (hostname, options, callback) => {
    if (entries.length === 0) {
      callback(new Error(`No verified address: ${hostname}`));
      return;
    }
    if (options.all) {
      callback(null, entries);
      return;
    }
    const first = entries[0]!;
    callback(null, first.address, first.family);
  };
}

/** Statuses that cannot have a body. `new Response` rejects them. */
const BODILESS_STATUSES = new Set([101, 103, 204, 205, 304]);

type RequestImpl = (
  options: Record<string, unknown>,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/**
 * HTTP call pinned to verified addresses.
 *
 * Redirects are not followed — `node:https` does not follow them in the first place, so no
 * extra setting is needed. 3xx returns as is and the caller classifies it.
 */
export function pinnedFetch(
  url: URL,
  init: PinnedRequestInit,
  requestImpl: RequestImpl = httpsRequest as unknown as RequestImpl,
): Promise<Response> {
  const cap = init.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const headers =
    init.body === undefined
      ? { ...init.headers }
      : { ...init.headers, "content-length": String(Buffer.byteLength(init.body)) };

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    let request: ClientRequest;
    try {
      request = requestImpl(
        {
          // Do not pass protocol. `https.request` defaults to https, and the `http.request` a test
          // injects defaults to http.
          hostname: url.hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: init.method ?? "GET",
          headers,
          // The destination is decided here, not by the name.
          lookup: createPinnedLookup(init.pinnedAddresses ?? []),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;

          response.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > cap) {
              // Read no further. Discard what was already received.
              response.destroy();
              request.destroy();
              fail(new ResponseTooLargeError(cap));
              return;
            }
            chunks.push(chunk);
          });

          response.on("end", () => {
            if (settled) return;
            settled = true;
            const status = response.statusCode ?? 502;
            const body = BODILESS_STATUSES.has(status)
              ? null
              : new Uint8Array(Buffer.concat(chunks));
            resolve(new Response(body, { status, headers: toHeaders(response) }));
          });

          response.on("error", fail);
        },
      );
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
      return;
    }

    request.on("error", fail);

    if (init.signal.aborted) {
      request.destroy();
      fail(new Error("aborted"));
      return;
    }
    init.signal.addEventListener(
      "abort",
      () => {
        request.destroy();
        fail(new Error("aborted"));
      },
      { once: true },
    );

    if (init.body === undefined) request.end();
    else request.end(init.body);
  });
}

/**
 * Response headers.
 *
 * Some headers arrive as arrays (`set-cookie`). They are appended individually, not joined —
 * joining leaves a value that differs from the original.
 */
function toHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}
