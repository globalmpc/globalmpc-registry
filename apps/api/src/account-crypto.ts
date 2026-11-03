import { createHmac, hkdfSync, randomBytes, randomInt } from "node:crypto";
import { isIPv4, isIPv6 } from "node:net";
import { EMAIL_CODE_DIGITS } from "@mpc/api-contract";

/**
 * Keys and secrets of the account flows — decision D10.
 *
 * Every HMAC key is derived from `SESSION_SECRET` with HKDF-SHA256 and its own `info` label, so
 * the raw secret is never a key and a key for one purpose cannot be used for another:
 *
 * - `mpc/email-code/v1` — the HMAC the database stores instead of an emailed code. The database
 *   never sees this key, so a copy of the database cannot be used to test guesses offline.
 * - `mpc/email-audit/v1` — keyed hashes of addresses (audit detail, rate-limit buckets) and of
 *   requester IPs (rate-limit buckets). Equal inputs give equal hashes, which is what lets the
 *   audit trail follow one address and a limit count one, without storing the address.
 *
 * Rotating `SESSION_SECRET` voids codes in flight (they fail as wrong) and starts new audit and
 * rate-limit hashes; nothing else depends on it.
 */

export type EmailCodePurpose = "sign_in" | "invitation" | "email_change";

export interface AccountCrypto {
  /**
   * HMAC of a code, bound to its purpose and to what it proves control for: the normalised
   * address (sign-in, email change) or the invitation token's hash (invitation — the API does
   * not know the invited address, the database does). 32 bytes.
   */
  codeHmac(purpose: EmailCodePurpose, binding: string, code: string): Buffer;
  /** Keyed hash of a normalised address. Never reversible without the key. */
  emailKey(email: string): string;
  /**
   * Keyed hash of a requester IP, for the database rate limits. An IPv6 address counts as its
   * /64: one subscriber is routinely given a whole /64, so a per-address count would let one
   * person rotate through 2^64 addresses.
   */
  ipKey(ip: string): string;
}

function deriveKey(secret: string, info: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.alloc(0), info, 32));
}

export function createAccountCrypto(sessionSecret: string): AccountCrypto {
  const codeKey = deriveKey(sessionSecret, "mpc/email-code/v1");
  const auditKey = deriveKey(sessionSecret, "mpc/email-audit/v1");
  const keyed = (label: string, value: string) =>
    createHmac("sha256", auditKey).update(`${label}\n${value}`).digest("hex");

  return {
    codeHmac: (purpose, binding, code) =>
      // Purpose and binding are inside the MAC, so a code issued for one never matches another.
      createHmac("sha256", codeKey).update(`${purpose}\n${binding}\n${code}`).digest(),
    emailKey: (email) => keyed("email", email),
    ipKey: (ip) => keyed("ip", rateLimitBucket(ip)),
  };
}

/** The part of an address a rate limit counts: the IPv4 address, or the /64 of an IPv6 one. */
export function rateLimitBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped && isIPv4(mapped[1]!)) return mapped[1]!;
  if (!isIPv6(ip)) return ip;
  const [head = "", tail = ""] = ip.toLowerCase().split("%")[0]!.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = ip.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = ip.includes("::")
    ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right]
    : left;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** A uniformly random code of `EMAIL_CODE_DIGITS` digits, leading zeros kept. */
export function generateEmailCode(): string {
  return randomInt(0, 10 ** EMAIL_CODE_DIGITS).toString().padStart(EMAIL_CODE_DIGITS, "0");
}

/** An invitation token: 32 random bytes, base64url (43 characters). Stored only as a hash. */
export function generateInvitationToken(): string {
  return randomBytes(32).toString("base64url");
}
