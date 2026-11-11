import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

// Vitest's coverage lock uses a PID and report-path hash in os.tmpdir(). Runner
// restarts can reuse both without owning the old lock. Keep the namespace in the
// checkout, where normal clean checkout removes it along with node_modules.
// This is deliberately NOT unique per invocation: concurrent coverage runs in
// one checkout must still contend for the same lock and cannot erase each other.
const directory = resolve("node_modules/.cache/vitest-temp");
mkdirSync(directory, { recursive: true });
process.env.TMPDIR = directory;
process.env.TMP = directory;
process.env.TEMP = directory;
