/**
 * Worker → API client.
 *
 * The worker authenticates with a **service token** (decision D7): a bearer secret issued by an
 * operator for the scan service subject, limited to the `scan_result` scope. It is not a person
 * and does not sign in like one — no wallet, no session, no second factor. The API makes only the
 * `scan_service` role effective for it, and only on the scan-result route; a leaked token reports
 * scan results and nothing else.
 *
 * There is no login, so there is nothing to refresh: a 401 means the token was revoked or has
 * expired, and retrying with the same token cannot fix that. It is reported, and the loop keeps
 * reporting it until an operator rotates the token.
 *
 * Every request has a timeout. The worker calls this client inside its loop, so one hang stalls
 * every later event — it shows up as a stall, not a failure, and a stall triggers neither retry
 * nor alert.
 */

/** Cap for a single request. Same order of magnitude as source lookup (05 §5.12). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Every service token starts with this (`apps/api/src/plugins/session-token.ts`). */
export const SERVICE_TOKEN_PREFIX = "mpcsvc_";

export interface ApiClientOptions {
  readonly baseUrl: string;
  /** The scan service's token. Never logged. */
  readonly serviceToken: string;
  /** Cap for a single request. Default 15 s. */
  readonly timeoutMs?: number;
}

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`${status} ${code}: ${message}`);
    this.name = "ApiRequestError";
  }
}

export interface ApiClient {
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<unknown>;
}

export function createApiClient(
  options: ApiClientOptions,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  // A person's session token or a wallet key in this variable would fail on the first report;
  // refusing at startup says which variable is wrong. The message never quotes the value.
  if (!options.serviceToken.startsWith(SERVICE_TOKEN_PREFIX)) {
    throw new Error(`SCAN_SERVICE_TOKEN must be a service token (${SERVICE_TOKEN_PREFIX}…)`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    async post(path, body, headers = {}) {
      const response = await fetchImpl(`${options.baseUrl}${path}`, {
        method: "POST",
        headers: {
          ...headers,
          authorization: `Bearer ${options.serviceToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body ?? {}),
        // A fresh signal per request. Reusing one aborts everything after the first timeout.
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const envelope = (await response.json().catch(() => ({}))) as {
          code?: string;
          message?: string;
        };
        throw new ApiRequestError(
          response.status,
          envelope.code ?? "UNKNOWN",
          envelope.message ?? "request failed",
        );
      }

      return response.json();
    },
  };
}
