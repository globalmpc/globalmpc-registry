/**
 * Checks whether the requester address is public.
 *
 * Code cannot know whether `TRUSTED_PROXY_HOPS` is right — the proxy count is a fact of the
 * deployment environment, not of this repository. But **one symptom of it being wrong** shows
 * at runtime: if the hop count is lower than the real one, `request.ip` falls to a proxy or
 * container private address. That state returns 200 without errors, so without anyone noticing
 * the unauthenticated-path cap becomes a site-wide total.
 *
 * The opposite direction (a hop count higher than real, letting the requester forge an address
 * via the header) cannot be caught here, since the forged address is also public. That is left
 * to the ops procedure that checks the real proxy hop count after deployment.
 */
import { parseCidr, matchesCidr, type CidrRange } from "./ip.js";

const IPV4_MAPPED_PREFIX = "::ffff:";

export function isUnroutableAddress(address: string | undefined): boolean {
  // Failing to determine an address also means per-requester counting is impossible, so report it too.
  if (!address) return true;

  const value = address.toLowerCase();
  // Docker gives IPv4 as `::ffff:10.0.5.2`. Without stripping the prefix, every private
  // range is missed.
  const bare = value.startsWith(IPV4_MAPPED_PREFIX)
    ? value.slice(IPV4_MAPPED_PREFIX.length)
    : value;

  if (bare === "::1" || bare === "::") return true;
  // IPv6 unique local (fc00::/7). link-local (fe80::/10) is caught for the same reason.
  if (/^f[cd][0-9a-f]{2}:/.test(bare)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(bare)) return true;

  const octets = bare.split(".");
  if (octets.length !== 4) return false;

  const [first, second] = octets.map((octet) => Number(octet));
  if (first === undefined || second === undefined) return false;
  if (Number.isNaN(first) || Number.isNaN(second)) return false;

  if (first === 127) return true;
  if (first === 10) return true;
  // 172.16/12 — 172.15 and 172.32 are public. Catching too broadly raises false alarms in normal
  // deployments, and a warning that false-alarms is soon ignored.
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 169 && second === 254) return true;

  return false;
}

/**
 * Reports **only once** when a private address resolves as the requester.
 *
 * Logging on every request buries real outages under it. Once conveys the fact
 * without noise.
 */
export function createUnroutableClientWarning(
  emit: (address: string, message: string) => void,
): (address: string | undefined) => void {
  let told = false;

  return (address) => {
    if (told) return;
    if (!isUnroutableAddress(address)) return;
    told = true;
    emit(
      address ?? "",
      "Requester address is not public — TRUSTED_PROXY_HOPS may be lower than the real proxy count. " +
        "In this state the request cap on unauthenticated paths becomes a site-wide total",
    );
  };
}

/**
 * Decides whether to trust `x-forwarded-*` — fastify `trustProxy`.
 *
 * fastify 5.12.1 removed the hop-count-only form, **because it is trust that does not check
 * the immediate peer** — a request that bypasses the proxy and fills the header itself makes
 * that value the requester address, bypassing the unauthenticated-path cap.
 *
 * Requires **both** conditions.
 *
 * 1. The hop is within `TRUSTED_PROXY_HOPS` — the chain is not walked back indefinitely.
 * 2. That hop's address is within `TRUSTED_PROXY_CIDRS` — confirms it is our proxy.
 *
 * An empty range trusts nobody. Being unable to trust the header makes the cap a site-wide
 * total, and `createUnroutableClientWarning` reports that.
 */
export function createProxyTrust(
  hops: number,
  cidrs: readonly string[],
): ((address: string, hop: number) => boolean) | false {
  if (hops <= 0) return false;

  const ranges = cidrs
    .map((entry) => parseCidr(entry))
    .filter((range): range is CidrRange => range !== null);
  if (ranges.length === 0) return false;

  return (address, hop) =>
    hop < hops && ranges.some((range) => matchesCidr(address, range));
}
