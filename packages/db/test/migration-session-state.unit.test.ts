import { describe, expect, it } from "vitest";
import { listMigrations, normalizeMigrationSql, splitStatements } from "../src/migrate.js";

/**
 * A run applies every file on one session (see the runner header), so a file that leaves state on
 * the session — a role, a setting, a temporary table — changes what every later file in the run
 * does. Each file must keep such state to its own transaction: `SET LOCAL`, `set_config(…, true)`.
 *
 * Scanned: every top-level statement, and the bodies of `DO` blocks, which run during the
 * migration. Function and procedure definitions are not: their bodies run later, when called, and
 * their `SET` clauses are scoped to the call.
 */
function sessionStateProblems(sql: string): string[] {
  const problems: string[] = [];
  for (const raw of splitStatements(sql)) {
    // String literals emptied: text inside them is data, not a statement.
    const statement = normalizeMigrationSql(raw).replace(/'(?:[^']|'')*'/g, "''");
    if (/^CREATE\s+(OR\s+REPLACE\s+)?(FUNCTION|PROCEDURE)\b/i.test(statement)) continue;
    if (/^SET\s+(?!LOCAL\b)/i.test(statement)) problems.push(`SET without LOCAL: ${statement}`);
    if (/^RESET\b/i.test(statement)) problems.push(`RESET: ${statement}`);
    if (/^DISCARD\b/i.test(statement)) problems.push(`DISCARD: ${statement}`);
    if (/^(PREPARE|LISTEN)\b/i.test(statement)) problems.push(`session object: ${statement}`);
    if (/^DO\b/i.test(statement)) {
      // A plpgsql statement starts after `;` or a block keyword.
      const inBody = /(?:;|\b(?:BEGIN|THEN|ELSE|LOOP))\s*(SET\s+(?!LOCAL\b)|RESET\b)/i.exec(statement);
      if (inBody) problems.push(`${inBody[1]!.trim()} in a DO block: ${statement}`);
    }
    if (/\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\s+TABLE\b/i.test(statement) && !/\bON\s+COMMIT\s+DROP\b/i.test(statement)) {
      problems.push(`temporary table outliving its transaction: ${statement}`);
    }
    for (const args of setConfigCalls(statement)) {
      if (args.length !== 3 || args[2]!.trim().toLowerCase() !== "true") {
        problems.push(`set_config without is_local = true: set_config(${args.join(",")})`);
      }
    }
  }
  return problems;
}

/** Arguments of every `set_config(…)` call, split at commas outside parentheses (literals already emptied). */
function setConfigCalls(statement: string): string[][] {
  const calls: string[][] = [];
  const opener = /\bset_config\s*\(/gi;
  for (let match = opener.exec(statement); match; match = opener.exec(statement)) {
    const args: string[] = [];
    let depth = 0;
    let current = "";
    for (let i = match.index + match[0].length; i < statement.length; i++) {
      const ch = statement[i]!;
      if (ch === "(") depth += 1;
      if (ch === ")" && depth-- === 0) break;
      if (ch === "," && depth === 0) {
        args.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    args.push(current);
    calls.push(args);
  }
  return calls;
}

describe("session state left by a migration", () => {
  it.each([
    "SET search_path = core;",
    "SET SESSION statement_timeout = 0;",
    "SET ROLE mpc_worker;",
    "SET SESSION AUTHORIZATION mpc_app;",
    "RESET ROLE;",
    "RESET ALL;",
    "SELECT set_config('app.current_tenant', 'x', false);",
    "SELECT set_config('role', current_setting('x'), false);",
    "DO $$ BEGIN SET ROLE mpc_app; END $$;",
    "DO $$ BEGIN PERFORM 1; RESET search_path; END $$;",
    "DO $$ BEGIN PERFORM set_config('lock_timeout', '5s', false); END $$;",
    "CREATE TEMP TABLE t (v INT);",
    "PREPARE p AS SELECT 1;",
  ])("is caught: %s", (sql) => {
    expect(sessionStateProblems(sql)).not.toEqual([]);
  });

  it.each([
    "SET LOCAL lock_timeout = '5s';",
    "SELECT set_config('row_security', 'off', true);",
    "DO $$ BEGIN PERFORM set_config('lock_timeout', '5s', TRUE); SET LOCAL x.y = 1; END $$;",
    "UPDATE t SET v = 1;",
    "ALTER TABLE t ALTER COLUMN v SET NOT NULL;",
    "INSERT INTO t VALUES (1) ON CONFLICT (v) DO UPDATE SET v = 2;",
    "CREATE OR REPLACE FUNCTION f() RETURNS void LANGUAGE plpgsql SET search_path = core, pg_temp AS $$ BEGIN SET ROLE x; END $$;",
    "-- SET ROLE x;\nSELECT 1;",
    "COMMENT ON TABLE t IS 'SET ROLE x; set_config(a, b, false)';",
    "CREATE TEMP TABLE t (v INT) ON COMMIT DROP;",
  ])("is allowed: %s", (sql) => {
    expect(sessionStateProblems(sql)).toEqual([]);
  });

  it("is left by no migration", () => {
    const found = listMigrations().flatMap((migration) =>
      sessionStateProblems(migration.sql).map((problem) => `${migration.name}: ${problem.slice(0, 200)}`),
    );
    expect(found).toEqual([]);
  });
});
