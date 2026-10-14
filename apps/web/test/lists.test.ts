import { afterEach, describe, expect, it, vi } from "vitest";
import { getDocumentGraph, listUploads } from "../src/lib/api.js";
import { truncationText } from "../src/lib/lists.js";

/**
 * Capped lists.
 *
 * A list the server capped must not read as complete. The screen states how much it shows.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function capture(): { urls: string[] } {
  const seen = { urls: [] as string[] };
  vi.stubGlobal("fetch", (async (input: RequestInfo | URL) => {
    seen.urls.push(String(input));
    return Response.json({ items: [], nodes: [], links: [] });
  }) as typeof fetch);
  return seen;
}

describe("truncationText", () => {
  it("states the shown count against the total when the total is known", () => {
    expect(truncationText({ shown: 100, total: 10_000, noun: "files" })).toBe(
      "Showing 100 of 10,000 files.",
    );
  });

  it("says more exist when there is no total, in the order the noun states", () => {
    expect(truncationText({ shown: 50, noun: "stale signals, oldest first" })).toBe(
      "Showing 50 stale signals, oldest first. More exist and are not listed here.",
    );
  });
});

describe("list requests", () => {
  it("sends the cursor back unchanged for the next upload page", async () => {
    const seen = capture();
    await listUploads("token", "p1");
    await listUploads("token", "p1", "abc+/=");
    expect(seen.urls).toEqual([
      "/api/v1/projects/p1/uploads",
      "/api/v1/projects/p1/uploads?cursor=abc%2B%2F%3D",
    ]);
  });

  it("asks the graph to include a focused document", async () => {
    const seen = capture();
    await getDocumentGraph("token", "p1");
    await getDocumentGraph("token", "p1", "u1");
    expect(seen.urls).toEqual([
      "/api/v1/projects/p1/document-graph",
      "/api/v1/projects/p1/document-graph?focus=u1",
    ]);
  });
});
