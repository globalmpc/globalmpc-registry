import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const wrapper = fileURLToPath(new URL('./server-process.mjs', import.meta.url));
const runner = fileURLToPath(new URL('./run-playwright.mjs', import.meta.url));
const wait = child => new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal })); });
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'e2e-monitor-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test('records unexpected exit code and baseline without copying environment secrets', async t => {
  const path = directory(t);
  const child = spawn(process.execPath, [wrapper, 'web', process.execPath, '-e', 'process.exit(17)'], {
    env: { ...process.env, E2E_DIAGNOSTICS_DIR: path, PRIVATE_VALUE: 'do-not-record-this' }, stdio: 'ignore',
  });
  assert.equal((await wait(child)).code, 17);
  const failure = JSON.parse(readFileSync(join(path, 'web-failure.json'), 'utf8'));
  assert.equal(failure.code, 17); assert.equal(failure.expected, false);
  const records = readFileSync(join(path, 'web-process.jsonl'), 'utf8');
  assert.match(records, /"event":"start"/); assert.match(records, /"event":"exit"/);
  assert.doesNotMatch(records, /do-not-record-this|PRIVATE_VALUE/);
});
test('records SIGKILL separately from an ordinary nonzero exit', async t => {
  const path = directory(t);
  const child = spawn(process.execPath, [wrapper, 'web', process.execPath, '-e', 'process.kill(process.pid, "SIGKILL")'], {
    env: { ...process.env, E2E_DIAGNOSTICS_DIR: path }, stdio: 'ignore',
  });
  assert.equal((await wait(child)).code, 1);
  const failure = JSON.parse(readFileSync(join(path, 'web-failure.json'), 'utf8'));
  assert.equal(failure.signal, 'SIGKILL'); assert.equal(failure.code, null);
});
test('requested shutdown forwards the signal and is not a server failure', async t => {
  const path = directory(t);
  const child = spawn(process.execPath, [wrapper, 'web', process.execPath, '-e', 'console.log("READY"); setInterval(()=>{},1000)'], {
    env: { ...process.env, E2E_DIAGNOSTICS_DIR: path }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const done = wait(child);
  await new Promise(resolve => child.stdout.once('data', resolve)); child.kill('SIGTERM');
  await done;
  assert.equal(readdirSync(path).includes('web-failure.json'), false);
  assert.match(readFileSync(join(path, 'web-process.jsonl'), 'utf8'), /"expected":true/);
});
test('a server crash aborts the owned test process instead of waiting for later tests', async t => {
  const path = directory(t); const bin = join(path, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env node
    const {spawn}=require('node:child_process');
    spawn(process.execPath,[${JSON.stringify(wrapper)},'web',process.execPath,'-e','process.exit(23)'],{stdio:'ignore'});
    setInterval(()=>{},1000);
  `, { mode: 0o755 });
  const child = spawn(process.execPath, [runner], { env: { ...process.env, CI_TEMP_DIR: path, PATH: bin + ':' + process.env.PATH }, stdio: 'ignore' });
  const kill = setTimeout(() => child.kill('SIGKILL'), 10_000);
  try { assert.equal((await wait(child)).code, 1); } finally { clearTimeout(kill); }
  const diagnostics = readdirSync(path).find(name => name.startsWith('e2e-process-'));
  assert.equal(JSON.parse(readFileSync(join(path, diagnostics, 'web-failure.json'), 'utf8')).code, 23);
});

test('normal test completion also cleans up a detached server', async t => {
  const path = directory(t); const bin = join(path, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'pnpm'), `#!/usr/bin/env node
    const {spawn}=require('node:child_process');
    const server=spawn(process.execPath,[${JSON.stringify(wrapper)},'web',process.execPath,'-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    server.unref(); setTimeout(()=>process.exit(0),300);
  `, { mode: 0o755 });
  const child = spawn(process.execPath, [runner], { env: { ...process.env, CI_TEMP_DIR: path, PATH: bin + ':' + process.env.PATH }, stdio: 'ignore' });
  assert.equal((await wait(child)).code, 0);
  const diagnostics = readdirSync(path).find(name => name.startsWith('e2e-process-'));
  const start=JSON.parse(readFileSync(join(path,diagnostics,'web-process.jsonl'),'utf8').split('\n')[0]);
  assert.throws(()=>process.kill(start.pid,0), { code: 'ESRCH' });
});

test('a terminating parent cannot cancel escalation for its SIGTERM-resistant descendant', { timeout: 12_000 }, async t => {
  const path = directory(t);
  const descendant = `process.on('SIGTERM',()=>{}); console.log('DESCENDANT_READY'); setInterval(()=>{},1000);`;
  const parent = `const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'inherit'});
    require('node:fs').writeFileSync(${JSON.stringify(join(path, 'descendant.pid'))},String(c.pid));
    setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, [wrapper, 'web', process.execPath, '-e', parent], {
    env: { ...process.env, E2E_DIAGNOSTICS_DIR: path }, stdio: ['ignore', 'pipe', 'ignore'],
  });
  t.after(() => {
    try { process.kill(Number(readFileSync(join(path,'descendant.pid'),'utf8')), 'SIGKILL'); } catch {}
    child.kill('SIGKILL');
  });
  const done=wait(child);
  await new Promise(resolve=>child.stdout.once('data',resolve));
  child.kill('SIGTERM');
  const result=await Promise.race([done,new Promise(resolve=>setTimeout(()=>resolve(null),6500))]);
  assert.notEqual(result,null,'wrapper must escalate even after its immediate child has exited');
  if (!child.stdout.readableEnded) await new Promise(resolve=>child.stdout.once('end',resolve));
});

test('external cancellation escalates for a test CLI that ignores SIGTERM', { timeout: 16_000 }, async t => {
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'pnpm'), `#!/usr/bin/env node
    require('node:fs').writeFileSync(${JSON.stringify(join(path,'cli.pid'))},String(process.pid));
    process.on('SIGTERM',()=>{});console.log('CLI_READY');setInterval(()=>{},1000);
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','ignore']});
  t.after(()=>{
    child.kill('SIGKILL');
    try { process.kill(Number(readFileSync(join(path,'cli.pid'),'utf8')),'SIGKILL'); } catch {}
  });
  const done=wait(child);
  await new Promise(resolve=>child.stdout.on('data',data=>{if(data.toString().includes('CLI_READY'))resolve();}));
  child.kill('SIGTERM');
  const result=await Promise.race([done,new Promise(resolve=>setTimeout(()=>resolve(null),12_000))]);
  assert.notEqual(result,null,'cancellation must have a deadline');
  assert.notEqual(result.code,0,'cancelled runs cannot report success');
});

test('a failure marker written just before successful CLI exit still fails the batch', async t => {
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'pnpm'), `#!/usr/bin/env node
    const fs=require('node:fs'),path=require('node:path');
    fs.writeFileSync(path.join(process.env.E2E_DIAGNOSTICS_DIR,'web-failure.json'),'{}');
    process.exit(0);
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:'ignore'});
  assert.equal((await wait(child)).code,1);
});

