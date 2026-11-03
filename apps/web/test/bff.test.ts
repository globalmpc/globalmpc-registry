import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "../src/proxy.js";
import {
  pathRefusal,
  cookieMode,
  cookieOptions,
  crossSiteRefusal,
  decodeOidcBinding,
  encodeOidcBinding,
  expectedOrigin,
  oidcRoute,
  sessionEndingRoute,
  sessionMaxAge,
  withoutCredentials,
} from "../src/lib/bff.js";
import { safeNextPath } from "../src/lib/next-path.js";
import { readCallback, readInvitationToken } from "../src/lib/oidc-callback.js";

/**
 * The web server's session boundary (WP6, threat model T10).
 *
 * Expected outcomes are derived from the contract, not the implementation: the token never reaches
 * page script, the cookie is HttpOnly and (in production) Secure and host-only, a state-changing
 * request from another site is refused before the API sees it, and a provider callback completes
 * nothing in a browser that did not start the flow.
 */

const WEB = "http://localhost:3000";
const BINDING = "b".repeat(43);
const TOKEN = "t".repeat(43);

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

function stubApi(reply: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call: Sent = {
        url: String(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body: typeof init.body === "string" ? JSON.parse(init.body) : null,
      };
      sent.push(call);
      return reply(call);
    }),
  );
  return sent;
}

