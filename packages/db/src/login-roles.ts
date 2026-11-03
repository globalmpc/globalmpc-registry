import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import type postgres from "postgres";
import { readConnectingRole, type ConnectingRole } from "./connecting-role.js";

export type { ConnectingRole } from "./connecting-role.js";

/**
 * Creates login roles that can connect.
 *
 * The `mpc_app` and `mpc_worker` roles created by migrations are NOLOGIN. They hold the
 * privilege boundary; the members that can connect are kept separate.
 *
 * **There is a reason this is code, not a SQL file.** Deployments cannot mount repository files
 * into containers — a compose-based deploy platform may rewrite relative bind mounts in compose to absolute host paths,
 * and the repository is not at that path. Code running inside the same image needs no mount,
 * and since the `$$` PL/pgSQL block never passes through a shell, quoting problems disappear too.
 *
 * **Passwords are reset every time.** If creation were only attempted and skipped when the role
 * already exists, a password regenerated on redeploy would not take effect and the API could not
 * connect — and the cause would show up only as "authentication failed", making it hard to find.
 *
 * **The plaintext password never reaches the server.** Only a SCRAM-SHA-256 verifier computed
 * here is sent, which the server stores as is. Sending the password itself — even as a bound
 * parameter — puts it in the DB log as `DETAIL: parameters: $2 = '…'` whenever statement or
 * duration logging is on, and Aurora exports that log to CloudWatch. The worker login bypasses
 * RLS, so that would be a cross-tenant credential in a widely read place.
 *
 * Called over the migration connection: a superuser, or an admin holding what
 * `connectingRoleProblem` lists.
 */

export interface LoginRolePasswords {
  readonly appPassword: string;
  readonly workerPassword: string;
}

export class LoginRoleError extends Error {
  readonly code = "LOGIN_ROLE_INVALID";
}

const APP_LOGIN = "mpc_app_login";
const WORKER_LOGIN = "mpc_worker_login";

/**
 * The shortest password accepted. The security of a logged or leaked verifier rests on this: a
 * SCRAM verifier holds StoredKey = H(ClientKey) and ServerKey, neither of which yields ClientKey,
 * so it cannot log in, and the only attack on it is guessing the password offline. 32 random
 * characters (`openssl rand -hex 32` gives 64) put that out of reach.
 */
export const MIN_PASSWORD_LENGTH = 32;

/** PostgreSQL's own default (`scram_iterations`); the generated passwords are 256-bit anyway. */
const SCRAM_ITERATIONS = 4096;

const BASE64 = "[A-Za-z0-9+/]+={0,2}";
const SCRAM_VERIFIER = new RegExp(`^SCRAM-SHA-256\\$[1-9][0-9]*:${BASE64}\\$${BASE64}:${BASE64}$`);

