import { afterEach, beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  sql: { end: vi.fn() },
  once: vi.fn(),
  backlog: vi.fn(),
  heartbeat: vi.fn(),
  scan: vi.fn(),
  post: vi.fn(),
  s3: vi.fn(),
  memory: vi.fn(),
  signals: new Map<string, () => void>(),
}));
vi.mock("postgres", () => ({ default: () => s.sql }));
vi.mock("@mpc/config", () => ({
  resolveSecret: (_name: string, value: string) => value,
}));
vi.mock("@mpc/db", () => ({ createHeartbeat: () => s.heartbeat }));
vi.mock("@mpc/storage", () => ({
  createMemoryObjectStore: s.memory,
  createS3ObjectStore: s.s3,
}));
vi.mock("../src/scanner.js", () => ({
  DEFAULT_SCANNER_OPTIONS: { timeoutMs: 1000, chunkBytes: 64 },
  scanBytes: s.scan,
}));
vi.mock("../src/scan-worker.js", () => ({
  scanOnce: s.once,
  scanBacklog: s.backlog,
}));
vi.mock("../src/api-client.js", () => ({
  createApiClient: () => ({ walletAddress: "0xpublic", post: s.post }),
}));
beforeEach(() => {
  vi.resetModules();
  for (const f of [
    s.sql.end,
    s.once,
    s.backlog,
    s.heartbeat,
    s.scan,
    s.post,
    s.s3,
    s.memory,
  ])
    f.mockReset();
  s.signals.clear();
  for (const [k, v] of Object.entries({
    DATABASE_URL: "postgres://local/test",
    API_BASE_URL: "http://api.test",
    SCAN_SERVICE_PRIVATE_KEY: "secret",
    SIWE_DOMAIN: "api.test",
    SIWE_URI: "http://api.test",
  }))
    vi.stubEnv(k, v);
  vi.stubEnv("OBJECT_STORE", "memory");
  s.memory.mockReturnValue("memory-store");
  s.backlog.mockResolvedValue({ stuck: 2 });
  s.once.mockImplementation(async () => {
    s.signals.get("SIGTERM")!();
    return { handled: false };
  });
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: () => void,
  ) => {
    s.signals.set(event, handler);
    return process;
  }) as typeof process.on);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.stubGlobal("setTimeout", (fn: () => void) => {
    queueMicrotask(fn);
    return 0;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("reports stuck quarantined uploads even when no work is handled", async () => {
  await import("../src/main.js");
  expect(s.memory).toHaveBeenCalledOnce();
  expect(s.heartbeat).toHaveBeenCalledWith({ handled: false });
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining('"msg":"scan.stuck"'),
  );
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("uses configured S3 storage and submits versioned scan results through the API", async () => {
  for (const [k, v] of Object.entries({
    OBJECT_STORE: "s3",
    OBJECT_BUCKET: "evidence",
    OBJECT_REGION: "region1",
    OBJECT_ENDPOINT: "http://s3.test",
    OBJECT_FORCE_PATH_STYLE: "true",
    OBJECT_KMS_KEY_ID: "kms",
    OBJECT_SSE: "kms",
    OBJECT_ACCESS_KEY_ID: "id",
    OBJECT_SECRET_ACCESS_KEY: "key",
  }))
    vi.stubEnv(k, v);
  s.once.mockImplementation(async (_sql, _store, scan, report) => {
    await scan(new Uint8Array([1]));
    await report({ uploadId: "u1", version: 2, result: "clean", detail: "OK" });
    await report({ uploadId: "u2", version: 3, result: "infected" });
    s.signals.get("SIGINT")!();
    return { handled: true };
  });
  await import("../src/main.js");
  expect(s.s3).toHaveBeenCalledWith(
    expect.objectContaining({
      bucket: "evidence",
      kmsKeyId: "kms",
      forcePathStyle: true,
      credentials: { accessKeyId: "id", secretAccessKey: "key" },
    }),
  );
  expect(s.scan).toHaveBeenCalledWith(
    new Uint8Array([1]),
    expect.objectContaining({ host: "clamav", port: 3310 }),
  );
  expect(s.post).toHaveBeenCalledWith(
    "/api/v1/uploads/u1/scan-result",
    { result: "clean", detail: "OK" },
    { "idempotency-key": "scan-u1-v2", "if-match": '"2"' },
  );
  expect(s.post).toHaveBeenCalledWith(
    "/api/v1/uploads/u2/scan-result",
    { result: "infected" },
    expect.anything(),
  );
});
it("logs loop failures and shuts down without losing the signal", async () => {
  s.once.mockImplementation(async () => {
    s.signals.get("SIGTERM")!();
    throw new Error("scanner failed");
  });
  await import("../src/main.js");
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining("scan.loop.failed"),
  );
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("refuses to start without an API endpoint", async () => {
  vi.stubEnv("API_BASE_URL", "");
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith(
    "API_BASE_URL is required\n",
  );
  expect(s.once).not.toHaveBeenCalled();
});
