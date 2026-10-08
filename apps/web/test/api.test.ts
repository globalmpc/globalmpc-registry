import { afterEach, describe, expect, it, vi } from "vitest";
import {
  apiFetch,
  BASE64_UPLOAD_LIMIT_BYTES,
  createUpload,
  listProjects,
} from "../src/lib/api.js";

/**
 * Screen request timeout.
 *
 * The error envelope (07 §7.1) covers only cases where the server **responds**. With no response at all,
 * the screen never reaches that design and stays in an endless loading state — the user cannot
 * tell what went wrong or whether to retry.
 */

/** A server that does not respond until aborted. Without a signal it simply succeeds. */
function hangingFetch(): typeof fetch {
  return ((_input: RequestInfo | URL, init: RequestInit = {}) =>
    new Promise<Response>((resolve, reject) => {
      if (!init.signal) {
        resolve(Response.json({ items: [] }));
        return;
      }
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("apiFetch", () => {
  it("aborts with a timeout when no response arrives", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(apiFetch("/api/v1/projects", {}, 20)).rejects.toThrow(/aborted/);
  });

  it("does not overwrite a signal the caller passed", async () => {
    // Replacing a cancellable screen request's signal here kills that cancellation.
    const controller = new AbortController();
    let seen: AbortSignal | null = null;
    vi.stubGlobal("fetch", (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen = init.signal ?? null;
      return Response.json({});
    }) as typeof fetch);

    await apiFetch("/api/v1/projects", { signal: controller.signal });

    expect(seen).toBe(controller.signal);
  });
});

describe("API client", () => {
  it("every request goes out with a timeout", async () => {
    // Fixing only the wrapper changes nothing if callers still use bare fetch.
    let seen: AbortSignal | null = null;
    vi.stubGlobal("fetch", (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen = init.signal ?? null;
      return Response.json({ items: [] });
    }) as typeof fetch);

    await listProjects("tok");

    expect(seen).toBeInstanceOf(AbortSignal);
  });
});

/**
 * Which path an upload takes — the phone photo case.
 *
 * The base64 path sends the bytes inside a JSON body, and base64 inflates them by a third. The
 * API runs on Fastify's default 1 MiB body limit, and a body over that limit never reaches the
 * route: the error handler has no `AppError` to map, so the caller gets a 500 with no usable
 * reason. A phone photo is 2-4 MB, so the cutoff has to sit low enough that anything still taking
 * the base64 path fits inside that limit.
 */
const API_BODY_LIMIT_BYTES = 1024 * 1024;

/** Records the one request `createUpload` makes and answers with a stored upload. */
function recordingFetch(seen: { url: string; body: BodyInit | null | undefined }): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    seen.url = String(input);
    seen.body = init.body;
    return Response.json({ id: "u1", state: "quarantined" });
  }) as typeof fetch;
}

describe("createUpload", () => {
  it("sends a phone-sized photo as multipart, not base64", async () => {
    const seen = { url: "", body: undefined as BodyInit | null | undefined };
    vi.stubGlobal("fetch", recordingFetch(seen));

    // 2 MB is an ordinary phone camera photo.
    const photo = new File([new Uint8Array(2 * 1024 * 1024)], "core-tray.jpg", {
      type: "image/jpeg",
    });
    await createUpload("tok", "p1", photo, "key-1");

    expect(seen.url).toContain("/uploads/stream");
    expect(seen.body).toBeInstanceOf(FormData);
  });

  it("keeps the largest base64 body under the API body limit", async () => {
    const seen = { url: "", body: undefined as BodyInit | null | undefined };
    vi.stubGlobal("fetch", recordingFetch(seen));

    // The largest file that still takes the base64 path. One byte more goes multipart.
    const file = new File([new Uint8Array(BASE64_UPLOAD_LIMIT_BYTES)], "report.pdf", {
      type: "application/pdf",
    });
    await createUpload("tok", "p1", file, "key-2");

    expect(seen.url).toMatch(/\/uploads$/);
    expect(new Blob([seen.body as string]).size).toBeLessThan(API_BODY_LIMIT_BYTES);
  });
});
