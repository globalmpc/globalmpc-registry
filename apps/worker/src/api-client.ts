import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import type { Hex } from "viem";

/**
 * worker → API 클라이언트.
 *
 * worker도 **사람과 같은 인증 경로를 지난다** — SIWE 서명으로 세션을 받는다.
 * 서비스 전용 우회 헤더를 두면 그 헤더가 곧 인증 우회가 되고, 실제로 R1에서
 * 그런 경로를 제거한 적이 있다.
 *
 * 세션은 만료되므로 401을 받으면 한 번 다시 로그인하고 재시도한다. 매 요청마다
 * 로그인하면 nonce 발급이 불필요하게 늘어난다.
 *
 * 모든 요청에 타임아웃을 건다. worker는 루프 안에서 이 클라이언트를 부르므로
 * 한 번 매달리면 그 뒤의 이벤트가 전부 밀린다 — 실패가 아니라 정지로 나타나고,
 * 정지는 재시도도 경보도 걸리지 않는다.
 */

/** 요청 하나의 상한. 출처 조회(05 §5.12)와 같은 자리수로 둔다. */
export const DEFAULT_TIMEOUT_MS = 15_000;

export interface ApiClientOptions {
  readonly baseUrl: string;
  readonly privateKey: Hex;
  readonly chainId: number;
  /** SIWE 메시지의 domain·uri. 서버 설정과 같아야 검증을 통과한다. */
  readonly siweDomain: string;
  readonly siweUri: string;
  /** 요청 하나의 상한. 기본 15초. */
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
  /** 현재 세션 주체. 로그에 남길 공개 정보다. */
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

  /** 요청마다 새 signal을 만든다. 재사용하면 첫 타임아웃 뒤 전부 즉시 끊긴다. */
  const deadline = () => AbortSignal.timeout(timeoutMs);

  async function login(): Promise<string> {
    const nonceResponse = await fetchImpl(`${options.baseUrl}/api/v1/auth/siwe/nonce`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ walletAddress, chainId: options.chainId }),
      signal: deadline(),
    });
    if (!nonceResponse.ok) {
      throw new ApiRequestError(nonceResponse.status, "SIWE_NONCE_FAILED", "nonce 발급 실패");
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
        body.message ?? "서명 검증 실패",
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

      // 세션이 만료됐을 수 있다. 한 번만 다시 로그인한다 — 반복하면 인증 실패를
      // 무한 루프로 바꾼다.
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
          envelope.message ?? "요청 실패",
        );
      }

      return response.json();
    },
  };
}
