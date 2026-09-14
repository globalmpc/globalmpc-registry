/**
 * README test count drift check.
 *
 * `README.md` lists test counts per package/app and a total. These counts drifted
 * twice — commits that added tests did not update README. Two recurrences showed
 * human discipline does not prevent it, so it is fixed as a check.
 *
 * How each is counted, and why:
 *
 * - **vitest**: `vitest list --json`. Without `DATABASE_URL`, DB-dependent tests drop
 *   out at collect time and the count comes out low. So this script requires
 *   it — the CI `verify` job already sets it.
 * - **Playwright**: `playwright test --list`. No browser install needed (it only reads
 *   specs).
 * - **Foundry**: counts `test*`/`invariant*` functions in `.t.sol`. `forge test` is not
 *   invoked because the CI job running this check has no foundry.
 *   Agreement with the actual run is checked separately by the `contracts` job.
 * - **route**: length of the `ROUTES` contract. It must equal the operation count in
 *   `openapi.json`, but `check:openapi` already compares that.
 *
 * `--write` rewrites README with the measured values. CI runs without arguments so drift
 * fails — the same shape as `check:openapi`.
 *
 * **The measured date moves only when counts change.** Stamping today every time fails even
 * on days the counts match, and that failure misstates its own reason (see `recordedDate`).
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { ROUTES } from "@mpc/api-contract";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAPP = path.join(HERE, "..");
const README = path.join(DAPP, "README.md");

const WRITE = process.argv.includes("--write");

/** One README table row. `label` is the path in the first cell, `count` the number in the last. */
interface Row {
  readonly label: string;
  readonly count: number;
}

