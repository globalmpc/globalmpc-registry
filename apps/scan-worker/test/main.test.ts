import { afterEach, beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  sql: { end: vi.fn() },
  once: vi.fn(),
  backlog: vi.fn(),
  tenant: vi.fn(),
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
  resolveScanTenant: s.tenant,
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
    s.tenant,
    s.heartbeat,
    s.scan,
    s.available,
    s.post,
    s.s3,
    s.memory,
  ])
    f.mockReset();
  s.signals.clear();
  s.client.mockReset().mockImplementation(() => ({ post: s.post }));
  for (const [k, v] of Object.entries({
    DATABASE_URL: "postgres://local/test",
    API_BASE_URL: "http://api.test",
    SCAN_SERVICE_TOKEN: "mpcsvc_secret",
    SCAN_SERVICE_TENANT_SLUG: "acme",
  }))
    vi.stubEnv(k, v);
  vi.stubEnv("OBJECT_STORE", "memory");
  vi.stubEnv("CLAMAV_HOST", undefined);
  vi.stubEnv("CLAMAV_PORT", undefined);
  s.available.mockResolvedValue(true);
  s.memory.mockReturnValue("memory-store");
  s.backlog.mockResolvedValue({ stuck: 2 });
  s.tenant.mockResolvedValue("tenant-acme");
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

it("authenticates with the service token and never logs it", async () => {
  await import("../src/main.js");
  expect(s.client).toHaveBeenCalledWith({ baseUrl: "http://api.test", serviceToken: "mpcsvc_secret" });
  const log = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(log).toContain('"identity":"service_token"');
  expect(log).not.toContain("mpcsvc_secret");
});

it("needs no chain and no SIWE settings: it signs nothing", async () => {
  // Left over from wallet sign-in, these are ignored rather than required.
  for (const name of ["CHAIN_ID", "SIWE_DOMAIN", "SIWE_URI", "SCAN_SERVICE_PRIVATE_KEY"]) vi.stubEnv(name, undefined);
  await import("../src/main.js");
  expect(s.once).toHaveBeenCalled();
});

it("refuses to start without a service token", async () => {
  vi.stubEnv("SCAN_SERVICE_TOKEN", undefined);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  // resolveSecret is mocked to pass the value through; the client refuses what is not a token.
  s.client.mockImplementation(() => {
    throw new Error("SCAN_SERVICE_TOKEN must be a service token (mpcsvc_…)");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith("SCAN_SERVICE_TOKEN must be a service token (mpcsvc_…)\n");
  expect(s.once).not.toHaveBeenCalled();
});

it("does not pass on a client error, which may quote the value", async () => {
  s.client.mockImplementation(() => {
    throw new Error("unexpected value 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
  });
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  const errors = vi.mocked(process.stderr.write).mock.calls.flat().join("");
  expect(errors).toBe("SCAN_SERVICE_TOKEN must be a service token (mpcsvc_…)\n");
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

it("backs off on a rejected token instead of leasing again at once, then resumes on an accepted report", async () => {
  // Jitter at its top: each pause is the full step (5s, 10s, 20s, ...).
  vi.spyOn(Math, "random").mockReturnValue(1);
  const timeline: (string | number)[] = [];
  vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => {
    timeline.push(ms);
    queueMicrotask(fn);
    return 0;
  });
  const results = [
    { handled: true, unauthorized: true, verdict: "error" },
    { handled: true, unauthorized: true, verdict: "error" },
    { handled: true, unauthorized: true, verdict: "error" },
    { handled: true, verdict: "clean" },
    { handled: false },
  ];
  let calls = 0;
  s.once.mockImplementation(async () => {
    timeline.push("lease");
    const result = results[calls++]!;
    if (calls === results.length) s.signals.get("SIGTERM")!();
    return result;
  });
  s.backlog.mockResolvedValue({ pending: 1, stuck: 0 });
  await import("../src/main.js");

  // One lease per back-off window, the window doubling, slept in steps of at most 15 seconds;
  // after the accepted report the ordinary poll interval is back.
  expect(timeline).toEqual(["lease", 5000, "lease", 10000, "lease", 15000, 5000, "lease", "lease", 3000]);
  const log = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(log.match(/"msg":"scan\.unauthorized"/g)).toHaveLength(3);
  expect(log).toContain('"level":"error","msg":"scan.unauthorized","failures":3,"backoffMs":20000');
  // The heartbeat says why the worker is idle while it waits, and clears after the success.
  expect(s.heartbeat).toHaveBeenCalledWith({ handled: false, status: "unauthorized", unauthorizedFailures: 3 });
  expect(s.heartbeat).toHaveBeenLastCalledWith({ handled: false });
  // The stuck-upload check still runs during the pause.
  expect(s.backlog).toHaveBeenCalledTimes(4);
});

it("never sleeps longer than five minutes between leases on a token that stays rejected", async () => {
  vi.spyOn(Math, "random").mockReturnValue(1);
  const timeline: (string | number)[] = [];
  vi.stubGlobal("setTimeout", (fn: () => void, ms: number) => {
    timeline.push(ms);
    queueMicrotask(fn);
    return 0;
  });
  let calls = 0;
  s.once.mockImplementation(async () => {
    timeline.push("lease");
    if (++calls === 9) s.signals.get("SIGTERM")!();
    return { handled: true, unauthorized: true, verdict: "error" };
  });
  await import("../src/main.js");
  const windows: number[] = [];
  for (const entry of timeline) {
    if (entry === "lease") windows.push(0);
    else windows[windows.length - 1]! += entry as number;
  }
  expect(windows.slice(0, 8)).toEqual([5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000]);
  expect(Math.max(...timeline.filter((e): e is number => typeof e === "number"))).toBeLessThanOrEqual(15000);
  // The pause stops at the signal: the last window is not slept out.
  expect(windows.at(-1)).toBeLessThan(300000);
});

it("scans for the one tenant its token was registered for", async () => {
  await import("../src/main.js");
  expect(s.tenant).toHaveBeenCalledWith(s.sql, "acme");
  expect(s.once).toHaveBeenCalledWith(
    s.sql, "memory-store", expect.any(Function), expect.any(Function),
    expect.objectContaining({ tenantId: "tenant-acme" }), expect.any(Function),
  );
  expect(s.backlog).toHaveBeenCalledWith(s.sql, 3, "tenant-acme");
  expect(process.stdout.write).toHaveBeenCalledWith(expect.stringContaining('"tenant":"acme"'));
});

it("refuses to start without a tenant slug", async () => {
  vi.stubEnv("SCAN_SERVICE_TENANT_SLUG", "");
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith("SCAN_SERVICE_TENANT_SLUG is required\n");
  expect(s.once).not.toHaveBeenCalled();
});

it("refuses to start for a tenant that does not exist, rather than scanning nothing quietly", async () => {
  s.tenant.mockResolvedValue(undefined);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith(
    "SCAN_SERVICE_TENANT_SLUG names no tenant (acme); bootstrap it first\n",
  );
  expect(s.sql.end).toHaveBeenCalledOnce();
  expect(s.once).not.toHaveBeenCalled();
});
