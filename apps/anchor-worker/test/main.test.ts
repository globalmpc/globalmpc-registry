import { afterEach, beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  config: vi.fn(),
  sql: { end: vi.fn() },
  step: vi.fn(),
  backlog: vi.fn(),
  heartbeat: vi.fn(),
  safe: vi.fn(),
  signals: new Map<string, () => void>(),
}));
vi.mock("postgres", () => ({ default: vi.fn(() => state.sql) }));
vi.mock("../src/anchor-config.js", () => ({ loadAnchorConfig: state.config }));
vi.mock("@mpc/db", () => ({ createHeartbeat: () => state.heartbeat }));
vi.mock("../src/anchor-submitter.js", () => ({
  stepOnce: state.step,
  chainBacklog: state.backlog,
  shouldBackOff: (r: { handled: boolean }) => !r.handled,
}));
vi.mock("../src/viem-chain-client.js", () => ({
  createViemChainClient: () => ({}),
  signerAddress: () => "0xpublic",
}));
vi.mock("../src/safe-client.js", () => ({ createSafeClient: state.safe }));
const config = {
  databaseUrl: "postgres://local/test",
  rpcUrl: "https://rpc.test/private-key",
  chainId: 31337,
  contractAddress: "0xcontract",
  signerPrivateKey: "secret",
  confirmationDepth: 2,
  eoaAllowedChainIds: [31337],
  safeAddress: null,
  pollIntervalMs: 1,
};
beforeEach(() => {
  vi.resetModules();
  state.signals.clear();
  state.config.mockReset().mockReturnValue({ ...config });
  state.sql.end.mockReset();
  state.heartbeat.mockReset();
  state.safe.mockReset();
  state.backlog.mockReset().mockResolvedValue({ needsAttention: 2 });
  state.step.mockReset().mockImplementation(async () => {
    state.signals.get("SIGTERM")!();
    return { handled: false };
  });
  vi.spyOn(process, "on").mockImplementation(((
    event: string,
    handler: () => void,
  ) => {
    state.signals.set(event, handler);
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
it("heartbeats an idle queue, reports attention and closes on SIGTERM", async () => {
  await import("../src/main.js");
  expect(state.heartbeat).toHaveBeenCalledWith({ handled: false });
  expect(state.sql.end).toHaveBeenCalledOnce();
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining('"msg":"anchor.needs_attention"'),
  );
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining('"submissionMode":"eoa"'),
  );
});
it("wires Safe proposals on chains where EOA submission is disallowed", async () => {
  state.config.mockReturnValue({
    ...config,
    chainId: 56,
    safeAddress: "0xsafe",
  });
  vi.stubEnv("SAFE_SERVICE_URL", "https://safe.test");
  state.safe.mockReturnValue("safe-client");
  let seenSafeClient: unknown;
  state.step.mockImplementation(async (...args: unknown[]) => {
    seenSafeClient = args[4];
    state.signals.get("SIGINT")!();
    return { handled: true };
  });
  await import("../src/main.js");
  expect(seenSafeClient).toBe("safe-client");
  expect(state.safe).toHaveBeenCalledWith(
    expect.objectContaining({ serviceUrl: "https://safe.test", chainId: 56 }),
  );
  expect(state.backlog).not.toHaveBeenCalled();
});
it("redacts RPC credentials when a step fails and still shuts down cleanly", async () => {
  state.config.mockReturnValue({ ...config, chainId: 56 });
  state.step.mockImplementation(async () => {
    state.signals.get("SIGTERM")!();
    throw new Error(`RPC failed ${config.rpcUrl}`);
  });
  await import("../src/main.js");
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain("anchor.loop.failed");
  expect(logs).not.toContain("private-key");
  expect(logs).toContain('"submissionMode":"blocked"');
  expect(state.sql.end).toHaveBeenCalledOnce();
});
it("exits with a readable configuration error before opening a database", async () => {
  state.config.mockImplementation(() => {
    throw new Error("Missing signer key");
  });
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith("Missing signer key\n");
  expect(state.step).not.toHaveBeenCalled();
});
