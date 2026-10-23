import { afterEach, beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  sql: { end: vi.fn() },
  publish: vi.fn(),
  dispatch: vi.fn(),
  deadLetter: vi.fn(),
  backlog: vi.fn(),
  deliver: vi.fn(),
  deliveryBacklog: vi.fn(),
  heartbeat: vi.fn(),
  expiry: vi.fn(),
  credentials: vi.fn(),
  ledger: vi.fn(),
  secret: vi.fn(),
  webhook: vi.fn(),
  signals: new Map<string, () => void>(),
}));
vi.mock("../src/evidence-ledger.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/evidence-ledger.js")>(),
  createLedgerSweep: () => s.ledger,
}));
vi.mock("postgres", () => ({ default: () => s.sql }));
vi.mock("@mpc/config", () => ({
  resolveSecret: s.secret,
  resolveWebhookSecret: s.webhook,
}));
vi.mock("@mpc/db", () => ({
  SESSION_CONNECTION: {},
  createHeartbeat: () => s.heartbeat,
}));
vi.mock("../src/credential-expiry.js", () => ({
  DEFAULT_CREDENTIAL_SWEEP_MS: 1000,
  createCredentialExpirySweep: () => s.credentials,
}));
vi.mock("../src/document-expiry.js", () => ({
  DEFAULT_EXPIRY_SWEEP_MS: 1000,
  createExpirySweep: () => s.expiry,
}));
vi.mock("../src/notification-delivery.js", () => ({
  deliverOnce: s.deliver,
  deliveryBacklog: s.deliveryBacklog,
}));
vi.mock("../src/outbox-handlers.js", () => ({ buildOutboxHandlers: () => [] }));
vi.mock("../src/outbox-publisher.js", () => ({
  DEFAULT_OUTBOX_MAX_ATTEMPTS: 5,
  backlogStats: s.backlog,
  createDispatcher: () => ({ publish: s.dispatch, onDeadLetter: s.deadLetter }),
  publishBatch: s.publish,
}));
beforeEach(() => {
  vi.resetModules();
  for (const f of [
    s.sql.end,
    s.publish,
    s.deadLetter,
    s.deliver,
    s.heartbeat,
    s.expiry,
    s.credentials,
    s.ledger,
    s.secret,
    s.webhook,
    s.backlog,
    s.deliveryBacklog,
  ])
    f.mockReset();
  s.signals.clear();
  s.secret.mockReturnValue("postgres://local/test");
  s.expiry.mockResolvedValue({ ran: true, flagged: 1 });
  s.ledger.mockResolvedValue({ ran: true, recorded: 1 });
  s.credentials.mockResolvedValue({ ran: true, flagged: 2 });
  s.deliver.mockResolvedValue({ handled: false, delivered: 0, failed: 0 });
  s.backlog.mockResolvedValue({
    pending: 1,
    deadLettered: 2,
    oldestPendingAt: new Date("2026-10-20"),
  });
  s.deliveryBacklog.mockResolvedValue({ failed: 1 });
  s.publish.mockImplementation(async () => {
    s.signals.get("SIGTERM")!();
    return { published: 0, failed: 0 };
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
});
it("sweeps expiries, emits a heartbeat when idle, and closes its connection", async () => {
  await import("../src/main.js");
  expect(s.heartbeat).toHaveBeenCalledWith({ published: 0, delivered: 0 });
  expect(s.sql.end).toHaveBeenCalledTimes(2);
  const log = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(log).toContain("document.expiry.flagged");
  expect(log).toContain("credential.expiry.flagged");
});
it("keeps publishing when expiry sweeps or dead-letter settlement fail", async () => {
  s.expiry.mockRejectedValue(new Error("document sweep failed"));
  s.credentials.mockRejectedValue(new Error("credential sweep failed"));
  s.deadLetter.mockRejectedValue(new Error("settle failed"));
  s.publish.mockImplementation(async (_sql, _publish, options) => {
    await options.onDeadLetter({ id: "e1", event_type: "export" });
    s.signals.get("SIGINT")!();
    return { published: 1, failed: 1 };
  });
  s.deliver.mockImplementation(async (_sql, options) => {
    options.resolveSecret("reference");
    return { handled: true, delivered: 0, failed: 1 };
  });
  await import("../src/main.js");
  const log = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  for (const event of [
    "outbox.dead_letter.settle_failed",
    "document.expiry.sweep_failed",
    "credential.expiry.sweep_failed",
    "notification.delivery.backlog",
    "outbox.publish.partial_failure",
  ])
    expect(log).toContain(event);
  expect(s.deadLetter).toHaveBeenCalledWith({ id: "e1", event_type: "export" });
  expect(s.webhook).toHaveBeenCalledWith("reference");
  expect(s.sql.end).toHaveBeenCalledTimes(2);
});
it("reports unexpected failures without stamping events published", async () => {
  s.publish.mockImplementation(async () => {
    s.signals.get("SIGTERM")!();
    throw new Error("DB unavailable");
  });
  await import("../src/main.js");
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining("outbox.loop.failed"),
  );
  expect(s.heartbeat).not.toHaveBeenCalled();
  expect(s.sql.end).toHaveBeenCalledTimes(2);
});
it("rejects a missing database secret before starting the loop", async () => {
  s.secret.mockImplementation(() => {
    throw new Error("DATABASE_URL required");
  });
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith("DATABASE_URL required\n");
});

it("delivers and heartbeats while a long ledger sweep runs, then drains before closing", async () => {
  let finish!: (value: {ran: boolean; recorded: number}) => void;
  s.ledger.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  let cycles = 0;
  s.publish.mockImplementation(async () => ({ published: 1, failed: 0 }));
  s.heartbeat.mockImplementation(async () => {
    cycles++;
    if (cycles === 2) {
      expect(s.ledger).toHaveBeenCalledOnce();
      expect(s.deliver).toHaveBeenCalledTimes(2);
      expect(s.sql.end).not.toHaveBeenCalled();
      s.signals.get("SIGTERM")!();
      queueMicrotask(() => finish({ ran: true, recorded: 1 }));
    }
  });
  await import("../src/main.js");
  expect(cycles).toBe(2);
  expect(s.sql.end).toHaveBeenCalledTimes(2);
});
