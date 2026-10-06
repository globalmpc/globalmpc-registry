import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import { badRequest } from "../src/errors.js";

/**
 * How a failure reaches the client — 07 §7.1.
 *
 * Every error that is not an `AppError` used to become a 500 with `INTERNAL_ERROR`. That is
 * right for a bug in our own code, but Fastify rejects an oversized JSON body before any route
 * runs, and answering 500 there tells the caller "the server broke, retry" when the truthful
 * answer is "the body is too large, send less". The web client can no longer build such a body
 * (`BASE64_UPLOAD_LIMIT_BYTES`), but a direct API caller still can.
 */
async function buildApp(bodyLimit: number) {
  const app = Fastify({ bodyLimit });
  await registerErrorHandler(app);
  app.post("/echo", async () => ({ ok: true }));
  app.get("/boom", async () => {
    throw new Error("unexpected");
  });
  app.get("/refused", async () => {
    throw badRequest("BAD_INPUT", "no");
  });
  return app;
}

describe("error handler", () => {
  it("answers 413 when the body exceeds the limit, not 500", async () => {
    const app = await buildApp(256);
    const response = await app.inject({
      method: "POST",
      url: "/echo",
      headers: { "content-type": "application/json" },
      payload: { blob: "x".repeat(1024) },
    });

    expect(response.statusCode).toBe(413);
    const body = response.json();
    expect(body.code).toBe("PAYLOAD_TOO_LARGE");
    // Sending the same body again fails the same way; retrying is not the fix.
    expect(body.retryable).toBe(false);
    await app.close();
  });

  it("still answers 500 for an unexpected error and keeps its message off the wire", async () => {
    const app = await buildApp(1024 * 1024);
    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(body)).not.toContain("unexpected");
    await app.close();
  });

  it("keeps an AppError's own status and code", async () => {
    const app = await buildApp(1024 * 1024);
    const response = await app.inject({ method: "GET", url: "/refused" });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("BAD_INPUT");
    await app.close();
  });
});
