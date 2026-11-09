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
  stdio: 'inherit', detached: process.platform !== 'win32',
  env: { ...process.env, E2E_DIAGNOSTICS_DIR: directory },
});
let failed = false;
let shutdown;
let cancelled;
function stop(signal) {
  return shutdown ||= stopGroup(child.pid, signal, 10_000);
}
const monitor = setInterval(() => {
  if (failed || !readdirSync(directory).some(name => name.endsWith('-failure.json'))) return;
  failed = true;
  console.error('[e2e-process] A server exited unexpectedly; stopping this batch. See process diagnostics.');
  void stop('SIGTERM');
}, 200);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  cancelled ||= signal;
  void stop(signal);
});
child.once('error', error => { console.error(error.code); clearInterval(monitor); process.exitCode = 1; });
child.once('exit', async (code, signal) => {
  clearInterval(monitor);
  await stop('SIGTERM');
  // Playwright gives each webServer its own group. Its CLI can itself be killed,
  // so clean up only groups recorded by this invocation, including detached servers.
  const servers = readdirSync(directory).filter(name => name.endsWith('-process.jsonl')).map(name =>
    JSON.parse(readFileSync(join(directory, name), 'utf8').split('\n')[0]));
  await Promise.all(servers.map(stopRecordedServer));
  // A crash marker may arrive after the last poll or during teardown.
  failed ||= readdirSync(directory).some(name => name.endsWith('-failure.json'));
  process.exitCode = failed ? 1 : cancelled ? (cancelled === 'SIGINT' ? 130 : 143) : code ?? (signal ? 1 : 0);
});
