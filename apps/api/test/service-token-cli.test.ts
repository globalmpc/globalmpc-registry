import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * Service token CLI — decision D7. Argument handling and the refusals that happen before any
 * write; the writes themselves are covered against Postgres in `service-tokens.test.ts`.
 */
const s = vi.hoisted(() => ({
  privileges: { rolsuper: true, rolbypassrls: false } as { rolsuper: boolean; rolbypassrls: boolean },
  tenants: [{ id: "tenant-1" }] as { id: string }[],
  sql: Object.assign(
    vi.fn(async (strings: TemplateStringsArray) =>
      strings.join("?").includes("core.tenants") ? s.tenants : [s.privileges],
    ),
    { end: vi.fn() },
  ),
  createServiceSubject: vi.fn(),
  issueServiceToken: vi.fn(),
  rotateServiceToken: vi.fn(),
  revokeServiceToken: vi.fn(),
  listServiceTokens: vi.fn(),
  ensureServiceToken: vi.fn(),
  generateServiceTokenValue: vi.fn(),
}));
vi.mock("postgres", () => ({ default: () => s.sql }));
vi.mock("@mpc/config", () => ({ resolveSecret: (_name: string, value: string) => value }));
vi.mock("../src/service-tokens.js", () => ({
  // The CLI explains only its own refusals, so the class identity is what matters here.
  ServiceTokenError: class ServiceTokenError extends Error {},
  createServiceSubject: s.createServiceSubject,
  issueServiceToken: s.issueServiceToken,
  rotateServiceToken: s.rotateServiceToken,
  revokeServiceToken: s.revokeServiceToken,
  listServiceTokens: s.listServiceTokens,
  ensureServiceToken: s.ensureServiceToken,
  generateServiceTokenValue: s.generateServiceTokenValue,
}));

const originalArgv = process.argv;
const originalExitCode = process.exitCode;
const DAY = 24 * 60 * 60;
const GENERATED = `mpcsvc_${"G".repeat(43)}`;
const STORED = `mpcsvc_${"S".repeat(43)}`;

beforeEach(() => {
  vi.resetModules();
  s.privileges = { rolsuper: true, rolbypassrls: false };
  s.tenants = [{ id: "tenant-1" }];
  for (const f of [
    s.sql.end,
    s.createServiceSubject,
    s.issueServiceToken,
    s.rotateServiceToken,
    s.revokeServiceToken,
    s.listServiceTokens,
    s.ensureServiceToken,
    s.generateServiceTokenValue,
  ])
    f.mockReset();
  s.generateServiceTokenValue.mockReturnValue(GENERATED);
  s.ensureServiceToken.mockResolvedValue({
    outcome: "registered",
    subjectId: "subject-1",
    subjectCreated: true,
    tokenId: "token-9",
    expiresAt: "2027-11-02T00:00:00.000Z",
    retired: [],
    renewalDue: false,
  });
  s.createServiceSubject.mockResolvedValue({ subjectId: "subject-1" });
  s.issueServiceToken.mockResolvedValue({ token: "mpcsvc_x", tokenId: "token-1", expiresAt: "2027-01-01T00:00:00.000Z" });
  s.rotateServiceToken.mockResolvedValue({
    token: "mpcsvc_y",
    tokenId: "token-2",
    expiresAt: "2027-02-01T00:00:00.000Z",
    previousExpiresAt: "2026-11-03T00:00:00.000Z",
  });
  s.revokeServiceToken.mockResolvedValue(true);
  s.listServiceTokens.mockResolvedValue([{ id: "token-1" }, { id: "token-2" }]);
  process.exitCode = 0;
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
  vi.stubEnv("DATABASE_URL", "postgres://local/test");
});

