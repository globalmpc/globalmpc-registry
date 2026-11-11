import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

// This regression intentionally exercises Vitest 5.1's ReportsDirectoryLock disk
// protocol (path hash and owner JSON), not an application-owned API. On EVERY
// Vitest/coverage-v8 upgrade, inspect the installed ReportsDirectoryLock and
// re-run this test; update the fixture to the new protocol if it changes. A
// changed protocol must not be papered over by skipping the contention checks.
const preload = resolve("scripts/coverage-temp.mjs");
const vitest = resolve("node_modules/vitest/vitest.mjs");
test("isolates foreign temp locks but preserves same-checkout coverage exclusion", () => {
  const root = mkdtempSync(join(tmpdir(), "registry-coverage-isolation-"));
  try {
    const inherited = join(root, "foreign-temp");
    const local = join(root, "node_modules/.cache/vitest-temp");
    const reports = join(root, "coverage/app");
    mkdirSync(inherited, { recursive: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    writeFileSync(join(root, "vitest.config.mjs"), `export default {test:{include:["fixture.test.js"],coverage:{provider:"v8",reportsDirectory:${JSON.stringify(reports)},reporter:["json-summary"]}}};`);
    writeFileSync(join(root, "fixture.test.js"), `import {test,expect} from ${JSON.stringify(resolve("node_modules/vitest/dist/index.js"))};test("fixture",()=>expect(2+2).toBe(4));`);
    const name = `vitest-coverage-${createHash("sha256").update(reports).digest("hex").slice(0,16)}.lock`;
    const owner = JSON.stringify({ pid: process.pid, reportsDirectory: reports });
    writeFileSync(join(inherited, name), owner);
    const run = usePreload => spawnSync(process.execPath, [
      ...(usePreload ? ["--import", preload] : []), vitest, "run", "--coverage", "--config", "vitest.config.mjs",
    ], { cwd: root, env: {...process.env, TMPDIR: inherited, TMP: inherited, TEMP: inherited}, encoding: "utf8", timeout: 120_000 });
    // This deadline bounds CLI startup on cold/shared runners; it is not a
    // service shutdown or performance requirement. Report spawn/timeout errors
    // explicitly instead of a misleading null-versus-zero status assertion.
    const before = run(false);
    assert.ifError(before.error);
    assert.equal(before.status, 1);
    assert.match(before.stderr + before.stdout, /already in use/);
    const after = run(true);
    assert.ifError(after.error);
    assert.equal(after.status, 0, after.stderr + after.stdout);
    assert.equal(readFileSync(join(inherited, name), "utf8"), owner);
    assert.ok(JSON.parse(readFileSync(join(reports, "coverage-summary.json"), "utf8")).total);
    writeFileSync(join(local, name), owner);
    const conflicting = run(true);
    assert.ifError(conflicting.error);
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr + conflicting.stdout, /already in use/);
    assert.equal(readFileSync(join(local, name), "utf8"), owner);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
