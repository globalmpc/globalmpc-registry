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

test('recorded cleanup waits for wrapper acknowledgement before signalling its child', { timeout: 5000 }, async t => {
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  const delayedWrapper=`const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
    let stopping=false;
    const server=spawn(process.execPath,['-e','console.log("READY");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','ignore']});
    const dir=process.env.E2E_DIAGNOSTICS_DIR;
    fs.writeFileSync(path.join(dir,'web-process.jsonl'),JSON.stringify({pid:server.pid,wrapperPid:process.pid})+'\\n');
    process.on('SIGTERM',()=>setTimeout(()=>{
      stopping=true;fs.writeFileSync(path.join(dir,'shutdown-'+process.pid+'.json'),'{}');
      try{process.kill(-server.pid,'SIGTERM');}catch{}
    },200));
    server.stdout.once('data',()=>console.log('READY'));
    server.on('exit',()=>{
      if(!stopping)fs.writeFileSync(path.join(dir,'web-failure.json'),'{}');
      process.exit(0);
    });`;
  writeFileSync(join(bin,'pnpm'), `#!/usr/bin/env node
    const {spawn}=require('node:child_process');
    const server=spawn(process.execPath,['-e',${JSON.stringify(delayedWrapper)}],{detached:true,stdio:['ignore','pipe','ignore']});
    server.stdout.once('data',()=>process.exit(0));
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:'ignore'});
  assert.equal((await wait(child)).code,0,'requested cleanup must not create a crash marker');
  const diagnostics=readdirSync(path).find(name=>name.startsWith('e2e-process-'));
  assert.equal(readdirSync(join(path,diagnostics)).includes('web-failure.json'),false);
});

test('an unresponsive wrapper receives bounded fallback cleanup and cannot report success', { timeout: 17_000 }, async t => {
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  const unresponsive=`const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
    process.on('SIGTERM',()=>{});
    const server=spawn(process.execPath,['-e','console.log("READY");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','ignore']});
    fs.writeFileSync(path.join(process.env.E2E_DIAGNOSTICS_DIR,'web-process.jsonl'),JSON.stringify({pid:server.pid,wrapperPid:process.pid})+'\\n');
    server.stdout.once('data',()=>console.log('READY'));
    setInterval(()=>{},1000);`;
  writeFileSync(join(bin,'pnpm'), `#!/usr/bin/env node
    const {spawn}=require('node:child_process');
    const server=spawn(process.execPath,['-e',${JSON.stringify(unresponsive)}],{detached:true,stdio:['ignore','pipe','ignore']});
    server.stdout.once('data',()=>process.exit(0));
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:'ignore'});
  assert.equal((await wait(child)).code,1,'unconfirmed shutdown is not a successful batch');
});

