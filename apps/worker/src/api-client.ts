import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { Hex } from "viem";

/**
 * Worker → API client.
 *
 * The worker **takes the same auth path as a person** — it gets a session via a SIWE signature.
 * A service-only bypass header would itself be an auth bypass, and R1 actually removed such a
 * path.
 *
 * Sessions expire, so on a 401 it logs in once more and retries. Logging in on every request
 * would issue nonces needlessly.
 *
 * Every request has a timeout. The worker calls this client inside its loop, so one hang stalls
 * every later event — it shows up as a stall, not a failure, and a stall triggers neither retry
 * nor alert.
 */

/** Cap for a single request. Same order of magnitude as source lookup (05 §5.12). */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly privateKey: Hex;
  readonly chainId: number;
  /** domain and uri of the SIWE message. Must match the server config to pass verification. */
  readonly siweDomain: string;
  readonly siweUri: string;
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
  /** Current session principal. Public information, safe to log. */
  readonly walletAddress: string;
}

export function createApiClient(
  options: ApiClientOptions,
  fetchImpl: typeof fetch = fetch,
): ApiClient {
  const account = privateKeyToAccount(options.privateKey);
  const walletAddress = account.address.toLowerCase();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let token: string | null = null;

  /** A fresh signal per request. Reusing one aborts everything immediately after the first timeout. */
  const deadline = () => AbortSignal.timeout(timeoutMs);

  async function login(): Promise<string> {
    const nonceResponse = await fetchImpl(`${options.baseUrl}/api/v1/auth/siwe/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress, chainId: options.chainId }),
      signal: deadline(),
    });
    if (!nonceResponse.ok) {
      throw new ApiRequestError(nonceResponse.status, "SIWE_NONCE_FAILED", "nonce issuance failed");
    }
    const challenge = (await nonceResponse.json()) as {
      nonce: string;
      statement: string;
      domain: string;
    };

    const message = createSiweMessage({
      address: account.address,
      chainId: options.chainId,
      domain: options.siweDomain,
      nonce: challenge.nonce,
      statement: challenge.statement,
      uri: options.siweUri,
      version: "1",
      issuedAt: new Date(),
    });

    const signature = await account.signMessage({ message });
    const verifyResponse = await fetchImpl(`${options.baseUrl}/api/v1/auth/siwe/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
      signal: deadline(),
    });
    if (!verifyResponse.ok) {
      const body = (await verifyResponse.json()) as { code?: string; message?: string };
      throw new ApiRequestError(
        verifyResponse.status,
        body.code ?? "SIWE_VERIFY_FAILED",
        body.message ?? "signature verification failed",
      );
    }

    const verified = (await verifyResponse.json()) as { sessionToken: string };
    return verified.sessionToken;
  }

  async function send(
    path: string,
    body: unknown,
    headers: Record<string, string>,
    sessionToken: string,
  ): Promise<Response> {
    return fetchImpl(`${options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...headers,
        authorization: `Bearer ${sessionToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: deadline(),
    });
  }

  return {
    walletAddress,

    async post(path, body, headers = {}) {
      token ??= await login();
      let response = await send(path, body, headers, token);

      // The session may have expired. Log in again only once — repeating turns an auth failure
      // into an infinite loop.
      if (response.status === 401) {
        token = await login();
        response = await send(path, body, headers, token);
      }

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
