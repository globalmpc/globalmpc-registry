import { describe, expect, it } from "vitest";
import {
  alterRolePasswordStatement,
  connectingRoleProblem,
  LoginRoleError,
  scramSha256Verifier,
  statementLoggingDecision,
} from "../src/login-roles.js";

/**
 * The SCRAM verifier and the statement that carries it, without a DB.
 *
 * The integration test proves the server accepts the verifier; these pin down that the statement
 * can never contain the password or anything that breaks out of its literal.
 */
describe("login role SCRAM verifier", () => {
  it("matches the verifier PostgreSQL itself stores", () => {
    // `CREATE ROLE ... PASSWORD 'pencil'` on PostgreSQL 17, read back from pg_authid. Same salt
    // and iteration count must give byte-identical keys.
    const fromServer =
      "SCRAM-SHA-256$4096:zhIUQi2NSjWefoCoKeVydw==" +
      "$7iA7mT8diHqzZU9IQo/tbUf27ywLC/18DyqkKGzeu3M=:xxTSJjQnH4DIUv0nPeF9L5TPVwYqxbX9rU15iDEdyG0=";
    const salt = Buffer.from("zhIUQi2NSjWefoCoKeVydw==", "base64");

    expect(scramSha256Verifier("pencil", salt, 4096)).toBe(fromServer);
  });

  it("uses a fresh salt and the server default iteration count", () => {
    const first = scramSha256Verifier("same-password");
    const second = scramSha256Verifier("same-password");

    expect(first).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$/);
    expect(first).not.toBe(second);
  });

  it("builds a statement without the password, even one full of quotes", () => {
    const awkward = "a'b\"c\\d$e";
    const statement = alterRolePasswordStatement("mpc_app_login", scramSha256Verifier(awkward));

    expect(statement).toMatch(/^ALTER ROLE mpc_app_login WITH PASSWORD 'SCRAM-SHA-256\$[^']+'$/);
    expect(statement).not.toContain(awkward);
  });

  it("refuses to embed anything that is not a verifier", () => {
    for (const value of ["plain-password", "SCRAM-SHA-256$4096:a'b$c:d", "md5abc"]) {
      expect(() => alterRolePasswordStatement("mpc_app_login", value)).toThrow(LoginRoleError);
    }
  });

  it("refuses non-ASCII and control characters", () => {
    // Non-ASCII goes through SASLprep on the server and clients; raw bytes here would not match.
    for (const value of ["wörker", "tab\there"]) {
      expect(() => scramSha256Verifier(value)).toThrow(LoginRoleError);
    }
  });
});

describe("login role preflight", () => {
  const admin = {
    rolsuper: false,
    rolbypassrls: true,
    rolcreaterole: true,
    serverVersionNum: 160004,
  };
  const grants = (overrides: { adminOnRole?: boolean; adminOnParent?: boolean; exists?: boolean } = {}) => ({
    roles: [
      { role: "mpc_app_login", parent: "mpc_app", exists: true, adminOnRole: true, adminOnParent: false },
      {
        role: "mpc_worker_login",
        parent: "mpc_worker",
        exists: true,
        adminOnRole: true,
        adminOnParent: false,
        ...overrides,
      },
    ],
    schemasWithoutGrantOption: [],
  });

  it("accepts a superuser whatever else it lacks", () => {
    expect(
      connectingRoleProblem({ rolsuper: true, rolbypassrls: false, rolcreaterole: false, serverVersionNum: 150000 }),
    ).toBeNull();
  });

  it("accepts a PG16+ admin holding every privilege the run needs", () => {
    expect(connectingRoleProblem(admin, grants())).toBeNull();
    // A login role that does not exist yet needs ADMIN on its parent, not on itself.
    expect(
      connectingRoleProblem(admin, grants({ exists: false, adminOnRole: false, adminOnParent: true })),
    ).toBeNull();
  });

  it.each([
    [{ serverVersionNum: 150008 }, undefined, "PostgreSQL 16 or later (server_version_num is 150008)"],
    [{ rolcreaterole: false }, undefined, "CREATEROLE"],
    [{ rolbypassrls: false }, undefined, "BYPASSRLS attribute, needed to grant BYPASSRLS to mpc_worker_login"],
    [{}, { adminOnRole: false }, "ADMIN OPTION on mpc_worker_login, needed to reset its password"],
    [{}, { exists: false, adminOnRole: false }, "ADMIN OPTION on mpc_worker, needed to create mpc_worker_login"],
  ] as const)("names a missing privilege: %j %j", (role, grant, expected) => {
    const problem = connectingRoleProblem({ ...admin, ...role }, grants(grant));
    expect(problem).toContain("not a superuser and lacks");
    expect(problem).toContain(expected);
  });

  it("names schemas it cannot grant USAGE on, and every missing privilege at once", () => {
    const problem = connectingRoleProblem(
      { ...admin, rolcreaterole: false },
      { ...grants(), schemasWithoutGrantOption: ["audit"] },
    );
    expect(problem).toContain("CREATEROLE");
    expect(problem).toContain("USAGE WITH GRANT OPTION (or ownership) on schema audit");
  });

  it("refuses a role it could not read", () => {
    expect(connectingRoleProblem(undefined)).toContain("could not be read");
  });
});

