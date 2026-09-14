/**
 * Applies the R-04 banned-term lint **to actual on-screen copy** — spec 11 §11.13 / AC-31.
 *
 * `@mpc/ui`'s `lintProhibitedLanguage` used to check only its own constants.
 * In that state the rule exists but is not enforced — CI passes even with a banned term
 * such as "guaranteed gain" on screen. This script closes that gap.
 *
 * **Comments are not checked.** They are invisible to users, and are rather the place to
 * quote banned terms to explain "why not to use them". So comments are stripped and only
 * strings and JSX text are checked.
 *
 * **Negation exceptions.** "does not mean it is automatically approved" contains a banned term
 * but asserts the exact opposite of what the term guards against. They are listed in a
 * per-string allowlist, each with its reason — if the list grows silently, the rule is moot.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { lintProhibitedLanguage } from "@mpc/ui";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.join(HERE, "..");

/** Places holding user-facing text. All UI copy, API messages, and exports. */
const ROOTS = [
  "apps/web/src",
  "apps/api/src",
  "apps/worker/src",
  "packages/ui/src",
  "packages/api-contract/src",
  "packages/domain/src",
];

/** The banned-term list itself is not checked — its definitions would flag as violations. */
const SKIP = ["packages/ui/src/prohibited-language.ts"];

/**
 * Phrases that negate a banned term or quote it to prevent the misreading.
 *
 * Each entry must be visibly confirmed as "this sentence does not make the claim the banned
 * term guards against". If that cannot be confirmed, it is copy to fix, not an exception.
 */
const NEGATIONS: readonly { readonly text: string; readonly why: string }[] = [
  {
    text: "다음 단계가 자동 승인된다는 뜻이 아니다",
    why: "States that readiness ok is not approval — the negation AC-03 requires",
  },
  {
    text: "정부 승인이나 MPC의 보증",
    why: "Boundary copy followed by '…is not' — the negative statement §11.12 requires",
  },
];

/** Strips comments. Tracks state so `//` inside strings is not mistaken for a comment. */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;

  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];

    if (quote) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      out += c;
      i += 1;
      continue;
    }

    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      out += c;
      i += 1;
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }

    out += c;
    i += 1;
  }

  return out;
}

function sources(dir: string): string[] {
  const entries = readdirSync(path.join(DAPP, dir), { withFileTypes: true });
  return entries.flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(rel);
    if (!/\.(ts|tsx)$/.test(entry.name)) return [];
    if (SKIP.includes(rel)) return [];
    return [rel];
  });
}

let violations = 0;

for (const root of ROOTS) {
  for (const file of sources(root)) {
    const text = stripComments(readFileSync(path.join(DAPP, file), "utf8"));
    for (const finding of lintProhibitedLanguage(text)) {
      if (NEGATIONS.some((entry) => finding.context.includes(entry.text))) continue;
      violations += 1;
      console.error(
        `${file}: banned term "${finding.phrase}" — ${finding.reason}\n` +
          `  context: …${finding.context.replace(/\s+/g, " ").trim()}…\n` +
          `  instead: ${finding.replacement}`,
      );
    }
  }
}

if (violations > 0) {
  console.error(`\nR-04 banned terms: ${violations}. Do not deploy until the copy is fixed.`);
  process.exit(1);
}

console.log("No R-04 banned terms.");
