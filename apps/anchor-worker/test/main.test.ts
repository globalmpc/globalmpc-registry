import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  config: vi.fn(),
  sql: { end: vi.fn() },
  step: vi.fn(),
  backlog: vi.fn(),
  otherChains: vi.fn(),
  extendWatch: vi.fn(),
  moves: vi.fn(),
  register: vi.fn(),
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
  otherChainsInFlight: state.otherChains,
  extendReorgWatch: state.extendWatch,
  processChainMoves: state.moves,
  registerAnchorContract: state.register,
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
  safeServiceUrl: null,
  pollIntervalMs: 1,
  finalityTag: "none",
  reorgWatchMs: 1_800_000,
};
beforeEach(() => {
  vi.resetModules();
  state.signals.clear();
  state.config.mockReset().mockReturnValue({ ...config });
  state.sql.end.mockReset().mockResolvedValue(undefined);
  state.heartbeat.mockReset();
  state.safe.mockReset();
  // The endpoint serves whatever chain the test configured, unless a test says otherwise.
  state.rpcChainId.mockReset().mockImplementation(async () => state.config().chainId);
  state.hasCode.mockReset().mockResolvedValue(true);
  state.answersTag.mockReset().mockResolvedValue(true);
  state.backlog.mockReset().mockResolvedValue({ needsAttention: 2 });
  state.otherChains.mockReset().mockResolvedValue([]);
  state.extendWatch.mockReset().mockResolvedValue(0);
  state.moves.mockReset().mockResolvedValue([]);
  state.register.mockReset().mockResolvedValue(undefined);
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
    safeServiceUrl: "https://safe.test",
  });
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
it("logs only that a Safe service is configured, never any part of its URL", async () => {
  state.config.mockReturnValue({
    ...config,
    chainId: 56,
    safeAddress: "0xsafe",
    safeServiceUrl: "https://SAFE-HOST-KEY.safe.test/api/SAFE-PATH-KEY?apikey=SAFE-QUERY-KEY",
  });
  state.safe.mockReturnValue("safe-client");
  await import("../src/main.js");
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain('"safeService":"configured"');
  expect(logs).not.toMatch(/SAFE-HOST-KEY|SAFE-PATH-KEY|SAFE-QUERY-KEY/);
  // The client itself still gets the full URL.
  expect(state.safe).toHaveBeenCalledWith(
    expect.objectContaining({
      serviceUrl: "https://SAFE-HOST-KEY.safe.test/api/SAFE-PATH-KEY?apikey=SAFE-QUERY-KEY",
    }),
  );
});
it("takes the Safe service URL from the loaded configuration, not the environment", async () => {
  // The configuration is the one source: what it holds is what is used, logged and redacted.
  state.config.mockReturnValue({ ...config, chainId: 56, safeAddress: "0xsafe" });
  vi.stubEnv("SAFE_SERVICE_URL", "https://env-only.safe.test");
  await import("../src/main.js");
  expect(state.safe).not.toHaveBeenCalled();
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain('"safeService":null');
});
it("redacts the Safe service URL from loop and startup errors", async () => {
  const safeServiceUrl = "https://SAFE-HOST-KEY.safe.test/api";
  state.config.mockReturnValue({ ...config, chainId: 56, safeAddress: "0xsafe", safeServiceUrl });
  state.step.mockImplementation(async () => {
    state.signals.get("SIGTERM")!();
    throw new Error(`Safe failed ${safeServiceUrl}/v1/safes`);
  });
  await import("../src/main.js");
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain("anchor.loop.failed");
  expect(logs).not.toMatch(/SAFE-HOST-KEY/i);

  vi.resetModules();
  state.rpcChainId.mockRejectedValue(new Error(`proxy ${safeServiceUrl} refused`));
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  const errors = vi.mocked(process.stderr.write).mock.calls.flat().join("");
  expect(errors).toContain("proxy [rpc-url] refused");
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
it("registers the configured contract for its chain before the first step", async () => {
  state.step.mockReset().mockImplementation(async () => {
    expect(state.register).toHaveBeenCalledWith(state.sql, 31337, "0xcontract");
    state.signals.get("SIGTERM")!();
    return { handled: false };
  });
  await import("../src/main.js");
  expect(state.register).toHaveBeenCalledOnce();
  expect(state.step).toHaveBeenCalled();
});

it("refuses to start when the configured contract cannot be registered", async () => {
  // A later chain move would not ask a contract no row names any more: anchoring twice.
  state.register.mockRejectedValue(new Error("connect to https://rpc.test/private-key failed"));
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw new Error("exit");
  });
  await expect(import("../src/main.js")).rejects.toThrow("exit");
  expect(process.exit).toHaveBeenCalledWith(1);
  expect(state.step).not.toHaveBeenCalled();
  const written = vi.mocked(process.stderr.write).mock.calls.map(([text]) => String(text)).join("");
  expect(written).toContain("anchor contract registration failed");
  expect(written).not.toContain("private-key");
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

it("warns at startup about unsettled transactions left on another chain", async () => {
  state.otherChains.mockResolvedValue([{ chainId: 5611, inFlight: 3, openSends: 1 }]);
  await import("../src/main.js");
  expect(state.otherChains).toHaveBeenCalledWith(state.sql, 31337, 1_800_000);
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain('"msg":"anchor.other_chain_in_flight"');
  expect(logs).toContain('"chains":[{"chainId":5611,"inFlight":3,"openSends":1}]');
});

it("stays quiet when no other chain has unsettled transactions", async () => {
  await import("../src/main.js");
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).not.toContain("anchor.other_chain_in_flight");
});

it("warns again on a busy pass once the interval has passed", async () => {
  // A busy worker never has an idle pass: the warning must not depend on one.
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  state.otherChains.mockResolvedValue([{ chainId: 5611, inFlight: 1, openSends: 0 }]);
  let passes = 0;
  state.step.mockImplementation(async () => {
    passes += 1;
    // Within the interval, then past it.
    now += passes === 1 ? 30_000 : 31_000;
    if (passes === 3) state.signals.get("SIGTERM")!();
    return { handled: true };
  });
  await import("../src/main.js");
  // At startup, then on the third pass (61 s later); the second (30 s) is throttled.
  expect(state.otherChains).toHaveBeenCalledTimes(2);
  const warnings = vi
    .mocked(process.stdout.write)
    .mock.calls.flat()
    .filter((line) => String(line).includes('"msg":"anchor.other_chain_in_flight"'));
  expect(warnings).toHaveLength(2);
});

it("keeps stepping when the other-chain count fails on a busy pass", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  state.otherChains
    .mockResolvedValueOnce([])
    .mockRejectedValueOnce(new Error(`count failed ${config.rpcUrl}`));
  let passes = 0;
  state.step.mockImplementation(async () => {
    passes += 1;
    now += 61_000;
    if (passes === 2) state.signals.get("SIGTERM")!();
    return { handled: true };
  });
  await import("../src/main.js");
  expect(passes).toBe(2);
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  // Its own message: the pass went on, so it is not reported as a failed pass.
  expect(logs).toContain('"msg":"anchor.other_chain_check.failed"');
  expect(logs).not.toContain("anchor.loop.failed");
  expect(logs).not.toContain("private-key");
  expect(state.sql.end).toHaveBeenCalledOnce();
});

