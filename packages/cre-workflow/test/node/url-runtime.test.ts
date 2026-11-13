import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { build } from "vite";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const protocol = fileURLToPath(new URL("../../src/protocol.ts", import.meta.url));

test("loads the real protocol and URL dependency with no URL global at startup", async () => {
  // Bundle without evaluating dependencies, then load the whole graph in a fresh
  // process. A TS loader itself needs URL, so it cannot run inside this sandbox.
  const output = await build({
    configFile: false, envFile: false, logLevel: "silent", root,
    build: { write: false, minify: false,
      lib: { entry: protocol, formats: ["iife"], name: "ProtocolUnderTest" } },
  });
  const bundles = Array.isArray(output) ? output : [output];
  const code = bundles.flatMap(bundle => "output" in bundle ? bundle.output : [])
    .filter(chunk => chunk.type === "chunk").map(chunk => chunk.code).join("\n");
  expect(code.length).toBeGreaterThan(0);
  const result = spawnSync(process.execPath, ["--input-type=commonjs"], {
    cwd: root, encoding: "utf8", timeout: 30_000, input: `
    const assert = require('node:assert/strict');
    for (const name of ["fetch", "Request", "Response", "Headers"]) delete globalThis[name];
    delete globalThis.URL;
    delete globalThis.URLSearchParams;
    assert.equal(typeof globalThis.URL, 'undefined');
    ${code}
    const { validateConfig, ERRORS } = ProtocolUnderTest;
    assert.equal(typeof globalThis.URL, 'undefined', 'pure parser must not install a global');
    const path = '/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports';
    const config = {
      schedule: '0 */5 * * * *', reportUrl: 'https://registry.example' + path,
      publicKey: 'synthetic-runtime-regression', chainName: 'binance_smart_chain-testnet',
      chainId: '97', receiver: '0x' + 'ab'.repeat(20), ttlSeconds: '300', gasLimit: '500000',
    };
    assert.equal(validateConfig(config).reportUrl, config.reportUrl);
    const local = { ...config, reportUrl: 'http://127.0.0.1:34149' + path, allowLocalHttp: true };
    assert.equal(validateConfig(local).reportUrl, local.reportUrl);
    for (const origin of ['https://999.1.1.1', 'https://[:::1]', 'https://user:password@registry.example']) {
      assert.throws(() => validateConfig({ ...config, reportUrl: origin + path }), { message: ERRORS.endpoint });
    }
    assert.throws(() => validateConfig({ ...local, allowLocalHttp: false }), { message: ERRORS.https });
    assert.throws(() => validateConfig({ ...local, reportUrl: 'http://127.0.0.2' + path }), { message: ERRORS.https });
    console.log('isolated startup validation passed');
  ` });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain("isolated startup validation passed");
}, 35_000);
