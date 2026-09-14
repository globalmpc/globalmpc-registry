import { describe, expect, it } from "vitest";
import { LEGACY_CHECKSUMS } from "../src/legacy-checksums.js";
import {
  fullTextChecksum,
  judgeChecksum,
  listMigrations,
  migrationChecksum,
  normalizeMigrationSql,
} from "../src/migrate.js";

/**
 * Migration checksums ignore comments — runs without a database.
 *
 * The checksum pins what a migration *does*. Comments do not change that, so translating or
 * rewording them must not stop a database that already applied the file. Code and string
 * literals still count: changing either is a different migration.
 */

describe("normalizeMigrationSql", () => {
  it("drops line and block comments and collapses whitespace", () => {
    const sql = "-- header\nCREATE TABLE t (\n  id INT /* key */\n);\n";
    expect(normalizeMigrationSql(sql)).toBe("CREATE TABLE t ( id INT );");
  });

  it("keeps comment markers inside single-quoted literals", () => {
    const sql = "SELECT '-- not a comment', 'it''s /* kept */' -- dropped\n";
    expect(normalizeMigrationSql(sql)).toBe("SELECT '-- not a comment', 'it''s /* kept */'");
  });

  it("drops comments inside dollar-quoted function bodies", () => {
    const sql = "AS $$\nBEGIN\n  -- note\n  RAISE EXCEPTION 'x'; /* remark */\nEND;\n$$;";
    expect(normalizeMigrationSql(sql)).toBe("AS $$ BEGIN RAISE EXCEPTION 'x'; END; $$;");
  });

  it("handles nested block comments", () => {
    expect(normalizeMigrationSql("SELECT 1 /* a /* b */ c */;")).toBe("SELECT 1 ;");
  });

  it("drops comments inside DO blocks and named function-body tags", () => {
    expect(normalizeMigrationSql("DO $$ BEGIN -- note\n PERFORM 1; END $$;")).toBe(
      "DO $$ BEGIN PERFORM 1; END $$;",
    );
    expect(normalizeMigrationSql("AS $fn$\nSELECT 1; -- note\n$fn$;")).toBe("AS $fn$ SELECT 1; $fn$;");
  });

  it("keeps a dollar-quoted literal nested in a function body verbatim", () => {
    const sql = "AS $$ BEGIN RETURN $q$keep -- this\n  /* too */$q$; END; $$;";
    expect(normalizeMigrationSql(sql)).toBe(
      "AS $$ BEGIN RETURN $q$keep -- this\n  /* too */$q$; END; $$;",
    );
  });

  it("keeps a dollar-quoted literal outside a function body verbatim", () => {
    const sql = "COMMENT ON TABLE t IS $c$range -- inclusive\n /* x */$c$;";
    expect(normalizeMigrationSql(sql)).toBe(sql);
  });
});

describe("migrationChecksum", () => {
  const original = "-- original comment\nCREATE TABLE t (id INT); -- tail\n";

  it("does not change when only comments change", () => {
    const translated = "-- translated comment\nCREATE TABLE t (id INT); -- end\n";
    expect(migrationChecksum(translated)).toBe(migrationChecksum(original));
  });

  it("changes when code changes", () => {
    expect(migrationChecksum("CREATE TABLE t (id BIGINT);")).not.toBe(migrationChecksum(original));
  });

  it("changes when a string literal changes", () => {
    expect(migrationChecksum("SELECT 'b';")).not.toBe(migrationChecksum("SELECT 'a';"));
  });

  it("changes when whitespace inside a string literal changes", () => {
    expect(migrationChecksum("SELECT 'a  b';")).not.toBe(migrationChecksum("SELECT 'a b';"));
  });

  it("changes when a dollar-quoted literal inside a function body changes", () => {
    const body = (text: string) =>
      `CREATE FUNCTION f() RETURNS text LANGUAGE plpgsql AS $$\nBEGIN RETURN $q$keep -- ${text}$q$; END;\n$$;`;
    expect(migrationChecksum(body("A"))).not.toBe(migrationChecksum(body("B")));
  });

  it("changes when a dollar-quoted literal outside a function body changes", () => {
    const comment = (text: string) => `COMMENT ON TABLE t IS $c$range -- ${text}$c$;`;
    expect(migrationChecksum(comment("inclusive"))).not.toBe(migrationChecksum(comment("exclusive")));
  });
});

describe("judgeChecksum", () => {
  const applied = "-- first wording\nCREATE TABLE t (id INT);\n";
  const current = "-- English\nCREATE TABLE t (id INT);\n";
  const legacy = { full: [fullTextChecksum(applied)], normalized: migrationChecksum(applied) };

  it("matches a checksum recorded with the comment-insensitive scheme", () => {
    expect(judgeChecksum({ recorded: migrationChecksum(current), sql: current })).toBe("match");
  });

  it("upgrades a full-text checksum of the same file", () => {
    expect(judgeChecksum({ recorded: fullTextChecksum(current), sql: current })).toBe("upgrade");
  });

  it("upgrades a known legacy checksum when only comments changed since", () => {
    expect(judgeChecksum({ recorded: fullTextChecksum(applied), sql: current, legacy })).toBe(
      "upgrade",
    );
  });

  it("rejects a known legacy checksum when the code changed since", () => {
    const edited = "-- English\nCREATE TABLE t (id BIGINT);\n";
    expect(judgeChecksum({ recorded: fullTextChecksum(applied), sql: edited, legacy })).toBe(
      "mismatch",
    );
  });

  it("rejects an unknown checksum", () => {
    expect(judgeChecksum({ recorded: "0".repeat(64), sql: current, legacy })).toBe("mismatch");
  });
});

describe("existing migrations", () => {
  it("differ from the recorded originals only in comments", () => {
    // Every file that existed before the comment-insensitive scheme must still normalize to
    // what was applied. A mismatch means a migration's code or literals were edited in place.
    const drifted = listMigrations()
      .filter((m) => LEGACY_CHECKSUMS[m.name] !== undefined)
      .filter((m) => LEGACY_CHECKSUMS[m.name]?.normalized !== migrationChecksum(m.sql))
      .map((m) => m.name);
    expect(drifted).toEqual([]);
  });

  it("have a legacy entry for every migration up to 0040", () => {
    const missing = listMigrations()
      .map((m) => m.name)
      .filter((name) => Number(name.slice(0, 4)) <= 40)
      .filter((name) => LEGACY_CHECKSUMS[name] === undefined);
    expect(missing).toEqual([]);
  });
});
