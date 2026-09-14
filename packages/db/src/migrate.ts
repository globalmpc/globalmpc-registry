import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { LEGACY_CHECKSUMS, type LegacyChecksum } from "./legacy-checksums.js";

/**
 * Migration runner.
 *
 * Each file runs in one transaction and is recorded in `core.schema_migrations`. Files that
 * were already applied are skipped. Files are applied in ascending file-name order.
 *
 * Skipping **does not look at the name alone.** Comparing names only would let an applied file
 * be edited later without anyone noticing, and schemas would drift per environment. So the
 * checksum is recorded too and compared on every run.
 *
 * The checksum covers what the migration does, not how it is commented: it hashes the SQL with
 * comments removed and whitespace collapsed. Rewording or translating a comment therefore does
 * not stop a database that already applied the file; changing code or a string literal does.
 */

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

/**
 * SQL with comments removed and whitespace runs in code collapsed to one space.
 *
 * Literals are kept verbatim — whitespace and comment markers inside them are data:
 * single-quoted strings (including `E''`), double-quoted identifiers, and dollar-quoted strings.
 *
 * A dollar-quoted string right after `AS` or `DO` is a function or `DO` body, i.e. code: it is
 * normalized recursively, so comments inside it are removed while literals nested in it
 * (including nested dollar-quoted ones) stay verbatim.
 */
export function normalizeMigrationSql(sql: string): string {
  return normalizeCode(sql).trim();
}

function normalizeCode(sql: string): string {
  let out = "";
  // A leading space is kept: a body's inner text starts right after its opening tag, and
  // `normalizeMigrationSql` trims the outermost level.
  const space = () => {
    if (!out.endsWith(" ")) out += " ";
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    const next = sql[i + 1];
    const tag = ch === "$" ? dollarTagAt(sql, i) : null;
    if (tag !== null) {
      const close = sql.indexOf(tag, i + tag.length);
      const innerEnd = close === -1 ? sql.length : close;
      const end = close === -1 ? sql.length : close + tag.length;
      const inner = sql.slice(i + tag.length, innerEnd);
      const closing = close === -1 ? "" : tag;
      out += FUNCTION_BODY_OPENER.test(out) ? `${tag}${normalizeCode(inner)}${closing}` : sql.slice(i, end);
      i = end;
    } else if (ch === "'" || ch === '"') {
      const end = endOfQuoted(sql, i);
      out += sql.slice(i, end);
      i = end;
    } else if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? sql.length : eol;
      space();
    } else if (ch === "/" && next === "*") {
      i = endOfBlockComment(sql, i);
      space();
    } else if (/\s/.test(ch)) {
      space();
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Output so far ends with the keyword that introduces a function or `DO` body. */
const FUNCTION_BODY_OPENER = /(?:^|[^A-Za-z0-9_$])(?:AS|DO) ?$/i;

/** The `$tag$` delimiter starting at `start`, or null. `$1`-style parameters are not tags. */
function dollarTagAt(sql: string, start: number): string | null {
  if (/[A-Za-z0-9_]/.test(sql[start - 1] ?? "")) return null;
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(start, start + 64));
  return match ? match[0] : null;
}

/** Index just past the quoted token that starts at `start`. Unterminated runs to the end. */
function endOfQuoted(sql: string, start: number): number {
  const quote = sql[start];
  const backslashEscapes =
    quote === "'" && /[eE]/.test(sql[start - 1] ?? "") && !/\w/.test(sql[start - 2] ?? "");
  let j = start + 1;
  while (j < sql.length) {
    const ch = sql[j];
    if (backslashEscapes && ch === "\\") {
      j += 2;
    } else if (ch === quote) {
      if (sql[j + 1] === quote) {
        j += 2;
      } else {
        return j + 1;
      }
    } else {
      j += 1;
    }
  }
  return sql.length;
}

/** Index just past the block comment that starts at `start`. PostgreSQL nests block comments. */
function endOfBlockComment(sql: string, start: number): number {
  let depth = 0;
  let j = start;
  while (j < sql.length) {
    if (sql[j] === "/" && sql[j + 1] === "*") {
      depth += 1;
      j += 2;
    } else if (sql[j] === "*" && sql[j + 1] === "/") {
      depth -= 1;
      j += 2;
      if (depth === 0) return j;
    } else {
      j += 1;
    }
  }
  return sql.length;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Checksum of what a migration does. Pins the applied content; ignores comments. */
export function migrationChecksum(sql: string): string {
  return sha256(normalizeMigrationSql(sql));
}

/** Checksum of the whole file text — the scheme used before comments were ignored. */
export function fullTextChecksum(sql: string): string {
  return sha256(sql);
}

export type ChecksumVerdict = "match" | "upgrade" | "mismatch";

/**
 * Compares a recorded checksum with the file on disk.
 *
 * - `match`: recorded with the current scheme and the code is unchanged.
 * - `upgrade`: recorded with the full-text scheme, and the file still does the same thing —
 *   either it is the same text, or it is a known earlier text whose normalized form equals the
 *   current one (only comments changed). The caller rewrites the recorded checksum.
 * - `mismatch`: the migration's code or literals changed after it was applied.
 */
export function judgeChecksum(input: {
  readonly recorded: string;
  readonly sql: string;
  readonly legacy?: LegacyChecksum;
}): ChecksumVerdict {
  const current = migrationChecksum(input.sql);
  if (input.recorded === current) return "match";
  if (input.recorded === fullTextChecksum(input.sql)) return "upgrade";
  const { legacy } = input;
  if (legacy && legacy.full.includes(input.recorded) && legacy.normalized === current) {
    return "upgrade";
  }
  return "mismatch";
}

export const MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

export function listMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      name: file,
      sql: readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"),
    }));
}

