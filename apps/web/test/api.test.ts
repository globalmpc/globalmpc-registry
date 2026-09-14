import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch, listProjects } from "../src/lib/api.js";

/**
 * 화면 요청의 타임아웃.
 *
 * error envelope(07 §7.1)는 서버가 **응답을 준** 경우만 다룬다. 응답이 아예 오지
 * 않으면 화면은 그 설계에 닿지 못하고 무한 로딩에 머문다 — 사용자는 무엇이
 * 잘못됐는지도, 다시 시도해야 하는지도 알 수 없다.
 */

/** 끊길 때까지 응답하지 않는 서버. signal이 없으면 그냥 성공한다. */
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
  it("응답이 오지 않으면 타임아웃으로 끊는다", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    await expect(apiFetch("/api/v1/projects", {}, 20)).rejects.toThrow(/aborted/);
  });

  it("호출부가 준 signal을 덮어쓰지 않는다", async () => {
    // 취소 가능한 화면 요청의 signal을 여기서 갈아치우면 그쪽 취소가 죽는다.
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

describe("API 클라이언트", () => {
  it("모든 요청이 타임아웃을 달고 나간다", async () => {
    // 래퍼만 고쳐 두고 호출부가 여전히 맨 fetch를 쓰면 아무것도 달라지지 않는다.
    let seen: AbortSignal | null = null;
    vi.stubGlobal("fetch", (async (_input: RequestInfo | URL, init: RequestInit = {}) => {
      seen = init.signal ?? null;
      return Response.json({ items: [] });
    }) as typeof fetch);

    await listProjects("tok");

    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
