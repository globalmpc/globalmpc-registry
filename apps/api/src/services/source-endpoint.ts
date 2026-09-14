import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ipv4ToBytes, ipv6ToBytes } from "../ip.js";

/**
 * 출처 endpoint 제한 — 06 §6.4, OD-43.
 *
 * `source_connections.endpoint`는 운영자가 정하고 **서버가 자격증명을 붙여**
 * 호출한다. 형식만 검사하면 그 값이 `http://169.254.169.254/`나 내부 서비스
 * 주소일 수 있고, 그러면 등록부 조회 경로가 내부망을 읽는 통로가 된다.
 *
 * 두 지점에서 막는다.
 *
 * 1. **저장할 때** — scheme과 호스트 문자열을 본다. 눈에 보이는 것을 그 자리에서
 *    거절해야 운영자가 무엇이 잘못됐는지 안다.
 * 2. **부르기 직전에** — 이름을 실제로 풀어 주소를 본다. 1번만 하면 이름이
 *    사설 주소를 가리키도록 DNS를 바꾸는 것으로 우회된다(DNS rebinding).
 *
 * 리다이렉트는 따라가지 않는다(`source-adapter.ts`). 따라가면 3xx 한 번으로
 * 이 검사 뒤의 주소가 바뀐다.
 */

export class EndpointNotAllowedError extends Error {
  readonly code = "SOURCE_ENDPOINT_NOT_ALLOWED";
  constructor(reason: string) {
    super(reason);
    this.name = "EndpointNotAllowedError";
  }
}

/**
 * 이름으로도 거절하는 호스트.
 *
 * 주소 검사가 본체이고 이것은 저장 시점에 사람에게 보이는 거절이다.
 */
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * 공개 인터넷 밖의 IPv4 대역.
 *
 * 클라우드 metadata endpoint(169.254.169.254)가 link-local에 있다 — 이 한 줄이
 * 없으면 인스턴스 자격증명이 읽힌다.
 */
function isPrivateIpv4Bytes(bytes: readonly number[]): boolean {
  const [a, b] = bytes as [number, number, number, number];

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local · metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF 특수 용도
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  // 192.88.99.0/24 — 6to4 relay anycast(RFC 7526에서 폐기). 남은 경로를 열어
  // 두지 않는다. IPv6 쪽에서 2002::/16을 막았으므로 IPv4 쪽도 같이 막는다.
  if (a === 192 && b === 88 && (bytes[2] as number) === 99) return true;
  if (a >= 224) return true; // multicast · 예약
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const bytes = ipv4ToBytes(address);
  // 주소로 읽히지 않으면 판정할 수 없다. 모르는 것을 통과시키지 않는다.
  return bytes === null ? true : isPrivateIpv4Bytes(bytes);
}

/**
 * IPv6 판정 — **공개 대역 밖을 전부 막는다.**
 *
 * 특수 대역을 하나씩 세는 방식은 새 표기가 나올 때마다 뚫린다(실제로 8종이
 * 통과했다). 전역 유니캐스트는 `2000::/3` 하나뿐이므로, 그 밖을 기본 거절로
 * 두고 안쪽의 예약 대역만 따로 센다. 모르는 대역이 생겨도 닫혀 있다.
 */
