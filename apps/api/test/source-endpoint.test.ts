import { describe, expect, it } from "vitest";
import {
  assertEndpointReachable,
  assertEndpointShape,
  EndpointNotAllowedError,
  isPrivateAddress,
} from "../src/services/source-endpoint.js";

/**
 * 출처 endpoint 제한 — SSRF.
 *
 * 이 값은 운영자가 정하고 **서버가 자격증명을 붙여** 부른다. 형식만 보면 그
 * 경로가 내부망을 읽는 통로가 된다.
 */
describe("assertEndpointShape", () => {
  it("공개 https 주소를 받는다", () => {
    expect(() => assertEndpointShape("https://registry.example/api/v1")).not.toThrow();
  });

  it("http를 거절한다 — 자격증명이 평문으로 나간다", () => {
    expect(() => assertEndpointShape("http://registry.example/api")).toThrow(
      EndpointNotAllowedError,
    );
  });

  it("localhost를 거절한다", () => {
    expect(() => assertEndpointShape("https://localhost/api")).toThrow(EndpointNotAllowedError);
    expect(() => assertEndpointShape("https://api.internal/x")).toThrow(EndpointNotAllowedError);
  });

  it("6to4 relay anycast를 거절한다", () => {
    // 2026-09-10 실사 A2의 잔여 1종. IPv6 쪽 2002::/16만 막고 IPv4 쪽을 두면
    // 같은 전이 경로가 한쪽으로 열려 있다.
    expect(isPrivateAddress("192.88.99.1")).toBe(true);
    expect(() => assertEndpointShape("https://192.88.99.1/")).toThrow(EndpointNotAllowedError);
  });

  it("클라우드 metadata 주소를 거절한다", () => {
    // 이 한 줄이 없으면 인스턴스 자격증명이 읽힌다.
    expect(() => assertEndpointShape("https://169.254.169.254/latest/meta-data/")).toThrow(
      EndpointNotAllowedError,
    );
    expect(() => assertEndpointShape("https://metadata.google.internal/x")).toThrow(
      EndpointNotAllowedError,
    );
  });

  it("사설 대역 주소를 거절한다", () => {
    for (const host of ["10.0.0.5", "172.16.3.1", "192.168.1.1", "127.0.0.1", "[::1]"]) {
      expect(() => assertEndpointShape(`https://${host}/api`)).toThrow(EndpointNotAllowedError);
    }
  });
});

describe("isPrivateAddress", () => {
  it("공개 주소는 통과한다", () => {
    expect(isPrivateAddress("203.0.113.10")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("IPv4-mapped IPv6로 우회되지 않는다", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  });

  it("주소로 해석되지 않으면 통과시키지 않는다", () => {
    // 모르는 것을 허용으로 떨어뜨리면 판정 실패가 곧 통과가 된다.
    expect(isPrivateAddress("not-an-address")).toBe(true);
  });
});

describe("assertEndpointReachable", () => {
  it("이름이 사설 주소로 해석되면 거절한다 — DNS rebinding", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => ["10.0.0.5"]),
    ).rejects.toThrow(EndpointNotAllowedError);
  });

  it("하나라도 사설이면 거절한다 — 어느 주소로 붙을지 우리가 고르지 않는다", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => [
        "203.0.113.10",
        "10.0.0.5",
      ]),
    ).rejects.toThrow(EndpointNotAllowedError);
  });

  it("전부 공개 주소면 통과하고 그 주소를 돌려준다", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => ["203.0.113.10"]),
    ).resolves.toEqual(["203.0.113.10"]);
  });

  it("이름을 풀 수 없으면 거절한다", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(EndpointNotAllowedError);
  });
});

/**
 * 우회 입력 회귀 — 2026-09-10 실사 A2.
 *
 * 아래 열두 개는 전부 **차단 함수를 지나 통과했던 입력**이다. 원인은 하나가
 * 아니었다: IPv4-mapped를 점 표기로만 찾았고(URL은 `::ffff:7f00:1`로 정규화한다),
 * link-local을 `fe80` 문자열로만 봤으며(대역은 `fe80::/10`이다), 6to4·NAT64처럼
 * IPv4를 품는 표기와 문서·멀티캐스트 대역에는 규칙이 아예 없었다.
 *
 * 하나씩 더하는 방식으로는 다음 표기에서 또 뚫린다. 그래서 판정을 뒤집었다 —
 * **공개 대역(2000::/3) 밖은 전부 막고** 그 안의 예약 대역만 따로 센다.
 */