afterEach(() => {
  process.argv = originalArgv;
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function run(...args: string[]): Promise<void> {
  process.argv = ["node", "service-token-cli.ts", ...args];
  await import("../src/service-token-cli.js");
}

const stdout = () => vi.mocked(process.stdout.write).mock.calls.map(([chunk]) => String(chunk)).join("");
const stderr = () => vi.mocked(process.stderr.write).mock.calls.map(([chunk]) => String(chunk)).join("");

it("prints usage and exits for a missing or unknown command, before connecting", async () => {
  await expect(run()).rejects.toThrow("exit:1");
  await expect(run("delete-everything")).rejects.toThrow("exit:1");
  expect(stderr()).toContain("Usage:");
  expect(s.sql).not.toHaveBeenCalled();
});

it("requires the migration connection", async () => {
  vi.stubEnv("DATABASE_URL", "");
  await expect(run("list", "tenant")).rejects.toThrow("exit:1");
  expect(stderr()).toContain("DATABASE_URL");
});

it("refuses a role that cannot bypass row-level security", async () => {
  s.privileges = { rolsuper: false, rolbypassrls: false };
  await run("list", "tenant");
  expect(process.exitCode).toBe(1);
  expect(stderr()).toContain("BYPASSRLS");
  expect(s.listServiceTokens).not.toHaveBeenCalled();
  expect(s.sql.end).toHaveBeenCalledOnce();
});

it("creates a service subject in the named tenant", async () => {
  await run("create-subject", "tenant", "Scan worker", "scan_service");
  expect(s.createServiceSubject).toHaveBeenCalledWith(s.sql, {
    tenantId: "tenant-1",
    displayName: "Scan worker",
    role: "scan_service",
  });
  expect(stdout()).toContain('"subjectId":"subject-1"');
});

it("issues with comma-separated scopes and a 90-day default lifetime, printing the token once", async () => {
  await run("issue", "tenant", "subject-1", "scan-worker", "scan_result, cre_report,");
  expect(s.issueServiceToken).toHaveBeenCalledWith(s.sql, {
    tenantId: "tenant-1",
    subjectId: "subject-1",
    label: "scan-worker",
    scopes: ["scan_result", "cre_report"],
    ttlSeconds: 90 * DAY,
  });
  expect(stdout().match(/mpcsvc_x/g)).toHaveLength(1);
});

it("issues with an explicit lifetime and refuses one that is not a whole number", async () => {
  await run("issue", "tenant", "subject-1", "scan-worker", "scan_result", "30");
  expect(s.issueServiceToken).toHaveBeenCalledWith(s.sql, expect.objectContaining({ ttlSeconds: 30 * DAY }));

  vi.resetModules();
  await run("issue", "tenant", "subject-1", "scan-worker", "scan_result", "1.5");
  expect(process.exitCode).toBe(1);
  expect(stderr()).toContain("ttlDays must be a whole number");
});

it("refuses issue without its arguments and an unknown tenant", async () => {
  await run("issue", "tenant", "subject-1");
  expect(stderr()).toContain("subjectId, label and scopes are required");

  vi.resetModules();
  s.tenants = [];
  await run("issue", "missing", "subject-1", "scan-worker", "scan_result");
  expect(stderr()).toContain("no tenant missing");

  vi.resetModules();
  await run("list");
  expect(stderr()).toContain("tenant slug is required");
  expect(s.issueServiceToken).not.toHaveBeenCalled();
  expect(process.exitCode).toBe(1);
});

it("rotates with a 24-hour default overlap, or the overlap given", async () => {
  await run("rotate", "token-1");
  expect(s.rotateServiceToken).toHaveBeenCalledWith(s.sql, {
    tokenId: "token-1",
    overlapSeconds: 24 * 60 * 60,
    ttlSeconds: 90 * DAY,
  });
  expect(stdout()).toContain('"previousTokenId":"token-1"');

  vi.resetModules();
  await run("rotate", "token-1", "2", "7");
  expect(s.rotateServiceToken).toHaveBeenLastCalledWith(s.sql, {
    tokenId: "token-1",
    overlapSeconds: 2 * 60 * 60,
    ttlSeconds: 7 * DAY,
  });

  vi.resetModules();
  await run("rotate");
  expect(stderr()).toContain("tokenId is required");
});

it("revokes and lists", async () => {
  await run("revoke", "token-1");
  expect(s.revokeServiceToken).toHaveBeenCalledWith(s.sql, "token-1");
  expect(stdout()).toContain('"revoked":true');

  vi.resetModules();
  await run("revoke");
  expect(stderr()).toContain("tokenId is required");

  vi.resetModules();
  await run("list", "tenant");
  expect(s.listServiceTokens).toHaveBeenCalledWith(s.sql, "tenant-1");
  expect(stdout()).toContain('{"id":"token-2"}');
});

it("reports an unexpected failure without its message, and still closes the connection", async () => {
  s.revokeServiceToken.mockRejectedValue(new Error("connection to secret-host refused"));
  await run("revoke", "token-1");
  expect(process.exitCode).toBe(1);
  expect(stderr()).toContain("unexpected error");
  expect(stderr()).not.toContain("secret-host");
  expect(s.sql.end).toHaveBeenCalledOnce();
});

it("generate prints a new token and nothing else, without connecting", async () => {
  vi.stubEnv("DATABASE_URL", "");
  await expect(run("generate")).rejects.toThrow("exit:0");
  expect(stdout()).toBe(`${GENERATED}\n`);
  expect(stderr()).toBe("");
  expect(s.sql).not.toHaveBeenCalled();
});

it("ensure registers the token from SERVICE_TOKEN with a one-year default, never printing it", async () => {
  vi.stubEnv("SERVICE_TOKEN", STORED);
  await run("ensure", "tenant", "scan-worker", "scan_service", "scan_result");
  expect(s.ensureServiceToken).toHaveBeenCalledWith(s.sql, {
    tenantId: "tenant-1",
    label: "scan-worker",
    role: "scan_service",
    scopes: ["scan_result"],
    token: STORED,
    ttlSeconds: 365 * DAY,
    overlapSeconds: 24 * 60 * 60,
  });
  expect(stdout()).toContain('"outcome":"registered"');
  expect(stdout() + stderr()).not.toContain(STORED);
  // Nothing that runs after the step can read it back from the environment.
  expect(process.env["SERVICE_TOKEN"]).toBeUndefined();
  expect(process.exitCode).toBe(0);
});

it("ensure refuses without SERVICE_TOKEN, before connecting", async () => {
  await expect(run("ensure", "tenant", "scan-worker", "scan_service", "scan_result")).rejects.toThrow("exit:1");
  expect(stderr()).toContain("SERVICE_TOKEN is required");
  expect(s.ensureServiceToken).not.toHaveBeenCalled();
});

it("ensure fails on an unknown tenant and warns when the stored value is due for renewal", async () => {
  vi.stubEnv("SERVICE_TOKEN", STORED);
  s.tenants = [];
  await run("ensure", "missing", "scan-worker", "scan_service", "scan_result");
  expect(process.exitCode).toBe(1);
  expect(stderr()).toContain("no tenant missing");

  vi.resetModules();
  process.exitCode = 0;
  vi.stubEnv("SERVICE_TOKEN", STORED);
  s.tenants = [{ id: "tenant-1" }];
  s.ensureServiceToken.mockResolvedValue({
    outcome: "unchanged",
    subjectId: "subject-1",
    subjectCreated: false,
    tokenId: "token-9",
    expiresAt: "2026-11-20T00:00:00.000Z",
    retired: [],
    renewalDue: true,
  });
  await run("ensure", "tenant", "scan-worker", "scan_service", "scan_result", "30", "2");
  expect(s.ensureServiceToken).toHaveBeenLastCalledWith(
    s.sql,
    expect.objectContaining({ ttlSeconds: 30 * DAY, overlapSeconds: 2 * 60 * 60 }),
  );
  expect(process.exitCode).toBe(0);
  expect(stderr()).toContain("generate a new value and store it");
  expect(stdout() + stderr()).not.toContain(STORED);
});
