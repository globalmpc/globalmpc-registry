import { loadConfig } from "./config.js";
import { createDb } from "./db.js";
import { buildServer } from "./server.js";
import { createOidcTestRelayFetch } from "./services/oidc-test-relay.js";

const config = loadConfig(process.env);
const sql = createDb(config);
// E2E only: the relay that stands in for Google and Microsoft. `loadConfig` refuses it in
// production and on mainnet, so a deployed API always reaches the real providers.
const app = await buildServer(
  config,
  sql,
  config.oidcTestRelayUrl ? { oidcFetch: createOidcTestRelayFetch(config.oidcTestRelayUrl) } : {},
);

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
      let exitCode = 0;
      try {
        await app.close();
        await sql.end({ timeout: 5 });
      } catch (error) {
        app.log.error({ err: error }, "graceful shutdown failed");
        exitCode = 1;
      }
      // The isolated preload owns the SDK. Await its bounded flush only after the
      // application has drained; startup refusal paths keep native synchronous exit.
      const shutdownTelemetry = (globalThis as Record<symbol, unknown>)[Symbol.for("mpc.telemetry.shutdown")];
      if (typeof shutdownTelemetry === "function") await shutdownTelemetry();
      process.exit(exitCode);
    })();
  });
}
