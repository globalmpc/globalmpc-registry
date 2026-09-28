/**
 * Public release hygiene over every tracked file — rules in `packages/config/src/public-hygiene.ts`.
 *
 * The same scan runs inside the `@mpc/config` tests, so CI enforces it without a separate step.
 * This script is for running it on its own, with private names supplied at run time:
 *
 *   PUBLIC_HYGIENE_EXTRA_PATTERNS="$(cat ~/private-name-patterns.txt)" pnpm check:public
 *
 * Output names the file, line, and rule only — never the matched text.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { isScannedPath, parseExtraPatterns, scanFile } from "../packages/config/src/public-hygiene.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const extra = parseExtraPatterns(process.env["PUBLIC_HYGIENE_EXTRA_PATTERNS"]);
const files = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" })
  .split("\0")
  .filter((file) => file !== "" && isScannedPath(file));
const violations = files.flatMap((file) => scanFile(file, readFileSync(path.join(ROOT, file)), extra));

if (violations.length > 0) {
  console.error("Text that must not be published was found:\n");
  for (const violation of violations) console.error(`  ${violation.file}:${violation.line}  ${violation.rule}`);
  process.exit(1);
}

console.log(`No public hygiene violations — ${files.length} files, ${extra.length} extra patterns`);
