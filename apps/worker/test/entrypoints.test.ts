import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Worker entrypoints load.
 *
 * The entrypoints run through `tsx`, which strips types without checking them. A name used but
 * never imported therefore passes the build and the unit tests, and the container dies at
 * startup with a `ReferenceError` — typecheck is the only other place it shows. That happened:
 * `main.ts` called `resolveSecret` after a merge dropped it from the import line.
 *
 * Each entrypoint is started with an empty environment. It must stop at its own configuration
 * check — a clean refusal — and not at a load-time error. Nothing here needs a database.
 */

const WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TSX = path.resolve(WORKER, "../../node_modules/.bin/tsx");

/** Errors that mean the module did not load, as opposed to refusing its configuration. */
const LOAD_FAILURE = /ReferenceError|SyntaxError|is not defined|is not a function|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND/;

function start(entrypoint: string): { readonly status: number | null; readonly stderr: string } {
  const result = spawnSync(TSX, [`src/${entrypoint}`], {
    cwd: WORKER,
    env: { PATH: process.env["PATH"] ?? "", HOME: process.env["HOME"] ?? "" },
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, stderr: result.stderr };
}

describe("worker entrypoints", () => {
  it.each([
    ["main.ts", /DATABASE_URL/],
    ["anchor-main.ts", /is required/],
    ["scan-main.ts", /SecretResolutionError/],
  ])("%s refuses an empty environment at its configuration check", { timeout: 40_000 }, (entrypoint, refusal) => {
    const { status, stderr } = start(entrypoint);
    expect(stderr).not.toMatch(LOAD_FAILURE);
    expect(stderr).toMatch(refusal);
    expect(status).toBe(1);
  });
});
