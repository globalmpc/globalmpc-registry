import { describe, expect, it } from "vitest";
import { createRedactor, redactUrls } from "../src/redact-urls.js";

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

  it("hides a configured URL's host when an error quotes it with another path", () => {
    // A Safe service key in the hostname, quoted by an error for a different endpoint path.
    const configured = "https://SAFEKEY.safe.example/api";
    const out = redactUrls("POST https://SAFEKEY.safe.example/v1/safes/0xabc failed", [configured]);
    expect(out).not.toContain("SAFEKEY");
    expect(out.toLowerCase()).not.toContain("safekey");
  });

  it("matches configured values whatever their case in the error", () => {
    const configured = "https://SAFEKEY.safe.example/api";
    for (const quoted of ["https://safekey.safe.example/x", "https://SafeKey.Safe.Example/api"]) {
      expect(redactUrls(`GET ${quoted}`, [configured]).toLowerCase()).not.toContain("safekey");
    }
  });

  it.each([
    ["the host without its port", "https://HOSTKEY.rpc.example:8545/v2", "getaddrinfo ENOTFOUND HOSTKEY.rpc.example"],
    ["a JSON-escaped URL", "https://rpc.example/v2/PATHKEY", 'body {"url":"https:\\/\\/rpc.example\\/v2\\/PATHKEY"}'],
    ["the path without scheme or host", "https://rpc.example/v2/PATHKEY", "request to rpc.example/v2/PATHKEY failed"],
    ["the userinfo without the rest", "https://u:PASSKEY@rpc.example/", "auth u:PASSKEY rejected"],
  ])("hides a configured URL's secret parts when an error quotes %s", (_case, configured, error) => {
    expect(redactUrls(error, [configured])).not.toMatch(/HOSTKEY|PATHKEY|PASSKEY/i);
  });

  it("masks an unconfigured JSON-escaped URL like any other", () => {
    expect(redactUrls('{"u":"https:\\/\\/other.example\\/v1\\/K1"}')).not.toContain("K1");
  });

  it("stays fast on a long scheme-like run", () => {
    const started = Date.now();
    redactUrls("a.".repeat(100_000), ["https://rpc.example/v2/KEY"]);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("treats regex characters in a configured URL literally", () => {
    const configured = "https://rpc.example/v1/K?apikey=a+b(c)";
    expect(redactUrls(`URL: ${configured}`, [configured])).toBe("URL: [rpc-url]");
  });

  it("masks every URL in the text", () => {
    const out = redactUrls("a https://a.example/K1 b https://b.example/?k=K2");
    expect(out).not.toMatch(/K1|K2/);
  });

  describe("a configured value straddling the 8192-character cut", () => {
    const hostKey = "https://SECRETHOSTKEY123.provider.io/";
    const pathKey = "https://rpc.example/v2/PATHSECRETKEY99";
    it.each([
      ["a key in the host, with scheme", hostKey, `${"x".repeat(8192 - 16)}https://SECRETHOSTKEY123.provider.io/ failed`],
      ["a key in the host, without scheme", hostKey, `${"x ".repeat(4090)}ENOTFOUND SECRETHOSTKEY123.provider.io`],
      ["a key in the path, without scheme", pathKey, `${"y ".repeat(4096 - 12)}rpc.example/v2/PATHSECRETKEY99`],
    ])("is still hidden for %s", (_case, configured, error) => {
      const out = redactUrls(error, [configured]);
      expect(out).not.toMatch(/SE/i);
      expect(out.endsWith("[rpc-url]")).toBe(true);
      // The output bound, which holds for any input.
      expect(out.length).toBeLessThanOrEqual(8192 + "[rpc-url]".length);
    });

    it("hides the start of a configured value that is not a URL", () => {
      expect(redactUrls("x SECRETNONURLKE", ["SECRETNONURLKEY"])).toBe("x [rpc-url]");
    });

    it("hides the start of a part a text was already cut in", () => {
      const out = redactUrls("ENOTFOUND SECRETHOST", [hostKey]);
      expect(out).not.toMatch(/SECRET/i);
      expect(out).toBe("ENOTFOUND [rpc-url]");
    });

    it.each([
      ["a word cut inside a part", "ENOTFOUND SECRETHO", "ENOTFOUND [rpc-url]"],
      ["a whole host label holding a digit", "ENOTFOUND SECRETHOSTKEY123", "ENOTFOUND [rpc-url]"],
      ["a part after a path's slash", "request to /data", "request to /[rpc-url]"],
      ["a part after a query's equals sign", "redirect=data", "redirect=[rpc-url]"],
    ])("hides the start of a part for %s", (_case, error, expected) => {
      const configured = ["https://SECRETHOSTKEY123.provider.io/", "https://data-seed-prebsc-1-s1.bnbchain.org:8545"];
      expect(redactUrls(error, configured)).toBe(expected);
    });

    it("keeps a whole word that only matches the start of a configured host", () => {
      // The word ends where the host's first label does, at `-`: an ordinary word, not a cut key.
      const configured = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
      expect(redactUrls("execution reverted: invalid data", [configured])).toBe(
        "execution reverted: invalid data",
      );
      // The same host quoted whole is still hidden.
      expect(redactUrls("ENOTFOUND data-seed-prebsc-1-s1.bnbchain.org", [configured])).toBe(
        "ENOTFOUND [rpc-url]",
      );
    });

    it("hides the start of a path key made of letter-only chunks, quoted alone", () => {
      const configured = "https://opbnb-mainnet.nodereal.io/v1/abcdefgh_ijklmnop";
      expect(redactUrls("invalid api key abcdefgh", [configured])).toBe("invalid api key [rpc-url]");
      // The host's words are still ordinary words.
      expect(redactUrls("rpc error on opbnb", [configured])).toBe("rpc error on opbnb");
    });

    it.each([
      ["a letters-only key label", "https://abcdef.provider.example/", "invalid API key abcdef", "invalid API key [rpc-url]"],
      ["in another case", "https://abcdef.provider.example/", "invalid API key ABCDEF.", "invalid API key [rpc-url]."],
      ["a key label with a hyphen", "https://abcd-efgh.provider.example/", "key abcd-efgh rejected", "key [rpc-url] rejected"],
      ["a deeper subdomain label", "https://mykey.rpc.provider.example/", "denied for mykey", "denied for [rpc-url]"],
    ])("hides a whole subdomain label quoted as a word: %s", (_case, configured, error, expected) => {
      expect(redactUrls(error, [configured])).toBe(expected);
    });

    it.each([
      ["a word inside a longer one", "https://abcdef.provider.example/", "abcdefgh and xabcdef", "abcdefgh and xabcdef"],
      ["the registrable domain's words", "https://abcdef.provider.example/", "provider example error", "provider example error"],
      ["a host of two labels", "https://nodekey.io/", "nodekey down", "nodekey down"],
      ["a label shorter than four characters", "https://rpc.provider.example/", "rpc error", "rpc error"],
      ["the start of a label, not all of it", "https://opbnb-testnet-rpc.bnbchain.org/", "rpc error on opbnb", "rpc error on opbnb"],
    ])("keeps %s", (_case, configured, error, expected) => {
      expect(redactUrls(error, [configured])).toBe(expected);
    });

    it.each([
      ["cut inside it", "lookup failed for host k3yabc", "lookup failed for host [rpc-url]"],
      ["in another case", "lookup failed for host K3YABCDEF", "lookup failed for host [rpc-url]"],
    ])("hides the start of a subdomain label that is not the first, %s", (_case, error, expected) => {
      expect(redactUrls(error, ["https://rpc.k3yabcdef99.provider.io/"])).toBe(expected);
    });

    it("keeps a whole word that only starts a later subdomain label", () => {
      expect(redactUrls("lookup failed: invalid data", ["https://rpc.data-seed-prebsc.provider.io/"])).toBe(
        "lookup failed: invalid data",
      );
    });

    it("hides such a word when the text was cut right after it", () => {
      const configured = "https://data-seed-prebsc-1-s1.bnbchain.org:8545";
      const out = redactUrls(`${"x ".repeat(4094)}data${"-".repeat(10)}`, [configured]);
      expect(out).toBe(`${"x ".repeat(4094)}[rpc-url]`);
    });

    it("drops what lies beyond the cut", () => {
      const out = redactUrls(`${"z".repeat(8192)}https://SECRETHOSTKEY123.provider.io/`, [hostKey]);
      expect(out).toBe("z".repeat(8192));
    });
  });

  it.each([
    ["percent-encoded", "https://rpc.example/v2/PATHKEY99", "redirect=https%3A%2F%2Frpc.example%2Fv2%2FPATHKEY99"],
    ["percent-encoded, lower-case escapes", "https://rpc.example/v2/PATHKEY99", "u=https%3a%2f%2frpc.example%2fv2%2fPATHKEY99"],
    ["as a query value alone", "https://rpc.example/v2?apikey=QUERYKEY99", 'param "apikey=QUERYKEY99" invalid'],
    ["as the last path segment under another path", "https://rpc.example/v2/PATHKEY99", "path /v3/PATHKEY99"],
    ["as a middle path segment, the path cut there", "https://rpc.example/v2/PATHKEY99/status", "path /v2/PATHKEY99 failed"],
    ["as a percent-encoded middle path segment", "https://rpc.example/v2/PATH%4BEY99/status", "path /v2/PATHKEY99 failed"],
    ["without its trailing slash", "https://rpc.example/v2/PATHKEY99/", "request to rpc.example/v2/PATHKEY99 failed"],
  ])("hides a configured URL's key when an error quotes it %s", (_case, configured, error) => {
    expect(redactUrls(error, [configured])).not.toMatch(/PATHKEY|QUERYKEY/i);
  });

  it("hides a middle path segment quoted without the rest of the path", () => {
    const out = redactUrls("path /v2/MIDDLESECRET failed", ["https://rpc.example/v2/MIDDLESECRET/status"]);
    expect(out).not.toContain("MIDDLESECRET");
    // A short segment like `v2` is not a key on its own and stays.
    expect(out).toBe("path /v2/[rpc-url] failed");
  });

  it("does not replace a part too short to be a key on its own", () => {
    const configured = "https://u:p@rpc.example/";
    expect(redactUrls("unknown user error", [configured])).toBe("unknown user error");
    expect(redactUrls(`URL: ${configured} failed`, [configured])).toBe("URL: [rpc-url] failed");
  });

  it.each([
    [
      "a username overlapping the start of the host",
      "login xnodebsc1SECRETHOSTKEY.example",
      ["https://xnodebsc1:pw@bsc1SECRETHOSTKEY.example/"],
    ],
    [
      "one configured URL's path overlapping the start of another's host",
      "x tx-servicemainnetKEY0123456.rpc.io",
      ["https://mainnetKEY0123456.rpc.io/", "https://safe.example/api/tx-servicemainnet"],
    ],
  ])("hides every part when %s", (_case, error, configured) => {
    const out = redactUrls(error, configured);
    expect(out).not.toMatch(/SECRET|HOSTKEY|KEY0123456/i);
    expect(out).toBe(`${error.split(" ")[0]} [rpc-url]`);
  });

  it.each([
    ["short parts replaced many times", "abcd ".repeat(3000), ["https://u:abcd@h.example/"]],
    ["a one-character configured value", "a".repeat(9000), ["a"]],
    ["masked URLs longer than the text they replace", "https://h/a ".repeat(1000), []],
  ])("never returns more than the input bound plus a placeholder for %s", (_case, error, configured) => {
    const out = redactUrls(error, configured);
    expect(out.length).toBeLessThanOrEqual(8192 + "[rpc-url]".length);
    expect(out).not.toMatch(/abcd/);
  });

  it("never rewrites a placeholder it has written", () => {
    // The password is `rpc-url`, which `[rpc-url]` contains: a second pass would nest it.
    const configured = "https://user:rpc-url@h.example/";
    expect(redactUrls(`a ${configured} b rpc-url c`, [configured])).toBe("a [rpc-url] b [rpc-url] c");
  });

  it("hides a short query value quoted with its name", () => {
    // Replaced alone too; quoted with its name, the name goes with it.
    const configured = "https://safe.example/api?apikey=abcdef";
    for (const quoted of ["apikey=abcdef", "APIKEY=ABCDEF", "apikey%3Dabcdef"]) {
      const out = redactUrls(`request rejected: ${quoted} invalid`, [configured]);
      expect(out.toLowerCase()).not.toContain("abcdef");
      expect(out).toBe("request rejected: [rpc-url] invalid");
    }
  });

  it("hides a short query value whose encoded form differs", () => {
    const configured = "https://safe.example/api?k=a%2Fb";
    expect(redactUrls("bad k=a/b", [configured])).toBe("bad [rpc-url]");
    expect(redactUrls("bad k=a%2Fb", [configured])).toBe("bad [rpc-url]");
  });

  it("hides a short userinfo password quoted with its context", () => {
    const configured = "https://u:pw1@rpc.example/";
    for (const quoted of ["u:pw1@rpc", ":pw1@rpc"]) {
      expect(redactUrls(`auth ${quoted} rejected`, [configured])).not.toContain("pw1");
    }
  });

  it.each([
    ["a short query value", "https://safe.example/api?apikey=abcdef", "invalid token abcdef", "abcdef"],
    ["a four-character query value", "https://safe.example/api?k=wxyz", "bad key wxyz given", "wxyz"],
    ["a short path segment", "https://rpc.example/v2/k3y9z1/status", "key k3y9z1 rejected", "k3y9z1"],
    ["a short percent-encoded path segment", "https://rpc.example/v2/k3y%399z/x", "key k3y99z rejected", "k3y99z"],
  ])("hides %s quoted alone, with nothing naming it", (_case, configured, error, secret) => {
    // Nothing tells a short key from an ordinary word, so it is hidden wherever it appears.
    const out = redactUrls(error, [configured]);
    expect(out.toLowerCase()).not.toContain(secret);
    expect(out).toBe(error.replace(secret, "[rpc-url]"));
  });

  it("hides a short configured value even where it reads as an ordinary word", () => {
    // The accepted cost of masking short keys: unrelated text that equals one is hidden too.
    const configured = "https://safe.example/api?apikey=abcdef";
    expect(redactUrls("hex abcdef and key=abcdef", [configured])).toBe("hex [rpc-url] and key=[rpc-url]");
  });

  it("keeps a path segment or query value shorter than four characters", () => {
    expect(redactUrls("api v2 ok", ["https://rpc.example/api/v2?x=ok"])).toBe("api v2 ok");
  });

  it("redacts the same through a redactor built once as through each call", () => {
    const configured = ["https://u:pw1@KEYHOST9.rpc.example/v2/PATHKEY99?apikey=QK1", null, undefined];
    const redact = createRedactor(configured);
    for (const error of [
      "GET https://u:pw1@KEYHOST9.rpc.example/v2/PATHKEY99?apikey=QK1 failed",
      "auth :pw1@rpc rejected, apikey=QK1",
      "ENOTFOUND KEYHOST9.rpc.example",
      "ENOTFOUND KEYHO",
      "execution reverted: invalid data",
      "",
    ]) {
      // Twice: the shared patterns carry no position from one text into the next.
      expect(redact(error)).toBe(redactUrls(error, configured));
      expect(redact(error)).toBe(redactUrls(error, configured));
    }
    expect(redact("GET https://u:pw1@KEYHOST9.rpc.example/v2/PATHKEY99?apikey=QK1 failed")).toBe(
      "GET [rpc-url] failed",
    );
  });

  it("leaves text without URLs unchanged", () => {
    expect(redactUrls("execution reverted: BatchAlreadyExists")).toBe(
      "execution reverted: BatchAlreadyExists",
    );
  });
});
