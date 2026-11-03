import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/migrate.js";
import { ensureLoginRoles, LoginRoleError, readLoginRoleGrants, setLocalIfPermitted } from "../src/login-roles.js";

/**
 * Login role creation.
 *
 * If this fails in deployment the API cannot connect to the DB, and the symptom shows only as
 * "authentication failed". In particular it checks **that a re-run updates the password** — if
 * creation were only attempted and skipped when the role exists, a new password would not take effect on redeploy.
 */
const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

/** A test password of the required length; `label` keeps the cases apart. */
const pw = (label: string) => `${label}-${"0".repeat(32)}`;

describeDb("login role", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    // Restore the local values other suites connect with. Roles are cluster-global. These public
    // passwords are below the CLI's minimum, so they are set the way login-roles.sql sets them.
    await sql.unsafe("ALTER ROLE mpc_app_login WITH PASSWORD 'app'");
    await sql.unsafe("ALTER ROLE mpc_worker_login WITH PASSWORD 'worker'");
    await sql.end();
  });

  async function canConnect(user: string, password: string): Promise<boolean> {
    const url = new URL(DATABASE_URL!);
    url.username = user;
    url.password = password;
    const probe = postgres(url.toString(), { onnotice: () => {}, max: 1 });
    try {
      await probe`SELECT 1`;
      return true;
    } catch {
      return false;
    } finally {
      await probe.end();
    }
  }

  it("creates both roles and can connect with their passwords", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("first-app"), workerPassword: pw("first-worker") });

    expect(await canConnect("mpc_app_login", pw("first-app"))).toBe(true);
    expect(await canConnect("mpc_worker_login", pw("first-worker"))).toBe(true);
  });

  /**
   * Is this a cluster that actually checks passwords?
   *
   * The README's local setup is `initdb --auth=trust`. Under trust any password connects, so
   * "cannot connect with the old password" cannot be checked — both pass whether or not the
   * update happened. Leaving an assertion that cannot pass would make its failure a permanent
   * red light that hides real failures.
   */
  async function passwordIsChecked(): Promise<boolean> {
    const rows = await sql<{ auth_method: string }[]>`
      SELECT auth_method FROM pg_hba_file_rules
      WHERE type = 'host' AND auth_method <> 'trust'
    `;
    return rows.length > 0;
  }

  it("a re-run updates the password", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("first-app"), workerPassword: pw("first-worker") });
    await ensureLoginRoles(sql, { appPassword: pw("second-app"), workerPassword: pw("second-worker") });

    expect(await canConnect("mpc_app_login", pw("second-app"))).toBe(true);

    // Whether the old password is blocked can only be seen on a cluster that checks passwords.
    if (await passwordIsChecked()) {
      expect(await canConnect("mpc_app_login", pw("first-app"))).toBe(false);
    }
  });

  /**
   * The verifier is computed in Node, so this is the only proof that it is a SCRAM verifier the
   * server accepts — a wrong one would still be stored and fail only at connect time.
   */
  it("each role accepts its password and refuses a wrong one", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("scram-app"), workerPassword: pw("scram-worker") });

    const stored = await sql<{ rolname: string; rolpassword: string }[]>`
      SELECT rolname, rolpassword FROM pg_authid
      WHERE rolname IN ('mpc_app_login', 'mpc_worker_login')
    `;
    expect(stored.map((row) => row.rolpassword)).toEqual([
      expect.stringMatching(/^SCRAM-SHA-256\$4096:/),
      expect.stringMatching(/^SCRAM-SHA-256\$4096:/),
    ]);

    expect(await canConnect("mpc_app_login", pw("scram-app"))).toBe(true);
    expect(await canConnect("mpc_worker_login", pw("scram-worker"))).toBe(true);
    if (await passwordIsChecked()) {
      expect(await canConnect("mpc_app_login", pw("scram-worker"))).toBe(false);
      expect(await canConnect("mpc_worker_login", pw("scram-app"))).toBe(false);
    }
  });

  /**
   * Postgres logs bound parameters as `DETAIL: parameters: $1 = '…'`, so a password sent even as a
   * parameter ends up in the DB log. Every query and parameter the driver sends is captured here,
   * including on a re-run where both roles already exist.
   */
  it("never sends a plaintext password to the server", async () => {
    const appPassword = pw("plaintext-app-7f3a");
    const workerPassword = pw("plaintext-worker-9c1e");
    const sent: string[] = [];
    const traced = postgres(DATABASE_URL!, {
      onnotice: () => {},
      debug: (_connection, query, parameters) => {
        sent.push(query, ...parameters.map((value) => String(value)));
      },
    });
    try {
      await ensureLoginRoles(traced, { appPassword, workerPassword });
      await ensureLoginRoles(traced, { appPassword, workerPassword });
    } finally {
      await traced.end();
    }

    expect(sent.some((text) => text.includes("ALTER ROLE mpc_worker_login WITH PASSWORD"))).toBe(true);
    // Statement logging off for the run, including the text of a statement that fails.
    for (const setting of [
      "log_statement = 'none'",
      "log_min_duration_statement = -1",
      "log_min_error_statement = panic",
    ]) {
      expect(sent).toContain(`SET LOCAL ${setting}`);
    }
    for (const text of sent) {
      expect(text).not.toContain(appPassword);
      expect(text).not.toContain(workerPassword);
    }
    expect(await canConnect("mpc_worker_login", workerPassword)).toBe(true);
  });

  it("only the worker role bypasses RLS", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("app-x"), workerPassword: pw("worker-x") });

    const rows = await sql<{ rolname: string; rolbypassrls: boolean }[]>`
      SELECT rolname, rolbypassrls FROM pg_roles
      WHERE rolname IN ('mpc_app_login', 'mpc_worker_login')
      ORDER BY rolname
    `;

    expect(rows).toEqual([
      { rolname: "mpc_app_login", rolbypassrls: false },
      { rolname: "mpc_worker_login", rolbypassrls: true },
    ]);
  });

  it("uses a password containing quotes as is", async () => {
    // The generator may emit special characters. Broken escaping would surface only in deployment.
    const awkward = pw("a'b\"c\\d$e");
    await ensureLoginRoles(sql, { appPassword: awkward, workerPassword: pw("worker-y") });

    expect(await canConnect("mpc_app_login", awkward)).toBe(true);
  });

  it("refuses a non-ASCII password before changing either role", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("ascii-app"), workerPassword: pw("ascii-worker") });
    await expect(
      ensureLoginRoles(sql, { appPassword: pw("next-app"), workerPassword: pw("wörker") }),
    ).rejects.toThrow(LoginRoleError);

    expect(await canConnect("mpc_app_login", pw("ascii-app"))).toBe(true);
  });

  /**
   * A role that can create and alter roles but cannot grant BYPASSRLS — the shape of an admin that
   * is not a real superuser. It must stop before resetting either password, not halfway through.
   */
  it("refuses a connecting role without superuser or BYPASSRLS before changing anything", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("kept-app"), workerPassword: pw("kept-worker") });
    const admin = "t_login_roles_preflight";
    await sql.unsafe(`DROP ROLE IF EXISTS ${admin}`);
    await sql.unsafe(`CREATE ROLE ${admin} LOGIN PASSWORD 'preflight' CREATEROLE`);
    await sql.unsafe(`GRANT mpc_app_login, mpc_worker_login TO ${admin} WITH ADMIN OPTION`);
    const url = new URL(DATABASE_URL!);
    url.username = admin;
    url.password = "preflight";
    const limited = postgres(url.toString(), { onnotice: () => {}, max: 1 });
    try {
      await expect(
        ensureLoginRoles(limited, { appPassword: pw("changed-app"), workerPassword: pw("changed-worker") }),
      ).rejects.toThrow(/lacks: the BYPASSRLS attribute, needed to grant BYPASSRLS to mpc_worker_login/);
    } finally {
      await limited.end();
      await sql.unsafe(`DROP ROLE ${admin}`);
    }

    expect(await canConnect("mpc_app_login", pw("kept-app"))).toBe(true);
    expect(await canConnect("mpc_worker_login", pw("kept-worker"))).toBe(true);
    if (await passwordIsChecked()) {
      expect(await canConnect("mpc_app_login", pw("changed-app"))).toBe(false);
    }
  });

  const storedPasswords = () => sql<{ rolname: string; rolpassword: string }[]>`
    SELECT rolname, rolpassword FROM pg_authid
    WHERE rolname IN ('mpc_app_login', 'mpc_worker_login')
    ORDER BY rolname
  `;

  /**
   * Runs `body` with a connection as a fresh non-superuser admin made of `attributes` and `grants`
   * (`{admin}` is its name), then drops it. Settings given with `ALTER ROLE ... SET` apply to its
   * sessions as a server configuration would.
   */
  async function asAdmin(
    attributes: string,
    grants: readonly string[],
    body: (limited: postgres.Sql) => Promise<void>,
  ): Promise<void> {
    const admin = "t_login_roles_admin";
    await sql.unsafe(`DROP OWNED BY ${admin}`).catch(() => {});
    await sql.unsafe(`DROP ROLE IF EXISTS ${admin}`);
    await sql.unsafe(`CREATE ROLE ${admin} LOGIN PASSWORD 'admin' ${attributes}`);
    for (const grant of grants) await sql.unsafe(grant.replaceAll("{admin}", admin));
    const url = new URL(DATABASE_URL!);
    url.username = admin;
    url.password = "admin";
    const limited = postgres(url.toString(), { onnotice: () => {}, max: 1 });
    try {
      await body(limited);
    } finally {
      await limited.end();
      // Grants it made (USAGE to the login roles) go with it; re-running restores them.
      await sql.unsafe(`REVOKE USAGE ON SCHEMA core, chain, audit FROM mpc_app_login, mpc_worker_login GRANTED BY ${admin} CASCADE`).catch(() => {});
      await sql.unsafe(`DROP OWNED BY ${admin}`);
      await sql.unsafe(`DROP ROLE ${admin}`);
      await sql.unsafe("GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login, mpc_worker_login");
    }
  }

  /** Everything a non-superuser needs on PG16+. INHERIT FALSE keeps the login roles' own rights out. */
  const FULL_ADMIN = [
    "GRANT mpc_app_login, mpc_worker_login TO {admin} WITH ADMIN OPTION, INHERIT FALSE",
    "GRANT USAGE ON SCHEMA core, chain, audit TO {admin} WITH GRANT OPTION",
  ];

  /**
   * Admins with CREATEROLE and BYPASSRLS, not superuser, that still lack one right the run needs.
   * The preflight names it before either password is reset.
   *
   * INHERIT FALSE (PG16+) keeps the admin from inheriting the login roles' own USAGE on audit;
   * with it, GRANT would only warn "no privileges were granted" instead of failing.
   *
   * Compared through pg_authid rather than by connecting: most local clusters use trust auth,
   * where any password connects and a changed password would go unnoticed.
   */
  it.each([
    {
      lacking: "ADMIN on the worker login role",
      grants: [
        "GRANT mpc_app_login TO {admin} WITH ADMIN OPTION, INHERIT FALSE",
        "GRANT USAGE ON SCHEMA core, chain, audit TO {admin} WITH GRANT OPTION",
      ],
      message: "ADMIN OPTION on mpc_worker_login, needed to reset its password",
    },
    {
      lacking: "grant rights on the audit schema",
      grants: [
        "GRANT mpc_app_login, mpc_worker_login TO {admin} WITH ADMIN OPTION, INHERIT FALSE",
        "GRANT USAGE ON SCHEMA core, chain TO {admin} WITH GRANT OPTION",
      ],
      message: "USAGE WITH GRANT OPTION (or ownership) on schema audit",
    },
  ])("refuses up front, changing neither password, when the admin lacks $lacking", async ({ grants, message }) => {
    await ensureLoginRoles(sql, { appPassword: pw("kept-app"), workerPassword: pw("kept-worker") });
    const before = await storedPasswords();

    await asAdmin("CREATEROLE BYPASSRLS", grants, async (limited) => {
      await expect(
        ensureLoginRoles(limited, { appPassword: pw("changed-app"), workerPassword: pw("changed-worker") }),
      ).rejects.toThrow(message);
    });

    expect(await storedPasswords()).toEqual(before);
  });

  /**
   * A failure the preflight cannot see: here the schema GRANT, refused by an event trigger. The
   * passwords come after it, so neither statement carrying a verifier ever runs, and the run rolls
   * back whole — the old DSNs keep working.
   */
  it("changes neither password when a statement before them fails", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("kept-app"), workerPassword: pw("kept-worker") });
    const before = await storedPasswords();
    await sql.unsafe(`
      CREATE FUNCTION public.t_login_roles_refuse_grant() RETURNS event_trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'grant refused for the test'; END $$;
      CREATE EVENT TRIGGER t_login_roles_refuse_grant ON ddl_command_start
        WHEN TAG IN ('GRANT') EXECUTE FUNCTION public.t_login_roles_refuse_grant();
    `);
    try {
      await expect(
        ensureLoginRoles(sql, { appPassword: pw("changed-app"), workerPassword: pw("changed-worker") }),
      ).rejects.toThrow("grant refused for the test");
    } finally {
      await sql.unsafe(`
        DROP EVENT TRIGGER t_login_roles_refuse_grant;
        DROP FUNCTION public.t_login_roles_refuse_grant();
      `);
    }

    expect(await storedPasswords()).toEqual(before);
  });

  /**
   * A non-superuser may not `SET LOCAL` the logging parameters. Whether it may go ahead then
   * depends on what the server would log: here its sessions log DDL (or every statement over a
   * duration), so the run stops before touching either role.
   */
  it.each([
    ["log_statement = 'ddl'", "log_statement = 'ddl' logs ALTER ROLE statements"],
    ["log_min_duration_statement = 0", "log_min_duration_statement = 0"],
    // Sampled when the transaction starts: no SET LOCAL inside the run could stop it.
    ["log_transaction_sample_rate = 1", "log_transaction_sample_rate = 1"],
    ["log_min_duration_sample = 0", "log_min_duration_sample = 0"],
  ])("stops before any change when the server would log the verifier (%s)", async (setting, message) => {
    await ensureLoginRoles(sql, { appPassword: pw("kept-app"), workerPassword: pw("kept-worker") });
    const before = await storedPasswords();

    await asAdmin(
      "CREATEROLE BYPASSRLS",
      [...FULL_ADMIN, `ALTER ROLE {admin} SET ${setting}`],
      async (limited) => {
        await expect(
          ensureLoginRoles(limited, { appPassword: pw("changed-app"), workerPassword: pw("changed-worker") }),
        ).rejects.toThrow(message);
      },
    );

    expect(await storedPasswords()).toEqual(before);
  });

  /**
   * The server's defaults, as an admin that may not change them finds them (Aurora's
   * `rds_superuser`): `log_min_error_statement = error` logs only a failing statement, so the run
   * goes ahead and says so.
   */
  it("goes ahead with warnings on a default configuration it cannot change", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("kept-app"), workerPassword: pw("kept-worker") });
    const before = await storedPasswords();

    await asAdmin(
      "CREATEROLE BYPASSRLS",
      [
        ...FULL_ADMIN,
        "ALTER ROLE {admin} SET log_statement = 'none'",
        "ALTER ROLE {admin} SET log_min_duration_statement = -1",
        "ALTER ROLE {admin} SET log_min_error_statement = error",
      ],
      async (limited) => {
        const result = await ensureLoginRoles(limited, {
          appPassword: pw("admin-app"),
          workerPassword: pw("admin-worker"),
        });
        expect(result.created).toEqual([]);
        expect(result.warnings).toEqual(
          expect.arrayContaining([
            expect.stringContaining("Not permitted to turn off log_statement, log_min_duration_statement"),
            expect.stringContaining("log_min_error_statement = 'error'"),
          ]),
        );
        for (const warning of result.warnings) {
          expect(warning).not.toContain(pw("admin-app"));
          expect(warning).not.toContain("SCRAM-SHA-256");
        }
      },
    );

    const after = await storedPasswords();
    expect(after.map((row) => row.rolpassword)).not.toEqual(before.map((row) => row.rolpassword));
    expect(await canConnect("mpc_worker_login", pw("admin-worker"))).toBe(true);
    const [worker] = await sql<{ rolbypassrls: boolean }[]>`
      SELECT rolbypassrls FROM pg_roles WHERE rolname = 'mpc_worker_login'
    `;
    expect(worker!.rolbypassrls).toBe(true);
  });

  /**
   * `log_min_duration_sample` exists from PostgreSQL 13. A superuser on an older server skips the
   * version gate, so turning it off there must not fail the run: an undefined setting cannot log
   * anything, and its read (`current_setting(…, true)`) is already null. Stood in for here by a
   * name no server defines.
   */
  it("skips a logging setting the server does not define, and keeps the transaction usable", async () => {
    const results = await sql.begin(async (tx) => [
      await setLocalIfPermitted(tx, "mpc_probe_setting_absent_here", "-1"),
      await setLocalIfPermitted(tx, "log_statement", "'none'"),
      (await tx<{ value: string }[]>`SELECT current_setting('log_statement') AS value`)[0]!.value,
    ]);
    expect(results).toEqual(["absent", "set", "none"]);
  });

  /**
   * On a first run the login roles do not exist yet. Dropping the cluster-global ones would
   * disturb every other suite, so stand-in names that exist nowhere take their place: an absent
   * role, parent or schema must read as absent — and so as missing ADMIN — not raise.
   */
  it("reads absent roles and schemas as absent for a non-superuser admin, without raising", async () => {
    await asAdmin("CREATEROLE BYPASSRLS", FULL_ADMIN, async (limited) => {
      const grants = await limited.begin((tx) =>
        readLoginRoleGrants(
          tx,
          [
            ["t_absent_login_role", "t_absent_parent_role"],
            ["t_absent_login_role_2", "mpc_app"],
            ["mpc_app_login", "mpc_app"],
          ],
          ["core", "t_absent_schema"],
        ),
      );
      expect(grants).toEqual({
        roles: [
          { role: "t_absent_login_role", parent: "t_absent_parent_role", exists: false, adminOnRole: false, adminOnParent: false },
          { role: "t_absent_login_role_2", parent: "mpc_app", exists: false, adminOnRole: false, adminOnParent: false },
          { role: "mpc_app_login", parent: "mpc_app", exists: true, adminOnRole: true, adminOnParent: false },
        ],
        schemasWithoutGrantOption: ["t_absent_schema"],
      });
    });
  });

  it("refuses a password shorter than 32 characters before changing either role", async () => {
    await ensureLoginRoles(sql, { appPassword: pw("kept-app"), workerPassword: pw("kept-worker") });
    const before = await storedPasswords();
    await expect(
      ensureLoginRoles(sql, { appPassword: pw("next-app"), workerPassword: "w".repeat(31) }),
    ).rejects.toThrow(/workerPassword is shorter than 32 characters.*openssl rand -hex 32/);
    expect(await storedPasswords()).toEqual(before);
  });

  it("rejects an empty password", async () => {
    await expect(
      ensureLoginRoles(sql, { appPassword: "", workerPassword: "worker" }),
    ).rejects.toThrow(LoginRoleError);
  });
});
