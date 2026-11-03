import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type postgres from "postgres";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { isEncodedAuthPath } from "../src/plugins/path-encoding.js";
import { testEnv } from "./helpers/db.js";

/**
 * Percent-encoded auth paths are refused before routing (WP6 review M1, defence in depth).
 *
 * The web BFF recognises `/api/v1/auth/email/verify` and friends by their literal path and turns
 * the issued token into an HttpOnly cookie. This router decodes `%76erify` to `verify`, so an
 * encoded variant would reach the same handler past that recognition and answer the token in a
 * body page script can read. Checked in real hook order and without a DB.
 */

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer(
    loadConfig(testEnv({ DATABASE_URL: "postgres://unused" })),
    (async () => []) as unknown as postgres.Sql,
  );
});

afterAll(async () => {
  await app.close();
});

describe("encoded auth paths", () => {
  it.each([
    ["POST", "/api/v1/auth/email/%76erify"],
    ["POST", "/api/v1/auth/invitations/accept/%76erify"],
    ["GET", "/api/v1/auth/%73essions"],
    ["POST", "/api/v1/auth/oidc/google/%73tart"],
    ["POST", "/api/v1/auth/oidc/google/%63allback"],
    ["POST", "/api/v1/auth/oidc/google/link/%73tart"],
    ["POST", "/api/v1/auth/oidc/google/link/%63allback"],
    ["POST", "/api/v1/auth/%6cogout"],
    ["POST", "/api/v1/%61uth/email/verify"],
    ["POST", "/api/%761/auth/email/verify"],
    ["POST", "/api/v1/auth%2Femail%2Fverify"],
    ["POST", "/api/v1/AUTH/email/%76erify"],
    ["GET", "/api/v1/auth/%73ession"],
  ])("refuses %s %s with 400 before any handler", async (method, url) => {
    const response =
      method === "POST"
        ? await app.inject({ method: "POST", url, payload: {} })
        : await app.inject({ method: "GET", url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "PATH_ENCODING_REFUSED" });
    expect(response.body).not.toContain("sessionToken");
  });

  it("still answers the literal path", async () => {
    const response = await app.inject({ method: "GET", url: "/api/v1/auth/session" });
    expect(response.statusCode).toBe(200);
  });

  it("leaves encoding elsewhere and in an auth query string alone", async () => {
    const elsewhere = await app.inject({ method: "GET", url: "/api/v1/public/registries/project/key%20with%20space" });
    expect(elsewhere.json().code).not.toBe("PATH_ENCODING_REFUSED");
    const query = await app.inject({ method: "GET", url: "/api/v1/auth/session?x=%76" });
    expect(query.statusCode).toBe(200);
  });
});

describe("isEncodedAuthPath", () => {
  it("decodes as far as a malformed escape allows, so a broken one cannot hide the prefix", () => {
    expect(isEncodedAuthPath("/api/v1/%61uth/email/verify%zz")).toBe(true);
    expect(isEncodedAuthPath("/api/v1/auth/%zz")).toBe(true);
    expect(isEncodedAuthPath("/api/v1/projects/%zz")).toBe(false);
  });

  it("ignores unencoded paths and paths outside auth", () => {
    expect(isEncodedAuthPath("/api/v1/auth/email/verify")).toBe(false);
    expect(isEncodedAuthPath("/api/v1/authority/%20")).toBe(false);
    expect(isEncodedAuthPath("/api/v1/public/registries/project/a%2Fb")).toBe(false);
  });
});
