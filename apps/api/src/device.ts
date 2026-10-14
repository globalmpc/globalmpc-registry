import { createHash } from "node:crypto";
import { matchesCidr, parseCidr, type CidrRange } from "./ip.js";

/**
 * Device metadata for audit records — 02 §2.7 "IP/device risk metadata".
 *
 * **Only facts the server observes.** The address class and a hash of the user agent. No score
 * is computed: a risk score needs inputs (device reputation, geolocation, history) and a model
 * that this system does not have, and a number written into the append-only audit log cannot be
 * corrected later.
 *
 * The user agent is hashed, not stored. Grouping records by device needs equality only, and the
 * raw string would add a fingerprinting surface to a log every auditor reads.
 */
export type IpClass = "loopback" | "private" | "link_local" | "public" | "unknown";

const ranges = (values: readonly string[]): CidrRange[] =>
  values.map((value) => {
    const range = parseCidr(value);
    if (!range) throw new Error(`Invalid CIDR constant: ${value}`);
    return range;
  });

const LOOPBACK = ranges(["127.0.0.0/8", "::1/128"]);
// RFC 1918, RFC 6598 shared address space, and IPv6 unique local addresses.
const PRIVATE = ranges(["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "fc00::/7"]);
const LINK_LOCAL = ranges(["169.254.0.0/16", "fe80::/10"]);

export function classifyIp(address: string | undefined | null): IpClass | null {
  if (address === undefined || address === null || address === "") return null;
  const within = (list: readonly CidrRange[]) => list.some((range) => matchesCidr(address, range));
  if (!parseCidr(address)) return "unknown";
  if (within(LOOPBACK)) return "loopback";
  if (within(PRIVATE)) return "private";
  if (within(LINK_LOCAL)) return "link_local";
  return "public";
}

export function hashUserAgent(userAgent: string | undefined): string | null {
  if (userAgent === undefined || userAgent.trim() === "") return null;
  return createHash("sha256").update(userAgent, "utf8").digest("hex");
}
