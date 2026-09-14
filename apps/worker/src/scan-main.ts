import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { createMemoryObjectStore, createS3ObjectStore } from "@mpc/storage";
import { DEFAULT_SCANNER_OPTIONS, scanBytes } from "./scanner.js";
import { scanBacklog, scanOnce } from "./scan-worker.js";
import { createApiClient } from "./api-client.js";
import { createHeartbeat } from "./heartbeat.js";

/**
 * 바이러스 검사 worker.
 *
 * quarantine 업로드를 하나씩 집어 ClamAV에 넘긴다. 감염 파일의 바이트가 API
 * 프로세스를 지나지 않게 하는 것이 이 프로세스를 분리한 이유다.
 *
 * API와 **같은 저장소 설정**을 쓴다. 다르면 worker가 다른 버킷을 보게 되고,
 * 그러면 검사 대기가 쌓이는데 원인이 보이지 않는다.
 *
 * 결과는 API로 보고한다 — 상태기계 검사·감사 기록·If-Match를 우회하지 않기
 * 위해서다. 인증도 사람과 같은 SIWE 경로를 지난다.
 */

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name}가 필요하다\n`);
    process.exit(1);
  }
  return value;
}

const databaseUrl = resolveSecret("DATABASE_URL", process.env["DATABASE_URL"]);
const pollIntervalMs = Number(process.env["SCAN_POLL_MS"] ?? "3000");
const maxAttempts = Number(process.env["SCAN_MAX_ATTEMPTS"] ?? "3");
// 검사 + 보고에 걸리는 시간보다 넉넉해야 한다. 짧으면 다른 worker가 같은 파일을
// 중복 검사한다.
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

// prepared statement를 쓰지 않는다. 오래 붙어 있는 프로세스라 그 사이 migration이
// 돌면 캐시된 계획의 결과 형식이 어긋나 루프가 죽는다.
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
  // 주소는 공개 정보다. 개인키는 어디에도 찍지 않는다.
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
            // 같은 업로드·같은 버전의 보고는 한 번만 반영된다. 재시도가 상태를
            // 두 번 밀지 않는다.
            "idempotency-key": `scan-${uploadId}-v${version}`,
            "if-match": `"${version}"`,
          },
        );
      },
      { maxAttempts, leaseMs },
      emit,
    );

    // 큐가 비어 있어도 신호를 남긴다 — 비어 있는 것과 worker가 없는 것을
    // 구분하는 것이 이 신호의 목적이다.
    await heartbeat({ handled: result.handled });

    if (!result.handled) {
      const backlog = await scanBacklog(sql, maxAttempts);
      if (backlog.stuck > 0) {
        // 시도 상한에 닿은 것은 자동으로 풀리지 않는다. 조용히 두면 업로드가
        // 검사되지 않은 채 남아 있는데 아무도 모른다.
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
