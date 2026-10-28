import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import ts from "typescript";

/**
 * Workflow source runs in Javy/QuickJS, not Node. tsconfig.src.json drops Node types so
 * the SDK's restricted declarations apply; this proves Node APIs in src/ fail typecheck.
 */
const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/node-globals.ts", import.meta.url));

function diagnosticLines(configName: string): Set<number> {
  const host = { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined };
  const parsed = ts.getParsedCommandLineOfConfigFile(`${packageRoot}${configName}`, { noEmit: true }, host);
  if (!parsed) throw new Error(`cannot parse ${configName}`);
  const program = ts.createProgram([...parsed.fileNames, fixture], parsed.options);
  const source = program.getSourceFile(fixture)!;
  return new Set(ts.getPreEmitDiagnostics(program, source)
    .filter((diagnostic) => diagnostic.file === source && diagnostic.start !== undefined)
    .map((diagnostic) => source.getLineAndCharacterOfPosition(diagnostic.start!).line + 1));
}

describe("workflow runtime types", () => {
  test("src/ rejects Node globals and built-in modules", () => {
    const lines = diagnosticLines("tsconfig.src.json");
    // fetch, setTimeout, process, readFileSync (node:fs is `never`).
    for (const line of [6, 7, 8, 9]) expect(lines, `line ${line}`).toContain(line);
  }, 120_000);

  test("the test project keeps Node types, so the restriction is what src/ adds", () => {
    const lines = diagnosticLines("tsconfig.json");
    expect(lines).not.toContain(7);
    expect(lines).not.toContain(8);
  }, 120_000);
});
