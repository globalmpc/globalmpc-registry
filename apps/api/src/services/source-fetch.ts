import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";

/**
 * 출처 호출 전송 계층 — 2026-09-10 실사 A2·A7.
 *
 * `fetch`를 그대로 쓰지 않는 이유는 두 가지다.
 *
 * 1. **검사한 주소로 연결을 고정해야 한다.** `assertEndpointReachable`이 이름을
 *    풀어 사설 주소를 걸러도, `fetch`가 이름을 다시 풀면 그 사이에 DNS 응답이
 *    바뀔 수 있다(rebinding). 그러면 검사한 주소와 연결한 주소가 다르다.
 *    `fetch`에는 목적지를 지정하는 입구가 없다.
 * 2. **응답 크기에 상한이 필요하다.** `response.text()`는 본문을 전부 메모리에
 *    올린다. 출처가 느리게 큰 본문을 보내면 그것만으로 API가 넘어간다.
 *
 * **주소를 URL에 박아 넣지 않는다.** `https://203.0.113.10/`로 부르면 인증서가
 * 호스트명과 맞지 않아 TLS 이름 검증이 무너지고, 그러면 SSRF를 막으려다 중간자를
 * 허용하게 된다. 이름은 그대로 두고 `lookup`만 바꾼다 — SNI·인증서 검증은
 * 호스트명으로 일어나고 연결만 검증된 주소로 간다.
 */

/**
 * 출처 응답 상한.
 *
 * 등록부 조회 한 건의 응답이다. 이것을 넘으면 우리가 아는 형식이 아니거나
 * 출처가 다른 것을 보내고 있다 — 어느 쪽이든 사람이 본다.
 */
export const MAX_SOURCE_RESPONSE_BYTES = 2 * 1024 * 1024;

export class SourceResponseTooLargeError extends Error {
  readonly code = "SOURCE_RESPONSE_TOO_LARGE";
  constructor(limit: number) {
    super(`출처 응답이 상한(${limit} bytes)을 넘었다`);
    this.name = "SourceResponseTooLargeError";
  }
}

/**
 * 출처 호출의 요청 형태.
 *
 * `RequestInit`의 부분집합에 `pinnedAddresses`를 더한 것이다. `typeof fetch`인
 * 테스트 대역이 그대로 들어맞도록 남은 필드는 `fetch`와 같은 이름을 쓴다.
 */
export interface SourceRequestInit {
  readonly headers: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
  /** 리다이렉트를 따라가지 않는다. 3xx는 사람이 확인한다. */
  readonly redirect: "manual";
  /** 검사에서 통과한 목적지. 이 주소로만 연결한다. */
  readonly pinnedAddresses?: readonly string[];
}

export type SourceFetch = (url: URL, init: SourceRequestInit) => Promise<Response>;

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
 * 이름을 풀지 않고 검증된 주소를 돌려주는 `lookup`.
 *
 * **비어 있으면 오류다.** 이름 해석으로 되돌아가면 고정이 없는 것과 같고, 그
 * 경로는 조용하다 — 검사를 지난 요청이 검사하지 않은 주소로 나간다.
 */
export function createPinnedLookup(addresses: readonly string[]): PinnedLookup {
  const entries = addresses.map((address) => ({ address, family: isIP(address) }));

  return (hostname, options, callback) => {
    if (entries.length === 0) {
      callback(new Error(`검증된 주소가 없다: ${hostname}`));
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

/** 본문을 가질 수 없는 상태. `new Response`가 거절한다. */
const BODILESS_STATUSES = new Set([101, 103, 204, 205, 304]);

type RequestImpl = (
  options: Record<string, unknown>,
  callback: (response: IncomingMessage) => void,
) => ClientRequest;

/**
 * 검증된 주소로 고정된 HTTP 호출.
 *
 * 리다이렉트를 따라가지 않는다 — `node:https`가 애초에 따라가지 않으므로 별도
 * 설정이 없다. 3xx는 그대로 돌아가고 분류가 사람 확인으로 보낸다.
 */
export function pinnedFetch(
  url: URL,
  init: SourceRequestInit,
  requestImpl: RequestImpl = httpsRequest as unknown as RequestImpl,
): Promise<Response> {
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
          // protocol을 넘기지 않는다. `https.request`는 https로, 테스트가 끼우는
          // `http.request`는 http로 각각 기본값을 쓴다.
          hostname: url.hostname,
          port: url.port === "" ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: "GET",
          headers: { ...init.headers },
          // 이름이 아니라 여기서 목적지가 정해진다.
          lookup: createPinnedLookup(init.pinnedAddresses ?? []),
        },
        (response) => {
          const chunks: Buffer[] = [];
          let received = 0;

          response.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > MAX_SOURCE_RESPONSE_BYTES) {
              // 더 읽지 않는다. 이미 받은 것도 버린다.
              response.destroy();
              request.destroy();
              fail(new SourceResponseTooLargeError(MAX_SOURCE_RESPONSE_BYTES));
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

    request.end();
  });
}

/**
 * 응답 헤더.
 *
 * 값이 배열로 오는 헤더(`set-cookie`)가 있다. 하나로 합치지 않고 각각 더한다 —
 * 합치면 원문과 다른 값이 남는다.
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