export async function runMigrations(
  sql: postgres.Sql,
  migrations: readonly Migration[] = listMigrations(),
): Promise<string[]> {
  await sql.unsafe(`
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE TABLE IF NOT EXISTS core.schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE core.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT;
  `);

  const applied = await sql<{ name: string; checksum: string | null }[]>`
    SELECT name, checksum FROM core.schema_migrations
  `;
  const appliedChecksums = new Map(applied.map((row) => [row.name, row.checksum]));
  const executed: string[] = [];

  for (const migration of migrations) {
    const checksum = migrationChecksum(migration.sql);

    if (appliedChecksums.has(migration.name)) {
      const recorded = appliedChecksums.get(migration.name) ?? null;

      // Applied before the checksum column existed. The text at that time is unknown, so the
      // current one becomes the reference — rejecting here would stop every existing database.
      if (recorded === null) {
        await sql`
          UPDATE core.schema_migrations SET checksum = ${checksum} WHERE name = ${migration.name}
        `;
        continue;
      }

      const legacy = LEGACY_CHECKSUMS[migration.name];
      const verdict = judgeChecksum({
        recorded,
        sql: migration.sql,
        ...(legacy ? { legacy } : {}),
      });
      if (verdict === "mismatch") {
        throw new Error(
          `Migration ${migration.name} checksum differs from when it was applied `
            + `(recorded ${recorded.slice(0, 12)}…, current ${checksum.slice(0, 12)}…). `
            + "Applied migrations are not edited — add a new file.",
        );
      }
      if (verdict === "upgrade") {
        await sql`
          UPDATE core.schema_migrations SET checksum = ${checksum} WHERE name = ${migration.name}
        `;
      }
      continue;
    }

    await sql.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`
        INSERT INTO core.schema_migrations (name, checksum)
        VALUES (${migration.name}, ${checksum})
      `;
    });
    executed.push(migration.name);
  }

  return executed;
}

// The CLI entry point is `cli.ts`. This module can be loaded as CJS (e.g. by the Playwright
// globalSetup), so it does not use `import.meta` beyond `MIGRATIONS_DIR`.
