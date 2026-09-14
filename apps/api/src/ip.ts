import { isIP } from "node:net";

/**
 * IP 주소 파싱과 대역 판정.
 *
 * 두 곳이 같은 질문을 한다 — 출처 endpoint가 내부망인가(SSRF, `services/
 * source-endpoint.ts`)와 요청을 넘긴 피어가 우리 프록시인가(`client-ip.ts`).
 * 각자 문자열 접두로 판정하다 실제로 뚫렸다(2026-09-10 실사 A2). 판정을 한 곳에
 * 모으고 **바이트로만 본다** — 표기가 여럿이면 판정하는 쪽과 연결하는 쪽이 다른
 * 주소를 본다.
 */

/**
 * 점 표기 IPv4를 바이트로.
 *
 * `010`을 8진수로 읽는 파서가 있다. 우리는 받지 않는다 — 표기를 하나로 좁히는
 * 것이 판정을 하나로 만드는 방법이다.
 */
export function ipv4ToBytes(address: string): readonly number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;

  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * IPv6 문자열을 16바이트로 편다.
 *
 * **문자열 접두로 대역을 판정하지 않기 위해서다.** `fe80` 접두 검사는
 * `fe80::/10`의 4분의 1만 덮고, `::ffff:127.0.0.1`은 `URL`을 지나면
 * `::ffff:7f00:1`이 되어 점 표기 정규식에 걸리지 않는다. 둘 다 실제로 통과했다.
 */
export function ipv6ToBytes(address: string): Uint8Array | null {
  const value = address.toLowerCase();
  // zone index(`fe80::1%eth0`)는 대상이 아니다. 판정하지 않는다.
  if (value.includes("%")) return null;

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const toBytes = (segment: string): number[] | null => {
    if (segment === "") return [];
    const items = segment.split(":");
    const out: number[] = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;

      // 점 표기 IPv4는 마지막 자리에만 온다.
      if (item.includes(".")) {
        if (index !== items.length - 1) return null;
        const quad = ipv4ToBytes(item);
        if (!quad) return null;
        out.push(...quad);
        continue;
      }

      if (!/^[0-9a-f]{1,4}$/.test(item)) return null;
      const word = Number.parseInt(item, 16);
      out.push(word >> 8, word & 0xff);
    }
    return out;
  };

  const head = toBytes(halves[0] ?? "");
  const tail = halves.length === 2 ? toBytes(halves[1] ?? "") : [];
  if (head === null || tail === null) return null;

  const bytes = new Uint8Array(16);
  if (halves.length === 1) {
    if (head.length !== 16) return null;
    bytes.set(head);
    return bytes;
  }

  // `::`가 최소 한 그룹을 덮어야 한다. 16바이트가 다 찼으면 압축할 것이 없다.
  if (head.length + tail.length >= 16) return null;
  bytes.set(head, 0);
  bytes.set(tail, 16 - tail.length);
  return bytes;
}

/**
 * 주소를 16바이트로 정규화한다.
 *
 * IPv4는 IPv4-mapped(`::ffff:a.b.c.d`)로 올린다. 그래야 `10.0.0.1`과
 * `::ffff:10.0.0.1`이 같은 대역 판정을 지난다 — Docker가 IPv4를 mapped 형태로
 * 주므로 둘을 따로 다루면 한쪽이 빠진다.
 */
export function ipToBytes(address: string): Uint8Array | null {
  const family = isIP(address);
  if (family === 4) {
    const quad = ipv4ToBytes(address);
    if (!quad) return null;
    const bytes = new Uint8Array(16);
    bytes[10] = 0xff;
    bytes[11] = 0xff;
    bytes.set(quad, 12);
    return bytes;
  }
  if (family === 6) return ipv6ToBytes(address);
  return null;
}

/** `10.0.0.0/8` · `fc00::/7` · 단일 주소(`127.0.0.1`)를 받는다. */
export interface CidrRange {
  readonly bytes: Uint8Array;
  readonly prefixBits: number;
}

export function parseCidr(value: string): CidrRange | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  const [address, prefix] = trimmed.split("/");
  if (address === undefined) return null;

  const bytes = ipToBytes(address);
  if (!bytes) return null;

  // IPv4를 mapped로 올렸으므로 접두 길이도 96을 더해 옮긴다.
  const isIpv4 = isIP(address) === 4;
  if (prefix === undefined) return { bytes, prefixBits: 128 };

  if (!/^[0-9]{1,3}$/.test(prefix)) return null;
  const declared = Number(prefix);
  if (declared > (isIpv4 ? 32 : 128)) return null;

  return { bytes, prefixBits: isIpv4 ? declared + 96 : declared };
}

export function matchesCidr(address: string, range: CidrRange): boolean {
  const bytes = ipToBytes(address);
  if (!bytes) return false;

  const fullBytes = range.prefixBits >> 3;
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== range.bytes[index]) return false;
  }

  const remainingBits = range.prefixBits & 7;
  if (remainingBits === 0) return true;

  const mask = 0xff << (8 - remainingBits);
  return (bytes[fullBytes]! & mask) === (range.bytes[fullBytes]! & mask);
}
