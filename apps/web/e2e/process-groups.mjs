import { setTimeout as delay } from 'node:timers/promises';

export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
/** Parent exit never cancels the deadline: descendants can outlive it and keep pipes open. */
export async function stopGroup(pid, signal = 'SIGTERM', timeout = 5000) {
  signalGroup(pid, signal);
  const deadline = Date.now() + timeout;
  while (groupAlive(pid) && Date.now() < deadline) await delay(50);
  if (groupAlive(pid)) signalGroup(pid, 'SIGKILL');
}
export async function stopRecordedServer(server) {
  try { process.kill(server.wrapperPid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await stopGroup(server.pid);
  // The wrapper writes its final marker synchronously before exiting. Wait for it
  // as well as its detached group before the controller makes its final decision.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { process.kill(server.wrapperPid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(50);
  }
  try { process.kill(server.wrapperPid, 'SIGKILL'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