function run(command: string, args: readonly string[], cwd: string): string {
  return execFileSync(command, [...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** Test count per vitest project. Cannot be counted without `DATABASE_URL`. */
function vitestCounts(): ReadonlyMap<string, number> {
  if (!process.env.DATABASE_URL) {
    console.error(
      "DATABASE_URL is not set. Without it, DB-dependent tests drop out at collect and the count comes out low.\n" +
        '  DATABASE_URL="postgres://postgres@localhost:5432/mpc_test" pnpm check:counts',
    );
    process.exit(2);
  }
  const listed: readonly { readonly projectName: string }[] = JSON.parse(
    run("pnpm", ["exec", "vitest", "list", "--json"], DAPP),
  );
  return listed.reduce((acc, entry) => {
    const next = new Map(acc);
    next.set(entry.projectName, (acc.get(entry.projectName) ?? 0) + 1);
    return next;
  }, new Map<string, number>());
}

/** Playwright spec count. `--list` runs without a browser. */
function playwrightCount(): number {
  const out = run("pnpm", ["exec", "playwright", "test", "--list"], path.join(DAPP, "apps/web"));
  const matched = /Total:\s+(\d+)\s+tests?/.exec(out);
  if (!matched) throw new Error(`Could not find the total in playwright --list output:\n${out}`);
  return Number(matched[1]);
}

/** Number of test/invariant functions in `.t.sol`. Counted without forge. */
function foundryCount(): number {
  const dir = path.join(DAPP, "contracts/test");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".t.sol"))
    .flatMap((name) => readFileSync(path.join(dir, name), "utf8").match(/^\s+function (?:test|invariant)[A-Za-z0-9_]*\(/gm) ?? [])
    .length;
}

const vitest = vitestCounts();
const counts = {
  vitestTotal: [...vitest.values()].reduce((sum, n) => sum + n, 0),
  playwright: playwrightCount(),
  foundry: foundryCount(),
  routes: ROUTES.length,
};

/**
 * README table rows that are counted.
 *
 * `apps/web` is left out. Its cell holds **both** unit tests and E2E, so it cannot be a
 * single number like the other rows — it is written separately below. At first web had no
 * vitest project at all; adding one later made this distinction necessary.
 */
const ROWS: readonly Row[] = [
  ...[...vitest.entries()]
    // web's project name is `web`, not `@mpc/web` (its own vitest.config).
    .filter(([project]) => project !== "web")
    .map(([project, count]) => ({
      label: project.replace("@mpc/", ""),
      count,
    })),
];

/** web unit tests. 0 when there is no project, in which case only E2E is written. */
const webUnitCount = vitest.get("web") ?? 0;

/** `@mpc/api` → `apps/api`, `@mpc/canonical` → `packages/canonical`. */
const APPS = new Set(["api", "web", "worker"]);
const pathFor = (label: string): string => `${APPS.has(label) ? "apps" : "packages"}/${label}`;

const original = readFileSync(README, "utf8");
const today = new Date().toISOString().slice(0, 10);

/** Replaces only the table's last cell (test count). The description cell is untouched. */
function withRowCount(text: string, cell: string, count: number, prefix = ""): string {
  const pattern = new RegExp(`(^\\| \`${cell.replace("/", "\\/")}\` \\|[^|]*\\| )${prefix}\\d+( \\|$)`, "m");
  if (!pattern.test(text)) throw new Error(`Could not find the \`${cell}\` row in README`);
  return text.replace(pattern, `$1${prefix}${count}$2`);
}

/** Substitutions that change only numbers. The summary line's **date is untouched.** */
const numericFixes = [
  ...ROWS.map((row) => (text: string) => withRowCount(text, pathFor(row.label), row.count)),
  // The web cell is `unit N · E2E M` or `E2E M`. Its shape differs from other rows, so
  // the whole cell is replaced.
  (text: string) => {
    const cell = webUnitCount > 0 ? `unit ${webUnitCount} · E2E ${counts.playwright}` : `E2E ${counts.playwright}`;
    const pattern = /(^\| `apps\/web` \|[^|]*\| )(?:unit \d+ · )?E2E \d+( \|$)/m;
    if (!pattern.test(text)) throw new Error("Could not find the `apps/web` row in README");
    return text.replace(pattern, `$1${cell}$2`);
  },
  (text: string) => text.replace(/(\| `apps\/api` \|[^|]*?)\d+ routes/, `$1${counts.routes} routes`),
  /**
   * Route counts outside the table — 2026-09-10 audit.
   *
   * The substitution above only matches the `| \`apps/api\` |` row. So "59 routes" in the
   * prose of §"What does not exist yet" stayed after routes reached 79, and the gate stayed
   * green. **A gate that checks one place does not vouch for the rest.**
   */
  (text: string) =>
    text.replace(/\d+ routes in the contract \(`ROUTES`\)/g, `${counts.routes} routes in the contract (\`ROUTES\`)`),
  (text: string) => text.replace(/\d+ Foundry tests/, `${counts.foundry} Foundry tests`),
];

const SUMMARY = /^Total: vitest \d+ \+ Playwright \d+ \+ Foundry \d+(?: \+ route \d+)?\. \(measured (\d{4}-\d{2}-\d{2})\)$/m;

/** Replaces the summary line with measured values. The caller decides the date. */
const withSummary =
  (date: string) =>
  (text: string): string =>
    text.replace(
      SUMMARY,
      `Total: vitest ${counts.vitestTotal} + Playwright ${counts.playwright} + Foundry ${counts.foundry} + route ${counts.routes}. (measured ${date})`,
    );

/**
 * The measured date recorded in README.
 *
 * **Never unconditionally re-stamp the date as today.** Doing so makes `updated !== original`
 * even on days every count matches, and CI fails with "counts differ from measured".
 * Since the stated reason is false, people reflexively run `--write`, and then
 * this gate becomes a ritual to pass rather than a drift detector.
 *
 * The date moves **only when counts actually change** — that is when it was re-measured.
 */
const recordedDate = SUMMARY.exec(original)?.[1] ?? today;

/** Counts fixed with the date left as is. Equal to original means no drift. */
const withRecordedDate = [...numericFixes, withSummary(recordedDate)].reduce(
  (text, apply) => apply(text),
  original,
);

const updated = [...numericFixes, withSummary(today)].reduce((text, apply) => apply(text), original);

if (withRecordedDate === original) {
  console.log(
    `README counts match — vitest ${counts.vitestTotal} · Playwright ${counts.playwright} · Foundry ${counts.foundry} · route ${counts.routes}`,
  );
  process.exit(0);
}

if (WRITE) {
  writeFileSync(README, updated);
  console.log(`Updated README with measured values (${today}).`);
  process.exit(0);
}

console.error("README test counts differ from measured values.\n");
const originalLines = original.split("\n");
updated.split("\n").forEach((line, index) => {
  if (line !== originalLines[index]) {
    console.error(`  ${README}:${index + 1}`);
    console.error(`  - ${originalLines[index]}`);
    console.error(`  + ${line}\n`);
  }
});
console.error("To fix: pnpm check:counts --write");
process.exit(1);
