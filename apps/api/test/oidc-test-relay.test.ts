import { describe, expect, it, vi } from "vitest";
import { createOidcTestRelayFetch, OIDC_RELAY_HOSTS, relayUrl } from "../src/services/oidc-test-relay.js";

/**
 * The E2E transport for Google and Microsoft (`OIDC_TEST_RELAY_URL`). The OIDC library keeps the
 * real issuer URLs; only the four provider hosts are sent to the relay, and nothing else leaves.
 */
describe("OIDC test relay", () => {
  const relay = "http://127.0.0.1:4555";

  it("rewrites every provider host to <relay>/<host><path><query>", () => {
    expect(relayUrl(relay, "https://accounts.google.com/.well-known/openid-configuration")).toBe(
      "http://127.0.0.1:4555/accounts.google.com/.well-known/openid-configuration",
    );
    expect(relayUrl(relay, "https://oauth2.googleapis.com/token")).toBe("http://127.0.0.1:4555/oauth2.googleapis.com/token");
    expect(relayUrl(relay, "https://www.googleapis.com/oauth2/v3/certs?x=1&y=%2F")).toBe(
      "http://127.0.0.1:4555/www.googleapis.com/oauth2/v3/certs?x=1&y=%2F",
    );
    expect(
      relayUrl(`${relay}/`, "https://login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration"),
    ).toBe("http://127.0.0.1:4555/login.microsoftonline.com/organizations/v2.0/.well-known/openid-configuration");
    expect([...OIDC_RELAY_HOSTS].sort()).toEqual([
      "accounts.google.com",
      "login.microsoftonline.com",
      "oauth2.googleapis.com",
      "www.googleapis.com",
    ]);
  });

  it("keeps a relay path prefix", () => {
    expect(relayUrl("https://relay.test/oidc", "https://oauth2.googleapis.com/token")).toBe(
      "https://relay.test/oidc/oauth2.googleapis.com/token",
    );
  });

  it("refuses any other host, scheme, port or credentials instead of fetching it", () => {
    for (const target of [
      "https://evil.example/token",
      "https://accounts.google.com.evil.example/x",
      "https://evilaccounts.google.com/x",
      "http://accounts.google.com/.well-known/openid-configuration",
      "https://accounts.google.com:8443/x",
      "https://user:pass@oauth2.googleapis.com/token",
      "https://169.254.169.254/latest/meta-data",
      "not a url",
    ]) {
      expect(() => relayUrl(relay, target), target).toThrow(/OIDC test relay/);
    }
  });

  it("sends the same method, headers and body to the relay", async () => {
    const response = new Response("{}", { status: 200 });
    const fetchImpl = vi.fn(async () => response);
    const relayed = createOidcTestRelayFetch(relay, fetchImpl as unknown as typeof fetch);
    const body = new URLSearchParams({ grant_type: "authorization_code", code: "abc" });
    const options = { method: "POST", headers: { authorization: "Basic eA==" }, body, redirect: "manual" as const };

    await expect(relayed("https://oauth2.googleapis.com/token", options)).resolves.toBe(response);
    expect(fetchImpl).toHaveBeenCalledWith("http://127.0.0.1:4555/oauth2.googleapis.com/token", options);
  });

  it("never calls fetch for a refused host", async () => {
    const fetchImpl = vi.fn();
    const relayed = createOidcTestRelayFetch(relay, fetchImpl as unknown as typeof fetch);
    expect(() => relayed("https://evil.example/", { method: "GET", headers: {}, body: undefined, redirect: "manual" })).toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
