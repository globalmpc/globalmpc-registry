import { stopGroup, stopRecordedServer } from './process-groups.mjs';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = process.env.CI_TEMP_DIR || tmpdir();
mkdirSync(root, { recursive: true });
const directory = mkdtempSync(join(root, 'e2e-process-'));
console.log(`[e2e-process] diagnostics: ${directory}`);
const child = spawn('pnpm', ['exec', 'playwright', 'test', ...process.argv.slice(2)], {
  stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32',
  env: { ...process.env, E2E_DIAGNOSTICS_DIR: directory },
});
let failed = false;
let cancelled;
let childEnded = false;
let childCode;
let childSignal;
let finalizing;
function entries() {
  try { return readdirSync(directory); }
  catch { failed = true; console.error('[e2e-process] Cannot read process diagnostics.'); return []; }
}
async function cleanupRecordedServers() {
  const servers = [];
  for (const name of entries().filter(name => name.endsWith('-process.jsonl'))) {
    try { servers.push(JSON.parse(readFileSync(join(directory, name), 'utf8').split('\n')[0])); }
    catch { failed = true; console.error('[e2e-process] Incomplete server record; continuing other cleanup.'); }
  }
  const results = await Promise.allSettled(servers.map(server => stopRecordedServer(server, directory)));
  failed ||= results.some(result => result.status === 'rejected' || !result.value);
}
function finalize() {
  // Start cleanup from every terminal path, not just the CLI's exit event. The
  // cached promise owns its rejection handler before any signal callback returns.
  return finalizing ||= (async () => {
    clearInterval(monitor);
    let groupStopped = false;
    try { await stopGroup(child.pid, cancelled || 'SIGTERM', 10_000); groupStopped = true; }
    catch { failed = true; console.error('[e2e-process] Test group cleanup failed; continuing recorded-server cleanup.'); }
    await cleanupRecordedServers();
    failed ||= entries().some(name => name.endsWith('-failure.json'));
    const status = failed ? 1 : cancelled ? (cancelled === 'SIGINT' ? 130 : 143) : childCode ?? (childSignal ? 1 : 0);
    // Uninterruptible CLI I/O can retain the ChildProcess handle indefinitely.
    // Only after recorded-server cleanup, fail and release this controller.
    if (!groupStopped || !childEnded) {
      child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
      process.exitCode = status || 1;
    } else process.exitCode = status;
  })().catch(() => {
    console.error('[e2e-process] Finalization failed.');
    child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    process.exitCode = 1;
  });
}
const monitor = setInterval(() => {
  if (finalizing) return;
  const names = entries();
  if (!failed && !names.some(name => name.endsWith('-failure.json'))) return;
  failed = true;
  console.error('[e2e-process] A server exited unexpectedly; stopping this batch. See process diagnostics.');
  void finalize();
}, 200);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  cancelled ||= signal;
  process.exitCode = failed ? 1 : cancelled === 'SIGINT' ? 130 : 143;
  void finalize();
});
child.once('error', error => {
  console.error(error.code); failed = true; childEnded = true;
  void finalize();
});
child.once('exit', (code, signal) => {
  childEnded = true; childCode = code; childSignal = signal;
  void finalize();
});
// Keep descendant output on owned pipes, so an uninterruptible CLI cannot keep
// the Actions step's stdout/stderr descriptors open after this controller leaves.
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