/**
 * The verifier PostgreSQL itself would store for `password` (RFC 5802 / RFC 7677).
 *
 * The server and every client run the password through SASLprep first. For ASCII it is the
 * identity, so hashing the raw bytes here matches; for anything else this would have to
 * reimplement SASLprep exactly, and a mismatch would only show up as "authentication failed".
 * Generated passwords are hex, so non-ASCII is refused instead.
 */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations: number = SCRAM_ITERATIONS,
): string {
  if (!/^[\x20-\x7e]+$/.test(password)) {
    throw new LoginRoleError("Passwords must be printable ASCII");
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest("base64");
  const serverKey = createHmac("sha256", salted).update("Server Key").digest("base64");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey}:${serverKey}`;
}

/**
 * `ALTER ROLE ... PASSWORD` does not accept parameter binding, so the verifier is embedded as a
 * literal. It can hold only base64 characters, `$`, `:` and digits — no quote can appear — and
 * the regex makes that a checked fact rather than an assumption. Role names are the constants
 * above (the parameter type admits nothing else), so there is no identifier-injection path.
 */
export function alterRolePasswordStatement(
  role: typeof APP_LOGIN | typeof WORKER_LOGIN,
  verifier: string,
): string {
  if (!SCRAM_VERIFIER.test(verifier)) {
    throw new LoginRoleError("Refusing to embed a malformed SCRAM verifier");
  }
  return `ALTER ROLE ${role} WITH PASSWORD '${verifier}'`;
}

/** Each login role and the NOLOGIN role it is created into. */
const LOGIN_ROLES = [
  [APP_LOGIN, "mpc_app"],
  [WORKER_LOGIN, "mpc_worker"],
] as const;

const GRANTED_SCHEMAS = ["core", "chain", "audit"] as const;

/** Before 16 only a superuser may set BYPASSRLS on another role. */
const NON_SUPERUSER_MIN_SERVER_VERSION = 160000;

/** What the connecting role holds over the objects this run touches. Read only for a non-superuser. */
export interface LoginRoleGrants {
  /** Per login role: whether it exists, ADMIN OPTION on it, and ADMIN OPTION on its parent. */
  readonly roles: readonly {
    readonly role: string;
    readonly parent: string;
    readonly exists: boolean;
    readonly adminOnRole: boolean;
    readonly adminOnParent: boolean;
  }[];
  /** Schemas on which the role cannot grant USAGE. */
  readonly schemasWithoutGrantOption: readonly string[];
}

/**
 * Why the connecting role cannot finish the run, or null if it can.
 *
 * A superuser can do everything. Otherwise PostgreSQL 16+ asks for (checked on 17; the rules are
 * those of the PG16 role-administration change):
 * - CREATEROLE, to create or alter roles at all;
 * - BYPASSRLS itself, to give BYPASSRLS to the worker login (before 16, superuser only);
 * - ADMIN OPTION on an existing login role, to change its password or attributes — a role created
 *   in this run grants it to its creator automatically;
 * - ADMIN OPTION on `mpc_app`/`mpc_worker` for `CREATE ROLE ... IN ROLE`; membership alone is
 *   refused;
 * - USAGE WITH GRANT OPTION (or ownership) on core, chain and audit.
 *
 * The run is a single transaction, so a late failure would roll back anyway; checking first gives
 * one message naming every missing privilege instead of a bare permission error. Aurora's admin
 * (`rds_superuser`) is not a superuser and must pass these like any other role.
 */
export function connectingRoleProblem(
  role: ConnectingRole | undefined,
  grants?: LoginRoleGrants,
): string | null {
  if (role?.rolsuper) return null;
  if (!role) return "The connecting role could not be read from pg_roles.";

  const missing: string[] = [];
  if (!(role.serverVersionNum >= NON_SUPERUSER_MIN_SERVER_VERSION)) {
    missing.push(
      `PostgreSQL 16 or later (server_version_num is ${role.serverVersionNum}); before 16 only a ` +
        `superuser can grant BYPASSRLS to ${WORKER_LOGIN}`,
    );
  }
  if (!role.rolcreaterole) missing.push("the CREATEROLE attribute");
  if (!role.rolbypassrls) {
    missing.push(`the BYPASSRLS attribute, needed to grant BYPASSRLS to ${WORKER_LOGIN}`);
  }
  for (const entry of grants?.roles ?? []) {
    if (entry.exists && !entry.adminOnRole) {
      missing.push(`ADMIN OPTION on ${entry.role}, needed to reset its password`);
    }
    if (!entry.exists && !entry.adminOnParent) {
      missing.push(`ADMIN OPTION on ${entry.parent}, needed to create ${entry.role} in it`);
    }
  }
  if (grants && grants.schemasWithoutGrantOption.length > 0) {
    missing.push(
      `USAGE WITH GRANT OPTION (or ownership) on schema ${grants.schemasWithoutGrantOption.join(", ")}`,
    );
  }
  if (missing.length === 0) return null;
  return (
    `The connecting role is not a superuser and lacks: ${missing.join("; ")}. ` +
    "Connect as a superuser, or grant what is listed."
  );
}

/**
 * Reads what `connectingRoleProblem` needs. Exported for tests, which pass stand-in names so the
 * cluster-global login roles need not be dropped.
 *
 * A login role does not exist on a first run, and `pg_has_role` with a name that does not
 * resolve raises instead of answering — SQL promises no evaluation order, so guarding it with
 * `EXISTS (...) AND` does not stop the call. Each role and schema is therefore looked up first and
 * checked by oid; one that does not exist reads as absent, without a call.
 */
export async function readLoginRoleGrants(
  tx: postgres.TransactionSql,
  loginRoles: readonly (readonly [string, string])[] = LOGIN_ROLES,
  schemas: readonly string[] = GRANTED_SCHEMAS,
): Promise<LoginRoleGrants> {
  const roles = [];
  for (const [role, parent] of loginRoles) {
    const [row] = await tx<{ exists: boolean; admin_on_role: boolean; admin_on_parent: boolean }[]>`
      SELECT
        r.oid IS NOT NULL AS exists,
        CASE WHEN r.oid IS NULL THEN false
             ELSE pg_has_role(current_user, r.oid, 'MEMBER WITH ADMIN OPTION') END AS admin_on_role,
        CASE WHEN p.oid IS NULL THEN false
             ELSE pg_has_role(current_user, p.oid, 'MEMBER WITH ADMIN OPTION') END AS admin_on_parent
      FROM (SELECT 1) AS one
      LEFT JOIN pg_roles r ON r.rolname = ${role}
      LEFT JOIN pg_roles p ON p.rolname = ${parent}
    `;
    roles.push({
      role,
      parent,
      exists: row!.exists,
      adminOnRole: row!.admin_on_role,
      adminOnParent: row!.admin_on_parent,
    });
  }
  const lacking = await tx<{ nspname: string }[]>`
    SELECT s AS nspname
    FROM unnest(${tx.array([...schemas])}::text[]) AS s
    LEFT JOIN pg_namespace n ON n.nspname = s
    WHERE n.oid IS NULL OR NOT has_schema_privilege(current_user, n.oid, 'USAGE WITH GRANT OPTION')
  `;
  return { roles, schemasWithoutGrantOption: lacking.map((row) => row.nspname) };
}

/**
 * The settings that decide whether this run's statements reach the server log, as they are in
 * effect for the run's transaction (after its `SET LOCAL` attempts).
 */
export interface StatementLogSettings {
  readonly logStatement: string;
  /** As `current_setting` shows it ("-1", "0", "250ms", "1s"); negative means off. */
  readonly logMinDurationStatement: string;
  readonly logMinErrorStatement: string;
  /** `pgaudit.log`, or null when the extension is not loaded. */
  readonly pgauditLog: string | null;
  /** Fraction of transactions logged in full, decided when the transaction starts (PG12+). */
  readonly logTransactionSampleRate: string | null;
  /** Sampled duration logging (PG13+): threshold, and the fraction of those statements logged. */
  readonly logMinDurationSample: string | null;
  readonly logStatementSampleRate: string | null;
  /** `pg_stat_statements.track_utility`, or null when the extension is not loaded. */
  readonly pgStatStatementsTrackUtility: string | null;
  /** Settings this role was not permitted to `SET LOCAL`. */
  readonly refused: readonly string[];
}

/**
 * Whether the run may go ahead with these settings in effect, and what to warn about if so.
 *
 * The `ALTER ROLE ... PASSWORD` statements carry SCRAM verifiers. A verifier is not the
 * password, but it allows an offline guessing attack, and the worker login bypasses RLS — so a
 * run whose statements would be logged stops before changing anything. A statement is logged
 * with its text by `log_statement` ddl/mod/all (`mod` includes DDL), by any
 * `log_min_duration_statement` threshold (0 or more: a slow run is logged too), by sampled
 * duration logging (`log_min_duration_sample` 0 or more with a nonzero `log_statement_sample_rate`),
 * by `log_transaction_sample_rate` above 0 — decided when the transaction starts, so no `SET LOCAL`
 * inside it can undo it — and by pgaudit's ROLE class. Those log every run, so they stop it.
 *
 * `log_min_error_statement` below `fatal` (PostgreSQL's default is `error`) logs a statement only
 * when it fails. The password statements run last, after every other statement of the run
 * succeeded and with lock and statement timeouts off, so little is left that could fail them; and
 * even then the logged verifier belongs to a password of at least `MIN_PASSWORD_LENGTH` characters,
 * which cannot be guessed and does not log in. That residual is a warning, so an admin that may
 * not change the setting (Aurora's `rds_superuser`) can still run on a default configuration.
 * `pg_stat_statements.track_utility` is a warning too: the text goes to that view, not the log.
 */
export function statementLoggingDecision(settings: StatementLogSettings): {
  readonly blockers: readonly string[];
  readonly warnings: readonly string[];
} {
  const blockers: string[] = [];
  if (["ddl", "mod", "all"].includes(settings.logStatement)) {
    blockers.push(`log_statement = '${settings.logStatement}' logs ALTER ROLE statements`);
  }
  if (!settings.logMinDurationStatement.startsWith("-")) {
    blockers.push(
      `log_min_duration_statement = ${settings.logMinDurationStatement} logs any statement ` +
        "slower than that, with its text",
    );
  }
  if (settings.pgauditLog !== null && pgauditLogsRole(settings.pgauditLog)) {
    blockers.push(`pgaudit.log = '${settings.pgauditLog}' logs role statements`);
  }
  if (settings.logTransactionSampleRate !== null && Number(settings.logTransactionSampleRate) !== 0) {
    blockers.push(
      `log_transaction_sample_rate = ${settings.logTransactionSampleRate} may log every statement ` +
        "of this run, decided before it could be turned off",
    );
  }
  if (
    settings.logMinDurationSample !== null &&
    !settings.logMinDurationSample.startsWith("-") &&
    Number(settings.logStatementSampleRate ?? "1") !== 0
  ) {
    blockers.push(
      `log_min_duration_sample = ${settings.logMinDurationSample} with log_statement_sample_rate = ` +
        `${settings.logStatementSampleRate ?? "1"} may log any statement slower than that, with its text`,
    );
  }

  const warnings: string[] = [];
  if (!["fatal", "panic"].includes(settings.logMinErrorStatement)) {
    warnings.push(
      `log_min_error_statement = '${settings.logMinErrorStatement}': a password statement that ` +
        "failed would be logged with its text; that verifier cannot log in, and the password is " +
        `at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (settings.pgStatStatementsTrackUtility === "on") {
    warnings.push(
      "pg_stat_statements.track_utility = on: the role statements, verifiers included, may be " +
        "kept in pg_stat_statements; reset it (pg_stat_statements_reset) after the run",
    );
  }
  // Scoped to the settings the blockers checked: the warnings above are what that leaves open,
  // and this one comes first so it does not read as contradicting them.
  if (blockers.length === 0 && settings.refused.length > 0) {
    warnings.unshift(
      `Not permitted to turn off ${settings.refused.join(", ")} for this run. It went ahead ` +
        "because the server's current log_statement, log_min_duration_statement, " +
        "log_min_duration_sample, log_transaction_sample_rate and pgaudit.log values do not log " +
        "a statement that succeeds" +
        (warnings.length > 0 ? "; see the warnings below for what may still record one" : ""),
    );
  }
  return { blockers, warnings };
}