function isPrivateIpv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (bytes === null) return true;

  const zerosUpTo = (count: number): boolean => bytes.slice(0, count).every((byte) => byte === 0);

  // `::`(미지정)과 `::1`(loopback).
  if (zerosUpTo(15) && (bytes[15] === 0 || bytes[15] === 1)) return true;

  // `::ffff:a.b.c.d` — IPv4-mapped. 안쪽 IPv4 규칙으로 판정한다.
  if (zerosUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4Bytes([...bytes.slice(12)]);
  }

  // `::a.b.c.d` — IPv4-compatible. 폐기된 표기이며 살려 둘 이유가 없다.
  if (zerosUpTo(12)) return true;

  // `2002::/16` — 6to4. IPv4가 2~5번 바이트에 박혀 있다.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4Bytes([...bytes.slice(2, 6)]);
  }

  // 여기부터가 기본 거절이다. 전역 유니캐스트(2000::/3) 밖은 전부 막는다 —
  // link-local(fe80::/10)·ULA(fc00::/7)·multicast(ff00::/8)·NAT64(64:ff9b::/96)·
  // discard(100::/64)가 한 줄에 걸린다.
  if ((bytes[0]! & 0xe0) !== 0x20) return true;

  // 전역 유니캐스트 안의 예약 대역.
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    // 2001::/23 — IETF 프로토콜 배정. Teredo(2001::/32)가 여기 있다.
    if (bytes[2] === 0x00 && (bytes[3]! & 0xfe) === 0x00) return true;
    // 2001:db8::/32 — 문서용.
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  }
  // 3fff::/20 — 문서용(RFC 9637).
  if (bytes[0] === 0x3f && (bytes[1]! & 0xf0) === 0xf0) return true;

  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  // 주소로 해석되지 않으면 판정할 수 없다. 모르는 것은 통과시키지 않는다.
  return true;
}

/** 대괄호와 끝 점을 벗긴 호스트명. IPv6 리터럴을 주소로 인식하려면 필요하다. */
function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * 저장 시점 검사. DNS를 보지 않는다.
 *
 * `https`만 받는다. 자격증명이 붙는 요청이므로 평문으로 나가면 그 값이 경로
 * 어딘가에서 읽힌다.
 */
export function assertEndpointShape(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EndpointNotAllowedError("endpoint가 URL 형식이 아니다");
  }

  if (url.protocol !== "https:") {
    throw new EndpointNotAllowedError("출처 endpoint는 https여야 한다");
  }

  // `URL.hostname`은 IPv6를 대괄호째 돌려준다. 벗기지 않으면 주소로 인식되지
  // 않아 `https://[::1]/`이 이름 검사만 지나고 통과한다.
  const host = hostnameOf(url);
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new EndpointNotAllowedError(`내부 호스트는 출처가 될 수 없다: ${host}`);
  }

  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new EndpointNotAllowedError(`사설·예약 주소는 출처가 될 수 없다: ${host}`);
  }

  return url;
}

/** 이름을 주소로 푸는 함수. 테스트가 바꿔 낀다. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export const dnsResolver: HostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((entry) => entry.address);
};

/**
 * 호출 직전 검사. **판정에 쓴 주소를 돌려준다.**
 *
 * **하나라도 사설이면 거절한다.** 일부만 공개인 이름은 어느 주소로 연결될지
 * 우리가 고르지 않는다.
 *
 * 돌려주는 값이 이 함수의 절반이다. 검사와 연결이 이름을 각각 풀면 그 사이에
 * DNS 응답이 바뀔 수 있고(rebinding), 그러면 검사한 주소와 연결한 주소가
 * 다르다. 호출부는 여기서 받은 주소로만 연결한다(`source-fetch.ts`).
 */
export async function assertEndpointReachable(
  endpoint: string,
  resolve: HostResolver = dnsResolver,
): Promise<readonly string[]> {
  const url = assertEndpointShape(endpoint);
  const host = hostnameOf(url);

  // 주소 리터럴은 shape 검사에서 이미 걸렀다. 그 주소가 곧 목적지다.
  if (isIP(host) !== 0) return [host];

  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new EndpointNotAllowedError(`이름을 풀 수 없다: ${host}`);
  }

  if (addresses.length === 0) {
    throw new EndpointNotAllowedError(`이름이 주소를 갖지 않는다: ${host}`);
  }

  const blocked = addresses.filter((address) => isPrivateAddress(address));
  if (blocked.length > 0) {
    throw new EndpointNotAllowedError(`사설·예약 주소로 해석된다: ${host}`);
  }

  return addresses;
}