describe("IPv6 우회 입력", () => {
  const blocked = [
    // URL이 IPv4-mapped를 16진수로 정규화한다. 점 표기만 보면 지나간다.
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:7f00:1",
    // 점 표기 IPv4-mapped·IPv4-compatible.
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    // link-local은 fe80::/10이다. fe80 접두만 보면 대역의 4분의 3이 열린다.
    "fe90::1",
    "febf::1",
    // IPv4를 품는 전이 표기. 안쪽 주소가 loopback이다.
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
    // 예약·특수 대역.
    "2001:db8::1",
    "2001::1",
    "3fff::1",
    "ff02::1",
    "100::1",
    "fc00::1",
    "fe80::1",
    "::1",
    "::",
  ];

  it.each(blocked)("%s를 사설·예약으로 판정한다", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(blocked)("https://[%s]/ 를 거절한다", (address) => {
    expect(() => assertEndpointShape(`https://[${address}]/`)).toThrow(EndpointNotAllowedError);
  });

  it("공개 IPv6는 계속 통과한다", () => {
    for (const address of ["2606:4700::1111", "2400:cb00:2048:1::", "2002:cb00:7101::"]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it("IPv4-mapped 공개 주소는 IPv4 규칙으로 판정한다", () => {
    expect(isPrivateAddress("::ffff:203.0.113.10")).toBe(false);
  });
});

/**
 * 검사한 주소로 연결을 고정한다 — 2026-09-10 실사 A2.
 *
 * 검사와 연결이 이름을 각각 풀면 그 사이에 응답이 바뀔 수 있다(DNS rebinding).
 * `assertEndpointReachable`이 **판정에 쓴 주소를 돌려주고** 호출부가 그 주소로만
 * 연결한다.
 */
describe("검증된 주소 반환", () => {
  it("판정에 쓴 주소를 돌려준다", async () => {
    const addresses = await assertEndpointReachable("https://registry.example/api", async () => [
      "203.0.113.10",
      "203.0.113.11",
    ]);
    expect(addresses).toEqual(["203.0.113.10", "203.0.113.11"]);
  });

  it("주소 리터럴은 그 주소를 돌려준다", async () => {
    const addresses = await assertEndpointReachable("https://203.0.113.10/api", async () => {
      throw new Error("이름을 풀면 안 된다");
    });
    expect(addresses).toEqual(["203.0.113.10"]);
  });
});

/**
 * 감사 A2의 재현 11종을 그대로 고정한다.
 *
 * 앞의 일곱은 예전에 통과했던 것이고 뒤의 넷은 처음부터 거절되던 것이다. 뒤의 넷이
 * 거절되는 이유는 우리 코드가 아니라 `new URL()`의 정규화다(8진수·정수·축약이
 * 점 표기로 돌아온다). **그 전제가 바뀌면 여기서 드러나야 한다** — 그래서 같이 둔다.
 */
describe("감사 A2 재현 11종", () => {
  const cases = [
    "https://[::ffff:7f00:1]/",
    "https://[::ffff:a9fe:a9fe]/",
    "https://[fe90::1]/",
    "https://[::127.0.0.1]/",
    "https://[64:ff9b::7f00:1]/",
    "https://[2002:7f00:1::]/",
    "https://192.88.99.1/",
    "https://0177.0.0.1/",
    "https://2130706433/",
    "https://127.1/",
    "https://169.254.169.254/",
  ];

  it.each(cases)("%s를 거절한다", (endpoint) => {
    expect(() => assertEndpointShape(endpoint)).toThrow(EndpointNotAllowedError);
  });

  it("열한 개 모두 거절된다 — ACCEPTED 0", () => {
    const accepted = cases.filter((endpoint) => {
      try {
        assertEndpointShape(endpoint);
        return true;
      } catch {
        return false;
      }
    });
    expect(accepted).toEqual([]);
  });
});
