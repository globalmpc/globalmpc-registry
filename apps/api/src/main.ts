import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { buildServer } from "./server.js";

const config = loadConfig(process.env);
const sql = createDb(config);
const app = await buildServer(config, sql);

// Log once at startup which secret was read via which path. Scheme and fingerprint, not the
// value — when operations asks "which key is in use right now", the answer must be in the
// logs, and the logs must not become a leak path.
app.log.info({ secrets: config.secretAudit }, "secret sources resolved");

await app.listen({ port: config.port, host: "0.0.0.0" });

/**
 * Shutdown handling.
 *
 * Container orchestrators send SIGTERM, then SIGKILL after a fixed period. If in-flight
 * requests do not finish, clients mistake the dropped connection for something to retry —
 * Idempotency-Key on mutations prevents duplicates, but attempting a graceful shutdown first
 * is still right.
 */
let shuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // Ignore a second signal. Calling close() again during shutdown throws.
    if (shuttingDown) return;
    shuttingDown = true;

    void (async () => {
      try {
        await app.close();
        await sql.end({ timeout: 5 });
        process.exit(0);
      } catch (error) {
        app.log.error({ err: error }, "graceful shutdown failed");
        process.exit(1);
      }
    })();
  });
}
