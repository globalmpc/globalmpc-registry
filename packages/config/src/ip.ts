import { isIP } from "node:net";

/**
 * IP address parsing and range checks.
 *
 * Three places ask the same question — is a source endpoint internal (SSRF, `endpoint.ts`),
 * is a notification webhook internal (SSRF, the worker), and is the peer forwarding the request
 * our proxy (`apps/api/src/client-ip.ts`). Each judged by string prefix and was actually breached
 * (2026-09-10 audit A2). The verdict is centralized and **looks only at bytes** — with multiple
 * notations, the judging side and the connecting side see different addresses.
 *
 * Lives in `@mpc/config` because the API and the worker both depend on it (W-087).
 */

/**
 * Dotted IPv4 to bytes.
 *
 * Some parsers read `010` as octal. We do not accept it — narrowing to one notation is how the
 * verdict stays single.
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
 * Expands an IPv6 string to 16 bytes.
 *
 * **So that ranges are not judged by string prefix.** A `fe80` prefix check covers only a
 * quarter of `fe80::/10`, and `::ffff:127.0.0.1` becomes `::ffff:7f00:1` after passing through
 * `URL`, evading a dotted-notation regex. Both actually passed.
 */
export function ipv6ToBytes(address: string): Uint8Array | null {
  const value = address.toLowerCase();
  // A zone index (`fe80::1%eth0`) is out of scope. Not judged.
  if (value.includes("%")) return null;

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const toBytes = (segment: string): number[] | null => {
    if (segment === "") return [];
    const items = segment.split(":");
    const out: number[] = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;

      // Dotted IPv4 appears only in the last position.
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

  // `::` must cover at least one group. If all 16 bytes are filled there is nothing to compress.
  if (head.length + tail.length >= 16) return null;
  bytes.set(head, 0);
  bytes.set(tail, 16 - tail.length);
  return bytes;
}

/**
 * Normalizes an address to 16 bytes.
 *
 * IPv4 is lifted to IPv4-mapped (`::ffff:a.b.c.d`). That way `10.0.0.1` and
 * `::ffff:10.0.0.1` go through the same range check — Docker gives IPv4 in mapped form,
 * so handling them separately misses one.
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

/** Accepts `10.0.0.0/8` · `fc00::/7` · a single address (`127.0.0.1`). */
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

  // IPv4 was lifted to mapped, so the prefix length shifts by 96 too.
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
