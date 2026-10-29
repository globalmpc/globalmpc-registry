import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  config: vi.fn(),
  sql: { end: vi.fn() },
  step: vi.fn(),
  backlog: vi.fn(),
  heartbeat: vi.fn(),
  safe: vi.fn(),
  rpcChainId: vi.fn(),
  hasCode: vi.fn(),
  answersTag: vi.fn(),
  signals: new Map<string, () => void>(),
}));
vi.mock("postgres", () => ({ default: vi.fn(() => state.sql) }));
vi.mock("../src/anchor-config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/anchor-config.js")>()),
  loadAnchorConfig: state.config,
}));
vi.mock("@mpc/db", () => ({ createHeartbeat: () => state.heartbeat }));
vi.mock("../src/anchor-submitter.js", () => ({
  stepOnce: state.step,
  chainBacklog: state.backlog,
  shouldBackOff: (r: { handled: boolean }) => !r.handled,
}));
vi.mock("../src/viem-chain-client.js", () => ({
  createViemChainClient: () => ({}),
  rpcChainId: state.rpcChainId,
  contractHasCode: state.hasCode,
  rpcAnswersBlockTag: state.answersTag,
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
  finalityTag: "none",
};
beforeEach(() => {
  vi.resetModules();
  state.signals.clear();
  state.config.mockReset().mockReturnValue({ ...config });
  state.sql.end.mockReset();
  state.heartbeat.mockReset();
  state.safe.mockReset();
  // The endpoint serves whatever chain the test configured, unless a test says otherwise.
  state.rpcChainId.mockReset().mockImplementation(async () => state.config().chainId);
  state.hasCode.mockReset().mockResolvedValue(true);
  state.answersTag.mockReset().mockResolvedValue(true);
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
it("reports the opBNB testnet as EOA only when it is opted in", async () => {
  const modes: string[] = [];
  for (const eoaAllowedChainIds of [[31337], [31337, 5611]]) {
    vi.resetModules();
    vi.mocked(process.stdout.write).mockClear();
    state.config.mockReturnValue({ ...config, chainId: 5611, eoaAllowedChainIds });
    await import("../src/main.js");
    const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
    modes.push(/"submissionMode":"([a-z_]+)"/.exec(logs)?.[1] ?? "missing");
  }
  expect(modes).toEqual(["blocked", "eoa"]);
});
it("never reports mainnet as EOA, whatever list reaches it", async () => {
  state.config.mockReturnValue({ ...config, chainId: 56, eoaAllowedChainIds: [56] });
  await import("../src/main.js");
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain('"submissionMode":"blocked"');
});
it("refuses to start when the RPC endpoint serves another chain", async () => {
  state.config.mockReturnValue({ ...config, chainId: 5611 });
  state.rpcChainId.mockResolvedValue(97);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.stderr.write).toHaveBeenCalledWith(
    "CHAIN_RPC_URL serves chain 97, but CHAIN_ID is 5611; refusing to start\n",
  );
  expect(state.step).not.toHaveBeenCalled();
});
it("refuses to start when the anchor contract address holds no code", async () => {
  // A send to an address without code succeeds and stores nothing; the batch would read as
  // anchored while no contract holds its root.
  state.config.mockReturnValue({ ...config, chainId: 5611 });
  state.hasCode.mockResolvedValue(false);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(state.hasCode).toHaveBeenCalledWith(config.rpcUrl, config.contractAddress);
  expect(process.stderr.write).toHaveBeenCalledWith(
    "ANCHOR_CONTRACT_ADDRESS has no contract code on chain 5611; refusing to start\n",
  );
  expect(state.step).not.toHaveBeenCalled();
});
it("refuses to start when the contract code cannot be read, without printing the RPC URL", async () => {
  state.hasCode.mockRejectedValue(new Error(`HTTP request failed. URL: ${config.rpcUrl}`));
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  const errors = vi.mocked(process.stderr.write).mock.calls.flat().join("");
  expect(errors).toContain("HTTP request failed");
  expect(errors).not.toContain("private-key");
  expect(state.step).not.toHaveBeenCalled();
});
it("refuses to start when the chain cannot be read, without printing the RPC URL", async () => {
  state.rpcChainId.mockRejectedValue(new Error(`HTTP request failed. URL: ${config.rpcUrl}`));
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  const errors = vi.mocked(process.stderr.write).mock.calls.flat().join("");
  expect(errors).toContain("HTTP request failed");
  expect(errors).not.toContain("private-key");
  expect(state.step).not.toHaveBeenCalled();
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
describe("finality tag at startup", () => {
  const refusal =
    'CHAIN_RPC_URL does not answer the "safe" block tag (ANCHOR_FINALITY_TAG) on chain 5611; refusing to start\n';

  it("starts when the endpoint answers the configured tag", async () => {
    state.config.mockReturnValue({ ...config, chainId: 5611, finalityTag: "safe" });
    await import("../src/main.js");
    expect(state.answersTag).toHaveBeenCalledWith(config.rpcUrl, "safe");
    expect(state.step).toHaveBeenCalled();
  });

  it("refuses to start when the endpoint has no block for the tag", async () => {
    // Every receipt would wait short of confirmed with finality_read_failed.
    state.config.mockReturnValue({ ...config, chainId: 5611, finalityTag: "safe" });
    state.answersTag.mockResolvedValue(false);
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(import("../src/main.js")).rejects.toThrow("exit");
    expect(process.stderr.write).toHaveBeenCalledWith(refusal);
    expect(state.step).not.toHaveBeenCalled();
  });

  it("refuses, saying the read failed and naming no URL, when the tag read fails", async () => {
    state.config.mockReturnValue({ ...config, chainId: 5611, finalityTag: "safe" });
    state.answersTag.mockRejectedValue(new Error(`unknown block tag. URL: ${config.rpcUrl}`));
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("exit");
    });
    await expect(import("../src/main.js")).rejects.toThrow("exit");
    const errors = vi.mocked(process.stderr.write).mock.calls.flat().join("");
    // A failed read may pass; the message does not claim the node lacks the tag.
    expect(errors).toBe(
      'CHAIN_RPC_URL could not be asked for the "safe" block tag (ANCHOR_FINALITY_TAG) on chain 5611; refusing to start\n',
    );
    expect(errors).not.toContain("rpc.test");
    expect(state.step).not.toHaveBeenCalled();
  });

  it("does not ask for a tag when it is none", async () => {
    await import("../src/main.js");
    expect(state.answersTag).not.toHaveBeenCalled();
    expect(state.step).toHaveBeenCalled();
  });
});