describe("statement logging decision", () => {
  const off = {
    logStatement: "none",
    logMinDurationStatement: "-1",
    logMinErrorStatement: "panic",
    pgauditLog: null,
    logTransactionSampleRate: "0",
    logMinDurationSample: "-1",
    logStatementSampleRate: "1",
    pgStatStatementsTrackUtility: null,
    refused: [],
  };

  it("goes ahead quietly when logging is off", () => {
    expect(statementLoggingDecision(off)).toEqual({ blockers: [], warnings: [] });
  });

  it.each([
    [{ logStatement: "ddl" }, "log_statement = 'ddl'"],
    [{ logStatement: "mod" }, "log_statement = 'mod'"],
    [{ logStatement: "all" }, "log_statement = 'all'"],
    [{ logMinDurationStatement: "0" }, "log_min_duration_statement = 0"],
    [{ logMinDurationStatement: "1s" }, "log_min_duration_statement = 1s"],
    [{ pgauditLog: "role" }, "pgaudit.log = 'role'"],
    [{ pgauditLog: "all" }, "pgaudit.log = 'all'"],
    [{ logTransactionSampleRate: "0.01" }, "log_transaction_sample_rate = 0.01"],
    [{ logMinDurationSample: "0" }, "log_min_duration_sample = 0 with log_statement_sample_rate = 1"],
    [{ logMinDurationSample: "250ms", logStatementSampleRate: "0.5" }, "log_min_duration_sample = 250ms"],
  ] as const)("stops when %j would log the role statements", (setting, expected) => {
    const decision = statementLoggingDecision({ ...off, ...setting, refused: ["log_statement"] });
    expect(decision.blockers).toEqual([expect.stringContaining(expected)]);
  });

  it("does not count pgaudit classes that leave role statements out", () => {
    for (const pgauditLog of ["none", "read, write", "ddl", "all, -role"]) {
      expect(statementLoggingDecision({ ...off, pgauditLog }).blockers).toEqual([]);
    }
  });

  it("does not count sampled duration logging whose sample rate is 0, or settings a server lacks", () => {
    expect(
      statementLoggingDecision({ ...off, logMinDurationSample: "0", logStatementSampleRate: "0" }).blockers,
    ).toEqual([]);
    expect(
      statementLoggingDecision({
        ...off,
        logTransactionSampleRate: null,
        logMinDurationSample: null,
        logStatementSampleRate: null,
      }).blockers,
    ).toEqual([]);
  });

  it("warns, without stopping, when pg_stat_statements keeps utility statements", () => {
    const decision = statementLoggingDecision({ ...off, pgStatStatementsTrackUtility: "on" });
    expect(decision.blockers).toEqual([]);
    expect(decision.warnings).toEqual([expect.stringContaining("pg_stat_statements.track_utility = on")]);
    expect(statementLoggingDecision({ ...off, pgStatStatementsTrackUtility: "off" }).warnings).toEqual([]);
  });

  it("warns, without stopping, when it could not turn logging off but nothing would log", () => {
    const decision = statementLoggingDecision({
      ...off,
      refused: ["log_statement", "log_min_duration_statement", "log_min_error_statement"],
    });
    expect(decision.blockers).toEqual([]);
    expect(decision.warnings).toEqual([
      expect.stringContaining("Not permitted to turn off log_statement, log_min_duration_statement"),
    ]);
  });

  it("does not claim nothing records the statements when another warning says something may", () => {
    const decision = statementLoggingDecision({
      ...off,
      logMinErrorStatement: "error",
      pgStatStatementsTrackUtility: "on",
      refused: ["log_min_error_statement", "pg_stat_statements.track_utility"],
    });
    expect(decision.blockers).toEqual([]);
    const [refusal, ...residual] = decision.warnings;
    expect(refusal).toContain("Not permitted to turn off log_min_error_statement, pg_stat_statements.track_utility");
    // Scoped to what was checked, and pointing at what remains.
    expect(refusal).not.toMatch(/do not log these statements/);
    expect(refusal).toContain("log_statement, log_min_duration_statement, log_min_duration_sample");
    expect(refusal).toContain("see the warnings below");
    expect(residual).toEqual([
      expect.stringContaining("log_min_error_statement = 'error'"),
      expect.stringContaining("pg_stat_statements.track_utility = on"),
    ]);
  });

  it("warns, without stopping, when a failing statement would be logged with its text", () => {
    // PostgreSQL's default is `error`. Only a failing password statement would be logged, and its
    // verifier, of a password of 32 or more characters, can neither log in nor be guessed.
    for (const level of ["debug5", "info", "notice", "warning", "error", "log"]) {
      const decision = statementLoggingDecision({ ...off, logMinErrorStatement: level });
      expect(decision.blockers).toEqual([]);
      expect(decision.warnings).toEqual([expect.stringContaining(`log_min_error_statement = '${level}'`)]);
    }
    for (const level of ["fatal", "panic"]) {
      expect(statementLoggingDecision({ ...off, logMinErrorStatement: level }).warnings).toEqual([]);
    }
  });
});
