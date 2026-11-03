import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import {
  migrationChecksum,
  runMigrations,
  runsOutsideTransaction,
  splitStatements,
  type Migration,
} from "../src/migrate.js";

/**
 * `-- migrate:no-transaction` — a migration run statement by statement, outside a transaction, so
 * it can build an index concurrently.
 *
 * Such a file is not atomic, so what matters is what happens around a failure: the file stays
 * unrecorded, runs again from the top, and a rerun-safe file (drop, then build) recovers from the
 * INVALID index a failed concurrent build leaves. Runners at the same time must not both run it.
 */
describe("no-transaction migrations, without a database", () => {
  it("are marked by their first line only", () => {
    const of = (sql: string): Migration => ({ name: "x.sql", sql });
    expect(runsOutsideTransaction(of("-- migrate:no-transaction\nCREATE INDEX CONCURRENTLY i ON t (c);"))).toBe(true);
    expect(runsOutsideTransaction(of("-- migrate:no-transaction  \r\nSELECT 1;"))).toBe(true);
    expect(runsOutsideTransaction(of("-- header\n-- migrate:no-transaction\nSELECT 1;"))).toBe(false);
    expect(runsOutsideTransaction(of("CREATE TABLE t (c INT);"))).toBe(false);
  });

  it("split at top-level semicolons only, dropping comment-only pieces", () => {
    const sql = [
      "-- migrate:no-transaction",
      "-- a comment; with a semicolon",
      "CREATE INDEX CONCURRENTLY a ON t (c) WHERE s = 'x;y';",
      "/* block; comment */",
      'CREATE INDEX CONCURRENTLY "b;c" ON t (c);',
      "CREATE FUNCTION f() RETURNS INT LANGUAGE sql AS $$ SELECT 1; $$;",
      "-- trailing comment",
    ].join("\n");
    expect(splitStatements(sql)).toEqual([
      "-- migrate:no-transaction\n-- a comment; with a semicolon\nCREATE INDEX CONCURRENTLY a ON t (c) WHERE s = 'x;y';",
      '/* block; comment */\nCREATE INDEX CONCURRENTLY "b;c" ON t (c);',
      "CREATE FUNCTION f() RETURNS INT LANGUAGE sql AS $$ SELECT 1; $$;",
    ]);
  });

  it("keep the checksum of the same statements without the marker", () => {
    // The marker is a comment: it says how the file runs, not what it does.
    expect(migrationChecksum("-- migrate:no-transaction\nSELECT 1;")).toBe(migrationChecksum("SELECT 1;"));
  });
});

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("no-transaction migrations", () => {
  const dbName = `mnotx_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let url: string;
  let sql: postgres.Sql;
  const table: Migration = {
    name: "0001_table.sql",
    sql: "CREATE TABLE probe (v INT NOT NULL);",
  };
  const unique = (sql: string): Migration => ({
    name: "0002_unique_index.sql",
    sql: `-- migrate:no-transaction\n${sql}`,
  });
  const rerunSafe = unique(
    "DROP INDEX CONCURRENTLY IF EXISTS probe_v_idx;\nCREATE UNIQUE INDEX CONCURRENTLY probe_v_idx ON probe (v);",
  );
  const recorded = async () =>
    (await sql<{ name: string }[]>`SELECT name FROM core.schema_migrations ORDER BY name`).map((row) => row.name);
  const index = async () => {
    const [row] = await sql<{ valid: boolean }[]>`
      SELECT i.indisvalid AS valid FROM pg_index i
      WHERE i.indexrelid = to_regclass('public.probe_v_idx')
    `;
    return row ?? null;
  };

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const parsed = new URL(DATABASE_URL!);
    parsed.pathname = `/${dbName}`;
    url = parsed.toString();
    // One connection, as the CLI and the tests use: the reserved session must not starve the rest.
    sql = postgres(url, { onnotice: () => {}, max: 1 });
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql.unsafe("DROP TABLE IF EXISTS probe; DROP SCHEMA IF EXISTS core CASCADE;");
  });

  it("runs a concurrent index build and records it after its last statement", async () => {
    expect(await runMigrations(sql, [table, rerunSafe])).toEqual([table.name, rerunSafe.name]);
    expect(await index()).toEqual({ valid: true });
    expect(await recorded()).toEqual([table.name, rerunSafe.name]);
    // Applied: skipped, like any other.
    expect(await runMigrations(sql, [table, rerunSafe])).toEqual([]);
  });

  it("stays unrecorded when a build fails, and recovers from the INVALID index it leaves", async () => {
    await runMigrations(sql, [table]);
    await sql`INSERT INTO probe (v) VALUES (1), (1)`;
    await expect(runMigrations(sql, [table, rerunSafe])).rejects.toThrow(/could not create unique index/);
    expect(await recorded()).toEqual([table.name]);
    expect(await index()).toEqual({ valid: false });

    // An `IF NOT EXISTS` build would now skip the invalid index; dropping it first rebuilds it.
    await sql`DELETE FROM probe`;
    expect(await runMigrations(sql, [table, rerunSafe])).toEqual([rerunSafe.name]);
    expect(await index()).toEqual({ valid: true });
    expect(await recorded()).toEqual([table.name, rerunSafe.name]);
  });

  it("is run by one of two runners started together; the other finds it applied", async () => {
    await runMigrations(sql, [table]);
    const slow = unique(
      "SELECT pg_sleep(0.5);\nDROP INDEX CONCURRENTLY IF EXISTS probe_v_idx;\nCREATE UNIQUE INDEX CONCURRENTLY probe_v_idx ON probe (v);",
    );
    const runners = [0, 1].map(() => postgres(url, { onnotice: () => {}, max: 1 }));
    try {
      const results = await Promise.all(runners.map((runner) => runMigrations(runner, [table, slow])));
      expect(results.flat()).toEqual([slow.name]);
      expect(await index()).toEqual({ valid: true });
      expect(await recorded()).toEqual([table.name, slow.name]);
      // The lock is released: a later runner is not held up.
      const [held] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `;
      expect(held!.n).toBe(0);
    } finally {
      await Promise.all(runners.map((runner) => runner.end()));
    }
  });

  it("serializes whole runs: two runners started together on transactional files apply each once", async () => {
    // Neither file runs outside a transaction. Each runner reads what is applied only once it holds
    // the run's lock, so the second finds both applied instead of running them again (and failing on
    // the table that exists, or on creating `core.schema_migrations` at the same moment).
    const slowTable: Migration = { name: "0001_table.sql", sql: "SELECT pg_sleep(0.3); CREATE TABLE probe (v INT NOT NULL);" };
    const column: Migration = { name: "0002_column.sql", sql: "ALTER TABLE probe ADD COLUMN w INT;" };
    const runners = [0, 1].map(() => postgres(url, { onnotice: () => {}, max: 1 }));
    try {
      const results = await Promise.allSettled(runners.map((runner) => runMigrations(runner, [slowTable, column])));
      expect(results.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
      expect(results.flatMap((result) => (result.status === "fulfilled" ? result.value : [])).sort()).toEqual([
        slowTable.name,
        column.name,
      ]);
      expect(await recorded()).toEqual([slowTable.name, column.name]);
      const [held] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_locks
        WHERE locktype = 'advisory' AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
      `;
      expect(held!.n).toBe(0);
    } finally {
      await Promise.all(runners.map((runner) => runner.end()));
    }
  });

  it("releases the run's lock when a migration fails", async () => {
    const broken: Migration = { name: "0001_broken.sql", sql: "CREATE TABLE probe (v INT NOT NULL); SELECT 1/0;" };
    await expect(runMigrations(sql, [broken])).rejects.toThrow(/division by zero/);
    // Rolled back with its file: nothing recorded, no table.
    expect(await recorded()).toEqual([]);
    expect((await sql`SELECT to_regclass('public.probe') AS t`)[0]!["t"]).toBeNull();
    expect(await runMigrations(sql, [table])).toEqual([table.name]);
  });

  it("refuses a file another runner applied with a different checksum", async () => {
    await runMigrations(sql, [table, rerunSafe]);
    const edited = unique("CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS probe_v_idx ON probe (v);");
    await expect(runMigrations(sql, [table, edited])).rejects.toThrow(/checksum differs/);
  });
});
