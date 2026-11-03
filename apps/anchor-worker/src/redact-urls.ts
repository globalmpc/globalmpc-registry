/**
 * Masks URLs in error text before it is stored or logged (L5).
 *
 * Hosted RPC providers put the API key in the URL — path (`/v2/<key>`), query (`?apikey=`) or
 * userinfo. viem quotes the request URL in its error messages, and the anchor worker stores those
 * messages in `chain.transactions.last_error`, which `GET /anchor-batches` serves as `lastError`.
 *
 * Configured URLs are replaced whole: a provider may put the key in the host itself. So is a
 * configured URL's host wherever else it appears, since an error may quote the same host with a
 * different path, and the generic masking below keeps hosts. Any other URL keeps scheme and host —
 * enough to tell which endpoint failed — and loses the rest.
 */

const CONFIGURED_PLACEHOLDER = "[rpc-url]";
// `://`, or `:\/\/` as JSON-escaped error bodies quote it. A backslash parses as a slash in a
// special-scheme URL, so the escaped form is masked the same way.
const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:(?:\/\/|\\\/\\\/)[^\s"'<>`]+/gi;
/**
 * Text beyond this is dropped before masking. Stored errors keep 500 characters anyway, and
 * `URL_PATTERN` rescans a long scheme-like run from every position, so an unbounded error body
 * from a broken or hostile endpoint could stall the worker loop.
 */
const MAX_INPUT = 8192;

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

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parts shorter than this are not replaced on their own: a one-letter username would otherwise be
 * replaced in every word of the message. The full configured URL is replaced whatever its length.
 *
 * Path segments and query values are replaced on their own from this length too, since an error
 * may quote a key without the rest of the URL (`invalid token <key>`), and nothing tells a short
 * key from an ordinary word. That over-masks — a segment like `status` is hidden wherever it
 * appears — but masking can only hide text, never reveal it.
 */
const MIN_PART = 4;

/** The secret-bearing pieces of one configured URL, in every form an error is seen to quote. */
function secretParts(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const path = `${url.pathname === "/" ? "" : url.pathname}${url.search}`;
  const trimmedPath = url.pathname.length > 1 && url.pathname.endsWith("/")
    ? `${url.pathname.slice(0, -1)}${url.search}`
    : "";
  // Every path segment, not only the last: a provider may put the key mid-path
  // (`/v2/<key>/status`), and an error may quote the path only up to it.
  const pathSegments = url.pathname.split("/").filter((segment) => segment !== "");
  const queryValues = url.search
    .slice(1)
    .split("&")
    .map((pair) => pair.slice(pair.indexOf("=") + 1));
  const segments = [...pathSegments, ...queryValues].flatMap((segment) => [segment, safeDecode(segment)]);
  return [
    url.host,
    url.hostname,
    path,
    trimmedPath,
    url.username,
    url.password,
    safeDecode(url.username),
    safeDecode(url.password),
    // Filtered to `MIN_PART` with the other parts by the caller.
    ...segments,
  ].flatMap((part) => [part, part.replaceAll("/", "\\/")]);
}

/**
 * Each secret of one configured URL together with the text that names it — a query value with its
 * parameter (`apikey=<value>`), a password with its userinfo (`user:<password>@`, `:<password>@`)
 * — in every form an error is seen to quote. These are kept whatever the secret's length: a value
 * too short to replace alone (`MIN_PART`) is still a key when quoted with its name, and the name
 * keeps the match from spreading to unrelated text.
 */
function contextParts(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const pairs = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair.indexOf("=") > 0 && !pair.endsWith("="))
    .flatMap((pair) => {
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const secret = pair.slice(at + 1);
      return [pair, `${safeDecode(name)}=${safeDecode(secret)}`];
    });
  const userinfo = url.password === ""
    ? []
    : [url.username, safeDecode(url.username)].flatMap((user) =>
        [url.password, safeDecode(url.password)].flatMap((password) => [
          `${user}:${password}@`,
          `:${password}@`,
        ]),
      );
  return [...pairs, ...userinfo].flatMap((part) => [part, part.replaceAll("/", "\\/")]);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parsesAsUrl(value: string): boolean {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every occurrence of every part that starts before the cut, merged where they overlap or touch.
 *
 * Not one pass over an alternation: that takes the earliest-starting match, so a shorter part
 * overlapping the start of a longer one would leave the longer one's remainder in clear. Each
 * part is searched on its own, overlapping occurrences included. Case-insensitive: hostnames are,
 * `URL` lowercases them, and an error may quote either form. A non-unicode `i` regex folds case
 * one code unit at a time, so match indices stay valid in the original text.
 */
function configuredRanges(window: string, patterns: readonly RegExp[]): [number, number][] {
  const ranges: [number, number][] = [];
  for (const pattern of patterns) {
    // Shared across calls: a `g` regex carries its position.
    pattern.lastIndex = 0;
    for (let match = pattern.exec(window); match !== null; match = pattern.exec(window)) {
      if (match.index >= MAX_INPUT) break;
      ranges.push([match.index, match.index + match[0].length]);
      pattern.lastIndex = match.index + 1;
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of ranges) {
    const last = merged.at(-1);
    if (last && from <= last[1]) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

const PLACEHOLDERS = [CONFIGURED_PLACEHOLDER, "[redacted-url]", "/[redacted]"];
/**
 * Replacements can be longer than what they replace — many short parts, or a short URL masked
 * with `/[redacted]` — so the result is bounded again. Everything here is already redacted, so
 * any prefix is safe; the cut only steps back so it does not leave half a placeholder.
 */
const MAX_OUTPUT = MAX_INPUT + CONFIGURED_PLACEHOLDER.length;

function bounded(out: string): string {
  if (out.length <= MAX_OUTPUT) return out;
  let cut = MAX_OUTPUT;
  for (const placeholder of PLACEHOLDERS) {
    const at = out.lastIndexOf(placeholder, cut - 1);
    if (at !== -1 && at < cut && at + placeholder.length > cut) cut = at;
  }
  return out.slice(0, cut);
}

/**
 * Text right before a fragment that marks it as part of a URL: after a scheme's `//`, userinfo's
 * `@`, a path's `/` (or JSON-escaped `\/`), a port's or password's `:`, or a query's `=`.
 */
const URL_CONTEXT = /[/\\@:=]$/;
const TOKEN_CHAR = /[a-z0-9]/i;

/**
 * Where a text that ends in the start of a configured part should be cut, or `undefined` to keep
 * it. A text cut short before it reached us may end inside a secret. But a hostname starts with
 * words — `invalid data` and a host `data-seed-….org` — so the start of a hostname, or of one of
 * its subdomain labels (`subdomainLabels`), counts as a cut secret only when:
 *
 * - the text was cut here (`MAX_INPUT`);
 * - the fragment sits in URL context (`URL_CONTEXT`);
 * - it stops inside a run of letters and digits of the hostname, so it is not a whole word; or
 * - it holds a digit. A whole host label like `<key>.provider.io`, cut right at its dot, is still
 *   a key; an ordinary word followed by `-` or `.` has no digit.
 *
 * Any other part — a path segment, a query value, userinfo — is where keys go, and a key may be
 * made of letter-only chunks (`abcdefgh_ijklmnop`), so the start of one always counts. `MIN_PART`
 * already accepts over-masking those.
 */
function cutTailAt(
  tail: string,
  prefixes: readonly string[],
  hostnames: ReadonlySet<string>,
  truncated: boolean,
): number | undefined {
  const lowerTail = tail.toLowerCase();
  let cut: number | undefined;
  for (const part of prefixes) {
    for (let length = Math.min(part.length - 1, tail.length); length >= MIN_PART; length--) {
      if (!lowerTail.endsWith(part.slice(0, length))) continue;
      const from = tail.length - length;
      const secret =
        !hostnames.has(part) ||
        truncated ||
        URL_CONTEXT.test(tail.slice(0, from)) ||
        TOKEN_CHAR.test(part[length] ?? "") ||
        /[0-9]/.test(part.slice(0, length));
      if (secret) {
        cut = Math.min(cut ?? from, from);
        break;
      }
    }
  }
  return cut;
}

/**
 * The labels of a configured URL's hostname left of its registrable domain — `abcdef` in
 * `abcdef.provider.example` — from `MIN_PART` characters. A provider that puts the key in the host
 * puts it there, and an error may quote that label alone as a word (`invalid API key abcdef`), with
 * nothing to tell it from an ordinary one; so the whole label, hyphens included, is masked wherever
 * it stands as a word, letters only or not. The registrable domain itself (`provider.example`, the
 * last two labels) names the provider, not the key, and its words stay. A host of two labels or
 * fewer has none to mask.
 *
 * Remaining limit: a fragment of such a label cut at one of its hyphens (`abcd` of `abcd-efgh`) is
 * not the whole label, and keeps the rules for the start of a hostname (`cutTailAt`): masked only
 * at the end of a cut text, in URL context, or holding a digit.
 */
function subdomainLabels(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const labels = url.hostname.split(".");
  return labels.length > 2 ? labels.slice(0, -2).filter((label) => label.length >= MIN_PART) : [];
}

/**
 * A redactor for one list of configured URLs. Parsing them and building their patterns is done
 * once here, not per error.
 */
export function createRedactor(configured: readonly (string | null | undefined)[] = []): (text: string) => string {
  const values = configured.filter(
    (value): value is string => typeof value === "string" && value !== "",
  );
  // Each configured URL whole — as is, JSON-escaped and percent-encoded — and each secret-bearing
  // part of it, for errors that quote it without the rest: with another path, without the port or
  // scheme, one query value alone, or a short one with its parameter name.
  const whole = values.flatMap((value) => [value, value.replaceAll("/", "\\/")]);
  const pieces = [
    ...values.flatMap(secretParts).filter((part) => part.length >= MIN_PART),
    ...values.flatMap(contextParts),
  ];
  const parts = [
    ...new Set(
      [...whole, ...pieces].flatMap((part) => [part, encodeURIComponent(part)]).filter((part) => part !== ""),
    ),
  ];
  const labels = [...new Set(values.flatMap(subdomainLabels))];
  const patterns = [
    ...parts.map((part) => new RegExp(escapeRegExp(part), "gi")),
    ...labels.map(
      (label) => new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(label)}(?![A-Za-z0-9-])`, "gi"),
    ),
  ];
  const longest = Math.max(0, ...parts.map((part) => part.length));
  // A configured value that is not a URL counts whole; a URL does not, since every one starts with
  // a scheme like `http` that ordinary text ends in too. Each subdomain label counts on its own as
  // well: a cut text may end in the start of one that is not the host's first
  // (`rpc.<key>.provider.io`), and the hostname's rules apply to it.
  const prefixes = [
    ...pieces,
    ...whole.filter((value) => value.length >= MIN_PART && !parsesAsUrl(value)),
    ...labels,
  ].map((part) => part.toLowerCase());
  const hostnames = new Set([
    ...values.flatMap((value) => {
      try {
        const url = new URL(value);
        return [url.host, url.hostname];
      } catch {
        return [];
      }
    }),
    ...labels,
  ]);

  return (text) => {
    // A configured value that straddles the cut is replaced whole: the scan reaches `longest` past
    // it. Matches starting beyond the cut are dropped with the rest, and nothing past the cut is
    // kept, so an earlier replacement shortening the text cannot pull a fragment back in.
    const window = text.slice(0, MAX_INPUT + longest);
    let out = "";
    let pos = 0;
    // The placeholders are written into `out`, never into `window`, so none is scanned again.
    for (const [from, to] of configuredRanges(window, patterns)) {
      out += window.slice(pos, from) + CONFIGURED_PLACEHOLDER;
      pos = to;
    }
    if (pos < MAX_INPUT) {
      const tail = window.slice(pos, MAX_INPUT);
      const cut = cutTailAt(tail, prefixes, hostnames, text.length > MAX_INPUT);
      out += cut === undefined ? tail : `${tail.slice(0, cut)}${CONFIGURED_PLACEHOLDER}`;
    }
    return bounded(out.replace(URL_PATTERN, maskUrl));
  };
}

/**
 * `createRedactor(configured)(text)`, built for this one call. A caller redacting many errors
 * against one configuration builds its redactor once with `createRedactor` instead.
 */
export function redactUrls(text: string, configured: readonly (string | null | undefined)[] = []): string {
  return createRedactor(configured)(text);
}
