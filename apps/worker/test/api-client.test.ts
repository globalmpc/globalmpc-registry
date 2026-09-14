import { describe, expect, it } from "vitest";
import { createApiClient } from "../src/api-client.js";

/**
 * worker → API 호출의 타임아웃.
 *
 * API가 응답을 지연시키면 worker의 요청은 끝나지 않는다. outbox publisher와
 * anchor submitter는 루프 안에서 이 클라이언트를 부르므로, 한 번 매달리면
 * 그 뒤의 이벤트가 전부 밀린다 — 실패가 아니라 정지로 나타난다.
 */

const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const options = {
  baseUrl: "http://api.test",
  privateKey: PRIVATE_KEY as `0x${string}`,
  chainId: 97,
  siweDomain: "api.test",
  siweUri: "http://api.test",
};

/** 로그인은 정상 응답하고, 본 요청만 주어진 처리로 넘긴다. */
function stubFetch(onTarget: (init: RequestInit) => Promise<Response>): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = String(input);
    if (url.endsWith("/auth/siwe/nonce")) {
      return Response.json({ nonce: "abcdef123456", statement: "sign in", domain: "api.test" });
    }
    if (url.endsWith("/auth/siwe/verify")) {
      return Response.json({ sessionToken: "tok" });
    }
    return onTarget(init);
  }) as typeof fetch;
}

describe("worker API 클라이언트", () => {
  it("응답이 오지 않으면 타임아웃으로 끊는다", async () => {
    const client = createApiClient(
      { ...options, timeoutMs: 50 },
      stubFetch(
        (init) =>
          new Promise<Response>((resolve, reject) => {
            // signal이 없으면 타임아웃이 걸려 있지 않다는 뜻이다.
            // 그때는 그냥 성공시켜, 이 테스트가 통과하지 못하게 둔다.
            if (!init.signal) {
              resolve(Response.json({ ok: true }));
              return;
            }
            init.signal.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );

    await expect(client.post("/api/v1/anchor", {})).rejects.toThrow(/aborted/);
  });
});
