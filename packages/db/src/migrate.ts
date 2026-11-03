import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { LEGACY_CHECKSUMS, type LegacyChecksum } from "./legacy-checksums.js";

/**
 * Migration runner.
 *
 * Each file runs in one transaction (unless it opts out, below) and is recorded in
 * `core.schema_migrations`. Files that were already applied are skipped. Files are applied in
 * ascending file-name order.
 *
 * Skipping **does not look at the name alone.** Comparing names only would let an applied file
 * be edited later without anyone noticing, and schemas would drift per environment. So the
 * checksum is recorded too and compared on every run.
 *
 * The checksum covers what the migration does, not how it is commented: it hashes the SQL with
 * comments removed and whitespace collapsed. Rewording a comment therefore does
 * not stop a database that already applied the file; changing code or a string literal does.
 *
 * **Outside a transaction, by opt-in.** A file whose first line is exactly
 * `-- migrate:no-transaction` runs statement by statement with no transaction around it — for
 * `CREATE INDEX CONCURRENTLY`, which PostgreSQL refuses inside one, so building an index on a large
 * live table does not block its writers. Such a file is not atomic: a failure leaves the
 * statements before it applied and the file unrecorded, so the next run executes it again from
 * the top. It must therefore be safe to rerun from any point — for an index, drop it if it
 * exists (a failed concurrent build leaves an INVALID one) and build it again. It is recorded
 * only after its last statement succeeds. A concurrent build also waits for every transaction in
 * the database that is older than it, so a long-running one elsewhere delays the build, not the
 * other way round. The marker is a comment, so it is not part of the checksum.
 *
 * **One runner at a time.** A whole run — creating the bookkeeping table, reading what is applied,
 * and every file — holds one session-level advisory lock on one reserved connection, so two
 * runners started together (two replicas deploying at once) never apply a file twice, never build
 * an index at once or drop each other's, and never race to create `core.schema_migrations`. The
 * one that waited reads what is applied only once it holds the lock, so it skips what the other
 * applied. The lock is per database. A runner of a release before this one took it only around
 * its no-transaction files, under the same key; it still waits for this one there.
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
      const quoted = normalizeDollarQuoted(sql, i, tag, out);
      out += quoted.text;
      i = quoted.end;
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

function normalizeDollarQuoted(sql: string, start: number, tag: string, prefix: string) {
  const close = sql.indexOf(tag, start + tag.length);
  const innerEnd = close === -1 ? sql.length : close;
  const end = close === -1 ? sql.length : close + tag.length;
  const inner = sql.slice(start + tag.length, innerEnd);
  const closing = close === -1 ? "" : tag;
  const text = FUNCTION_BODY_OPENER.test(prefix)
    ? `${tag}${normalizeCode(inner)}${closing}`
    : sql.slice(start, end);
  return { text, end };
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
 * - `upgrade`: the recorded checksum belongs to a known earlier revision of this file, and the
 *   file on disk is exactly the pinned current revision — either the same text under the
 *   full-text scheme, or a reviewed revision listed in `LEGACY_CHECKSUMS`. The caller rewrites
 *   the recorded checksum.
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
  const known = legacy
    ? legacy.full.includes(input.recorded) || (legacy.earlier ?? []).includes(input.recorded)
    : false;
  if (legacy && known && legacy.normalized === current) return "upgrade";
  return "mismatch";
}

/** First line of a migration that runs outside a transaction (see the runner header). */
export const NO_TRANSACTION_MARKER = "-- migrate:no-transaction";

export function runsOutsideTransaction(migration: Migration): boolean {
  return migration.sql.split("\n", 1)[0]?.trim() === NO_TRANSACTION_MARKER;
}

/**
 * The statements of a migration, split at top-level semicolons — not inside quoted text, dollar
 * quotes or comments — each as written. Statements that are only comments are dropped.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] ?? "";
    const next = sql[i + 1];
    const tag = ch === "$" ? dollarTagAt(sql, i) : null;
    if (tag !== null) {
      const close = sql.indexOf(tag, i + tag.length);
      i = close === -1 ? sql.length : close + tag.length;
    } else if (ch === "'" || ch === '"') {
      i = endOfQuoted(sql, i);
    } else if (ch === "-" && next === "-") {
      const eol = sql.indexOf("\n", i);
      i = eol === -1 ? sql.length : eol;
    } else if (ch === "/" && next === "*") {
      i = endOfBlockComment(sql, i);
    } else if (ch === ";") {
      statements.push(sql.slice(start, i + 1));
      i += 1;
      start = i;
    } else {
      i += 1;
    }
  }
  statements.push(sql.slice(start));
  return statements.map((statement) => statement.trim()).filter((statement) => normalizeMigrationSql(statement) !== "");
}

/**
 * Serializes runs (see the header). An arbitrary constant: the name of the lock, not data. Kept
 * from when it guarded only no-transaction files, so a runner of that release and this one still
 * exclude each other there.
 */