function req(
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; origin?: string } = {},
): NextRequest {
  return new NextRequest(`${init.origin ?? WEB}${path}`, {
    method: init.method ?? "POST",
    headers: init.headers ?? {},
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

const sameOrigin = { "sec-fetch-site": "same-origin", "content-type": "application/json" };

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

beforeEach(() => {
  vi.stubEnv("API_ORIGIN", "http://api.internal:3001");
  vi.stubEnv("WEB_ORIGIN", "");
  vi.stubEnv("EDGE_PROXY_SECRET", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("cookie attributes", () => {
  it("is host-only, Secure and prefixed in production even behind a TLS-terminating proxy", () => {
    const mode = cookieMode(req("/api/v1/auth/email/verify"), "production");
    expect(mode).toEqual({ secure: true, session: "__Host-mpc_session", oidc: "__Host-mpc_oidc" });
    expect(cookieOptions(mode, 60)).toEqual({ httpOnly: true, secure: true, sameSite: "strict", path: "/", maxAge: 60 });
  });

  it("is Secure on https outside production, and plain only on plain http development", () => {
    expect(cookieMode(req("/x", { origin: "https://localhost:3000" }), "development").secure).toBe(true);
    expect(cookieMode(req("/x"), "development")).toEqual({ secure: false, session: "mpc_session", oidc: "mpc_oidc" });
  });

  it("never outlives the API's absolute session lifetime", () => {
    const now = Date.parse("2026-11-02T00:00:00Z");
    expect(sessionMaxAge("2026-11-02T01:00:00Z", now)).toBe(3600);
    expect(sessionMaxAge("2026-11-05T00:00:00Z", now)).toBe(8 * 3600);
    expect(sessionMaxAge("2026-11-01T00:00:00Z", now)).toBe(0);
    expect(sessionMaxAge(undefined, now)).toBe(8 * 3600);
    expect(sessionMaxAge("not a date", now)).toBe(8 * 3600);
  });
});

describe("cross-site refusal (CSRF)", () => {
  it.each(["cross-site", "same-site", "none"])("refuses a POST the browser marks %s", (site) => {
    expect(crossSiteRefusal(req("/api/v1/x", { headers: { "sec-fetch-site": site } }), true, "")).toBe(
      `sec-fetch-site:${site}`,
    );
  });

  it("lets safe methods and same-origin requests through", () => {
    expect(crossSiteRefusal(req("/api/v1/x", { method: "GET", headers: { "sec-fetch-site": "cross-site" } }), true, "")).toBeNull();
    expect(crossSiteRefusal(req("/api/v1/x", { headers: { "sec-fetch-site": "same-origin" } }), true, "")).toBeNull();
  });

  it("falls back to Origin, compared with WEB_ORIGIN when it is set", () => {
    expect(crossSiteRefusal(req("/api/v1/x", { headers: { origin: WEB } }), true, "")).toBeNull();
    expect(crossSiteRefusal(req("/api/v1/x", { headers: { origin: "https://evil.example" } }), true, "")).toBe("origin");
    // Behind a proxy the Host header is the internal one; WEB_ORIGIN names the public origin.
    expect(
      crossSiteRefusal(req("/api/v1/x", { headers: { origin: "https://registry.example" } }), true, "https://registry.example/"),
    ).toBeNull();
    expect(crossSiteRefusal(req("/api/v1/x", { headers: { origin: WEB } }), true, "https://registry.example")).toBe("origin");
  });

  it("does not let a malformed WEB_ORIGIN open the check", () => {
    expect(expectedOrigin(req("/x"), "not a url")).toBe(WEB);
    expect(crossSiteRefusal(req("/api/v1/x", { headers: { origin: "https://evil.example" } }), true, "::")).toBe("origin");
  });

  it("refuses a cookie-riding request that names no origin, but not a client with its own bearer", () => {
    expect(crossSiteRefusal(req("/api/v1/x"), true, "")).toBe("no-origin");
    expect(crossSiteRefusal(req("/api/v1/x"), false, "")).toBeNull();
  });

  it("refuses a cross-site POST in the proxy before the API sees it", async () => {
    const sent = stubApi(() => Response.json({}));
    const response = await proxy(
      req("/api/v1/projects", {
        headers: { "sec-fetch-site": "cross-site", cookie: `mpc_session=${TOKEN}` },
        body: {},
      }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("CROSS_SITE_REQUEST_REFUSED");
    expect(sent).toHaveLength(0);
  });

  it("refuses a cross-site sign-in completion even without a cookie (login CSRF)", async () => {
    const sent = stubApi(() => Response.json({}));
    const response = await proxy(
      req("/api/v1/auth/email/verify", { headers: { origin: "https://evil.example" }, body: { email: "a@b.c", code: "1" } }),
    );
    expect(response.status).toBe(403);
    expect(sent).toHaveLength(0);
  });
});

describe("session cookie ↔ bearer", () => {
  it("turns the cookie into a bearer for the API and forwards no cookie", async () => {
    const response = await proxy(
      req("/api/v1/projects?limit=2", { method: "GET", headers: { cookie: `mpc_session=${TOKEN}; other=1` } }),
    );
    expect(response.headers.get("x-middleware-rewrite")).toBe("http://api.internal:3001/api/v1/projects?limit=2");
    expect(response.headers.get("x-middleware-request-authorization")).toBe(`Bearer ${TOKEN}`);
    expect(response.headers.get("x-middleware-override-headers")).not.toContain("cookie");
  });

  it("forwards a client's own bearer as sent and ignores the cookie", async () => {
    const response = await proxy(
      req("/api/v1/projects", {
        method: "GET",
        headers: { authorization: "Bearer service", cookie: `mpc_session=${TOKEN}` },
      }),
    );
    expect(response.headers.get("x-middleware-request-authorization")).toBe("Bearer service");
  });

  it("reads only the prefixed cookie in production, so an unprefixed one cannot be planted", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await proxy(req("/api/v1/projects", { method: "GET", headers: { cookie: `mpc_session=${TOKEN}` } }));
    expect(response.headers.get("x-middleware-request-authorization")).toBeNull();
  });

  it.each([
    "/api/v1/auth/email/verify",
    "/api/v1/auth/invitations/accept/verify",
  ])("keeps the token issued by %s out of the body and in an HttpOnly cookie", async (path) => {
    vi.stubEnv("NODE_ENV", "production");
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const sent = stubApi(() =>
      Response.json({ sessionToken: TOKEN, expiresAt, subjectId: "s" }, { headers: { "x-request-id": "rid" } }),
    );
    const response = await proxy(req(path, { origin: "https://registry.example", headers: sameOrigin, body: { code: "1" } }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual({ expiresAt, subjectId: "s" });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(response.headers.get("x-request-id")).toBe("rid");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const [cookie] = setCookies(response);
    expect(cookie).toMatch(new RegExp(`^__Host-mpc_session=${TOKEN};`));
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).not.toMatch(/Domain=/i);
    expect(sent[0]!.url).toBe(`http://api.internal:3001${path}`);
    expect(sent[0]!.headers.get("cookie")).toBeNull();
  });

  it("sets no cookie when the API refuses the sign-in, and passes the refusal on", async () => {
    stubApi(() => Response.json({ code: "EMAIL_CODE_INVALID", message: "no" }, { status: 400 }));
    const response = await proxy(req("/api/v1/auth/email/verify", { headers: sameOrigin, body: { code: "1" } }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("EMAIL_CODE_INVALID");
    expect(setCookies(response)).toEqual([]);
  });

  it("clears the cookie on sign-out even when the API no longer knows the token", async () => {
    const sent = stubApi(() => Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }));
    const response = await proxy(
      req("/api/v1/auth/logout", { headers: { ...sameOrigin, cookie: `mpc_session=${TOKEN}` } }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revoked: false });
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(setCookies(response)[0]).toMatch(/^mpc_session=;.*Max-Age=0/i);
  });

  it("passes a successful sign-out through", async () => {
    stubApi(() => Response.json({ revoked: true }));
    const response = await proxy(req("/api/v1/auth/logout", { headers: { ...sameOrigin, cookie: `mpc_session=${TOKEN}` } }));
    expect(await response.json()).toEqual({ revoked: true });
  });

  it("answers 502 in the API's error shape when the API cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    const response = await proxy(req("/api/v1/auth/email/verify", { headers: sameOrigin, body: {} }));
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "API_UNREACHABLE", retryable: true });
  });
});

describe("a route that ends the request's own session (WP7 review L2)", () => {
  const SESSION = "/api/v1/auth/sessions/0f0e0d0c-0000-4000-8000-000000000001/revocation";
  const UNLINK = "/api/v1/auth/identities/0f0e0d0c-0000-4000-8000-000000000002/unlink";
  const withCookie = { headers: { ...sameOrigin, cookie: `mpc_session=${TOKEN}` } };

  it("clears the cookie when the revoked session is the current one", async () => {
    const sent = stubApi(() => Response.json({ id: "s", revoked: true, current: true }));
    const response = await proxy(req(SESSION, withCookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "s", revoked: true, current: true });
    expect(sent[0]!.url).toBe(`http://api.internal:3001${SESSION}`);
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.headers.get("cookie")).toBeNull();
    expect(setCookies(response)[0]).toMatch(/^mpc_session=;.*Max-Age=0/i);
  });

  it("clears the prefixed cookie in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    stubApi(() => Response.json({ id: "s", revoked: true, current: true }));
    const response = await proxy(
      req(SESSION, {
        origin: "https://registry.example",
        headers: { ...sameOrigin, cookie: `__Host-mpc_session=${TOKEN}` },
      }),
    );
    const [cookie] = setCookies(response);
    expect(cookie).toMatch(/^__Host-mpc_session=;.*Max-Age=0/i);
    expect(cookie).toMatch(/Secure/i);
  });

  it("keeps the cookie when another session was revoked", async () => {
    stubApi(() => Response.json({ id: "s", revoked: true, current: false }));
    const response = await proxy(req(SESSION, withCookie));
    expect(response.status).toBe(200);
    expect(setCookies(response)).toEqual([]);
  });

  it("keeps the cookie when the API refuses, whatever the body says", async () => {
    stubApi(() => Response.json({ code: "MFA_REQUIRED", current: true }, { status: 403 }));
    const response = await proxy(req(SESSION, withCookie));
    expect(response.status).toBe(403);
    expect(((await response.json()) as { code: string }).code).toBe("MFA_REQUIRED");
    expect(setCookies(response)).toEqual([]);
  });

  it("does not take a string or a truthy value for true", async () => {
    stubApi(() => Response.json({ id: "s", revoked: true, current: "true" }));
    expect(setCookies(await proxy(req(SESSION, withCookie)))).toEqual([]);
  });

  it("clears the cookie when unlinking ends the current session, and not otherwise", async () => {
    stubApi(() => Response.json({ revokedSessions: 1, currentSessionEnded: true }));
    expect(setCookies(await proxy(req(UNLINK, withCookie)))[0]).toMatch(/^mpc_session=;.*Max-Age=0/i);
    stubApi(() => Response.json({ revokedSessions: 1, currentSessionEnded: false }));
    expect(setCookies(await proxy(req(UNLINK, withCookie)))).toEqual([]);
  });

  it("leaves the cookie to a client that sent its own bearer: it ended that bearer's session", async () => {
    const response = await proxy(
      req(SESSION, { headers: { ...sameOrigin, authorization: "Bearer service", cookie: `mpc_session=${TOKEN}` } }),
    );
    // Forwarded as a plain rewrite, with the client's bearer, and no cookie is touched.
    expect(response.headers.get("x-middleware-rewrite")).toBe(`http://api.internal:3001${SESSION}`);
    expect(response.headers.get("x-middleware-request-authorization")).toBe("Bearer service");
    expect(setCookies(response)).toEqual([]);
  });

  it("clears the cookie when removing a factor ends the current session, and not otherwise", async () => {
    for (const path of ["/api/v1/auth/mfa/passkeys/p1/removal", "/api/v1/auth/mfa/totp/removal"]) {
      stubApi(() => Response.json({ removed: true, revokedSessions: 2, currentSessionEnded: true }));
      expect(setCookies(await proxy(req(path, withCookie)))[0], path).toMatch(/^mpc_session=;.*Max-Age=0/i);
      stubApi(() => Response.json({ removed: true, revokedSessions: 1, currentSessionEnded: false }));
      expect(setCookies(await proxy(req(path, withCookie))), path).toEqual([]);
    }
  });

  it("clears the cookie whenever disabling one's own wallet succeeds: it ends every session", async () => {
    const path = "/api/v1/auth/wallets/w1/disable";
    stubApi(() => Response.json({ id: "w1", disabledAt: "2026-11-02T00:00:00Z", revokedSessions: 1 }));
    expect(setCookies(await proxy(req(path, withCookie)))[0]).toMatch(/^mpc_session=;.*Max-Age=0/i);
    stubApi(() => Response.json({ code: "MFA_REQUIRED" }, { status: 403 }));
    expect(setCookies(await proxy(req(path, withCookie)))).toEqual([]);
  });

  it("matches exactly the session-ending routes", () => {
    expect(sessionEndingRoute(SESSION)).toBe("current");
    expect(sessionEndingRoute(UNLINK)).toBe("currentSessionEnded");
    expect(sessionEndingRoute("/api/v1/auth/mfa/passkeys/p1/removal")).toBe("currentSessionEnded");
    expect(sessionEndingRoute("/api/v1/auth/mfa/totp/removal")).toBe("currentSessionEnded");
    expect(sessionEndingRoute("/api/v1/auth/wallets/w1/disable")).toBe("always");
    // A bind that replaces the wallet keeps the session (0130); only a disable ends them.
    expect(sessionEndingRoute("/api/v1/auth/wallets")).toBeNull();
    expect(sessionEndingRoute("/api/v1/auth/mfa/passkeys/p1")).toBeNull();
    expect(sessionEndingRoute("/api/v1/auth/sessions")).toBeNull();
    expect(sessionEndingRoute(`${SESSION}/x`)).toBeNull();
    expect(sessionEndingRoute("/api/v1/auth/sessions/a/b/revocation")).toBeNull();
    expect(sessionEndingRoute("/api/v1/auth/logout")).toBeNull();
  });

  it("refuses an encoded variant before it can skip the clearing", async () => {
    const sent = stubApi(() => Response.json({ current: true }));
    const response = await proxy(req("/api/v1/auth/sessions/s/%72evocation", withCookie));
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});

describe("OIDC browser binding", () => {
  it("keeps the binding in an HttpOnly cookie, never in the page's answer", async () => {
    const sent = stubApi(() =>
      Response.json({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1", browserBinding: BINDING }),
    );
    const response = await proxy(
      req("/api/v1/auth/oidc/google/start", { headers: sameOrigin, body: { purpose: "invitation_accept", invitationToken: "i" } }),
    );
    expect(await response.json()).toEqual({ authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
    const [cookie] = setCookies(response);
    expect(cookie).toContain(`mpc_oidc=google.invitation_accept.${BINDING}`);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Max-Age=600/);
    expect(sent[0]!.body).toEqual({ purpose: "invitation_accept", invitationToken: "i" });
  });

  it("records a link flow as such, started by the signed-in person", async () => {
    const sent = stubApi(() => Response.json({ authorizationUrl: "https://login.microsoftonline.com/x", browserBinding: BINDING }));
    const response = await proxy(
      req("/api/v1/auth/oidc/microsoft/link/start", { headers: { ...sameOrigin, cookie: `mpc_session=${TOKEN}` } }),
    );
    expect(setCookies(response)[0]).toContain(`mpc_oidc=microsoft.link.${BINDING}`);
    expect(sent[0]!.url).toBe("http://api.internal:3001/api/v1/auth/oidc/microsoft/link/start");
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it("sets no binding cookie when the start is refused", async () => {
    stubApi(() => Response.json({ code: "OIDC_PROVIDER_UNAVAILABLE" }, { status: 404 }));
    const response = await proxy(req("/api/v1/auth/oidc/google/start", { headers: sameOrigin, body: { purpose: "sign_in" } }));
    expect(response.status).toBe(404);
    expect(setCookies(response)).toEqual([]);
  });

  it("refuses a callback without the binding cookie and never forwards it", async () => {
    const sent = stubApi(() => Response.json({ sessionToken: TOKEN }));
    const response = await proxy(
      req("/api/v1/auth/oidc/google/callback", { headers: sameOrigin, body: { state: "s", code: "c" } }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe("OIDC_BINDING_MISSING");
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["another provider", `mpc_oidc=microsoft.sign_in.${BINDING}`],
    ["a malformed value", "mpc_oidc=google.sign_in.short"],
    ["an unknown purpose", `mpc_oidc=google.admin.${BINDING}`],
  ])("refuses a callback whose binding names %s", async (_case, cookie) => {
    const sent = stubApi(() => Response.json({ sessionToken: TOKEN }));
    const response = await proxy(
      req("/api/v1/auth/oidc/google/callback", { headers: { ...sameOrigin, cookie }, body: { state: "s", code: "c" } }),
    );
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
    expect(setCookies(response)[0]).toMatch(/^mpc_oidc=;/);
  });

  it("refuses a callback body that is not an object", async () => {
    const sent = stubApi(() => Response.json({}));
    const response = await proxy(
      req("/api/v1/auth/oidc/google/callback", { headers: { ...sameOrigin, cookie: `mpc_oidc=google.sign_in.${BINDING}` }, body: ["x"] }),
    );
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("adds the kept binding to a sign-in callback, issues the session cookie and spends the binding", async () => {
    const sent = stubApi(() => Response.json({ sessionToken: TOKEN, expiresAt: null, aal: "aal1" }));
    const response = await proxy(
      req("/api/v1/auth/oidc/google/callback", {
        headers: { ...sameOrigin, cookie: `mpc_oidc=google.sign_in.${BINDING}` },
        body: { state: "s", code: "c", browserBinding: "attacker-chosen" },
      }),
    );
    expect(sent[0]!.url).toBe("http://api.internal:3001/api/v1/auth/oidc/google/callback");
    // The page cannot choose the binding: the cookie's value wins over anything in the body.
    expect(sent[0]!.body).toEqual({ state: "s", code: "c", browserBinding: BINDING });
    expect(await response.json()).toEqual({ expiresAt: null, aal: "aal1" });
    expect(response.headers.get("x-mpc-oidc-purpose")).toBe("sign_in");
    const cookies = setCookies(response);
    expect(cookies.some((cookie) => cookie.startsWith(`mpc_session=${TOKEN};`))).toBe(true);
    expect(cookies.some((cookie) => /^mpc_oidc=;.*Max-Age=0/i.test(cookie))).toBe(true);
  });

  it("completes a link flow on the link route and issues no session", async () => {
    const sent = stubApi(() => Response.json({ provider: "microsoft", linked: true }));
    const response = await proxy(
      req("/api/v1/auth/oidc/microsoft/callback", {
        headers: { ...sameOrigin, cookie: `mpc_oidc=microsoft.link.${BINDING}; mpc_session=${TOKEN}` },
        body: { state: "s", code: "c" },
      }),
    );
    expect(sent[0]!.url).toBe("http://api.internal:3001/api/v1/auth/oidc/microsoft/link/callback");
    expect(sent[0]!.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(response.headers.get("x-mpc-oidc-purpose")).toBe("link");
    expect(setCookies(response).some((cookie) => cookie.startsWith("mpc_session="))).toBe(false);
  });

  it("round-trips only what it wrote", () => {
    const value = { provider: "google", purpose: "sign_in", binding: BINDING } as const;
    expect(decodeOidcBinding(encodeOidcBinding(value))).toEqual(value);
    expect(decodeOidcBinding(undefined)).toBeNull();
    expect(decodeOidcBinding("a.b")).toBeNull();
    expect(decodeOidcBinding(`Google.sign_in.${BINDING}`)).toBeNull();
  });

  it("recognises exactly the four OIDC steps", () => {
    expect(oidcRoute("/api/v1/auth/oidc/google/start")).toEqual({ provider: "google", step: "start" });
    expect(oidcRoute("/api/v1/auth/oidc/google/link/start")).toEqual({ provider: "google", step: "link_start" });
    expect(oidcRoute("/api/v1/auth/oidc/google/callback")).toEqual({ provider: "google", step: "callback" });
    expect(oidcRoute("/api/v1/auth/oidc/google/link/callback")).toEqual({ provider: "google", step: "callback" });
    expect(oidcRoute("/api/v1/auth/oidc/google/identities")).toBeNull();
    expect(oidcRoute("/api/v1/auth/oidc/../start")).toBeNull();
  });

  it("strips both credential fields from any answer", () => {
    expect(withoutCredentials({ sessionToken: "x", browserBinding: "y", ok: 1 })).toEqual({ ok: 1 });
    expect(withoutCredentials(null)).toEqual({});
    expect(withoutCredentials(["sessionToken"])).toEqual({});
  });
});

describe("encoded paths (review M1, L1)", () => {
  /**
   * Every route this proxy intercepts, with one letter percent-encoded. The API decodes the escape
   * and routes it as the literal path, so each must be refused here — never forwarded, where the
   * token or the browser binding would come back in a body page script reads, or a callback would
   * skip the binding check, or logout would revoke without clearing the cookie.
   */
  const ENCODED = [
    "/api/v1/auth/email/%76erify",
    "/api/v1/auth/invitations/accept/%76erify",
    "/api/v1/auth/oidc/google/%73tart",
    "/api/v1/auth/oidc/microsoft/%73tart",
    "/api/v1/auth/oidc/google/link/%73tart",
    "/api/v1/auth/oidc/google/%63allback",
    "/api/v1/auth/oidc/google/link/%63allback",
    "/api/v1/auth/%6cogout",
    "/api/v1/%61uth/email/verify",
    "/api/%761/auth/email/verify",
    "/api/v1/auth%2Femail%2Fverify",
    "/api/v1/auth/email/%56ERIFY",
    "/api/v1/auth/oidc/%67oogle/start",
  ];

  it.each(ENCODED)("refuses POST %s with 400 and forwards nothing", async (path) => {
    const sent = stubApi(() => Response.json({ sessionToken: TOKEN, browserBinding: BINDING, expiresAt: null }));
    const response = await proxy(
      req(path, { headers: { ...sameOrigin, cookie: `mpc_session=${TOKEN}` }, body: { code: "12345678" } }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body).toMatchObject({ code: "PATH_ENCODING_REFUSED", details: { reason: "encoded_auth" } });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    expect(setCookies(response)).toEqual([]);
    expect(sent).toHaveLength(0);
  });

  it("treats a dot segment as the route it resolves to, never as a plain rewrite", async () => {
    // URL parsing resolves `%2e%2e` before the proxy sees the path, so this arrives as the literal
    // verify route and is intercepted: the token becomes the cookie, not a body field.
    stubApi(() => Response.json({ sessionToken: TOKEN, expiresAt: null }));
    const response = await proxy(
      req("/api/v1/projects/%2e%2e/auth/email/verify", { headers: sameOrigin, body: { code: "12345678" } }),
    );
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(TOKEN);
    expect(setCookies(response).join(";")).toContain("mpc_session=");

    // A path that reaches the check unresolved is refused.
    expect(pathRefusal("/api/v1/projects/%2e%2e/auth/email/verify")).toBe("dot_segment");
    expect(pathRefusal("/api/v1/projects/../x")).toBe("dot_segment");
    expect(pathRefusal("/api/v1/projects/%2E/x")).toBe("dot_segment");
  });

  it("refuses an escape that does not decode", async () => {
    stubApi(() => Response.json({}));
    const response = await proxy(req("/api/v1/projects/%zz", { method: "GET" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ details: { reason: "malformed" } });
  });

  it("still forwards encoding outside auth — a public registry key is free text", async () => {
    expect(pathRefusal("/api/v1/public/registries/project/key%20with%20space")).toBeNull();
    expect(pathRefusal("/api/v1/public/registries/project/a%2Fb")).toBeNull();
    expect(pathRefusal("/api/v1/auth/email/verify")).toBeNull();
    expect(pathRefusal("/api/v1/authorities/x%20y")).toBeNull();
  });

  it("still intercepts the literal route", async () => {
    stubApi(() => Response.json({ sessionToken: TOKEN, expiresAt: null }));
    const response = await proxy(req("/api/v1/auth/email/verify", { headers: sameOrigin, body: { code: "12345678" } }));
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain(TOKEN);
    expect(setCookies(response).join(";")).toContain("mpc_session=");
  });
});

describe("page code holds no credential", () => {
  /**
   * A client module that builds `Authorization: Bearer ${token}` itself would now send the session
   * marker — the proxy forwards a request's own header unchanged — and every call it makes would
   * fail as signed out (found in the browser run: the project list answered 401). Only the proxy
   * writes that header.
   */
  /** The web server's own modules: the proxy, its helpers and the streaming upload pass-through. */
  const SERVER_ONLY = new Set(["proxy.ts", join("lib", "bff.ts"), join("lib", "stream-upload.ts")]);

  it("never builds an Authorization header outside the web server", () => {
    const root = fileURLToPath(new URL("../src", import.meta.url));
    const offenders = readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(ts|tsx)$/.test(file) && !SERVER_ONLY.has(file))
      .filter((file) => {
        // Code only: block and line comments may describe the header.
        const code = readFileSync(join(root, file), "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/^\s*\/\/.*$/gm, "");
        return /authorization["']?\s*:|Bearer \$\{/i.test(code);
      });
    expect(offenders).toEqual([]);
  });
});

describe("values a URL carries", () => {
  it("reads the provider's answer from the query and nothing else", () => {
    expect(readCallback("?state=s&code=c&iss=https%3A%2F%2Faccounts.google.com")).toEqual({
      state: "s",
      code: "c",
      iss: "https://accounts.google.com",
    });
    expect(readCallback("?state=s&error=access_denied")).toEqual({ state: "s", error: "access_denied" });
    expect(readCallback("?code=c")).toBeNull();
    expect(readCallback("?state=s")).toBeNull();
  });

  it("takes the invitation token only from the fragment and only in its exact shape", () => {
    const token = "A".repeat(43);
    expect(readInvitationToken(`#token=${token}`)).toBe(token);
    expect(readInvitationToken(`token=${token}`)).toBe(token);
    expect(readInvitationToken("#token=short")).toBeNull();
    expect(readInvitationToken("")).toBeNull();
  });

  it.each([
    ["https://evil.example/x"],
    ["//evil.example/x"],
    ["/\\evil.example"],
    ["javascript:alert(1)"],
    ["/w/projects\u0000"],
    [""],
    [null],
  ])("never sends a fresh session to %s after sign-in", (raw) => {
    expect(safeNextPath(raw)).toBe("/w/projects");
  });

  it("keeps a path on this site", () => {
    expect(safeNextPath("/w/settings?tab=factors")).toBe("/w/settings?tab=factors");
    expect(safeNextPath(null, "/w/admin")).toBe("/w/admin");
  });
});
