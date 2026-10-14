import { execFileSync } from "node:child_process";
import { listMigrations, type Migration } from "./migrate.js";
import { checkMigrationRollback } from "./rollback-check.js";

/**
 * Migration and rollback check against the previous release — 13 §13.9 item 2.
 *
 *   DATABASE_URL=postgres://… MIGRATION_BASE_REF=<commit> pnpm --filter @mpc/db rollback-check
 *
 * `MIGRATION_BASE_REF` is the release being replaced: in CI, the pull request's base commit, or
 * the previous head of `main` on push. Its migration files are read from git, not from the
 * working tree, so the check sees exactly what that release applied.
 *
 * `DATABASE_URL` must be a role that can create databases. Two temporary databases are created
 * and dropped; nothing else on the server is touched.
 */

const url = process.env["DATABASE_URL"];
const baseRef = process.env["MIGRATION_BASE_REF"];

if (!url || !baseRef) {
  process.stderr.write("DATABASE_URL and MIGRATION_BASE_REF are required\n");
  process.exit(1);
}

const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" });

function migrationsAt(ref: string): Migration[] {
  const root = git("rev-parse", "--show-toplevel").trim();
  const dir = "packages/db/migrations";
  return git("-C", root, "ls-tree", "--name-only", `${ref}:${dir}`)
    .split("\n")
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, sql: git("-C", root, "show", `${ref}:${dir}/${name}`) }));
}

try {
  const previous = migrationsAt(baseRef);
  const result = await checkMigrationRollback({ adminUrl: url, previous, current: listMigrations() });
  process.stdout.write(
    [
      `Previous release (${baseRef.slice(0, 12)}): ${result.previous.length} migrations`,
      `Forward on a populated copy: ${result.forward.length === 0 ? "nothing new" : result.forward.join(", ")}`,
      "Restored copy holds exactly the previous release's migrations and rows",
      `Roll forward again after rollback: ${result.reapplied.length === 0 ? "nothing new" : result.reapplied.join(", ")}`,
      "",
    ].join("\n"),
  );
} catch (error) {
  process.stderr.write(`Migration rollback check failed: ${(error as Error).message}\n`);
  process.exit(1);
}