const MIGRATION_LOCK = 7_104_000_001;
const MIGRATION_LOCK_POLL_MS = 250;

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
  // Everything on one reserved connection: the lock is held by a session, a no-transaction file's
  // statements must each reach the server on their own, and a one-connection pool (the CLI's, the
  // tests') is not starved by the reservation.
  const session = new RunSession(await sql.reserve());
  try {
    // Polled, not `pg_advisory_lock`: a runner blocked in that statement holds a snapshot, and a
    // concurrent index build in the runner holding the lock waits for every older snapshot in the
    // database — including the blocked runner's, which waits for the lock. Between tries this
    // session holds none.
    while (true) {
      const [lock] = await session.sql<{ locked: boolean }[]>`
        SELECT pg_try_advisory_lock(${MIGRATION_LOCK}) AS locked
      `;
      if (lock?.locked) break;
      await new Promise((resolve) => setTimeout(resolve, MIGRATION_LOCK_POLL_MS));
    }
    try {
      return await applyMigrations(session, migrations);
    } catch (error) {
      session.saw(error); // before the unlock below, which must not be sent on a dead connection
      throw error;
    } finally {
      await session.unlock();
    }
  } catch (error) {
    session.saw(error);
    throw error;
  } finally {
    session.release();
  }
}

/**
 * The run's reserved connection, and whether it is known to be dead.
 *
 * Cleanup — ROLLBACK, the unlock — never replaces the error that ended the run: its own failure is
 * swallowed. And once any statement failed because the connection is gone, nothing more is sent:
 * postgres.js never settles a query sent on a reserved connection after it closed, and `release`
 * would put the closed connection among the open ones. Left alone, the pool reconnects it on its
 * next use; the session's lock ended with the session.
 */
class RunSession {
  private lost = false;

  constructor(readonly sql: postgres.ReservedSql) {}

  /** Notes an error; true when it says the connection is gone. */
  saw(error: unknown): boolean {
    if (connectionLost(error)) this.lost = true;
    return this.lost;
  }

  /** Sends `statement` unless the connection is dead; true if it succeeded. Never throws. */
  async quietly(statement: () => Promise<unknown>): Promise<boolean> {
    if (this.lost) return false;
    try {
      await statement();
      return true;
    } catch (error) {
      this.saw(error);
      return false;
    }
  }

  /**
   * Releases the run's lock. A live session that refuses it is in a failed transaction — a
   * no-transaction file that opened one — so that is ended and the unlock tried once more. If that
   * fails too on a live connection, it goes back to the pool still holding the lock (postgres.js
   * cannot close one reserved connection), which holds off other runners until the pool ends; a
   * later run from the same pool takes it again.
   */
  async unlock(): Promise<void> {
    const unlock = () => this.sql`SELECT pg_advisory_unlock(${MIGRATION_LOCK})`;
    if (await this.quietly(unlock)) return;
    await this.quietly(() => this.sql.unsafe("ROLLBACK"));
    await this.quietly(unlock);
  }

  release(): void {
    if (!this.lost) this.sql.release();
  }
}

/**
 * The error says the connection is gone: the server ended the session (FATAL, e.g. it was
 * terminated) or postgres.js lost the socket (`CONNECTION_CLOSED`, `ECONNRESET`, …).
 */
function connectionLost(error: unknown): boolean {
  const { severity, code } = (error ?? {}) as { severity?: string; code?: string };
  if (severity === "FATAL" || severity === "PANIC") return true;
  return typeof code === "string" && (code.startsWith("CONNECTION_") || /^E[A-Z]+$/.test(code));
}

async function record(session: postgres.ReservedSql, name: string, checksum: string): Promise<void> {
  await session`
    INSERT INTO core.schema_migrations (name, checksum)
    VALUES (${name}, ${checksum})
  `;
}

/** The run itself, under the lock `runMigrations` holds on `session`. */
async function applyMigrations(
  run: RunSession,
  migrations: readonly Migration[],
): Promise<string[]> {
  const session = run.sql;
  await session.unsafe(`
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE TABLE IF NOT EXISTS core.schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE core.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT;
  `);

  const applied = await session<{ name: string; checksum: string | null }[]>`
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
        await session`
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
        await session`
          UPDATE core.schema_migrations SET checksum = ${checksum} WHERE name = ${migration.name}
        `;
      }
      continue;
    }

    if (runsOutsideTransaction(migration)) {
      // Not atomic (see the header): recorded only after its last statement succeeds.
      for (const statement of splitStatements(migration.sql)) {
        await session.unsafe(statement);
      }
      await record(session, migration.name, checksum);
    } else {
      // A reserved connection has no `begin`; the transaction is spelled out on it instead.
      await session.unsafe("BEGIN");
      try {
        await session.unsafe(migration.sql);
        await record(session, migration.name, checksum);
        await session.unsafe("COMMIT");
      } catch (error) {
        // Ends the failed transaction; after a failed COMMIT there is none, and this only warns.
        run.saw(error);
        await run.quietly(() => session.unsafe("ROLLBACK"));
        throw error;
      }
    }
    executed.push(migration.name);
  }

  return executed;
}

// The CLI entry point is `cli.ts`. This module can be loaded as CJS (e.g. by the Playwright
// globalSetup), so it does not use `import.meta` beyond `MIGRATIONS_DIR`.
