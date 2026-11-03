import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

/**
 * The provider the API tests use, loaded at run time. Its module belongs to the API's test tree,
 * so the web's type check does not follow it into the API's sources; this is the part used here.
 */
interface MockProvider {
  fetch(
    url: string,
    options: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<Response>;
  authorize(
    authorizationUrl: string,
    options?: { claims?: Record<string, unknown> },
  ): unknown;
}
const MOCK_MODULE = "../../api/test/helpers/mock-oidc.ts";

/**
 * The E2E stand-in for Google and Microsoft (WP7) — a test process, started by
 * `playwright.config.ts` beside the API and the web; never part of a build.
 *
 * It serves the same in-process provider the API tests use (`apps/api/test/helpers/mock-oidc.ts`)
 * over HTTP, in two halves:
 *
 * - **The provider's back channel**, for the API. With `OIDC_TEST_RELAY_URL` set (refused in
 *   production), the API sends every request for `https://<provider host><path>` here as
 *   `/<host><path>` (`apps/api/src/services/oidc-test-relay.ts`). Discovery, the key set and the
 *   code exchange answer as the provider would; issuer, audience, nonce, PKCE and the redirect
 *   URI are all still checked by the API's OIDC library against the real issuer URLs.
 * - **The person at the provider**, for the specs: `POST /__e2e/authorize` takes the
 *   authorization URL the browser was sent to, and the claims the person's provider would
 *   assert, and returns the code and state the provider would redirect back with
 *   (`e2e/oidc.ts` turns it into that redirect).
 *
 * It listens on loopback only.
 */

const port = Number(process.env["E2E_OIDC_PORT"] ?? 3102);

async function body(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function send(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

async function main(): Promise<void> {
  // This package is CommonJS, so the ESM module is imported at run time, not at the top level.
  const { MockOidcProvider } = (await import(MOCK_MODULE)) as {
    MockOidcProvider: { create(): Promise<MockProvider> };
  };
  const provider = await MockOidcProvider.create();
  serve(provider);
}

function serve(provider: MockProvider): void {
  const server = createServer((request, response) => {
    void (async () => {
      const path = request.url ?? "/";
      const method = (request.method ?? "GET").toUpperCase();
      try {
        if (method === "GET" && path === "/__e2e/health")
          return send(response, 200, { ok: true });
        if (method === "POST" && path === "/__e2e/authorize") {
          const { authorizationUrl, claims } = JSON.parse(
            await body(request),
          ) as {
            authorizationUrl: string;
            claims?: Record<string, unknown>;
          };
          return send(
            response,
            200,
            provider.authorize(authorizationUrl, { claims }),
          );
        }
        // `/<host><path><query>` → `https://<host><path><query>`, which the provider serves or refuses.
        const target = `https:/${path}`;
        const upstream = await provider.fetch(target, {
          method,
          headers: request.headers as Record<string, string>,
          body:
            method === "GET" || method === "HEAD"
              ? undefined
              : await body(request),
        });
        response.writeHead(
          upstream.status,
          Object.fromEntries(upstream.headers.entries()),
        );
        response.end(Buffer.from(await upstream.arrayBuffer()));
      } catch {
        // The caller needs a gateway failure, not provider exceptions or stack details.
        send(response, 502, { error: "mock_provider_request_failed" });
      }
    })();
  });

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`mock OIDC relay on http://127.0.0.1:${port}\n`);
  });
}

main().catch((caught: unknown) => {
  process.stderr.write(`mock OIDC relay failed to start: ${String(caught)}\n`);
  process.exit(1);
});
