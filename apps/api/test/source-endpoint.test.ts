import { describe, expect, it } from "vitest";
import {
  assertEndpointReachable,
  assertEndpointShape,
  EndpointNotAllowedError,
  isPrivateAddress,
} from "../src/services/source-endpoint.js";

/**
 * Source endpoint restrictions — SSRF.
 *
 * The operator sets this value and **the server calls it with credentials attached**. Checking
 * only the format turns it into a channel for reading the internal network.
 */
describe("assertEndpointShape", () => {
  it("accepts a public https address", () => {
    expect(() => assertEndpointShape("https://registry.example/api/v1")).not.toThrow();
  });

  it("rejects http — credentials would go out in plaintext", () => {
    expect(() => assertEndpointShape("http://registry.example/api")).toThrow(
      EndpointNotAllowedError,
    );
  });

  it("rejects localhost", () => {
    expect(() => assertEndpointShape("https://localhost/api")).toThrow(EndpointNotAllowedError);
    expect(() => assertEndpointShape("https://api.internal/x")).toThrow(EndpointNotAllowedError);
  });

  it("rejects 6to4 relay anycast", () => {
    // The one remaining case from 2026-09-10 audit A2. Blocking only IPv6 2002::/16 and not the
    // IPv4 side leaves the same transition path open on one side.
    expect(isPrivateAddress("192.88.99.1")).toBe(true);
    expect(() => assertEndpointShape("https://192.88.99.1/")).toThrow(EndpointNotAllowedError);
  });

  it("rejects the cloud metadata address", () => {
    // Without this line, instance credentials can be read.
    expect(() => assertEndpointShape("https://169.254.169.254/latest/meta-data/")).toThrow(
      EndpointNotAllowedError,
    );
    expect(() => assertEndpointShape("https://metadata.google.internal/x")).toThrow(
      EndpointNotAllowedError,
    );
  });

  it("rejects private-range addresses", () => {
    for (const host of ["10.0.0.5", "172.16.3.1", "192.168.1.1", "127.0.0.1", "[::1]"]) {
      expect(() => assertEndpointShape(`https://${host}/api`)).toThrow(EndpointNotAllowedError);
    }
  });
});

describe("isPrivateAddress", () => {
  it("passes public addresses", () => {
    expect(isPrivateAddress("203.0.113.10")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("is not bypassed via IPv4-mapped IPv6", () => {
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
  });

  it("does not pass input that does not parse as an address", () => {
    // Defaulting unknowns to allow turns a failed check into a pass.
    expect(isPrivateAddress("not-an-address")).toBe(true);
  });
});

describe("assertEndpointReachable", () => {
  it("rejects a name resolving to a private address — DNS rebinding", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => ["10.0.0.5"]),
    ).rejects.toThrow(EndpointNotAllowedError);
  });

  it("rejects if any address is private — we do not choose which one connects", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => [
        "203.0.113.10",
        "10.0.0.5",
      ]),
    ).rejects.toThrow(EndpointNotAllowedError);
  });

  it("passes and returns the addresses when all are public", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => ["203.0.113.10"]),
    ).resolves.toEqual(["203.0.113.10"]);
  });

  it("rejects a name that cannot be resolved", async () => {
    await expect(
      assertEndpointReachable("https://registry.example/api", async () => {
        throw new Error("ENOTFOUND");
      }),
    ).rejects.toThrow(EndpointNotAllowedError);
  });
});

/**
 * Bypass input regressions — 2026-09-10 audit A2.
 *
 * All twelve below are **inputs that once got past the blocking function**. There was more than
 * one cause: IPv4-mapped was matched only in dotted form (URL normalizes to `::ffff:7f00:1`),
 * link-local was matched only by the `fe80` string (the range is `fe80::/10`), and there were no
 * rules at all for IPv4-embedding forms like 6to4/NAT64 or documentation/multicast ranges.
 *
 * Adding rules one by one breaks again on the next notation, so the check is inverted —
 * **everything outside the public range (2000::/3) is blocked** and reserved ranges inside it
 * are listed separately.
 */
describe("IPv6 bypass inputs", () => {
  const blocked = [
    // URL normalizes IPv4-mapped to hex. Checking only dotted form lets it through.
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "0:0:0:0:0:ffff:7f00:1",
    // Dotted IPv4-mapped and IPv4-compatible.
    "::ffff:127.0.0.1",
    "::ffff:169.254.169.254",
    "::127.0.0.1",
    // link-local is fe80::/10. Checking only the fe80 prefix leaves three quarters open.
    "fe90::1",
    "febf::1",
    // IPv4-embedding transition forms. The inner address is loopback.
    "2002:7f00:1::",
    "64:ff9b::7f00:1",
    // Reserved and special-purpose ranges.
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

  it.each(blocked)("classifies %s as private/reserved", (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each(blocked)("rejects https://[%s]/", (address) => {
    expect(() => assertEndpointShape(`https://[${address}]/`)).toThrow(EndpointNotAllowedError);
  });

  it("still passes public IPv6", () => {
    for (const address of ["2606:4700::1111", "2400:cb00:2048:1::", "2002:cb00:7101::"]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });

  it("judges an IPv4-mapped public address by IPv4 rules", () => {
    expect(isPrivateAddress("::ffff:203.0.113.10")).toBe(false);
  });
});

/**
 * Pins the connection to the checked address — 2026-09-10 audit A2.
 *
 * If the check and the connection resolve the name separately, the answer can change in
 * between (DNS rebinding). `assertEndpointReachable` **returns the addresses it checked** and
 * the caller connects only to them.
 */
describe("returns verified addresses", () => {
  it("returns the addresses used for the check", async () => {
    const addresses = await assertEndpointReachable("https://registry.example/api", async () => [
      "203.0.113.10",
      "203.0.113.11",
    ]);
    expect(addresses).toEqual(["203.0.113.10", "203.0.113.11"]);
  });

  it("returns the literal address for an address literal", async () => {
    const addresses = await assertEndpointReachable("https://203.0.113.10/api", async () => {
      throw new Error("must not resolve the name");
    });
    expect(addresses).toEqual(["203.0.113.10"]);
  });
});

/**
 * Pins the 11 reproductions from audit A2 as-is.
 *
 * The first seven once passed; the last four were rejected from the start. Those four are
 * rejected by `new URL()` normalization, not our code (octal, integer, and shorthand forms come
 * back dotted). **If that premise changes, it must show up here** — hence kept together.
 */
describe("audit A2 reproductions (11)", () => {
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

  it.each(cases)("rejects %s", (endpoint) => {
    expect(() => assertEndpointShape(endpoint)).toThrow(EndpointNotAllowedError);
  });

  it("rejects all eleven — ACCEPTED 0", () => {
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
