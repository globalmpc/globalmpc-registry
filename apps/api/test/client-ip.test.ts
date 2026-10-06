import { describe, expect, it } from "vitest";
import { createProxyTrust, createUnroutableClientWarning, isUnroutableAddress } from "../src/client-ip.js";

/**
 * Whether the requester address is public — the only runtime signal that the hop count is right.
 *
 * If `TRUSTED_PROXY_HOPS` is lower than the real proxy count, `request.ip` falls back to a
 * proxy or container address. That state returns 200 without errors, but the cap on
 * unauthenticated routes becomes a site-wide total, so one person can block every sign-in.
 * Noticing this in a deployment would require someone watching the logs, so the server
 * reports it itself.
 */
describe("isUnroutableAddress", () => {
  it("treats public addresses as normal", () => {
    expect(isUnroutableAddress("203.0.113.7")).toBe(false);
    expect(isUnroutableAddress("8.8.8.8")).toBe(false);
    expect(isUnroutableAddress("2001:db8::1")).toBe(false);
  });

  it("catches loopback — the request did not pass through a proxy", () => {
    expect(isUnroutableAddress("127.0.0.1")).toBe(true);
    expect(isUnroutableAddress("::1")).toBe(true);
    expect(isUnroutableAddress("::ffff:127.0.0.1")).toBe(true);
  });

  it("catches private ranges — container network addresses", () => {
    expect(isUnroutableAddress("10.0.5.2")).toBe(true);
    expect(isUnroutableAddress("172.16.0.1")).toBe(true);
    expect(isUnroutableAddress("172.31.255.255")).toBe(true);
    expect(isUnroutableAddress("192.168.1.10")).toBe(true);
    expect(isUnroutableAddress("169.254.1.1")).toBe(true);
    expect(isUnroutableAddress("fd00::1")).toBe(true);
    // Docker gives IPv4 in IPv6-mapped form. Checking only the prefix must not miss it.
    expect(isUnroutableAddress("::ffff:10.0.5.2")).toBe(true);
  });

  it("treats addresses outside 172.16/12 as public — does not widen the boundary", () => {
    expect(isUnroutableAddress("172.15.0.1")).toBe(false);
    expect(isUnroutableAddress("172.32.0.1")).toBe(false);
  });

  it("warns when no address could be determined", () => {
    expect(isUnroutableAddress("")).toBe(true);
    expect(isUnroutableAddress(undefined)).toBe(true);
  });
});

describe("createUnroutableClientWarning", () => {
  it("reports a private address", () => {
    const seen: { message: string; address: string }[] = [];
    const warn = createUnroutableClientWarning((address, message) =>
      seen.push({ address, message }),
    );

    warn("10.0.5.2");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.address).toBe("10.0.5.2");
    expect(seen[0]?.message).toMatch(/TRUSTED_PROXY_HOPS/);
  });

  it("says nothing for a public address", () => {
    const seen: string[] = [];
    const warn = createUnroutableClientWarning((address) => seen.push(address));

    warn("203.0.113.7");

    expect(seen).toEqual([]);
  });

  /**
   * Warning on every request would flood the log and bury real failures. Once is enough
   * to convey the fact without noise.
   */
  it("reports only once across repeated hits — does not flood the log", () => {
    const seen: string[] = [];
    const warn = createUnroutableClientWarning((address) => seen.push(address));

    warn("10.0.5.2");
    warn("10.0.5.3");
    warn("127.0.0.1");

    expect(seen).toEqual(["10.0.5.2"]);
  });
});

/**
 * When to trust `x-forwarded-*` — 2026-09-10.
 *
 * fastify 5.12.1 **removed the hop-count-only option.** A hop count does not check who the
 * immediate peer is, so a request that reaches the server directly, bypassing the proxy, can
 * fill the header itself and become the requester — bypassing the cap on unauthenticated routes.
 */
describe("createProxyTrust", () => {
  const cidrs = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "fc00::/7"];

  it("trusts only hops inside the trusted ranges", () => {
    const trust = createProxyTrust(1, cidrs);
    expect(typeof trust).toBe("function");
    if (typeof trust !== "function") return;

    expect(trust("10.0.5.2", 0)).toBe(true);
    // A request directly from a public address. Filling the header does not make it the requester.
    expect(trust("203.0.113.7", 0)).toBe(false);
  });

  it("treats Docker's IPv4-mapped notation as the same range", () => {
    const trust = createProxyTrust(1, cidrs);
    if (typeof trust !== "function") return;

    // Comparing as strings without stripping the prefix misses every address in this form.
    expect(trust("::ffff:10.0.5.2", 0)).toBe(true);
  });

  it("does not trust beyond the hop count — does not walk the chain back indefinitely", () => {
    const trust = createProxyTrust(1, cidrs);
    if (typeof trust !== "function") return;

    expect(trust("10.0.5.2", 1)).toBe(false);
  });

  it("matches IPv6 private ranges by range", () => {
    const trust = createProxyTrust(2, cidrs);
    if (typeof trust !== "function") return;

    expect(trust("fd00::1", 0)).toBe(true);
    expect(trust("2606:4700::1111", 0)).toBe(false);
  });

  it("trusts no one when the ranges are empty or hops are 0", () => {
    // Not trusting the header makes the cap a site-wide total; `createUnroutableClientWarning`
    // reports that.
    expect(createProxyTrust(1, [])).toBe(false);
    expect(createProxyTrust(0, cidrs)).toBe(false);
    // Only malformed values is the same as having no trusted range.
    expect(createProxyTrust(1, ["not-a-cidr"])).toBe(false);
  });
});