it("extends this chain's watched rows to the configured watch before the first step", async () => {
  const order: string[] = [];
  state.extendWatch.mockImplementation(async () => {
    order.push("extend");
    return 2;
  });
  state.step.mockImplementation(async () => {
    order.push("step");
    state.signals.get("SIGTERM")!();
    return { handled: false };
  });
  await import("../src/main.js");
  expect(state.extendWatch).toHaveBeenCalledWith(state.sql, 31337, 1_800_000);
  expect(order).toEqual(["extend", "step"]);
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain('"msg":"anchor.reorg_watch.extended","transactions":2');
});

it("logs a failed watch extension under its own message and still steps", async () => {
  state.extendWatch.mockRejectedValue(new Error(`db down ${config.rpcUrl}`));
  await import("../src/main.js");
  expect(state.step).toHaveBeenCalledOnce();
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain('"msg":"anchor.reorg_watch.extend_failed"');
  expect(logs).not.toContain("anchor.loop.failed");
  expect(logs).not.toContain("private-key");
  expect(logs).toContain("[rpc-url]");
});

it("extends again once a minute, so rows a shorter-watch replica confirms are reached", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let passes = 0;
  state.step.mockImplementation(async () => {
    passes += 1;
    now += passes === 1 ? 30_000 : 31_000;
    if (passes === 3) state.signals.get("SIGTERM")!();
    return { handled: true };
  });
  await import("../src/main.js");
  // Before the first pass, then on the third (61 s later); the second (30 s) is throttled.
  expect(state.extendWatch).toHaveBeenCalledTimes(2);
});