test('cancellation remains unsuccessful even when the CLI handles SIGTERM with exit zero', async t => {
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'pnpm'), `#!/usr/bin/env node
    process.on('SIGTERM',()=>process.exit(0));console.log('CLI_READY');setInterval(()=>{},1000);
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','ignore']});
  const done=wait(child);
  await new Promise(resolve=>child.stdout.on('data',data=>{if(data.toString().includes('CLI_READY'))resolve();}));
  child.kill('SIGTERM');
  assert.equal((await done).code,143);
});

test('a marker created during recorded-server cleanup overrides a successful CLI exit', async t => {
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  const source=`const fs=require('node:fs'),path=require('node:path');
    process.on('SIGTERM',()=>{fs.writeFileSync(path.join(process.env.E2E_DIAGNOSTICS_DIR,'late-failure.json'),'{}');process.exit(0);});
    console.log('READY');setInterval(()=>{},1000);`;
  writeFileSync(join(bin,'pnpm'), `#!/usr/bin/env node
    const {spawn}=require('node:child_process');
    const server=spawn(process.execPath,[${JSON.stringify(wrapper)},'web',process.execPath,'-e',${JSON.stringify(source)}],{stdio:['ignore','pipe','ignore']});
    server.stdout.once('data',()=>process.exit(0));
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:'ignore'});
  assert.equal((await wait(child)).code,1);
});