async function zombieGroup(t, path, childSource = 'process.exit(0)') {
  const holderSource = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e',${JSON.stringify(childSource)}],{detached:true,stdio:'ignore'});
    process.on('SIGTERM',()=>{});
    child.once('exit',()=>process.exit(0));
    console.log(JSON.stringify({pid:child.pid}));
    process.kill(process.pid,'SIGSTOP');`;
  const holder=spawn(process.execPath,['-e',holderSource],{stdio:['ignore','pipe','ignore']});
  const done=wait(holder);let pid;
  t.after(async()=>{
    if(pid)try{process.kill(-pid,'SIGKILL');}catch{}
    holder.kill('SIGCONT');
    await done;
  });
  let text='';
  pid=await new Promise(resolve=>holder.stdout.on('data',data=>{
    text+=data;if(text.includes('\n'))resolve(JSON.parse(text.split('\n')[0]).pid);
  }));
  const deadline=Date.now()+3000;
  while(Date.now()<deadline){
    try{
      const stat=readFileSync(`/proc/${pid}/stat`,'utf8');
      if(stat.slice(stat.lastIndexOf(')')+2).split(' ')[0]==='Z')return pid;
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  assert.fail('fixture did not retain an unreaped zombie');
}

if(process.platform==='linux'){
  test('an acknowledged zombie wrapper does not fail successful recorded cleanup', {timeout:8000}, async t=>{
    const path=directory(t);
    const {stopRecordedServer}=await import('./process-groups.mjs');
    const wrapperPid=await zombieGroup(t,path);
    writeFileSync(join(path,`shutdown-${wrapperPid}.json`),'{}');
    const server=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    const done=wait(server);
    t.after(()=>server.kill('SIGKILL'));
    assert.equal(await stopRecordedServer({wrapperPid,pid:server.pid},path),true);
    await done;
  });
  test('a zombie-only process group is already terminated', async t=>{
    const path=directory(t);
    const {groupAlive}=await import('./process-groups.mjs');
    const pid=await zombieGroup(t,path,'process.title="e2e ) zombie";process.exit(0)');
    assert.equal(groupAlive(pid),false);
  });
  test('a zombie leader does not hide a live SIGTERM-resistant descendant', async t=>{
    const path=directory(t);
    const {groupAlive,stopGroup}=await import('./process-groups.mjs');
    const descendant=`process.title='live ) worker';process.on('SIGTERM',()=>{});console.log('READY');setInterval(()=>{},1000);`;
    const source=`const {spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','pipe','ignore']});
      child.stdout.once('data',()=>process.exit(0));`;
    const pid=await zombieGroup(t,path,source);
    assert.equal(groupAlive(pid),true,'the descendant must still count as running');
    await stopGroup(pid,'SIGTERM',100);
    assert.equal(groupAlive(pid),false,'all live members must be gone after escalation');
  });
  test('a zombie wrapper without acknowledgement cannot turn teardown into success', async t=>{
    const path=directory(t);
    const {stopRecordedServer}=await import('./process-groups.mjs');
    const wrapperPid=await zombieGroup(t,path);
    const server=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    const done=wait(server);
    t.after(()=>server.kill('SIGKILL'));
    assert.equal(await stopRecordedServer({wrapperPid,pid:server.pid},path),false);
    await done;
  });

}

test('an incomplete process record fails the batch but does not bypass other server cleanup', async t=>{
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  writeFileSync(join(bin,'pnpm'), `#!/usr/bin/env node
    const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
    const server=spawn(process.execPath,[${JSON.stringify(wrapper)},'web',process.execPath,'-e','console.log("READY");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','ignore']});
    server.stdout.once('data',()=>{
      fs.writeFileSync(path.join(process.env.E2E_DIAGNOSTICS_DIR,'broken-process.jsonl'),'{');process.exit(0);
    });
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:'ignore'});
  assert.equal((await wait(child)).code,1);
  const diagnostics=join(path,readdirSync(path).find(name=>name.startsWith('e2e-process-')));
  const server=JSON.parse(readFileSync(join(diagnostics,'web-process.jsonl'),'utf8').split('\n')[0]);
  assert.equal(readdirSync(diagnostics).includes(`shutdown-${server.wrapperPid}.json`),true);
  assert.throws(()=>process.kill(server.pid,0),{code:'ESRCH'});
});

