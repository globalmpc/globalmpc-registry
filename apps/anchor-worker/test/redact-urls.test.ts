import { describe, expect, it } from "vitest";
import { redactUrls } from "../src/redact-urls.js";

/**
 * URL masking for stored error text (L5).
 *
 * Hosted RPC providers put the API key in the path (`/v2/<key>`), the query (`?apikey=`) or the
 * userinfo. What survives is scheme and host — enough to tell which endpoint failed.
 */
describe("redactUrls", () => {
  it("keeps scheme and host and drops path and query", () => {
    expect(redactUrls("URL: https://rpc.example/v2/KEY?apikey=KEY2 failed")).toBe(
      "URL: https://rpc.example/[redacted] failed",
    );
  });

  it("drops userinfo", () => {
    const out = redactUrls("at https://user:PASS@rpc.example:8545");
    expect(out).not.toContain("PASS");
    expect(out).toContain("rpc.example:8545");
  });

  it("leaves a bare origin as is", () => {
    expect(redactUrls("URL: http://localhost:8545")).toBe("URL: http://localhost:8545");
  });

  it("masks websocket URLs", () => {
    expect(redactUrls("wss://ws.example/KEY")).toBe("wss://ws.example/[redacted]");
  });

  it("replaces a configured URL whole, even when its host carries the key", () => {
    const configured = "https://KEYINHOST.rpc.example/path";
    const out = redactUrls(`URL: ${configured}`, [configured]);
    expect(out).not.toContain("KEYINHOST");
    expect(out).toBe("URL: [rpc-url]");
  });

  it("masks every URL in the text", () => {
    const out = redactUrls("a https://a.example/K1 b https://b.example/?k=K2");
    expect(out).not.toMatch(/K1|K2/);
  });

  it("leaves text without URLs unchanged", () => {
    expect(redactUrls("execution reverted: BatchAlreadyExists")).toBe(
      "execution reverted: BatchAlreadyExists",
    );
  });
});
