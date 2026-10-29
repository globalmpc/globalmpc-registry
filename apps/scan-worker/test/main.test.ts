import { afterEach, beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  sql: { end: vi.fn() },
  once: vi.fn(),
  backlog: vi.fn(),
  heartbeat: vi.fn(),
  scan: vi.fn(),
  available: vi.fn(),
  post: vi.fn(),
  s3: vi.fn(),
  memory: vi.fn(),
  client: vi.fn(),
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
  scannerAvailable: s.available,
}));
vi.mock("../src/scan-worker.js", () => ({
  scanOnce: s.once,
  scanBacklog: s.backlog,
}));
vi.mock("../src/api-client.js", () => ({
  createApiClient: s.client,
}));
beforeEach(() => {
  vi.resetModules();
  for (const f of [
    s.sql.end,
    s.once,
    s.backlog,
    s.heartbeat,
    s.scan,
    s.available,
    s.post,
    s.s3,
    s.memory,
  ])
    f.mockReset();
  s.signals.clear();
  s.client.mockReset().mockImplementation(() => ({ walletAddress: "0xpublic", post: s.post }));
  for (const [k, v] of Object.entries({
    DATABASE_URL: "postgres://local/test",
    API_BASE_URL: "http://api.test",
    SCAN_SERVICE_PRIVATE_KEY: "secret",
    SIWE_DOMAIN: "api.test",
    SIWE_URI: "http://api.test",
    CHAIN_ID: "31337",
  }))
    vi.stubEnv(k, v);
  vi.stubEnv("OBJECT_STORE", "memory");
  vi.stubEnv("CLAMAV_HOST", undefined);
  vi.stubEnv("CLAMAV_PORT", undefined);
  s.available.mockResolvedValue(true);
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
    expect.objectContaining({ host: "127.0.0.1", port: 3310 }),
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

it("signs in on the configured chain", async () => {
  vi.stubEnv("CHAIN_ID", "5611");
  await import("../src/main.js");
  expect(s.client).toHaveBeenCalledWith(expect.objectContaining({ chainId: 5611 }));
});

it("refuses to start without CHAIN_ID instead of assuming the local chain", async () => {
  vi.stubEnv("CHAIN_ID", undefined);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith("CHAIN_ID is required\n");
  expect(s.client).not.toHaveBeenCalled();
  expect(s.once).not.toHaveBeenCalled();
});

it("refuses an unsupported or non-decimal CHAIN_ID, naming only the allowed chains", async () => {
  // 97 is BSC testnet; the others are values `Number()` would read as a supported chain.
  for (const value of ["97", "0x15eb", " 56 ", "5.611e3", "5611abc", ""]) {
    vi.resetModules();
    vi.mocked(process.stderr.write).mockClear();
    vi.stubEnv("CHAIN_ID", value);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(import("../src/main.js"), value).rejects.toThrow("exit");
    const errors = vi.mocked(process.stderr.write).mock.calls.flat().join("");
    expect(errors, value).toBe(
      value === ""
        ? "CHAIN_ID is required\n"
        : "CHAIN_ID must be one of 56 (BSC mainnet), 5611 (opBNB testnet), 31337 (local chain)\n",
    );
    expect(s.client, value).not.toHaveBeenCalled();
  }
});

it("refuses to start with a public development key, naming the variable only", async () => {
  s.client.mockImplementation(() => {
    throw new Error("SCAN_SERVICE_PRIVATE_KEY is a public development key (anvil/hardhat or a committed fixture), accepted only on chain 31337; generate a fresh key for chain 5611");
  });
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith(
    expect.stringMatching(/^SCAN_SERVICE_PRIVATE_KEY is a public development key \(anvil\/hardhat or a committed fixture\)/),
  );
  expect(s.once).not.toHaveBeenCalled();
});
it("does not pass on a key library error, which may quote the key", async () => {
  s.client.mockImplementation(() => {
    throw new Error("expected valid private key: 1 <= n < …, got 1157920892373161954235709850086879078532699846");
  });
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  const errors = vi.mocked(process.stderr.write).mock.calls.flat().join("");
  expect(errors).toBe("SCAN_SERVICE_PRIVATE_KEY is not a valid key\n");
});

it("pauses and keeps its heartbeat alive across repeated scanner outages, then resumes", async () => {
  s.available.mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValueOnce(false).mockResolvedValue(true);
  let polls = 0;
  s.once.mockImplementation(async (_sql, _store, _scan, _report, options) => {
    polls++;
    if (!(await options.scannerAvailable())) return { handled: false, scannerUnavailable: true };
    s.signals.get("SIGTERM")!();
    return { handled: true };
  });
  await import("../src/main.js");
  expect(polls).toBe(4);
  expect(s.available).toHaveBeenCalledTimes(4);
  expect(s.available).toHaveBeenCalledWith(expect.objectContaining({ timeoutMs: 1000 }));
  expect(s.heartbeat).toHaveBeenCalledWith({ scannerAvailable: false });
  expect(s.heartbeat).toHaveBeenLastCalledWith({ handled: true, scannerAvailable: true });
});

it("refreshes actual scanner availability during a long active scan", async () => {
  let periodic!: () => void;
  vi.spyOn(globalThis,"setInterval").mockImplementation(((callback: () => void) => { periodic=callback; return 1; }) as unknown as typeof setInterval);
  vi.spyOn(globalThis,"clearInterval").mockImplementation(() => {});
  s.available.mockResolvedValueOnce(true).mockResolvedValue(false);
  s.scan.mockImplementation(async () => {
    periodic();
    for(let i=0;i<5;i++) await Promise.resolve();
    expect(s.heartbeat).toHaveBeenCalledWith({scannerAvailable:false});
    return {kind:"error",reason:"scan timeout"};
  });
  s.once.mockImplementation(async (_sql,_store,scan,_report,options) => {
    await options.scannerAvailable();
    await scan(new Uint8Array([1]));
    s.signals.get("SIGTERM")!();
    return {handled:true};
  });
  await import("../src/main.js");
  expect(s.heartbeat).toHaveBeenLastCalledWith({handled:true,scannerAvailable:false});
  expect(clearInterval).toHaveBeenCalledWith(1);
});

it("does not refresh heartbeat when the loop is stuck outside its bounded scanner call", async () => {
  let periodic!: () => void;
  vi.spyOn(globalThis,"setInterval").mockImplementation(((callback: () => void) => {periodic=callback;return 1;}) as unknown as typeof setInterval);
  vi.spyOn(globalThis,"clearInterval").mockImplementation(() => {});
  s.once.mockImplementation(async (_sql,_store,_scan,_report,options) => {
    await options.scannerAvailable();
    s.available.mockClear();
    s.heartbeat.mockClear();
    periodic();
    for(let i=0;i<5;i++) await Promise.resolve();
    expect(s.available).not.toHaveBeenCalled();
    expect(s.heartbeat).not.toHaveBeenCalled();
    s.signals.get("SIGTERM")!();
    return {handled:false};
  });
  await import("../src/main.js");
});