for(const trigger of ['cancellation','monitor']){
  test(`cleanup rejection during ${trigger} still cleans recorded servers without CLI exit`, {timeout:5000}, async t=>{
    const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
    const helper=new URL('./process-groups.mjs',import.meta.url).href;
    const replacement=`export {stopRecordedServer} from ${JSON.stringify(helper+'?actual')};
      import {stopGroup as realStop} from ${JSON.stringify(helper+'?actual')};
      import {readFileSync} from 'node:fs';
      export async function stopGroup(pid,...args){
        if(pid===Number(readFileSync(process.env.TEST_CLI_PID,'utf8')))throw new Error('injected cleanup rejection');
        return realStop(pid,...args);
      }`;
    const loader=join(path,'inject.mjs');
    writeFileSync(loader,`import {registerHooks} from 'node:module';
      registerHooks({load(url,context,next){return url===${JSON.stringify(helper)}?{format:'module',source:${JSON.stringify(replacement)},shortCircuit:true}:next(url,context);}});`);
    const cliPidFile=join(path,'cli.pid');
    writeFileSync(join(bin,'pnpm'),`#!/usr/bin/env node
      const {spawn}=require('node:child_process'),fs=require('node:fs');
      fs.writeFileSync(process.env.TEST_CLI_PID,String(process.pid));
      process.on('SIGTERM',()=>{});
      const server=spawn(process.execPath,[${JSON.stringify(wrapper)},'web',process.execPath,'-e','console.log("READY");setInterval(()=>{},1000)'],{detached:true,stdio:['ignore','pipe','ignore']});
      server.stdout.once('data',()=>console.log('CLI_READY'));
      setInterval(()=>{},1000);`,{mode:0o755});
    const child=spawn(process.execPath,['--import',loader,runner],{env:{...process.env,CI_TEMP_DIR:path,TEST_CLI_PID:cliPidFile,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
    let records=[];let cliPid;
    t.after(()=>{
      child.kill('SIGKILL');
      if(cliPid)try{process.kill(-cliPid,'SIGKILL');}catch{}
      for(const server of records){try{process.kill(server.wrapperPid,'SIGKILL');}catch{}try{process.kill(-server.pid,'SIGKILL');}catch{}}
    });
    const done=wait(child);const closed=new Promise(resolve=>child.once('close',resolve));
    let stdout='';let stderr='';child.stderr.on('data',data=>stderr+=data);
    await new Promise(resolve=>child.stdout.on('data',data=>{stdout+=data;if(stdout.includes('CLI_READY'))resolve();}));
    const diagnostics=join(path,readdirSync(path).find(name=>name.startsWith('e2e-process-')));
    records=readdirSync(diagnostics).filter(name=>name.endsWith('-process.jsonl')).map(name=>JSON.parse(readFileSync(join(diagnostics,name),'utf8').split('\n')[0]));
    cliPid=Number(readFileSync(cliPidFile,'utf8'));
    if(trigger==='cancellation')child.kill('SIGTERM');else writeFileSync(join(diagnostics,'injected-failure.json'),'{}');
    assert.equal((await done).code,1);
    assert.doesNotThrow(()=>process.kill(cliPid,0),'fixture CLI must not have exited');
    let deadline;
    try { await Promise.race([closed,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('stuck CLI retained controller output')),1000);})]); }
    finally { clearTimeout(deadline); }
    assert.doesNotMatch(stderr,/injected cleanup rejection/,'cleanup failure must be caught, not an unhandled rejection');
    for(const server of records)assert.equal(readdirSync(diagnostics).includes(`shutdown-${server.wrapperPid}.json`),true,'cleanup must run even without CLI exit');
    const {groupAlive}=await import('./process-groups.mjs');
    for(const server of records)assert.equal(groupAlive(server.pid),false);
  });
}

test('the server wrapper handles cleanup rejection and releases a stuck child handle', {timeout:5000}, async t=>{
  const path=directory(t);const helper=new URL('./process-groups.mjs',import.meta.url).href;
  const loader=join(path,'reject-wrapper.mjs');
  writeFileSync(loader,`import {registerHooks} from 'node:module';
    registerHooks({load(url,context,next){return url===${JSON.stringify(helper)}?{format:'module',source:'export async function stopGroup(){throw new Error("injected wrapper cleanup rejection");}',shortCircuit:true}:next(url,context);}});`);
  const child=spawn(process.execPath,['--import',loader,wrapper,'web',process.execPath,'-e','process.on("SIGTERM",()=>{});console.log("READY");setInterval(()=>{},1000)'],{
    env:{...process.env,E2E_DIAGNOSTICS_DIR:path},stdio:['ignore','pipe','pipe'],
  });
  let serverPid;let stderr='';child.stderr.on('data',data=>stderr+=data);
  t.after(()=>{child.kill('SIGKILL');if(serverPid)try{process.kill(-serverPid,'SIGKILL');}catch{}});
  const done=wait(child);
  await new Promise(resolve=>child.stdout.once('data',resolve));
  serverPid=JSON.parse(readFileSync(join(path,'web-process.jsonl'),'utf8').split('\n')[0]).pid;
  child.kill('SIGTERM');
  assert.equal((await done).code,1);
  assert.equal(readdirSync(path).includes('web-cleanup-failure.json'),true);
  assert.match(stderr,/cleanup failed/);
  assert.doesNotMatch(stderr,/injected wrapper cleanup rejection/);
});

