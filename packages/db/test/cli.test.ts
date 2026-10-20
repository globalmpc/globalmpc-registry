import { afterEach, beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  sql: { end: vi.fn() },
  migrate: vi.fn(),
  roles: vi.fn(),
  rollback: vi.fn(),
  git: vi.fn(),
  list: vi.fn(),
}));
vi.mock("postgres", () => ({ default: () => s.sql }));
vi.mock("../src/migrate.js", () => ({
  runMigrations: s.migrate,
  listMigrations: s.list,
}));
vi.mock("../src/login-roles.js", () => ({
  ensureLoginRoles: s.roles,
  LoginRoleError: class extends Error {},
}));
vi.mock("../src/rollback-check.js", () => ({
  checkMigrationRollback: s.rollback,
}));
vi.mock("node:child_process", () => ({ execFileSync: s.git }));
const exitCode = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  for (const f of [s.sql.end, s.migrate, s.roles, s.rollback, s.git, s.list])
    f.mockReset();
  vi.stubEnv("DATABASE_URL", "postgres://local/test");
  process.exitCode = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
});
afterEach(() => {
  process.exitCode = exitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
it.each([["001.sql"], []])(
  "reports applied migrations or a clean schema (%j)",
  async (...migrations) => {
    s.migrate.mockResolvedValue(migrations);
    await import("../src/cli.js");
    expect(s.migrate).toHaveBeenCalledWith(s.sql);
    expect(s.sql.end).toHaveBeenCalledOnce();
    expect(process.stdout.write).toHaveBeenCalledWith(
      migrations.length
        ? `Applied: ${migrations.join(", ")}\n`
        : "No migrations to apply\n",
    );
  },
);
it("refuses migrations without a database URL", async () => {
  vi.stubEnv("DATABASE_URL", "");
  await expect(import("../src/cli.js")).rejects.toThrow("exit:1");
  expect(s.migrate).not.toHaveBeenCalled();
});
it("creates login roles without printing either password", async () => {
  vi.stubEnv("APP_DB_PASSWORD", "app-secret");
  vi.stubEnv("WORKER_DB_PASSWORD", "worker-secret");
  s.roles.mockResolvedValue({ created: ["mpc_app_login"] });
  await import("../src/login-roles-cli.js");
  expect(s.roles).toHaveBeenCalledWith(s.sql, {
    appPassword: "app-secret",
    workerPassword: "worker-secret",
  });
  const log = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(log).toContain("mpc_app_login");
  expect(log).not.toContain("secret");
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("reports login role creation errors and closes the connection", async () => {
  vi.stubEnv("APP_DB_PASSWORD", "a");
  vi.stubEnv("WORKER_DB_PASSWORD", "b");
  s.roles.mockRejectedValue(new Error("Role denied"));
  await import("../src/login-roles-cli.js");
  expect(process.exitCode).toBe(1);
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("Role denied"),
  );
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("requires both role passwords before connecting", async () => {
  vi.stubEnv("APP_DB_PASSWORD", "");
  vi.stubEnv("WORKER_DB_PASSWORD", "");
  await expect(import("../src/login-roles-cli.js")).rejects.toThrow("exit:1");
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("APP_DB_PASSWORD, WORKER_DB_PASSWORD"),
  );
});
it("reads and sorts only SQL files from the base ref before checking rollback", async () => {
  vi.stubEnv("MIGRATION_BASE_REF", "base-ref");
  s.git.mockImplementation((_exe, args) =>
    args.includes("rev-parse")
      ? "/repo\n"
      : args.includes("ls-tree")
        ? "002.sql\nREADME.md\n001.sql\n"
        : "SELECT 1;",
  );
  s.list.mockReturnValue([{ name: "001.sql", sql: "SELECT 1;" }]);
  s.rollback.mockResolvedValue({
    previous: ["001.sql", "002.sql"],
    forward: ["003.sql"],
    reapplied: ["003.sql"],
  });
  await import("../src/rollback-check-cli.js");
  expect(s.rollback).toHaveBeenCalledWith({
    adminUrl: "postgres://local/test",
    previous: [
      { name: "001.sql", sql: "SELECT 1;" },
      { name: "002.sql", sql: "SELECT 1;" },
    ],
    current: [{ name: "001.sql", sql: "SELECT 1;" }],
  });
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining("Forward on a populated copy: 003.sql"),
  );
});
it("reports a rollback failure with a failing exit", async () => {
  vi.stubEnv("MIGRATION_BASE_REF", "bad");
  s.git.mockImplementation(() => {
    throw new Error("Unknown ref");
  });
  await expect(import("../src/rollback-check-cli.js")).rejects.toThrow(
    "exit:1",
  );
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringContaining("Unknown ref"),
  );
});
it("requires a migration base ref", async () => {
  vi.stubEnv("MIGRATION_BASE_REF", "");
  await expect(import("../src/rollback-check-cli.js")).rejects.toThrow(
    "exit:1",
  );
  expect(s.git).not.toHaveBeenCalled();
});
