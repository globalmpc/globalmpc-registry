import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * The CDK migration task's program, `docker/migrate-task.sh`: migrate → bootstrap (only with
 * BOOTSTRAP_EMAIL) → register the scan worker's token.
 *
 * Run as the task runs it, with `/bin/sh`, against a stand-in `node` that records each step's
 * working directory, arguments and environment, and fails on request. What the steps themselves
 * do is tested with their own code (bootstrap.test.ts, service-token-ensure.test.ts).
 */

const SCRIPT = fileURLToPath(new URL("../../../docker/migrate-task.sh", import.meta.url));
const EMAIL = "first.operator+deploy@example.test";
const TOKEN = `mpcsvc_${"Q".repeat(43)}`;
const PASSWORD = "db-password-not-for-logs";

interface Step {
  readonly cwd: string;
  readonly args: string;
  readonly env: Map<string, string>;
}

describe("migration task program", () => {
  let dir: string;
  let calls: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-task-"));
    calls = join(dir, "calls");
    for (const sub of ["bin", "calls", "repo/packages/db", "repo/apps/api"]) mkdirSync(join(dir, sub), { recursive: true });
    const fake = join(dir, "bin", "node");
    writeFileSync(
      fake,
      [
        "#!/bin/sh",
        'n=$(ls "$FAKE_CALLS" | wc -l | tr -d " ")',
        '{ echo "cwd=$PWD"; echo "args=$*"; env; } > "$FAKE_CALLS/$n"',
        'if [ -n "${FAKE_FAIL:-}" ]; then case "$*" in *"$FAKE_FAIL"*) echo "fake step failed" >&2; exit 3;; esac; fi',
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(fake, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(extra: Record<string, string | undefined> = {}) {
    const env: Record<string, string> = {
      PATH: `${join(dir, "bin")}:/usr/bin:/bin`,
      MIGRATE_TASK_ROOT: join(dir, "repo"),
      FAKE_CALLS: calls,
      DB_USER: "admin",
      DB_PASSWORD: PASSWORD,
      DB_HOST: "db.internal",
      DB_PORT: "5432",
      DB_NAME: "mpc_registry",
      DB_SSLMODE: "require",
      SCAN_SERVICE_TOKEN: TOKEN,
      SCAN_SERVICE_TENANT_SLUG: "registry",
    };
    for (const [name, value] of Object.entries(extra)) {
      if (value === undefined) delete env[name];
      else env[name] = value;
    }
    const result = spawnSync("/bin/sh", [SCRIPT], { env, encoding: "utf8" });
    const steps: Step[] = readdirSync(calls)
      .sort((a, b) => Number(a) - Number(b))
      .map((file) => {
        const lines = readFileSync(join(calls, file), "utf8").split("\n");
        const env = new Map<string, string>();
        for (const line of lines.slice(2)) {
          const at = line.indexOf("=");
          if (at > 0) env.set(line.slice(0, at), line.slice(at + 1));
        }
        return { cwd: lines[0]!.slice(4), args: lines[1]!.slice(5), env };
      });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, steps };
  }

  const bootstrapVars = {
    BOOTSTRAP_EMAIL: EMAIL,
    BOOTSTRAP_TENANT_SLUG: "registry",
    BOOTSTRAP_TENANT_NAME: "Registry",
    BOOTSTRAP_ORG_NAME: "Registry Operator",
    BOOTSTRAP_SUBJECT_NAME: "First operator",
  };

  it("without BOOTSTRAP_EMAIL, migrates, says bootstrap was skipped, then registers the token", () => {
    const { status, output, steps } = run();
    expect(status).toBe(0);
    expect(steps.map((step) => step.args)).toEqual([
      "--import tsx src/cli.ts",
      "--import tsx src/service-token-cli.ts ensure registry scan-worker scan_service scan_result",
    ]);
    expect(steps[0]!.cwd).toBe(join(dir, "repo/packages/db"));
    expect(steps[1]!.cwd).toBe(join(dir, "repo/apps/api"));
    expect(output).toContain('"msg":"migrate_task.bootstrap.skipped"');
    expect(steps[0]!.env.get("DATABASE_URL")).toBe(
      `postgres://admin:${PASSWORD}@db.internal:5432/mpc_registry?sslmode=require`,
    );
    // The migration never sees the token; only the registration step does, by environment.
    expect(steps[0]!.env.has("SCAN_SERVICE_TOKEN")).toBe(false);
    expect(steps[0]!.env.has("SERVICE_TOKEN")).toBe(false);
    expect(steps[1]!.env.get("SERVICE_TOKEN")).toBe(TOKEN);
    expect(steps[1]!.env.has("SCAN_SERVICE_TOKEN")).toBe(false);
  });

  it("with BOOTSTRAP_EMAIL, bootstraps after migrating and before the token, handing the address to that step only", () => {
    const { status, output, steps } = run(bootstrapVars);
    expect(status).toBe(0);
    expect(steps.map((step) => step.args)).toEqual([
      "--import tsx src/cli.ts",
      "--import tsx src/bootstrap-cli.ts",
      "--import tsx src/service-token-cli.ts ensure registry scan-worker scan_service scan_result",
    ]);
    const [migrate, bootstrap, ensure] = steps;
    expect(bootstrap!.cwd).toBe(join(dir, "repo/apps/api"));
    expect(bootstrap!.env.get("BOOTSTRAP_EMAIL")).toBe(EMAIL);
    expect(bootstrap!.env.get("BOOTSTRAP_TENANT_SLUG")).toBe("registry");
    expect(bootstrap!.env.get("DATABASE_URL")).toBe(migrate!.env.get("DATABASE_URL"));
    expect(migrate!.env.has("BOOTSTRAP_EMAIL")).toBe(false);
    expect(ensure!.env.has("BOOTSTRAP_EMAIL")).toBe(false);
    expect(bootstrap!.env.has("SERVICE_TOKEN")).toBe(false);
    expect(bootstrap!.env.has("SCAN_SERVICE_TOKEN")).toBe(false);
    expect(output).toContain('"msg":"migrate_task.bootstrap.run"');
    // Neither secret is ever printed or put on a command line.
    for (const secret of [EMAIL, TOKEN, PASSWORD]) {
      expect(output).not.toContain(secret);
      for (const step of steps) expect(step.args).not.toContain(secret);
    }
  });

  it("passes an explicitly selected legacy subject UUID to the bootstrap process", () => {
    const subjectId = "1c30ec15-7874-43f1-805b-633fbe816644";
    const { status, output, steps } = run({ ...bootstrapVars, BOOTSTRAP_SUBJECT_ID: subjectId });
    expect(status).toBe(0);
    const bootstrap = steps.find((step) => step.args === "--import tsx src/bootstrap-cli.ts");
    expect(bootstrap?.env.get("BOOTSTRAP_SUBJECT_ID")).toBe(subjectId);
    expect(bootstrap?.env.get("BOOTSTRAP_EMAIL")).toBe(EMAIL);
    // This is plain migration-task configuration, inherited by the child process, never an arg.
    expect(bootstrap?.args).not.toContain(subjectId);
    expect(output).not.toContain(subjectId);
  });

  it("stops the deploy when bootstrap fails: non-zero, and the token is not registered", () => {
    const { status, output, steps } = run({ ...bootstrapVars, FAKE_FAIL: "bootstrap-cli.ts" });
    expect(status).not.toBe(0);
    expect(steps.map((step) => step.args)).toEqual(["--import tsx src/cli.ts", "--import tsx src/bootstrap-cli.ts"]);
    expect(output).not.toContain(EMAIL);
  });

  it("stops after a failed migration, before bootstrap and the token", () => {
    const { status, steps } = run({ ...bootstrapVars, FAKE_FAIL: "src/cli.ts" });
    expect(status).not.toBe(0);
    expect(steps.map((step) => step.args)).toEqual(["--import tsx src/cli.ts"]);
  });

  it("exits non-zero when the token registration fails", () => {
    const { status } = run({ FAKE_FAIL: "ensure" });
    expect(status).not.toBe(0);
  });

  it("names a missing input and runs nothing, without echoing any value", () => {
    for (const name of ["DB_PASSWORD", "SCAN_SERVICE_TOKEN", "SCAN_SERVICE_TENANT_SLUG"]) {
      rmSync(calls, { recursive: true, force: true });
      mkdirSync(calls);
      const { status, output, steps } = run({ ...bootstrapVars, [name]: "" });
      expect(status, name).toBe(1);
      expect(output).toContain(`migrate-task: ${name} is empty`);
      expect(steps).toHaveLength(0);
      for (const secret of [EMAIL, TOKEN, PASSWORD]) expect(output).not.toContain(secret);
    }
  });
});
