'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { spawn } = require('node:child_process');
const { resolve } = require('node:path');
const root = resolve(__dirname, '../..');
const marker = 'FULL_TELEMETRY_FIXTURE';
const schema = require('protobufjs').parse(`syntax = "proto3";
message AnyValue { string stringValue=1; } message Attribute { string key=1; AnyValue value=2; }
message Span { string name=5; int32 kind=6; repeated Attribute attributes=9; }
message Scope { string name=1; } message ScopeSpans { Scope scope=1; repeated Span spans=2; }
message ResourceSpans { repeated ScopeSpans scopeSpans=2; } message Traces { repeated ResourceSpans resourceSpans=1; }
message LogRecord { int32 severityNumber=2; AnyValue body=5; } message ScopeLogs { repeated LogRecord logRecords=2; }
message ResourceLogs { repeated ScopeLogs scopeLogs=2; } message Logs { repeated ResourceLogs resourceLogs=1; }
`).root;
const fixture = `
import Fastify from ${JSON.stringify(resolve(root, 'apps/api/node_modules/fastify/fastify.js'))};
import { createRequire } from 'node:module';
const { get } = createRequire(import.meta.url)('node:http');
import { parseSecretReference } from ${JSON.stringify(resolve(root, 'packages/config/src/index.ts'))};
if (typeof parseSecretReference !== 'function') throw Error('workspace exports changed');
const app = Fastify({logger:true});
app.get('/test', async (req) => {
  req.log.error({err:new Error('${marker}_PINO_ERROR'), body:'${marker}_PINO_BODY'}, 'request failed');
  console.log(JSON.stringify({level:'warn',msg:'outbox.loop.failed',error:'${marker}_WORKER_ERROR'}));
  return {ok:true};
});
await app.listen({host:'127.0.0.1',port:0});
const origin = 'http://127.0.0.1:'+app.server.address().port;
await (await fetch(origin+'/test?detail=${marker}_FETCH')).text();
await new Promise((resolve,reject) => get(origin+'/test?detail=${marker}_HTTP', (res) => { res.resume(); res.on('end',resolve); }).on('error',reject));
await app.close();`;
function run(enabled, endpoint, cli = false, source = fixture, extraEnv = {}, signal = false) {
  return new Promise((resolveResult, reject) => {
    const args = cli ? [resolve(root, 'node_modules/tsx/dist/cli.mjs'), '--input-type=module', '-e', source]
      : ['--import', 'tsx', '--input-type=module', '-e', source];
    const child = spawn(resolve(__dirname, 'otel-wrapper.sh'), [process.execPath, ...args], {
      cwd: root, env: {...process.env, NODE_OPTIONS:'', OTEL_ENABLED:String(enabled),
        OTEL_SERVICE_NAME:'globalmpc-registry-api', OTEL_EXPORTER_OTLP_ENDPOINT:endpoint, ...extraEnv},
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (data) => { stdout += data; if (signal && stdout.includes('DRAIN_READY')) { signal = false; child.kill('SIGTERM'); } });
    child.stderr.on('data', (data) => { stderr += data; });
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(Error('runtime timeout')); }, 12000);
    child.on('exit', (code) => { clearTimeout(deadline); resolveResult({code,stdout,stderr}); });
    child.on('error', reject);
  });
}
test('full ESM/tsx traces and logs export once; off/outage remain usable', async (t) => {
  let batches = [];
  const server = createServer((req,res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => { batches.push({path:req.url,bytes:Buffer.concat(chunks)}); res.end(); });
  });
  await new Promise((resolveListen) => server.listen(0,'127.0.0.1',resolveListen));
  t.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  for (const cli of [false,true]) {
    batches = [];
    const result = await run(true, endpoint, cli);
    assert.equal(result.code,0,result.stderr);
    assert.doesNotMatch(result.stderr,/failed.to.wrap|import-in-the-middle|instrumentation unavailable/i);
    assert.ok(result.stdout.includes(marker),'original CloudWatch log is preserved');
    const traces = batches.filter((batch) => batch.path === '/v1/traces').flatMap((batch) =>
      schema.lookupType('Traces').decode(batch.bytes).resourceSpans.flatMap((resource) => resource.scopeSpans));
    assert.ok(traces.some((scope) => scope.scope.name.endsWith('-http') && scope.spans.some((span) => span.kind === 2)),'HTTP server spans');
    for (const name of ['http','undici']) {
      assert.ok(traces.some((scope) => scope.scope.name.endsWith('-'+name) && scope.spans.some((span) => span.kind === 3)),name+' outgoing span');
    }
    const traceBytes = Buffer.concat(batches.filter((batch) => batch.path === '/v1/traces').map((batch) => batch.bytes));
    assert.ok(traceBytes.includes(marker+'_FETCH') && traceBytes.includes(marker+'_HTTP'),'full URL/query attributes');
    const logBatches = batches.filter((batch) => batch.path === '/v1/logs');
    const records = logBatches.flatMap((batch) => schema.lookupType('Logs').decode(batch.bytes).resourceLogs
      .flatMap((resource) => resource.scopeLogs.flatMap((scope) => scope.logRecords)));
    const logs = Buffer.concat(logBatches.map((batch) => batch.bytes));
    assert.ok(logs.includes(marker+'_PINO_ERROR') && logs.includes(marker+'_PINO_BODY'),'full Pino error and body');
    assert.equal(records.filter((record) => record.body?.stringValue === 'request failed').length,2,'one Pino log per request');
    const workers = records.filter((record) => record.body?.stringValue?.includes('outbox.loop.failed'));
    assert.equal(workers.length,2,'one worker JSON log per request');
    assert.ok(workers.every((record) => record.body.stringValue.includes(marker+'_WORKER_ERROR') && record.severityNumber === 13),'full worker detail and WARN severity');
  }
  batches = [];
  assert.equal((await run(false,endpoint)).code,0);
  assert.equal(batches.length,0,'disabled SDK must not export');
  assert.equal((await run(true,'http://127.0.0.1:1')).code,0,'collector outage must not stop the app');
});

