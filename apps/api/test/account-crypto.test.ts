import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createAccountCrypto,
  generateEmailCode,
  generateInvitationToken,
  rateLimitBucket,
} from "../src/account-crypto.js";

/**
 * Account keys (D10): purpose-separated HKDF keys, codes bound to purpose and address, and
 * rate-limit buckets that one requester cannot multiply.
 */
describe("account crypto", () => {
  const secret = "s".repeat(32);
  const keys = createAccountCrypto(secret);

  it("binds a code to its purpose and address", () => {
    const base = keys.codeHmac("sign_in", "a@example.com", "12345678");
    expect(base).toHaveLength(32);
    expect(keys.codeHmac("sign_in", "a@example.com", "12345678").equals(base)).toBe(true);
    expect(keys.codeHmac("sign_in", "b@example.com", "12345678").equals(base)).toBe(false);
    expect(keys.codeHmac("email_change", "a@example.com", "12345678").equals(base)).toBe(false);
    expect(keys.codeHmac("sign_in", "a@example.com", "12345679").equals(base)).toBe(false);
  });

  it("never uses the session secret itself as a key, and keeps code and audit keys apart", () => {
    const raw = createHmac("sha256", secret).update("sign_in\na@example.com\n12345678").digest();
    expect(keys.codeHmac("sign_in", "a@example.com", "12345678").equals(raw)).toBe(false);
    const auditWithRaw = createHmac("sha256", secret).update("email\na@example.com").digest("hex");
    expect(keys.emailKey("a@example.com")).not.toBe(auditWithRaw);
    expect(keys.emailKey("a@example.com")).toMatch(/^[0-9a-f]{64}$/);
    expect(createAccountCrypto("t".repeat(32)).emailKey("a@example.com")).not.toBe(keys.emailKey("a@example.com"));
  });

  it("counts an IPv6 requester by its /64 and an IPv4 one by its address", () => {
    expect(rateLimitBucket("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(rateLimitBucket("2001:0db8:0001:0002:ffff:ffff:ffff:ffff")).toBe("2001:db8:1:2::/64");
    expect(rateLimitBucket("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(rateLimitBucket("2001:db8:0:1::1")).not.toBe(rateLimitBucket("2001:db8::1"));
    expect(rateLimitBucket("::ffff:192.0.2.1")).toBe("192.0.2.1");
    expect(rateLimitBucket("192.0.2.1")).toBe("192.0.2.1");
    expect(keys.ipKey("2001:db8:1:2::1")).toBe(keys.ipKey("2001:db8:1:2::abcd"));
    expect(keys.ipKey("192.0.2.1")).not.toBe(keys.ipKey("192.0.2.2"));
  });

  it("generates 8-digit codes with leading zeros kept and 32-byte invitation tokens", () => {
    for (let i = 0; i < 200; i++) expect(generateEmailCode()).toMatch(/^[0-9]{8}$/);
    expect(generateInvitationToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
