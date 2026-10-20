import { afterEach, beforeEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({
  sql: { end: vi.fn() },
  replay: vi.fn(),
  args: vi.fn(),
  secret: vi.fn(),
  handlers: [{ name: "export" }],
}));
vi.mock("node:util", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:util")>()),
  parseArgs: s.args,
}));
vi.mock("postgres", () => ({ default: () => s.sql }));
vi.mock("@mpc/config", () => ({ resolveSecret: s.secret }));
vi.mock("../src/outbox-handlers.js", () => ({
  buildOutboxHandlers: () => s.handlers,
}));
vi.mock("../src/outbox-replay.js", () => ({
  replayEvents: s.replay,
  ReplayInputError: class ReplayInputError extends Error {},
}));
const code = process.exitCode;
beforeEach(() => {
  vi.resetModules();
  s.replay.mockReset().mockResolvedValue({ selected: 2, dryRun: true });
  s.sql.end.mockReset();
  s.secret.mockReset().mockReturnValue("postgres://local/test");
  s.args
    .mockReset()
    .mockReturnValue({
      values: {
        "include-published": false,
        limit: "100",
        apply: false,
        reason: "",
        help: false,
      },
    });
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = code;
  vi.restoreAllMocks();
});
it("defaults to a dry run without skipping handlers or including published events", async () => {
  await import("../src/outbox-replay-cli.js");
  expect(s.replay).toHaveBeenCalledWith(
    s.sql,
    s.handlers,
    { eventIds: [], includePublished: false, limit: 100 },
    { dryRun: true, skipHandlers: [], reason: "" },
  );
  expect(s.sql.end).toHaveBeenCalledOnce();
});
it("forwards explicit apply, filter and skip options", async () => {
  s.args.mockReturnValue({
    values: {
      "event-id": ["e1"],
      "event-type": "export",
      "include-published": true,
      "skip-handler": ["log"],
      limit: "3",
      apply: true,
      reason: "Fixed consumer",
    },
  });
  await import("../src/outbox-replay-cli.js");
  expect(s.replay).toHaveBeenCalledWith(
    s.sql,
    s.handlers,
    { eventIds: ["e1"], eventType: "export", includePublished: true, limit: 3 },
    { dryRun: false, skipHandlers: ["log"], reason: "Fixed consumer" },
  );
});
it("prints usage without accessing the database", async () => {
  s.args.mockReturnValue({ values: { help: true } });
  await expect(import("../src/outbox-replay-cli.js")).rejects.toThrow("exit:0");
  expect(s.secret).not.toHaveBeenCalled();
});
it("refuses a missing database secret", async () => {
  s.secret.mockImplementation(() => {
    throw new Error("DATABASE_URL required");
  });
  await expect(import("../src/outbox-replay-cli.js")).rejects.toThrow("exit:1");
  expect(s.replay).not.toHaveBeenCalled();
});
it.each(["input", "database"])(
  "uses distinct exit codes for %s errors and always closes",
  async (kind) => {
    const { ReplayInputError } = await import("../src/outbox-replay.js");
    s.replay.mockRejectedValue(
      kind === "input"
        ? new ReplayInputError("Invalid filter")
        : new Error("Connection failed"),
    );
    await import("../src/outbox-replay-cli.js");
    expect(process.exitCode).toBe(kind === "input" ? 2 : 1);
    expect(s.sql.end).toHaveBeenCalledOnce();
  },
);
