import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, listProjects } from "../src/lib/api.js";

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