it("hands the submitter the same redactor it logs with", async () => {
  let seen: { redact?: (text: string) => string } | undefined;
  state.step.mockImplementation(async (...args: unknown[]) => {
    seen = args[2] as typeof seen;
    state.signals.get("SIGTERM")!();
    return { handled: false };
  });
  await import("../src/main.js");
  expect(seen?.redact?.(`GET ${config.rpcUrl}`)).toBe("GET [rpc-url]");
});

it("carries out chain moves before stepping, and once a minute after", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const order: string[] = [];
  state.moves.mockImplementation(async () => {
    order.push("moves");
    return [];
  });
  let passes = 0;
  state.step.mockImplementation(async () => {
    order.push("step");
    passes += 1;
    now += passes === 1 ? 30_000 : 31_000;
    if (passes === 3) state.signals.get("SIGTERM")!();
    return { handled: true };
  });
  await import("../src/main.js");
  expect(state.moves).toHaveBeenCalledWith(state.sql, expect.anything(), expect.objectContaining({ chainId: 31337 }), expect.any(Function));
  expect(order).toEqual(["moves", "step", "step", "moves", "step"]);
});

it("logs failed chain moves under their own message and still steps", async () => {
  state.moves.mockRejectedValue(new Error(`db down ${config.rpcUrl}`));
  await import("../src/main.js");
  expect(state.step).toHaveBeenCalledOnce();
  const logs = vi.mocked(process.stdout.write).mock.calls.flat().join("");
  expect(logs).toContain('"msg":"anchor.chain_move.failed"');
  expect(logs).not.toContain("anchor.loop.failed");
  expect(logs).not.toContain("private-key");
});

it("keeps stepping and heartbeating while a run of chain moves is still going, and never overlaps one", async () => {
  // A slow node: the run does not end while the loop goes on. Inline, it held the step and the
  // heartbeat for as long, past the health check's window.
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let finish: () => void = () => {};
  state.moves.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  let passes = 0;
  state.step.mockImplementation(async () => {
    passes += 1;
    // Well past the interval each pass: only the run still going keeps another from starting.
    now += 61_000;
    if (passes === 3) state.signals.get("SIGTERM")!();
    return { handled: true };
  });
  await import("../src/main.js");
  expect(state.step).toHaveBeenCalledTimes(3);
  expect(state.heartbeat).toHaveBeenCalledTimes(3);
  expect(state.moves).toHaveBeenCalledOnce();
  // Shutdown waited for it only so long, then closed the database.
  expect(state.sql.end).toHaveBeenCalledOnce();
  finish();
});

it("starts the next run of chain moves once the last has ended and the interval has passed", async () => {
  let now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let finish: () => void = () => {};
  state.moves.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = () => resolve([]);
      }),
  );
  let passes = 0;
  state.step.mockImplementation(async () => {
    passes += 1;
    now += 61_000;
    // The first run ends during the second pass; the third pass starts the next.
    if (passes === 2) finish();
    if (passes === 3) state.signals.get("SIGTERM")!();
    return { handled: true };
  });
  await import("../src/main.js");
  expect(state.moves).toHaveBeenCalledTimes(2);
  finish();
});
