import { createServer, request as httpRequest, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPinnedLookup,
  MAX_SOURCE_RESPONSE_BYTES,
  pinnedFetch,
  SourceResponseTooLargeError,
} from "../src/services/source-fetch.js";

/**
 * 검증된 주소로 연결을 고정한다 — 2026-09-10 실사 A2.
 *
 * `assertEndpointReachable`이 이름을 풀어 사설 주소를 걸러도, 연결이 이름을 다시
 * 풀면 그 사이에 응답이 바뀔 수 있다(DNS rebinding). 검사한 주소로만 연결해야
 * 검사가 뜻을 갖는다.
 *
 * **TLS 이름 검증은 그대로 둔다.** 주소를 URL에 박아 넣는 방식이면 인증서가
 * 호스트명과 맞지 않아 검증이 무너진다. 여기서는 이름은 그대로 두고 `lookup`만
 * 바꾼다 — SNI와 인증서 검증은 호스트명으로 일어난다.
 */
describe("createPinnedLookup", () => {
  it("이름을 풀지 않고 고정된 주소를 돌려준다", async () => {
    const lookup = createPinnedLookup(["203.0.113.10"]);

    const result = await new Promise<{ address: string; family: number }>((resolve, reject) => {
      lookup("registry.example", {}, (error, address, family) => {
        if (error) reject(error);
        else resolve({ address: address as string, family: family as number });
      });
    });

    expect(result).toEqual({ address: "203.0.113.10", family: 4 });
  });

  it("all 옵션에는 목록으로 돌려준다", async () => {
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

  it("고정할 주소가 없으면 연결을 만들지 않는다", async () => {
    // 빈 목록에서 이름 해석으로 되돌아가면 고정이 없는 것과 같다.
    const lookup = createPinnedLookup([]);

    await expect(
      new Promise((resolve, reject) => {
        lookup("registry.example", {}, (error, address) => {
          if (error) reject(error);
          else resolve(address);
        });
      }),
    ).rejects.toThrow(/검증된 주소가 없다/);
  });
});

describe("pinnedFetch", () => {
  let server: Server;
  let port: number;
  let seen: { host: string | undefined; url: string | undefined }[] = [];
  /** 다음 응답. 테스트가 출처 역할을 한다. */
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
    // 이 이름은 실제로 해석되지 않는다(.invalid). 그런데도 요청이 도달하면
    // 연결이 고정된 주소로 갔다는 뜻이다.
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

  it("해석되지 않는 이름이어도 고정된 주소로 연결한다", async () => {
    respond = (write) => write(200, JSON.stringify({ licenseId: "MN-1" }));

    const response = await call("/api?x=1", ["127.0.0.1"]);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(JSON.stringify({ licenseId: "MN-1" }));
    // Host 헤더는 주소가 아니라 이름이다 — TLS 이름 검증과 같은 이름이어야 한다.
    expect(seen[0]?.host).toBe(`registry.invalid:${port}`);
    expect(seen[0]?.url).toBe("/api?x=1");
  });

  it("리다이렉트를 따라가지 않는다", async () => {
    // 따라가면 3xx 한 번으로 검사 뒤의 주소가 바뀐다.
    respond = (write) => write(302, "");

    const response = await call("/api", ["127.0.0.1"]);
    expect(response.status).toBe(302);
  });

  it("상한을 넘는 응답을 메모리에 다 올리지 않는다", async () => {
    respond = (write) => write(200, "x".repeat(MAX_SOURCE_RESPONSE_BYTES + 1024));

    await expect(call("/api", ["127.0.0.1"])).rejects.toThrow(SourceResponseTooLargeError);
  });

  it("고정할 주소가 없으면 요청을 보내지 않는다", async () => {
    respond = (write) => write(200, "{}");

    await expect(call("/api", [])).rejects.toThrow(/검증된 주소가 없다/);
    expect(seen).toHaveLength(0);
  });
});
