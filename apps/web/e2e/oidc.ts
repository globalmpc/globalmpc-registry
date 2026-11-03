import type { BrowserContext, Cookie, Page, Route } from "@playwright/test";

/**
 * The person at Google or Microsoft, for the specs (WP7).
 *
 * The browser is sent to the real authorization URL the API produced. The spec intercepts that
 * one top-level navigation — it never reaches the internet — hands the URL to the mock provider
 * (`e2e/oidc-relay.ts`), which checks it as the provider would (client, redirect URI, state,
 * nonce, S256 PKCE) and issues a code bound to it, and answers the browser with the provider's
 * redirect: a 302 to the registered callback, from the provider's origin. Chrome therefore follows
 * a genuine cross-site redirect, which is what decides whether SameSite cookies survive it.
 */

export const OIDC_RELAY = `http://127.0.0.1:${process.env["E2E_OIDC_PORT"] ?? 3102}`;

/** The Microsoft directory the mock provider's tokens name, allowed by the run's API. */
export const MOCK_MICROSOFT_TENANT = "11111111-1111-4111-8111-111111111111";

const PROVIDER_PAGES = /^https:\/\/(accounts\.google\.com|login\.microsoftonline\.com)\//;

export interface ProviderVisit {
  /** The authorization URL the browser was sent to. */
  readonly url: URL;
  /** The cookies the browser held while at the provider (the binding the web server set). */
  readonly cookies: readonly Cookie[];
}

/**
 * Answers the next visit to the provider as a person who approves, asserting `claims` (merged
 * over the mock's honest defaults). `visited` resolves with what the browser carried there.
 */
export async function approveAtProvider(
  page: Page,
  claims: Record<string, unknown>,
): Promise<{ readonly visited: Promise<ProviderVisit> }> {
  let resolve!: (visit: ProviderVisit) => void;
  const visited = new Promise<ProviderVisit>((done) => (resolve = done));
  const handler = async (route: Route) => {
    if (route.request().resourceType() !== "document") return route.abort();
    const url = new URL(route.request().url());
    const answer = await fetch(`${OIDC_RELAY}/__e2e/authorize`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authorizationUrl: url.href, claims }),
    });
    if (!answer.ok) {
      await route.fulfill({ status: 400, body: `mock provider refused: ${await answer.text()}` });
      return;
    }
    const { code, state } = (await answer.json()) as { code: string; state: string };
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    const cookies = await cookiesOf(page.context());
    await route.fulfill({ status: 302, headers: { location: callback.href } });
    await page.unroute(PROVIDER_PAGES, handler);
    resolve({ url, cookies });
  };
  await page.route(PROVIDER_PAGES, handler);
  return { visited };
}

async function cookiesOf(context: BrowserContext): Promise<Cookie[]> {
  return context.cookies();
}