test('a CLI spawn error uses the same unsuccessful finalization path', {timeout:5000}, async t=>{
  const path=directory(t);const bin=join(path,'empty-bin');mkdirSync(bin);
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin},stdio:'ignore'});
  assert.equal((await wait(child)).code,1);
});

for (const stream of ['stdout', 'stderr']) {
  for (const brokenRecord of [false, true]) {
    test(`detached ${stream} holder cannot retain finalization (broken record: ${brokenRecord})`, {timeout:6000}, async t=>{
      const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
      const pidFile=join(path,'holder.pid');
      const holder=`setInterval(()=>{},1000);`;
      writeFileSync(join(bin,'pnpm'),`#!/usr/bin/env node
        const {spawn}=require('node:child_process'),fs=require('node:fs'),path=require('node:path');
        const holder=spawn(process.execPath,['-e',${JSON.stringify(holder)}],{
          detached:true,stdio:['ignore',${stream==='stdout' ? "'inherit'" : "'ignore'"},${stream==='stderr' ? "'inherit'" : "'ignore'"}]
        });
        fs.writeFileSync(${JSON.stringify(pidFile)},String(holder.pid));
        ${brokenRecord ? "fs.writeFileSync(path.join(process.env.E2E_DIAGNOSTICS_DIR,'broken-process.jsonl'),'{');" : ''}
        holder.unref();process.exit(0);
      `,{mode:0o755});
      const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
      child.stdout.resume();child.stderr.resume();
      const done=wait(child);const closed=new Promise(resolve=>child.once('close',resolve));
      t.after(()=>{
        child.kill('SIGKILL');
        try{process.kill(-Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch{}
      });
      let deadline;
      try {
        const result=await Promise.race([done,new Promise((_,reject)=>{
          deadline=setTimeout(()=>reject(new Error('detached output pipe retained controller')),3500);
        })]);
        assert.equal(result.code,1,'abandoned output must fail even after a successful CLI exit');
        await closed;
        assert.doesNotThrow(()=>process.kill(Number(readFileSync(pidFile,'utf8')),0),'holder must still be alive to reproduce an escaped pipe');
      } finally {clearTimeout(deadline);}
    });
  }
}

test('a detached descendant can flush final output within the drain deadline', {timeout:5000}, async t=>{
  const path=directory(t);const bin=join(path,'bin');mkdirSync(bin);
  const holder=`setTimeout(()=>{console.log('FINAL_STDOUT');console.error('FINAL_STDERR');},200);`;
  const pidFile=join(path,'holder.pid');
  writeFileSync(join(bin,'pnpm'),`#!/usr/bin/env node
    const {spawn}=require('node:child_process'),fs=require('node:fs');
    const holder=spawn(process.execPath,['-e',${JSON.stringify(holder)}],{detached:true,stdio:'inherit'});
    fs.writeFileSync(${JSON.stringify(pidFile)},String(holder.pid));
    holder.unref();process.exit(0);
  `,{mode:0o755});
  const child=spawn(process.execPath,[runner],{env:{...process.env,CI_TEMP_DIR:path,PATH:bin+':'+process.env.PATH},stdio:['ignore','pipe','pipe']});
  t.after(()=>{child.kill('SIGKILL');try{process.kill(-Number(readFileSync(pidFile,'utf8')),'SIGKILL');}catch{}});
  let stdout='',stderr='';child.stdout.on('data',data=>stdout+=data);child.stderr.on('data',data=>stderr+=data);
  const closed=new Promise(resolve=>child.once('close',resolve));
  assert.equal((await wait(child)).code,0);
  await closed;
  assert.match(stdout,/FINAL_STDOUT/);assert.match(stderr,/FINAL_STDERR/);
});
