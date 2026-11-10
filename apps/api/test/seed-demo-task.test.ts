import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const program = fileURLToPath(new URL("../../../docker/seed-demo-task.sh", import.meta.url));

describe("development seed container program", () => {
  it("rejects production before starting node", () => {
    const response = spawnSync("sh", [program], { encoding: "utf8", env: { PATH: process.env["PATH"], DEPLOY_ENVIRONMENT: "production", CHAIN_ID: "5611" } });
    expect(response.status).toBe(1);
    expect(response.stderr).toContain("requires develop");
  });

  it("encodes credentials and limits secrets inherited by the seed process", () => {
    const root = mkdtempSync(join(tmpdir(), "dev-demo-entry-"));
    try {
      mkdirSync(join(root, "bin")); mkdirSync(join(root, "apps/api"), { recursive: true });
      const output = join(root, "observed.json");
      const node = join(root, "bin/node");
      writeFileSync(node, `#!/bin/sh\nif [ "$1" = '-e' ]; then exec "$REAL_NODE" "$@"; fi\nexec "$REAL_NODE" -e 'require("node:fs").writeFileSync(process.env.OBSERVED,JSON.stringify({url:process.env.DATABASE_URL,password:process.env.DB_PASSWORD,scan:process.env.SCAN_SERVICE_TOKEN,email:process.env.BOOTSTRAP_EMAIL,args:process.argv.slice(1)}))' -- "$@"\n`);
      chmodSync(node, 0o700);
      const password = "local-test-#%@:/password";
      const response = spawnSync("sh", [program], { encoding: "utf8", env: {
        PATH: `${join(root, "bin")}:${process.env["PATH"]}`, REAL_NODE: process.execPath, OBSERVED: output,
        DEPLOY_ENVIRONMENT: "develop", CHAIN_ID: "5611", DEMO_TASK_ROOT: root,
        DB_USER: "owner", DB_PASSWORD: password, DB_HOST: "db.example.test", DB_PORT: "5432", DB_NAME: "registry", DB_SSLMODE: "require",
        OBJECT_BUCKET: "evidence", OBJECT_REGION: "ap-northeast-2", DEMO_TENANT_SLUG: "registry",
        SCAN_SERVICE_TOKEN: "do-not-inherit", BOOTSTRAP_EMAIL: "do-not-inherit@example.test",
      } });
      expect(response.status, response.stderr).toBe(0);
      const observed = JSON.parse(readFileSync(output, "utf8")) as { url: string; password?: string; scan?: string; email?: string; args: string[] };
      expect(decodeURIComponent(new URL(observed.url).password)).toBe(password);
      expect(observed.password).toBeUndefined(); expect(observed.scan).toBeUndefined(); expect(observed.email).toBeUndefined();
      expect(observed.args).toEqual(["--import", "tsx", "src/dev-demo-cli.ts"]);
      expect(response.stdout).not.toContain(password);
      expect(response.stderr).not.toContain(password);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
