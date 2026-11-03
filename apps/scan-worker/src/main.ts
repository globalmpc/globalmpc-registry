import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { createMemoryObjectStore, createS3ObjectStore } from "@mpc/storage";
import { DEFAULT_SCANNER_OPTIONS, scanBytes, scannerAvailable } from "./scanner.js";
import { resolveScanTenant, scanBacklog, scanOnce } from "./scan-worker.js";
import { createApiClient } from "./api-client.js";
import { createUnauthorizedBackoff } from "./auth-backoff.js";
import { createHeartbeat } from "@mpc/db";

/**
 * Virus scan worker.
 *
 * Claims quarantined uploads one at a time and hands them to ClamAV. This process is separate so
 * that infected file bytes never pass through the API process.
 *
 * Uses **the same storage config** as the API. If it differed, the worker would see another
 * bucket and the scan queue would grow with no visible cause.
 *
 * Results are reported through the API — so state machine checks, audit records, and If-Match
 * are not bypassed. The worker authenticates with a service token limited to the scan-result
 * route (decision D7); it holds no wallet key and signs nothing.
 */

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }
  return value;
}

const databaseUrl = resolveSecret("DATABASE_URL", process.env["DATABASE_URL"]);
const pollIntervalMs = Number(process.env["SCAN_POLL_MS"] ?? "3000");
const maxAttempts = Number(process.env["SCAN_MAX_ATTEMPTS"] ?? "3");
// Must comfortably exceed scan + report time. Too short and another worker scans the same file
// again.
const leaseMs = Number(process.env["SCAN_LEASE_MS"] ?? String(2 * 60 * 1000));

const scannerOptions = {
  ...DEFAULT_SCANNER_OPTIONS,
  host: process.env["CLAMAV_HOST"] ?? "127.0.0.1",
  port: Number(process.env["CLAMAV_PORT"] ?? "3310"),
  timeoutMs: Number(process.env["SCAN_TIMEOUT_MS"] ?? String(DEFAULT_SCANNER_OPTIONS.timeoutMs)),
  maxAttempts,
};

const baseUrl = required("API_BASE_URL");
// One tenant per deployment: the tenant the service token was registered for. The API refuses a
// report on another tenant's upload, so the worker leases only this tenant's.
const tenantSlug = required("SCAN_SERVICE_TENANT_SLUG");
// Generated with `service-token generate` and registered by the deploy (`service-token ensure`).
// A secret reference (`file:`/`aws-sm:`) is resolved like every other secret; the value is never
// printed.
const serviceToken = resolveSecret("SCAN_SERVICE_TOKEN", process.env["SCAN_SERVICE_TOKEN"]);
let api: ReturnType<typeof createApiClient>;
try {
  api = createApiClient({ baseUrl, serviceToken });
} catch {
  // The client's refusal names the variable only; nothing here quotes the value.
  process.stderr.write("SCAN_SERVICE_TOKEN must be a service token (mpcsvc_…)\n");
  process.exit(1);
}

const store =
  process.env["OBJECT_STORE"] === "s3"
    ? createS3ObjectStore({
        bucket: required("OBJECT_BUCKET"),
        region: required("OBJECT_REGION"),
        sse: (process.env["OBJECT_SSE"] ?? "aes256") as "none" | "aes256" | "kms",
        ...(process.env["OBJECT_ENDPOINT"] ? { endpoint: process.env["OBJECT_ENDPOINT"] } : {}),
        ...(process.env["OBJECT_FORCE_PATH_STYLE"] === "true" ? { forcePathStyle: true } : {}),
        ...(process.env["OBJECT_KMS_KEY_ID"] ? { kmsKeyId: process.env["OBJECT_KMS_KEY_ID"] } : {}),
        ...(process.env["OBJECT_ACCESS_KEY_ID"] && process.env["OBJECT_SECRET_ACCESS_KEY"]
          ? {
              credentials: {
                accessKeyId: process.env["OBJECT_ACCESS_KEY_ID"],
                secretAccessKey: resolveSecret(
                  "OBJECT_SECRET_ACCESS_KEY",
                  process.env["OBJECT_SECRET_ACCESS_KEY"],
                ),
              },
            }
          : {}),
      })
    : createMemoryObjectStore();

// No prepared statements. This is a long-lived process; a migration in the meantime makes the
// cached plan's result shape mismatch and kills the loop.
const sql = postgres(databaseUrl, { onnotice: () => {}, prepare: false });

