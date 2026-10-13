import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { edgeRequestHeaders } from "../src/proxy.js";
import { streamUploadUrl } from "../src/lib/api.js";

/**
 * Edge proxy path — what the web proxy tells the API about the visitor.
 *
 * The visitor must never be able to name its own address, and the vouching headers exist only
 * when this deployment holds the secret.
 */
const SECRET = "p".repeat(32);

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("https://registry.example/api/v1/projects", { headers });
}

describe("edgeRequestHeaders", () => {
  it("strips the vouching headers a visitor sent, with or without a secret", () => {
    const sent = { "x-mpc-edge-secret": "guess", "x-mpc-client-ip": "203.0.113.1" };
    expect(edgeRequestHeaders(request(sent), undefined).has("x-mpc-client-ip")).toBe(false);
    expect(edgeRequestHeaders(request(sent), undefined).has("x-mpc-edge-secret")).toBe(false);
    // With a secret the value is replaced by what the platform reported, never kept.
    const vouched = edgeRequestHeaders(request({ ...sent, "x-real-ip": "198.51.100.2" }), SECRET);
    expect(vouched.get("x-mpc-client-ip")).toBe("198.51.100.2");
    expect(vouched.get("x-mpc-edge-secret")).toBe(SECRET);
  });

  it("prefers the platform's x-real-ip and falls back to the last x-forwarded-for entry", () => {
    expect(
      edgeRequestHeaders(
        request({ "x-real-ip": "198.51.100.2", "x-forwarded-for": "203.0.113.1, 10.0.0.1" }),
        SECRET,
      ).get("x-mpc-client-ip"),
    ).toBe("198.51.100.2");
    expect(
      edgeRequestHeaders(request({ "x-forwarded-for": "203.0.113.1, 10.0.0.1" }), SECRET).get(
        "x-mpc-client-ip",
      ),
    ).toBe("10.0.0.1");
  });

  it("does not vouch for an address the visitor wrote into x-forwarded-for", () => {
    // A platform that appends keeps the visitor's own entry on the left; only the right end is
    // what the platform itself saw.
    const headers = edgeRequestHeaders(
      request({ "x-forwarded-for": "203.0.113.9, 198.51.100.7" }),
      SECRET,
    );
    expect(headers.get("x-mpc-client-ip")).toBe("198.51.100.7");
  });

  it("adds nothing when the platform reported no address — a secret without an address vouches for nothing", () => {
    const headers = edgeRequestHeaders(request({}), SECRET);
    expect(headers.has("x-mpc-edge-secret")).toBe(false);
    expect(headers.has("x-mpc-client-ip")).toBe(false);
  });

  it("leaves every other header untouched", () => {
    expect(edgeRequestHeaders(request({ authorization: "Bearer t" }), SECRET).get("authorization")).toBe(
      "Bearer t",
    );
  });
});

describe("streamUploadUrl", () => {
  it("stays same-origin unless a direct API origin is configured", () => {
    expect(streamUploadUrl("p1", undefined)).toBe("/api/v1/projects/p1/uploads/stream");
    expect(streamUploadUrl("p1", "")).toBe("/api/v1/projects/p1/uploads/stream");
  });

  it("goes straight to the API host when one is named", () => {
    expect(streamUploadUrl("p1", "https://api.registry.example")).toBe(
      "https://api.registry.example/api/v1/projects/p1/uploads/stream",
    );
  });
});
