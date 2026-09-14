/**
 * No variable substitution in Compose volume paths — 2026-09-11.
 *
 * Coolify rejects `${` in a volume source for security and **halts the whole deploy**:
 *
 *   Deployment failed: Invalid Docker volume definition: Invalid volume source:
 *   contains forbidden character '${' (variable substitution with potential
 *   command injection).
 *
 * Local `docker compose` accepts the substitution, so local checks, CI, and E2E all stay
 * green while only the deploy fails. That happened (2026-09-10 A4 fix → 2026-09-11 deploy
 * failure). It is a constraint people cannot reliably remember, so it is a gate.
 *
 * No YAML parser — indentation is used to see only services' `volumes:` blocks. This
 * repository's compose files use only short syntax (`- source:target`) and long syntax (`source:`).
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DAPP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
/**
 * The default targets are all compose files this repository has.
 *
 * Per-environment compose files may be absent depending on the repository. If a default file
 * is missing, it **prints that it was skipped** and moves on — dropping it silently creates a
 * state where the check seems to run but looks at nothing. A file named as an argument that
 * does not exist is an error. That is a typo, not a configuration difference.
 */
const DEFAULT_FILES = ["docker-compose.yml"];
const requested = process.argv.slice(2);
const FILES = (requested.length > 0 ? requested : DEFAULT_FILES).filter((file) => {
  if (existsSync(path.isAbsolute(file) ? file : path.join(DAPP, file))) return true;
  if (requested.length > 0) {
    console.error(`Check target does not exist: ${file}`);
    process.exit(1);
  }
  console.log(`Skipping, not found: ${file}`);
  return false;
});

if (FILES.length === 0) {
  console.error("No compose files to check.");
  process.exit(1);
}

interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/**
 * Strings Coolify rejects in a volume source — `validateShellSafePath`
 * (coollabsio/coolify `bootstrap/helpers/shared.php`). Not just `${`. The list is copied
 * verbatim so the next rejection does not surface at deploy time again.
 * Newline and CR are omitted since they cannot occur within one line.
 */
const FORBIDDEN: readonly string[] = ["`", "$(", "${", "|", "&", ";", "\t", ">", "<"];

const indentOf = (line: string): number => line.length - line.trimStart().length;

export function findVolumeSubstitutions(file: string, text: string): Violation[] {
  const violations: Violation[] = [];
  let volumesIndent: number | null = null;

  text.split("\n").forEach((raw, index) => {
    const line = raw.replace(/\s+#.*$/, "");
    if (line.trim() === "" || line.trim().startsWith("#")) return;

    const indent = indentOf(line);

    // Only `volumes:` under a service. Top-level `volumes:` (named volume declarations) has no paths.
    if (/^\s+volumes:\s*$/.test(line)) {
      volumesIndent = indent;
      return;
    }
    if (volumesIndent !== null && indent <= volumesIndent) volumesIndent = null;
    if (volumesIndent === null) return;

    const trimmed = line.trim();
    // Short syntax (`- source:target:mode`) checks the whole item. With `${A:-b}` the
    // substitution contains `:`, so cutting out just the source is hard, and target/mode have no reason to contain these characters.
    const item = trimmed.startsWith("-") ? trimmed.replace(/^-\s*/, "") : "";
    const longSource = /^source:\s*(.+)$/.exec(trimmed)?.[1] ?? "";
    const candidate = item || longSource;
    const found = FORBIDDEN.find((token) => candidate.includes(token));
    if (found) {
      violations.push({ file, line: index + 1, text: `${JSON.stringify(found)} · ${raw.trim()}` });
    }
  });

  return violations;
}

const all = FILES.flatMap((file) =>
  findVolumeSubstitutions(file, readFileSync(path.isAbsolute(file) ? file : path.join(DAPP, file), "utf8")),
);

if (all.length > 0) {
  console.error("Volume paths contain Coolify-forbidden characters. The deploy will be rejected:\n");
  for (const violation of all) console.error(`  ${violation.file}:${violation.line}  ${violation.text}`);
  console.error(
    "\nKeep only fixed paths in volumes. If a file must be chosen, choose it via an env var in a start script" +
      " (e.g. pick the file in the container entrypoint).",
  );
  process.exit(1);
}

console.log(`No Coolify-forbidden characters in volume paths — ${FILES.join(" · ")}`);