const tenantId = await resolveScanTenant(sql, tenantSlug);
if (!tenantId) {
  process.stderr.write(`SCAN_SERVICE_TENANT_SLUG names no tenant (${tenantSlug}); bootstrap it first\n`);
  await sql.end();
  process.exit(1);
}

let running = true;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

emit({
  level: "info",
  msg: "scan.worker.started",
  scanner: `${scannerOptions.host}:${scannerOptions.port}`,
  objectStore: process.env["OBJECT_STORE"] ?? "memory",
  // The token is a secret; only the kind of identity is logged.
  identity: "service_token",
  tenant: tenantSlug,
  maxAttempts,
});

const heartbeat = createHeartbeat(sql, "scan", 15_000, process.env["WORKER_HEALTH_FILE"]);

let probe: Promise<boolean> | undefined;
let lastScannerAvailable: boolean | undefined;
let scanActive = false;
const probeAndBeat = () => probe ??= (async () => {
  const available = await scannerAvailable({ ...scannerOptions, timeoutMs: Math.min(scannerOptions.timeoutMs, 2000) });
  lastScannerAvailable = available;
  await heartbeat({ scannerAvailable: available });
  return available;
})().finally(() => { probe = undefined; });
// A rejected token pauses leasing (see auth-backoff.ts). The pause is slept in heartbeat-sized
// steps that keep beating with `status: "unauthorized"`: one long sleep would let the heartbeat
// go stale and the health file fail, and the task would be restarted into the same 401 instead
// of reporting why it is idle. The status stays until a report is accepted again.
const backoff = createUnauthorizedBackoff();
const BACKOFF_BEAT_MS = 15_000;
const beat = (detail: Record<string, unknown>) => heartbeat({
  ...detail,
  ...(lastScannerAvailable === undefined ? {} : { scannerAvailable: lastScannerAvailable }),
  ...(backoff.failures > 0 ? { status: "unauthorized", unauthorizedFailures: backoff.failures } : {}),
});
const reportStuck = async () => {
  const backlog = await scanBacklog(sql, maxAttempts, tenantId);
  if (backlog.stuck > 0) {
    // Uploads at the attempt cap do not recover on their own. Left silent, they stay
    // unscanned and nobody knows.
    emit({ level: "warn", msg: "scan.stuck", ...backlog });
  }
};
const pauseUnauthorized = async (ms: number) => {
  for (let left = ms; running && left > 0; left -= BACKOFF_BEAT_MS) {
    await sleep(Math.min(left, BACKOFF_BEAT_MS));
    await beat({ handled: false });
  }
};
// Refresh only while the absolute-bounded scan is active. A stuck lease/query must still
// become stale instead of being masked forever by an independent timer.
const healthTimer = setInterval(() => { if (scanActive) void probeAndBeat().catch(() => {}); }, 15_000);

while (running) {
  try {
    const result = await scanOnce(
      sql,
      store,
      async (bytes) => {
        scanActive = true;
        try { return await scanBytes(bytes, scannerOptions); }
        finally { scanActive = false; }
      },
      async ({ uploadId, version, result: verdict, detail }) => {
        await api.post(
          `/api/v1/uploads/${uploadId}/scan-result`,
          { result: verdict, ...(detail ? { detail } : {}) },
          {
            // A report for the same upload and version applies once. A retry does not advance
            // the state twice.
            "idempotency-key": `scan-${uploadId}-v${version}`,
            "if-match": `"${version}"`,
          },
        );
      },
      {
        tenantId, maxAttempts, leaseMs, scannerTimeoutMs: scannerOptions.timeoutMs,
        scannerAvailable: probeAndBeat,
      },
      emit,
    );

    // Beat even when the queue is empty — telling "empty" apart from "no worker" is the point
    // of this signal.
    if (result.scannerUnavailable) lastScannerAvailable = false;
    if (result.unauthorized) {
      const backoffMs = backoff.next();
      // Alertable: until the token is registered or replaced nothing is scanned.
      emit({ level: "error", msg: "scan.unauthorized", failures: backoff.failures, backoffMs });
      await beat({ handled: false });
      await reportStuck();
      await pauseUnauthorized(backoffMs);
      continue;
    }
    // An accepted report proves the token again; the normal poll resumes.
    if (result.verdict === "clean" || result.verdict === "infected") backoff.reset();
    await beat({ handled: result.handled });

    if (!result.handled) {
      await reportStuck();
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    emit({ level: "error", msg: "scan.loop.failed", error: String(error) });
    await sleep(pollIntervalMs);
  }
}

clearInterval(healthTimer);
await probe;
emit({ level: "info", msg: "scan.worker.stopped" });
await sql.end();
