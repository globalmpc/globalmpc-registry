import { describe, expect, it } from "vitest";
import { createProxyTrust, createUnroutableClientWarning, isUnroutableAddress } from "../src/client-ip.js";

/**
 * 요청자 주소가 공인 주소인지 — 홉 수 설정이 맞는지의 유일한 런타임 신호.
 *
 * `TRUSTED_PROXY_HOPS`가 실제 프록시 수보다 작으면 `request.ip`가 프록시·컨테이너
 * 주소로 떨어진다. 그 상태는 오류 없이 200을 돌려주지만 무인증 경로의 상한이
 * 사이트 전체 합산이 되어 한 사람이 전체 로그인을 막는다. 배포에서 이것을
 * 사람이 알아채려면 로그를 보고 있어야 하므로, 서버가 스스로 말하게 한다.
 */
describe("isUnroutableAddress", () => {
  it("공인 주소는 정상으로 본다", () => {
    expect(isUnroutableAddress("203.0.113.7")).toBe(false);
    expect(isUnroutableAddress("8.8.8.8")).toBe(false);
    expect(isUnroutableAddress("2001:db8::1")).toBe(false);
  });

  it("loopback을 잡는다 — 프록시를 지나지 않았다는 뜻이다", () => {
    expect(isUnroutableAddress("127.0.0.1")).toBe(true);
    expect(isUnroutableAddress("::1")).toBe(true);
    expect(isUnroutableAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("사설 대역을 잡는다 — 컨테이너 네트워크 주소다", () => {
    expect(isUnroutableAddress("10.0.5.2")).toBe(true);
    expect(isUnroutableAddress("172.16.0.1")).toBe(true);
    expect(isUnroutableAddress("172.31.255.255")).toBe(true);
    expect(isUnroutableAddress("192.168.1.10")).toBe(true);
    expect(isUnroutableAddress("169.254.1.1")).toBe(true);
    expect(isUnroutableAddress("fd00::1")).toBe(true);
    // Docker는 IPv4를 IPv6 매핑 형태로 준다. 접두만 보고 놓치면 안 된다.
    expect(isUnroutableAddress("::ffff:10.0.5.2")).toBe(true);
  });

  it("172.16/12 밖은 공인이다 — 경계를 넓게 잡지 않는다", () => {
    expect(isUnroutableAddress("172.15.0.1")).toBe(false);
    expect(isUnroutableAddress("172.32.0.1")).toBe(false);
  });

  it("주소를 정하지 못한 경우도 경고 대상이다", () => {
    expect(isUnroutableAddress("")).toBe(true);
    expect(isUnroutableAddress(undefined)).toBe(true);
  });
});

describe("createUnroutableClientWarning", () => {
  it("사설 주소가 나오면 알린다", () => {
    const seen: { message: string; address: string }[] = [];
    const warn = createUnroutableClientWarning((address, message) =>
      seen.push({ address, message }),
    );

    warn("10.0.5.2");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.address).toBe("10.0.5.2");
    expect(seen[0]?.message).toMatch(/TRUSTED_PROXY_HOPS/);
  });

  it("공인 주소에는 아무 말도 하지 않는다", () => {
    const seen: string[] = [];
    const warn = createUnroutableClientWarning((address) => seen.push(address));

    warn("203.0.113.7");

    expect(seen).toEqual([]);
  });

  /**
   * 매 요청마다 경고하면 로그가 그것으로 덮여 실제 장애가 묻힌다. 한 번이면
   * 사실은 전달되고 소음은 생기지 않는다.
   */
  it("여러 번 걸려도 한 번만 말한다 — 로그를 덮지 않는다", () => {
    const seen: string[] = [];
    const warn = createUnroutableClientWarning((address) => seen.push(address));

    warn("10.0.5.2");
    warn("10.0.5.3");
    warn("127.0.0.1");

    expect(seen).toEqual(["10.0.5.2"]);
  });
});

/**
 * `x-forwarded-*`를 언제 믿는가 — 2026-09-10.
 *
 * fastify 5.12.1이 **홉 수만 주는 방식을 없앴다.** 홉 수는 바로 앞 상대가 누구인지
 * 검사하지 않으므로, 프록시를 거치지 않고 직접 닿은 요청이 헤더를 스스로 채우면
 * 그 값이 요청자가 된다 — 무인증 경로의 상한이 우회된다.
 */
describe("createProxyTrust", () => {
  const cidrs = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "fc00::/7"];

  it("신뢰 대역 안의 홉만 믿는다", () => {
    const trust = createProxyTrust(1, cidrs);
    expect(typeof trust).toBe("function");
    if (typeof trust !== "function") return;

    expect(trust("10.0.5.2", 0)).toBe(true);
    // 공인 주소에서 직접 온 요청. 헤더를 채워도 요청자가 되지 않는다.
    expect(trust("203.0.113.7", 0)).toBe(false);
  });

  it("Docker가 주는 IPv4-mapped 표기도 같은 대역으로 본다", () => {
    const trust = createProxyTrust(1, cidrs);
    if (typeof trust !== "function") return;

    // 접두를 벗기지 않고 문자열로 비교하면 이 형태가 전부 빠진다.
    expect(trust("::ffff:10.0.5.2", 0)).toBe(true);
  });

  it("홉 수를 넘어가면 믿지 않는다 — 체인을 무한히 거슬러 올라가지 않는다", () => {
    const trust = createProxyTrust(1, cidrs);
    if (typeof trust !== "function") return;

    expect(trust("10.0.5.2", 1)).toBe(false);
  });

  it("IPv6 사설 대역도 대역으로 판정한다", () => {
    const trust = createProxyTrust(2, cidrs);
    if (typeof trust !== "function") return;

    expect(trust("fd00::1", 0)).toBe(true);
    expect(trust("2606:4700::1111", 0)).toBe(false);
  });

  it("대역이 비었거나 홉이 0이면 아무도 믿지 않는다", () => {
    // 헤더를 못 믿는 상태는 상한이 사이트 전체 합산이 되는 것이며, 그 사실은
    // `createUnroutableClientWarning`이 알린다.
    expect(createProxyTrust(1, [])).toBe(false);
    expect(createProxyTrust(0, cidrs)).toBe(false);
    // 형식이 아닌 값만 있으면 신뢰 대역이 없는 것과 같다.
    expect(createProxyTrust(1, ["not-a-cidr"])).toBe(false);
  });
});