/** pgaudit classes: `role` covers CREATE/ALTER ROLE and GRANT; `-role` excludes it from `all`. */
function pgauditLogsRole(value: string): boolean {
  const classes = value.toLowerCase().split(",").map((item) => item.trim());
  if (classes.includes("role")) return true;
  return classes.includes("all") && !classes.includes("-role");
}

const LOGGING_OFF = [
  ["log_statement", "'none'"],
  ["log_min_duration_statement", "-1"],
  // A failing statement is logged with its text too, whatever the two settings above say.
  ["log_min_error_statement", "panic"],
  ["log_min_duration_sample", "-1"],
  ["pgaudit.log", "'none'"],
  ["pg_stat_statements.track_utility", "off"],
] as const;

/**
 * Runs `SET LOCAL` in a savepoint and reports a privilege refusal (42501) or a setting the server
 * does not define (42704) instead of throwing. Exported for tests.
 *
 * These settings are SUSET, and whether Aurora's `rds_superuser` may set them is not something
 * this code can verify. A refusal does not stop the run by itself: the effective values are read
 * afterwards and decide (`statementLoggingDecision`). An undefined one — `log_min_duration_sample`
 * before PostgreSQL 13, reached by a superuser, who skips the version gate — logs nothing; its read
 * (`current_setting(…, true)`) is null and counts as absent there too.
 */