test('protected RPC/Safe origins never export credentials; ordinary requests still trace', async (t) => {
  const batches = [];
  const collector = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { batches.push(Buffer.concat(chunks)); res.end(); });
  });
  const target = createServer((req, res) => res.end('ok'));
  for (const server of [collector, target]) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
  }
  const endpoint = `http://127.0.0.1:${collector.address().port}`;
  const secretUrl = `http://127.0.0.1:${target.address().port}/rpc/FAKE_RPC_KEY?api_key=FAKE_QUERY_KEY`;
  const source = fixture.replace('await app.close();', `
    await (await fetch(${JSON.stringify(secretUrl)})).text();
    await new Promise((resolve,reject) => get(${JSON.stringify(secretUrl)}, res => {res.resume();res.on('end',resolve);}).on('error',reject));
    await app.close();`);
  const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
  const dir = mkdtempSync('/tmp/pr102-otel-');
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  writeFileSync(dir+'/endpoint', secretUrl+'\n');
  for (const env of [
    { CHAIN_RPC_URL: secretUrl },
    { SAFE_SERVICE_URL: secretUrl },
    { SAFE_SERVICE_URL: 'env:PROTECTED_SAFE', PROTECTED_SAFE: secretUrl },
    { SAFE_SERVICE_URL: 'file:'+dir+'/endpoint' },
  ]) {
    batches.length = 0;
    const result = await run(true, endpoint, false, source, env);
    assert.equal(result.code, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /instrumentation unavailable/);
    const exported = Buffer.concat(batches);
    assert.equal(exported.includes('FAKE_RPC_KEY'), false);
    assert.equal(exported.includes('FAKE_QUERY_KEY'), false);
    assert.ok(exported.includes(marker+'_FETCH'), 'unrelated HTTP URL metadata remains');
  }
});

test('SIGTERM keeps telemetry alive during drain and preserves explicit exit status', async (t) => {
  const batches = [];
  const collector = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {batches.push(Buffer.concat(chunks));res.end();});
  });
  await new Promise(resolve => collector.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => collector.close(resolve)));
  const source = `
    const keepAlive = setInterval(() => {}, 1000);
    process.on('SIGTERM', async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      console.log('FINAL_DRAIN_MARKER');
      clearInterval(keepAlive);
      await globalThis[Symbol.for('mpc.telemetry.shutdown')]?.();
      process.exit(7);
    });
    console.log('DRAIN_READY');`;
  const endpoint = `http://127.0.0.1:${collector.address().port}`;
  for (const cli of [false, true]) {
    batches.length = 0;
    const result = await run(true, endpoint, cli, source, {}, true);
    assert.equal(result.code, 7, result.stderr);
    assert.ok(result.stdout.includes('FINAL_DRAIN_MARKER'));
    assert.ok(Buffer.concat(batches).includes('FINAL_DRAIN_MARKER'), 'final drain log reaches collector');
    batches.length = 0;
    const natural = await run(true, endpoint, cli, source.replace("await globalThis[Symbol.for('mpc.telemetry.shutdown')]?.();", '').replace('process.exit(7);', 'process.exitCode = 7;'), {}, true);
    assert.equal(natural.code, 7, natural.stderr);
    assert.ok(Buffer.concat(batches).includes('FINAL_DRAIN_MARKER'));
    const started = Date.now();
    const outage = await run(true, 'http://127.0.0.1:1', cli, source, {}, true);
    assert.equal(outage.code, 7);
    assert.ok(Date.now()-started < 6000, 'collector failure has bounded exit');
  }
});


test('startup refusal exits synchronously before initialization or queued work', async (t) => {
  const { mkdtempSync, existsSync, rmSync } = require('node:fs');
  const dir = mkdtempSync('/tmp/otel-exit-contract-');
  t.after(() => rmSync(dir, {recursive:true,force:true}));
  for (const enabled of [false, true]) {
    for (const cli of [false, true]) {
      const sentinel = dir + '/' + enabled + '-' + cli;
      const source = `
        import { writeFileSync } from 'node:fs';
        console.log('STARTUP_REFUSED');
        setTimeout(() => writeFileSync(${JSON.stringify(sentinel)}, 'queued work ran'), 0);
        process.exit(1);
        writeFileSync(${JSON.stringify(sentinel)}, 'database initialization reached');`;
      const result = await run(enabled, 'http://127.0.0.1:1', cli, source);
      assert.equal(result.code, 1, result.stderr);
      assert.equal(existsSync(sentinel), false, 'process.exit must not return or run queued work');
    }
  }
});
