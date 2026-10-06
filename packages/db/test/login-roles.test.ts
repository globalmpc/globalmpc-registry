import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/migrate.js";
import { ensureLoginRoles, LoginRoleError } from "../src/login-roles.js";

/**
 * Login role creation.
 *
 * If this fails in deployment the API cannot connect to the DB, and the symptom shows only as
 * "authentication failed". In particular it checks **that a re-run updates the password** — if
 * creation were only attempted and skipped when the role exists, a new password would not take effect on redeploy.
 */
const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb("login role", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { onnotice: () => {} });
    await runMigrations(sql);
  });

  afterAll(async () => {
    // Restore the values other tests use. Roles are cluster-global.
    await ensureLoginRoles(sql, { appPassword: "app", workerPassword: "worker" });
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
    await ensureLoginRoles(sql, { appPassword: "first-app", workerPassword: "first-worker" });

    expect(await canConnect("mpc_app_login", "first-app")).toBe(true);
    expect(await canConnect("mpc_worker_login", "first-worker")).toBe(true);
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
    await ensureLoginRoles(sql, { appPassword: "first-app", workerPassword: "first-worker" });
    await ensureLoginRoles(sql, { appPassword: "second-app", workerPassword: "second-worker" });

    expect(await canConnect("mpc_app_login", "second-app")).toBe(true);

    // Whether the old password is blocked can only be seen on a cluster that checks passwords.
    if (await passwordIsChecked()) {
      expect(await canConnect("mpc_app_login", "first-app")).toBe(false);
    }
  });

  it("only the worker role bypasses RLS", async () => {
    await ensureLoginRoles(sql, { appPassword: "app-x", workerPassword: "worker-x" });

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
    const awkward = "a'b\"c\\d$e";
    await ensureLoginRoles(sql, { appPassword: awkward, workerPassword: "worker-y" });

    expect(await canConnect("mpc_app_login", awkward)).toBe(true);
  });

  it("rejects an empty password", async () => {
    await expect(
      ensureLoginRoles(sql, { appPassword: "", workerPassword: "worker" }),
    ).rejects.toThrow(LoginRoleError);
  });
});