export async function setLocalIfPermitted(
  tx: postgres.TransactionSql,
  name: string,
  value: string,
): Promise<"set" | "refused" | "absent"> {
  return tx
    .savepoint((sp) => sp.unsafe(`SET LOCAL ${name} = ${value}`))
    .then(() => "set" as const)
    .catch((error: unknown) => {
      const code = (error as { code?: string }).code;
      if (code === "42501") return "refused" as const;
      if (code === "42704") return "absent" as const;
      throw error;
    });
}

async function readStatementLogSettings(
  tx: postgres.TransactionSql,
  refused: readonly string[],
): Promise<StatementLogSettings> {
  const [row] = await tx<
    {
      log_statement: string;
      log_min_duration_statement: string;
      log_min_error_statement: string;
      pgaudit_log: string | null;
      log_transaction_sample_rate: string | null;
      log_min_duration_sample: string | null;
      log_statement_sample_rate: string | null;
      pgss_track_utility: string | null;
    }[]
  >`
    SELECT current_setting('log_statement') AS log_statement,
           current_setting('log_min_duration_statement') AS log_min_duration_statement,
           current_setting('log_min_error_statement') AS log_min_error_statement,
           current_setting('pgaudit.log', true) AS pgaudit_log,
           current_setting('log_transaction_sample_rate', true) AS log_transaction_sample_rate,
           current_setting('log_min_duration_sample', true) AS log_min_duration_sample,
           current_setting('log_statement_sample_rate', true) AS log_statement_sample_rate,
           current_setting('pg_stat_statements.track_utility', true) AS pgss_track_utility
  `;
  // Absent on older servers, or an empty placeholder when an extension is not loaded.
  const present = (value: string | null) => (value === "" ? null : value);
  return {
    logStatement: row!.log_statement,
    logMinDurationStatement: row!.log_min_duration_statement,
    logMinErrorStatement: row!.log_min_error_statement,
    // A placeholder from our own SET LOCAL when the extension is absent reads 'none'.
    pgauditLog: present(row!.pgaudit_log),
    logTransactionSampleRate: present(row!.log_transaction_sample_rate),
    logMinDurationSample: present(row!.log_min_duration_sample),
    logStatementSampleRate: present(row!.log_statement_sample_rate),
    pgStatStatementsTrackUtility: present(row!.pgss_track_utility),
    refused,
  };
}

