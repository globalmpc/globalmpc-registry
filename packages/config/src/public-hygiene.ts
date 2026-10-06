/**
 * Public release hygiene — what must not reach the open-source tree.
 *
 * This repository is published as is. The rules below catch text that only makes sense inside
 * the organization: internal tracker ids, internal audit finding labels, workstation paths,
 * personal addresses, and non-English prose. Documented notation (`OD-nn`, `AC-nn`, `D-nn`,
 * `spec NN §N.N`, see `docs/spec-sections.md`) is public on purpose and is not flagged.
 *
 * **Private names are never listed here.** Writing a hostname or account into this file would
 * publish the very thing the rule protects. Those come in at run time through
 * `PUBLIC_HYGIENE_EXTRA_PATTERNS` (one regular expression per line).
 *
 * A violation carries the file, line, and rule — **never the matched text**, so a CI log does
 * not republish what it caught.
 *
 * Not exported from the package index: this is a repository check, not runtime configuration.
 */

export type PublicHygieneRule =
  | "non-english-text"
  | "internal-tracker-id"
  | "internal-audit-label"
  | "workstation-path"
  | "email-address"
  | "extra-pattern";

export interface PublicHygieneViolation {
  readonly file: string;
  /** 1-based. 0 means the file path itself. */
  readonly line: number;
  readonly rule: PublicHygieneRule;
}

/** Hangul (syllables, jamo, compatibility jamo), CJK ideographs, and kana. */
const NON_ENGLISH_SCRIPT =
  /[\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7FF\uFF65-\uFFDC]/u;

const BUILT_IN_RULES: readonly { readonly rule: PublicHygieneRule; readonly pattern: RegExp }[] = [
  { rule: "non-english-text", pattern: NON_ENGLISH_SCRIPT },
  // Internal work-tracker ids. Their documents are not published, so the id explains nothing.
  { rule: "internal-tracker-id", pattern: /\b[WQ]-\d{2,4}\b/ },
  // Internal audit finding labels: a dated audit, an audit finding number, or a bare finding number in parentheses.
  { rule: "internal-audit-label", pattern: /\b\d{4}-\d{2}-\d{2} audit\b|\baudit A\d\b|\(A\d(?:\s*[·,/]\s*A\d)*\)/ },
  { rule: "workstation-path", pattern: /\/(?:Users|home)\/[^/\s"'`]+\/|\b[A-Za-z]:\\Users\\/ },
];

const EMAIL = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

/** Domains reserved for documentation and tests (RFC 2606, RFC 6761). */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|example|test|invalid|localhost)$/i;

/** `logo@2x.png` is an asset scale suffix, not an address. */
const SCALE_SUFFIX = /^\d+x\.[a-z]+$/i;

function hasEmailAddress(line: string): boolean {
  // Most lines have no `@`; skipping them keeps the regex off long generated lines.
  if (!line.includes("@")) return false;
  return [...line.matchAll(EMAIL)].some(([, domain = ""]) => !RESERVED_DOMAIN.test(domain) && !SCALE_SUFFIX.test(domain));
}

function rulesForLine(line: string, extra: readonly RegExp[]): readonly PublicHygieneRule[] {
  const builtIn = BUILT_IN_RULES.filter(({ pattern }) => pattern.test(line)).map(({ rule }) => rule);
  const email: readonly PublicHygieneRule[] = hasEmailAddress(line) ? ["email-address"] : [];
  const custom: readonly PublicHygieneRule[] = extra.some((pattern) => pattern.test(line)) ? ["extra-pattern"] : [];
  return [...builtIn, ...email, ...custom];
}

function findPathViolations(file: string, extra: readonly RegExp[]): readonly PublicHygieneViolation[] {
  return rulesForLine(file, extra).map((rule) => ({ file, line: 0, rule }));
}

/** Violations in one file's text. The path is checked as well as the contents. */
export function findPublicHygieneViolations(
  file: string,
  text: string,
  extra: readonly RegExp[],
): readonly PublicHygieneViolation[] {
  const inPath = findPathViolations(file, extra);
  const inText = text
    .split(/\r?\n/)
    .flatMap((line, index) => rulesForLine(line, extra).map((rule) => ({ file, line: index + 1, rule })));
  return [...inPath, ...inText];
}

/**
 * Rules waived for specific files, each with its reason. Keep this short — a growing list
 * means the rule no longer holds.
 */
const ALLOWANCES: readonly { readonly file: RegExp; readonly rule: PublicHygieneRule; readonly reason: string }[] = [
  {
    file: /^packages\/canonical\/(?:test\/(?:jcs\.test\.ts|vectors\.json)|scripts\/generate-vectors\.ts)$/,
    rule: "non-english-text",
    reason:
      "Non-ASCII inputs are serialization test data. Changing them changes the golden vectors that pin anchored roots.",
  },
];

const isAllowed = (violation: PublicHygieneViolation): boolean =>
  ALLOWANCES.some(({ file, rule }) => rule === violation.rule && file.test(violation.file));

/**
 * Violations in one tracked file, given its bytes. Content that is not valid UTF-8 (images,
 * fonts) is not text: only its path is checked.
 */
export function scanFile(
  file: string,
  bytes: Uint8Array,
  extra: readonly RegExp[],
): readonly PublicHygieneViolation[] {
  const text = decodeUtf8(bytes);
  const violations = text === null ? findPathViolations(file, extra) : findPublicHygieneViolations(file, text, extra);
  return violations.filter((violation) => !isAllowed(violation));
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Vendored code and generated lockfiles are not ours to reword. */
export function isScannedPath(file: string): boolean {
  return !file.startsWith("contracts/lib/") && file !== "pnpm-lock.yaml";
}

/**
 * Parses `PUBLIC_HYGIENE_EXTRA_PATTERNS`: one case-insensitive regular expression per line,
 * blank lines and `#` comments ignored. An invalid pattern fails by line number only.
 */
export function parseExtraPatterns(value: string | undefined): readonly RegExp[] {
  return (value ?? "")
    .split(/\r?\n/)
    .map((line, index) => ({ source: line.trim(), line: index + 1 }))
    .filter(({ source }) => source !== "" && !source.startsWith("#"))
    .map(({ source, line }) => {
      try {
        return new RegExp(source, "i");
      } catch {
        throw new Error(`PUBLIC_HYGIENE_EXTRA_PATTERNS line ${line} is not a valid regular expression`);
      }
    });
}
