import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function signalGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
const inspectLinuxState = process.platform === 'linux' && existsSync('/proc/self/stat');
const terminated = state => state === 'Z' || state === 'X' || state === 'x';
function linuxState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm can contain spaces and parentheses; fields begin after its final ')'.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    return { state: fields[0], group: Number(fields[2]) };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    throw error;
  }
}
export function groupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(process.platform === 'win32' ? pid : -pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (!inspectLinuxState) return true;
  // The leader may already be dead while another member is still running.
  // Inspect the entire group; an unreaped zombie alone cannot retain resources.
  let unknown = false;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let member;
    try { member = linuxState(Number(entry)); }
    catch (error) {
      if (error.code !== 'EACCES' && error.code !== 'EPERM') throw error;
      unknown = true; continue;
    }
    if (member?.group === pid && !terminated(member.state)) return true;
  }
  // Hidden process state is not proof that cleanup succeeded.
  return unknown;
}
/** Parent exit never cancels the deadline: descendants can outlive it and keep pipes open. */
export async function stopGroup(pid, signal = 'SIGTERM', timeout = 5000) {
  signalGroup(pid, signal);
  const deadline = Date.now() + timeout;
  while (groupAlive(pid) && Date.now() < deadline) await delay(50);
  if (groupAlive(pid)) {
    signalGroup(pid, 'SIGKILL');
    const killDeadline = Date.now() + 5000;
    while (groupAlive(pid) && Date.now() < killDeadline) await delay(50);
    if (groupAlive(pid)) throw new Error(`Process group ${pid} did not terminate`);
  }
}
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
  if (!inspectLinuxState) return true;
  const processState = linuxState(pid);
  return processState !== null && !terminated(processState.state);
}
export async function stopRecordedServer(server, directory) {
  const acknowledgement = join(directory, `shutdown-${server.wrapperPid}.json`);
  try { process.kill(server.wrapperPid, 'SIGTERM'); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  // Sending a signal does not mean the wrapper's JS handler has run. Only its
  // acknowledgement establishes that child exit will be classified as requested.
  const acknowledgeDeadline = Date.now() + 5000;
  while (!existsSync(acknowledgement) && processAlive(server.wrapperPid) && Date.now() < acknowledgeDeadline) await delay(50);
  const acknowledged = existsSync(acknowledgement);
  if (!acknowledged) {
    // Do not let an unresponsive wrapper misclassify our fallback child signal.
    // An unconfirmed teardown fails the batch instead of assuming a clean exit.
    try { process.kill(server.wrapperPid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  await stopGroup(server.pid);
  // Wait for final crash markers before the controller decides the batch status.
  const deadline = Date.now() + 5000;
  while (processAlive(server.wrapperPid) && Date.now() < deadline) await delay(50);
  if (processAlive(server.wrapperPid)) {
    try { process.kill(server.wrapperPid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    return false;
  }
  return acknowledged;
}
