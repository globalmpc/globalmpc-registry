import { stopGroup } from './process-groups.mjs';
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [label, command, ...args] = process.argv.slice(2);
if (!label || !command) throw new Error('usage: server-process.mjs LABEL COMMAND [ARGS...]');
const directory = process.env.E2E_DIAGNOSTICS_DIR;
const record = (event) => {
  const line = JSON.stringify({ time: new Date().toISOString(), service: label, ...event }) + '\n';
  if (directory) appendFileSync(join(directory, `${label}-process.jsonl`), line);
};
function memory() {
  const values = {};
  for (const name of ['memory.current', 'memory.peak', 'memory.max', 'memory.events']) {
    try { values[name] = readFileSync(`/sys/fs/cgroup/${name}`, 'utf8').trim(); } catch { /* Non-Linux runner. */ }
  }
  // Read only PID relationships and RSS, never command arguments or environment values.
  try {
    const rows = execFileSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8', timeout: 1000 })
      .trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const owned = new Set([process.pid]);
    let changed;
    do {
      changed = false;
      for (const [pid, parent] of rows) if (owned.has(parent) && !owned.has(pid)) { owned.add(pid); changed = true; }
    } while (changed);
    values.processes = rows.filter(([pid]) => owned.has(pid)).map(([pid, ppid, rssKiB]) => ({ pid, ppid, rssKiB }));
  } catch { /* Diagnostics must not change server behavior. */ }
  return values;
}
let stopping = false;
let shutdown;
let cleanupFailed = false;
const child = spawn(command, args, { stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32' });

function requestStop(signal) {
  return shutdown ||= stopGroup(child.pid, signal).catch(error => {
    cleanupFailed = true;
    const event = { event: 'cleanup-failure', error: error.code || error.name };
    try {
      record(event);
      if (directory) writeFileSync(join(directory, `${label}-cleanup-failure.json`), JSON.stringify(event));
    } catch { console.error(`[e2e-service] ${label} cleanup diagnostics unavailable`); }
    console.error(`[e2e-service] ${label} cleanup failed`);
    process.exitCode = 1;
    // A child that could not terminate must not retain the wrapper forever.
    child.stdout.destroy(); child.stderr.destroy(); child.unref();
  });
}
const timer = setInterval(() => record({ event: 'sample', memory: memory() }), 2000);
timer.unref();
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  record({ event: 'requested-stop', signal });
  if (directory) writeFileSync(join(directory, `shutdown-${process.pid}.json`), JSON.stringify({ signal }));
  void requestStop(signal);
});
// Install shutdown handlers before forwarding readiness output to the test controller.
record({ event: 'start', pid: child.pid, wrapperPid: process.pid, memory: memory() });
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
function finish(code, signal, error) {
  clearInterval(timer);
  void requestStop('SIGTERM');
  const event = { event: 'exit', code, signal, expected: stopping, error: error?.code, memory: memory() };
  record(event);
  if (!stopping && directory) writeFileSync(join(directory, `${label}-failure.json`), JSON.stringify(event));
  console.error(`[e2e-service] ${label} exited: code=${code} signal=${signal} expected=${stopping}`);
  process.exitCode = cleanupFailed ? 1 : code || (signal || error ? 1 : 0);
}
child.once('error', error => finish(null, null, error));
child.once('exit', (code, signal) => finish(code, signal));
