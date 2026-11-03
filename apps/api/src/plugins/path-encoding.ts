/** `/api/v1/auth` and everything under it, compared after decoding and without regard to case. */
const AUTH_PATH = /^\/api\/v1\/auth(?:\/|$)/i;

/**
 * Whether a raw request target is a percent-encoded path into `/api/v1/auth`.
 *
 * Only the path counts; a query string may carry encoded values as usual. A path whose encoding
 * is malformed is decoded as far as it reads, so a broken escape cannot hide the prefix: both the
 * raw and the decoded form are checked.
 */
export function isEncodedAuthPath(rawUrl: string): boolean {
  const cut = rawUrl.indexOf("?");
  const path = cut === -1 ? rawUrl : rawUrl.slice(0, cut);
  if (!path.includes("%")) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    decoded = path.replace(/%([0-9a-f]{2})/gi, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
  }
  return AUTH_PATH.test(decoded) || AUTH_PATH.test(path);
}
