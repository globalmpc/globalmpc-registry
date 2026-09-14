import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "../src/migrate.js";
import { ensureLoginRoles, LoginRoleError } from "../src/login-roles.js";

/**
 * login role 생성.
 *
 * 배포에서 이것이 실패하면 API가 DB에 붙지 못하고, 증상은 "인증 실패"로만
 * 보인다. 특히 **재실행이 비밀번호를 갱신하는지**를 본다 — role이 이미 있을 때
 * 만들기만 시도하고 넘어가면 재배포에서 새 비밀번호가 반영되지 않는다.
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
    // 다른 테스트가 쓰는 값으로 되돌린다. role은 클러스터 전역이다.
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

  it("두 role을 만들고 그 비밀번호로 붙을 수 있다", async () => {
    await ensureLoginRoles(sql, { appPassword: "first-app", workerPassword: "first-worker" });

    expect(await canConnect("mpc_app_login", "first-app")).toBe(true);
    expect(await canConnect("mpc_worker_login", "first-worker")).toBe(true);
  });

  /**
   * 비밀번호가 실제로 검사되는 클러스터인가.
   *
   * README의 로컬 설정은 `initdb --auth=trust`다. trust에서는 어떤 비밀번호로도
   * 붙으므로 "옛 비밀번호로는 못 붙는다"를 확인할 수 없다 — 갱신이 됐든 안 됐든
   * 둘 다 통과한다. 통과할 수 없는 단언을 남겨 두면 그 실패가 상시 빨간불이
   * 되어 진짜 실패를 가린다.
   */
  async function passwordIsChecked(): Promise<boolean> {
    const rows = await sql<{ auth_method: string }[]>`
      SELECT auth_method FROM pg_hba_file_rules
      WHERE type = 'host' AND auth_method <> 'trust'
    `;
    return rows.length > 0;
  }

  it("재실행이 비밀번호를 갱신한다", async () => {
    await ensureLoginRoles(sql, { appPassword: "first-app", workerPassword: "first-worker" });
    await ensureLoginRoles(sql, { appPassword: "second-app", workerPassword: "second-worker" });

    expect(await canConnect("mpc_app_login", "second-app")).toBe(true);

    // 옛 비밀번호가 막히는지는 비밀번호를 검사하는 클러스터에서만 볼 수 있다.
    if (await passwordIsChecked()) {
      expect(await canConnect("mpc_app_login", "first-app")).toBe(false);
    }
  });

  it("worker role만 RLS를 우회한다", async () => {
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

  it("따옴표가 들어간 비밀번호도 그대로 쓴다", async () => {
    // 생성기가 특수문자를 뱉을 수 있다. 이스케이프가 깨지면 배포에서만 드러난다.
    const awkward = "a'b\"c\\d$e";
    await ensureLoginRoles(sql, { appPassword: awkward, workerPassword: "worker-y" });

    expect(await canConnect("mpc_app_login", awkward)).toBe(true);
  });

  it("빈 비밀번호를 거절한다", async () => {
    await expect(
      ensureLoginRoles(sql, { appPassword: "", workerPassword: "worker" }),
    ).rejects.toThrow(LoginRoleError);
  });
});