export interface LoginRolesResult {
  readonly created: string[];
  /** Safe to print: setting names and values, never a password or verifier. */
  readonly warnings: readonly string[];
}

export async function ensureLoginRoles(
  sql: postgres.Sql,
  passwords: LoginRolePasswords,
): Promise<LoginRolesResult> {
  for (const [name, value] of [
    ["appPassword", passwords.appPassword],
    ["workerPassword", passwords.workerPassword],
  ] as const) {
    if (value.trim() === "") {
      throw new LoginRoleError(`${name} is empty`);
    }
    if (value.length < MIN_PASSWORD_LENGTH) {
      throw new LoginRoleError(
        `${name} is shorter than ${MIN_PASSWORD_LENGTH} characters. Generate one with ` +
          "`openssl rand -hex 32`",
      );
    }
  }

  // Built before touching the DB, so a refused password leaves both roles as they were.
  const plan = LOGIN_ROLES.map(([role, parent]) => [
    role,
    parent,
    alterRolePasswordStatement(
      role,
      scramSha256Verifier(role === APP_LOGIN ? passwords.appPassword : passwords.workerPassword),
    ),
  ] as const);

  const created: string[] = [];
  let warnings: readonly string[] = [];

  /**
   * One transaction for the whole run. The preflight names every privilege it knows the run
   * needs, but anything it misses failing after a committed reset would leave the old DSNs dead
   * and the new ones never handed off. Role DDL is transactional, so a failure anywhere leaves
   * both roles exactly as they were. The passwords are set last (see below).
   *
   * Statement logging, failing statements included, is off for this transaction only, as defence
   * in depth: the verifier is not the password, but it would allow an offline guessing attack.
   * `SET LOCAL` reverts when the transaction ends, so other connections are untouched. A role not
   * permitted to turn it off still runs when the server's own values would not log the
   * statements, and stops before any change when they would.
   */
  await sql.begin(async (tx) => {
    const connecting = await readConnectingRole(tx);
    const grants = connecting?.rolsuper ? undefined : await readLoginRoleGrants(tx);
    const problem = connectingRoleProblem(connecting, grants);
    if (problem) throw new LoginRoleError(problem);

    const refused: string[] = [];
    for (const [name, value] of LOGGING_OFF) {
      if ((await setLocalIfPermitted(tx, name, value)) === "refused") refused.push(name);
    }
    const logging = statementLoggingDecision(await readStatementLogSettings(tx, refused));
    if (logging.blockers.length > 0) {
      throw new LoginRoleError(
        `The role statements would be written to the server log (${logging.blockers.join("; ")}), ` +
          "and the run could not turn that off for itself. Turn these off in the server or role " +
          "configuration for the duration of the run, or run it as a role that may set them (a " +
          "superuser, or one granted SET on them); a transaction sample rate must already be 0 " +
          "when the run starts.",
      );
    }
    warnings = logging.warnings;

    for (const [role, parent] of plan) {
      const existing = await tx<{ rolname: string }[]>`
        SELECT rolname FROM pg_roles WHERE rolname = ${role}
      `;
      if (existing.length === 0) {
        // No password yet: the role cannot log in until the statement below, in this transaction.
        await tx.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ${parent}`);
        created.push(role);
      }
    }

    await tx.unsafe(
      `GRANT USAGE ON SCHEMA ${GRANTED_SCHEMAS.join(", ")} TO ${APP_LOGIN}, ${WORKER_LOGIN}`,
    );

    // The worker is a system process that spans tenants (0012). It bypasses RLS, but the bypass
    // is limited to the privileges granted to mpc_worker.
    await tx.unsafe(`ALTER ROLE ${WORKER_LOGIN} BYPASSRLS`);

    // The statements that carry verifiers come last, once everything else succeeded, and cannot
    // time out: a failing statement may be logged with its text (`log_min_error_statement`).
    // Both settings are user-settable, so no admin is refused them.
    await tx.unsafe("SET LOCAL lock_timeout = 0");
    await tx.unsafe("SET LOCAL statement_timeout = 0");
    for (const [, , setPassword] of plan) await tx.unsafe(setPassword);
  });

  return { created, warnings };
}
