import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { createMemoryObjectStore, createS3ObjectStore } from "@mpc/storage";
import { DEFAULT_SCANNER_OPTIONS, scanBytes } from "./scanner.js";
import { scanBacklog, scanOnce } from "./scan-worker.js";
import { createApiClient } from "./api-client.js";
import { createHeartbeat } from "./heartbeat.js";

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
 * are not bypassed. Authentication goes through the same SIWE path as people.
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
  host: process.env["CLAMAV_HOST"] ?? "clamav",
  port: Number(process.env["CLAMAV_PORT"] ?? "3310"),
  timeoutMs: Number(process.env["SCAN_TIMEOUT_MS"] ?? String(DEFAULT_SCANNER_OPTIONS.timeoutMs)),
  maxAttempts,
};

const api = createApiClient({
  baseUrl: required("API_BASE_URL"),
  privateKey: resolveSecret(
    "SCAN_SERVICE_PRIVATE_KEY",
    process.env["SCAN_SERVICE_PRIVATE_KEY"],
  ) as `0x${string}`,
  chainId: Number(process.env["CHAIN_ID"] ?? "97"),
  siweDomain: required("SIWE_DOMAIN"),
  siweUri: required("SIWE_URI"),
});

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
  // The address is public. The private key is never printed anywhere.
  identity: api.walletAddress,
  maxAttempts,
});

const heartbeat = createHeartbeat(sql, "scan");

while (running) {
  try {
    const result = await scanOnce(
      sql,
      store,
      (bytes) => scanBytes(bytes, scannerOptions),
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
      { maxAttempts, leaseMs },
      emit,
    );

    // Beat even when the queue is empty — telling "empty" apart from "no worker" is the point
    // of this signal.
    await heartbeat({ handled: result.handled });

    if (!result.handled) {
      const backlog = await scanBacklog(sql, maxAttempts);
      if (backlog.stuck > 0) {
        // Uploads at the attempt cap do not recover on their own. Left silent, they stay
        // unscanned and nobody knows.
        emit({ level: "warn", msg: "scan.stuck", ...backlog });
      }
      await sleep(pollIntervalMs);
    }
  } catch (error) {
    emit({ level: "error", msg: "scan.loop.failed", error: String(error) });
    await sleep(pollIntervalMs);
  }
}

emit({ level: "info", msg: "scan.worker.stopped" });
await sql.end();
