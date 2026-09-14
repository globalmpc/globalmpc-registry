/**
 * Brand asset sync check.
 *
 * The web app serves the logo as static files (`public/`, `src/app/icon.svg`). It works
 * without bundler config but **creates copies** — copies silently keep serving old
 * artwork when the original changes.
 *
 * So this checks the copies are byte-identical to the originals in `@mpc/design/assets/logo`.
 * Redrawing the logo fails this check, and the failure is the signal to update the copies.
 *
 * Artwork is not edited here. The source is design-system and the generator lives in the
 * host repository (`design-system/README.md` "To change the logo").
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.join(HERE, "..");
/** design-system sits under the repository root. */
const ORIGIN = path.join(DAPP, "design-system/assets/logo/svg");

interface Copy {
  readonly origin: string;
  readonly copy: string;
  readonly why: string;
}

const COPIES: readonly Copy[] = [
  {
    origin: "mpc-mark-on-dark.svg",
    copy: "apps/web/public/brand/mpc-mark-on-dark.svg",
    why: "TopBar brand mark",
  },
  {
    origin: "mpc-mark-on-dark.svg",
    copy: "apps/web/src/app/icon.svg",
    why: "favicon (Next app router convention)",
  },
];

const drifted = COPIES.filter((entry) => {
  const origin = readFileSync(path.join(ORIGIN, entry.origin));
  const copy = readFileSync(path.join(DAPP, entry.copy));
  return !origin.equals(copy);
});

if (drifted.length > 0) {
  for (const entry of drifted) {
    console.error(
      `Brand asset differs from the original: ${entry.copy} (${entry.why})\n` +
        `  original: design-system/assets/logo/svg/${entry.origin}\n` +
        `  fix: cp design-system/assets/logo/svg/${entry.origin} ${entry.copy}`,
    );
  }
  process.exit(1);
}

console.log(`${COPIES.length} brand assets match the originals.`);
