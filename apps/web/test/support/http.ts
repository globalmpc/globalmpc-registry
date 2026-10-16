import { vi } from "vitest";

export interface HttpCall {
  url: string;
  method: string;
  headers: Headers;
  body: Record<string, unknown> | null;
}
/** Keep the real API client; replace only the HTTP boundary, rejecting unhandled requests. */
export function mockHttp(routes: Record<string, unknown | ((call: HttpCall) => unknown)>) {
  const calls: HttpCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const call: HttpCall = {
        url: String(input),
        method: init.method ?? "GET",
        headers: new Headers(init.headers),
        body:
          typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      calls.push(call);
      const key = `${call.method} ${call.url}`;
      if (!(key in routes)) throw new Error(`Unhandled test request: ${key}`);
      const route = routes[key];
      const result = await (typeof route === "function" ? route(call) : route);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}
