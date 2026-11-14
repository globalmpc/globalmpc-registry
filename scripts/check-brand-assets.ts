/**
 * Brand asset sync check.
 *
 * The web app serves the mark and multi-size favicon as static files in `public/`. It works
 * without bundler config but **creates copies** — copies silently keep serving old
 * artwork when the original changes.
 *
 * The TopBar copy stays byte-identical to the original. The favicon must match its
 * canonical-artwork generator, including size-specific tile clearance.
 * Redrawing the logo fails this check, and the failure is the signal to update the copies.
 *
 * Artwork is not edited here. The source is design-system and the generator lives in the
 * host repository (`design-system/README.md` "To change the logo").
 */

import { brandIcon } from "./brand-icon.mjs";
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

if (!readFileSync(path.join(DAPP, "apps/web/public/favicon.ico")).equals(await brandIcon())) {
  throw new Error("Favicon differs from the canonical tile: node scripts/sync-brand-icon.mjs");
}
const provenance = JSON.parse(readFileSync(path.join(DAPP, "design-system/SOURCE.json"), "utf8"));
const { createHash } = await import("node:crypto");
for (const [file, expected] of Object.entries(provenance.files)) {
  const actual = createHash("sha256").update(readFileSync(path.join(DAPP, "design-system", file))).digest("hex");
  if (actual !== (expected as { sha256: string }).sha256) throw new Error(`Pinned design source drift: ${file}`);
}
console.log(`Canonical source and generated favicon verified. ${COPIES.length} brand assets match the originals.`);
