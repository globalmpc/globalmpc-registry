import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { ipv4ToBytes, ipv6ToBytes } from "./ip.js";

/**
 * Outbound endpoint restriction — SSRF. 06 §6.4, OD-43.
 *
 * Two server-side callers take a URL an operator set: source endpoints (`apps/api`, called
 * **with credentials attached**) and notification webhooks (`apps/worker`, called with a signed
 * body). Checking format alone, the value could be `http://169.254.169.254/` or an internal
 * service address, turning either path into a channel for reading the internal network. Both
 * judge with this module so the rules cannot drift apart (W-087).
 *
 * Blocked at two points.
 *
 * 1. **On save** — checks the scheme and host string. Rejecting what is visible on the spot
 *    tells the operator what is wrong.
 * 2. **Right before calling** — actually resolves the name and checks the addresses. Doing only
 *    #1 is bypassed by changing DNS so the name points to a private address (DNS rebinding).
 *
 * Redirects are not followed (`pinned-fetch.ts`). Following them would change the address
 * after this check with a single 3xx.
 */

export class EndpointNotAllowedError extends Error {
  readonly code = "ENDPOINT_NOT_ALLOWED";
  constructor(reason: string) {
    super(reason);
    this.name = "EndpointNotAllowedError";
  }
}

/**
 * Hosts rejected by name as well.
 *
 * The address check is the real guard; this is the save-time rejection visible to humans.
 */
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];

/**
 * IPv4 ranges outside the public internet.
 *
 * The cloud metadata endpoint (169.254.169.254) is link-local — without this one line
 * instance credentials can be read.
 */
function isPrivateIpv4Bytes(bytes: readonly number[]): boolean {
  const [a, b] = bytes as [number, number, number, number];

  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local · metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 192 && b === 0) return true; // IETF special purpose
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  // 192.88.99.0/24 — 6to4 relay anycast (deprecated by RFC 7526). Leave no remaining path
  // open. 2002::/16 is blocked on the IPv6 side, so the IPv4 side is blocked too.
  if (a === 192 && b === 88 && (bytes[2] as number) === 99) return true;
  if (a >= 224) return true; // multicast · reserved
  return false;
}

function isPrivateIpv4(address: string): boolean {
  const bytes = ipv4ToBytes(address);
  // If it does not read as an address it cannot be judged. Unknown values are not passed.
  return bytes === null ? true : isPrivateIpv4Bytes(bytes);
}

/**
 * IPv6 verdict — **blocks everything outside the public range.**
 *
 * Enumerating special ranges one by one breaks with every new notation (8 kinds actually
 * passed). Global unicast is only `2000::/3`, so everything outside is denied by default
 * and only the reserved ranges inside are enumerated. Unknown ranges stay closed.
 */
function isPrivateIpv6(address: string): boolean {
  const bytes = ipv6ToBytes(address);
  if (bytes === null) return true;

  const zerosUpTo = (count: number): boolean => bytes.slice(0, count).every((byte) => byte === 0);

  // `::` (unspecified) and `::1` (loopback).
  if (zerosUpTo(15) && (bytes[15] === 0 || bytes[15] === 1)) return true;

  // `::ffff:a.b.c.d` — IPv4-mapped. Judged by the inner IPv4 rules.
  if (zerosUpTo(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isPrivateIpv4Bytes([...bytes.slice(12)]);
  }

  // `::a.b.c.d` — IPv4-compatible. A deprecated notation with no reason to keep.
  if (zerosUpTo(12)) return true;

  // `2002::/16` — 6to4. IPv4 is embedded in bytes 2–5.
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    return isPrivateIpv4Bytes([...bytes.slice(2, 6)]);
  }

  // Default deny starts here. Everything outside global unicast (2000::/3) is blocked —
  // link-local(fe80::/10)·ULA(fc00::/7)·multicast(ff00::/8)·NAT64(64:ff9b::/96)·
  // discard(100::/64) are caught in one line.
  if ((bytes[0]! & 0xe0) !== 0x20) return true;

  // Reserved ranges inside global unicast.
  if (bytes[0] === 0x20 && bytes[1] === 0x01) {
    // 2001::/23 — IETF protocol assignments. Teredo (2001::/32) is here.
    if (bytes[2] === 0x00 && (bytes[3]! & 0xfe) === 0x00) return true;
    // 2001:db8::/32 — documentation.
    if (bytes[2] === 0x0d && bytes[3] === 0xb8) return true;
  }
  // 3fff::/20 — documentation (RFC 9637).
  if (bytes[0] === 0x3f && (bytes[1]! & 0xf0) === 0xf0) return true;

  return false;
}

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  // If it does not resolve as an address it cannot be judged. Unknown values are not passed.
  return true;
}

/** Hostname with brackets and trailing dot stripped. Needed to recognize IPv6 literals. */
function hostnameOf(url: URL): string {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

/**
 * Save-time check. Does not consult DNS.
 *
 * Only `https` is accepted. Source calls carry credentials and webhook bodies carry project
 * identifiers, so a plaintext request exposes them somewhere along the path.
 */
export function assertEndpointShape(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new EndpointNotAllowedError("Endpoint is not a URL");
  }

  if (url.protocol !== "https:") {
    throw new EndpointNotAllowedError("Endpoint must be https");
  }

  // `URL.hostname` returns IPv6 with brackets. Without stripping them it is not recognized as an
  // address, and `https://[::1]/` passes on the name check alone.
  const host = hostnameOf(url);
  if (BLOCKED_HOSTNAMES.has(host) || BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new EndpointNotAllowedError(`Internal hosts are not allowed: ${host}`);
  }

  if (isIP(host) !== 0 && isPrivateAddress(host)) {
    throw new EndpointNotAllowedError(`Private or reserved addresses are not allowed: ${host}`);
  }

  return url;
}

/** Resolves a name to addresses. Swapped by tests. */
export type HostResolver = (hostname: string) => Promise<readonly string[]>;

export const dnsResolver: HostResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  return results.map((entry) => entry.address);
};

/**
 * Pre-call check. **Returns the addresses used for the verdict.**
 *
 * **Rejects if any address is private.** For names only partly public, we do not choose which
 * address the connection goes to.
 *
 * The return value is half of this function. If the check and the connection each resolved
 * the name, the DNS answer could change in between (rebinding), making the checked and
 * connected addresses differ. Callers connect only to the addresses returned here
 * (`pinnedFetch`).
 */
export async function assertEndpointReachable(
  endpoint: string,
  resolve: HostResolver = dnsResolver,
): Promise<readonly string[]> {
  const url = assertEndpointShape(endpoint);
  const host = hostnameOf(url);

  // Address literals were already filtered by the shape check. That address is the destination.
  if (isIP(host) !== 0) return [host];

  let addresses: readonly string[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new EndpointNotAllowedError(`Cannot resolve name: ${host}`);
  }

  if (addresses.length === 0) {
    throw new EndpointNotAllowedError(`Name has no addresses: ${host}`);
  }

  const blocked = addresses.filter((address) => isPrivateAddress(address));
  if (blocked.length > 0) {
    throw new EndpointNotAllowedError(`Resolves to a private or reserved address: ${host}`);
  }

  return addresses;
}
