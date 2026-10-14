/**
 * Masks URLs in error text before it is stored or logged (L5).
 *
 * Hosted RPC providers put the API key in the URL — path (`/v2/<key>`), query (`?apikey=`) or
 * userinfo. viem quotes the request URL in its error messages, and the anchor worker stores those
 * messages in `chain.transactions.last_error`, which `GET /anchor-batches` serves as `lastError`.
 *
 * Configured URLs are replaced whole: a provider may put the key in the host itself. Any other URL
 * keeps scheme and host — enough to tell which endpoint failed — and loses the rest.
 */

const CONFIGURED_PLACEHOLDER = "[rpc-url]";
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;

function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "[redacted-url]";
  }
  const hasRest =
    (url.pathname !== "" && url.pathname !== "/") ||
    url.search !== "" ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== "";
  return `${url.protocol}//${url.host}${hasRest ? "/[redacted]" : ""}`;
}

export function redactUrls(text: string, configured: readonly (string | undefined)[] = []): string {
  const literal = configured
    .filter((value): value is string => typeof value === "string" && value !== "")
    .reduce((acc, value) => acc.split(value).join(CONFIGURED_PLACEHOLDER), text);
  return literal.replace(URL_PATTERN, maskUrl);
}
