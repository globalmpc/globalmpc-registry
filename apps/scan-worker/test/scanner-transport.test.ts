import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ connect: s.connect }));
import { MAX_SCAN_BYTES, scanBytes, scanDeadlineMs, scannerAvailable } from "../src/scanner.js";
afterEach(() => vi.clearAllMocks());
function socket() {
  return Object.assign(new EventEmitter(), {
    write: vi.fn().mockReturnValue(true),
    destroy: vi.fn(),
    setTimeout: vi.fn(),
  });
}
it("sends length-prefixed chunks and joins a fragmented ClamAV response", async () => {
  const sock = socket();
  s.connect.mockReturnValue(sock);
  const pending = scanBytes(new Uint8Array([1, 2, 3]), {
    host: "scanner",
    port: 3310,
    timeoutMs: 50,
    chunkBytes: 2,
  });
  sock.emit("connect");
  expect(
    sock.write.mock.calls.map((c) =>
      typeof c[0] === "string" ? c[0] : [...c[0]],
    ),
  ).toEqual(["zINSTREAM\0", [0, 0, 0, 2, 1, 2], [0, 0, 0, 1, 3], [0, 0, 0, 0]]);
  sock.emit("data", Buffer.from("stream: EIC"));
  sock.emit("data", Buffer.from("AR FOUND\0"));
  sock.emit("end");
  expect(await pending).toEqual({ kind: "infected", signature: "EICAR" });
  expect(sock.destroy).toHaveBeenCalledOnce();
});
it.each(["timeout", "error"])(
  "treats %s as scanner failure and settles only once",
  async (event) => {
    const sock = socket();
    s.connect.mockReturnValue(sock);
    const pending = scanBytes(new Uint8Array(), {
      host: "scanner",
      port: 3310,
      timeoutMs: 50,
      chunkBytes: 2,
    });
    sock.emit(event, new Error("connection refused"));
    sock.emit("end");
    expect(await pending).toEqual({
      kind: "error",
      reason: event === "timeout" ? "scan timeout" : "connection refused",
      unavailable: true,
    });
    expect(sock.destroy).toHaveBeenCalledOnce();
  },
);

it("caps cumulative response bytes across fragments before interpreting a success suffix", async () => {
  const sock = socket();
  s.connect.mockReturnValue(sock);
  const pending = scanBytes(new Uint8Array(), {
    host: "scanner", port: 3310, timeoutMs: 1000, chunkBytes: 2,
  });
  sock.emit("data", Buffer.alloc(2048, 65));
  sock.emit("data", Buffer.alloc(2048, 65));
  expect(sock.destroy).not.toHaveBeenCalled();
  sock.emit("data", Buffer.from("stream: OK\0"));
  sock.emit("end");
  expect(await pending).toEqual({ kind: "error", reason: "scanner response exceeds 4096 bytes" });
  expect(sock.destroy).toHaveBeenCalledOnce();
});

it("expires the absolute deadline even while data keeps the connection active", async () => {
  vi.useFakeTimers();
  try {
    const sock = socket();
    s.connect.mockReturnValue(sock);
    const pending = scanBytes(new Uint8Array(), {
      host: "scanner", port: 3310, timeoutMs: 1000, chunkBytes: 2,
    });
    sock.emit("connect");
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(100);
      sock.emit("data", Buffer.from("x"));
    }
    expect(sock.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toEqual({ kind: "error", reason: "scan timeout" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("clears the absolute deadline after a successful response", async () => {
  vi.useFakeTimers();
  try {
    const sock = socket();
    s.connect.mockReturnValue(sock);
    const pending = scanBytes(new Uint8Array(), {
      host: "scanner", port: 3310, timeoutMs: 1000, chunkBytes: 2,
    });
    sock.emit("data", Buffer.from("stream: OK\0"));
    sock.emit("end");
    expect(await pending).toEqual({ kind: "clean" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it("rejects an oversized response from a real TCP peer without waiting for peer EOF", async () => {
  const net = await vi.importActual<typeof import("node:net")>("node:net");
  s.connect.mockImplementation(net.connect);
  const peers = new Set<import("node:net").Socket>();
  const server = net.createServer((peer) => {
    peers.add(peer);
    peer.on("error", () => {});
    peer.on("close", () => peers.delete(peer));
    peer.once("data", () => {
      peer.write(Buffer.alloc(2048, 65));
      setImmediate(() => peer.write(Buffer.alloc(2049, 65)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    expect(await scanBytes(new Uint8Array([1]), {
      host: "127.0.0.1", port: address.port, timeoutMs: 2000, chunkBytes: 2,
    })).toEqual({ kind: "error", reason: "scanner response exceeds 4096 bytes" });
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it("bounds a real TCP peer that drips data without becoming idle", async () => {
  const net = await vi.importActual<typeof import("node:net")>("node:net");
  s.connect.mockImplementation(net.connect);
  let sent = 0;
  let peerSocket: import("node:net").Socket | undefined;
  let drip: ReturnType<typeof setInterval> | undefined;
  const server = net.createServer((peer) => {
    peerSocket = peer;
    peer.on("error", () => {});
    peer.once("data", () => {
      drip = setInterval(() => { sent++; peer.write("x"); }, 10);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as import("node:net").AddressInfo;
    expect(await scanBytes(new Uint8Array([1]), {
      host: "127.0.0.1", port: address.port, timeoutMs: 500, chunkBytes: 2,
    })).toEqual({ kind: "error", reason: "scan timeout" });
    expect(sent).toBeGreaterThan(1);
  } finally {
    clearInterval(drip);
    peerSocket?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it.each(["timeout", "error"])("does not refund a %s after the peer accepted the upload", async (event) => {
  const sock = socket();
  s.connect.mockReturnValue(sock);
  const pending = scanBytes(new Uint8Array([1]), { host: "scanner", port: 3310, timeoutMs: 50, chunkBytes: 2 });
  sock.emit("connect");
  sock.emit(event, new Error("connection reset"));
  expect(await pending).toEqual({ kind: "error", reason: event === "timeout" ? "scan timeout" : "connection reset" });
});

it("probes daemon availability with PING and joins fragmented PONG", async () => {
  const sock = socket();
  s.connect.mockReturnValue(sock);
  const pending = scannerAvailable({ host: "scanner", port: 3310, timeoutMs: 1000 });
  sock.emit("connect");
  expect(sock.write).toHaveBeenCalledWith("zPING\0");
  sock.emit("data", Buffer.from("PO"));
  sock.emit("data", Buffer.from("NG\0"));
  expect(await pending).toBe(true);
  expect(sock.destroy).toHaveBeenCalledOnce();
});

it.each(["NOT PONG\0", "ERROR\0", "PONG\0extra", "stream: OK\0"])("rejects malformed availability response %s", async (reply) => {
  const sock = socket();
  s.connect.mockReturnValue(sock);
  const pending = scannerAvailable({ host: "scanner", port: 3310, timeoutMs: 1000 });
  sock.emit("data", Buffer.from(reply));
  sock.emit("end");
  expect(await pending).toBe(false);
});

it("bounds probe response size and absolute time even when a peer drips data", async () => {
  vi.useFakeTimers();
  try {
    const oversized = socket();
    s.connect.mockReturnValue(oversized);
    const first = scannerAvailable({ host: "scanner", port: 3310, timeoutMs: 1000 });
    oversized.emit("data", Buffer.alloc(4097));
    expect(await first).toBe(false);
    const drip = socket();
    s.connect.mockReturnValue(drip);
    const second = scannerAvailable({ host: "scanner", port: 3310, timeoutMs: 1000 });
    for (let i = 0; i < 9; i++) { await vi.advanceTimersByTimeAsync(100); drip.emit("data", Buffer.from("x")); }
    await vi.advanceTimersByTimeAsync(100);
    expect(await second).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

it.each(["timeout", "error", "end"])("returns unavailable on probe %s", async (event) => {
  const sock = socket();
  s.connect.mockReturnValue(sock);
  const pending = scannerAvailable({ host: "scanner", port: 3310, timeoutMs: 1000 });
  sock.emit(event, new Error("unavailable"));
  expect(await pending).toBe(false);
});

it("scales the absolute and idle budgets through the accepted size limit", () => {
  expect(scanDeadlineMs(0)).toBe(30_000);
  expect(scanDeadlineMs(300 * 1024 * 1024)).toBe(67_500);
  expect(scanDeadlineMs(MAX_SCAN_BYTES)).toBe(280_000);
  expect(() => scanDeadlineMs(MAX_SCAN_BYTES + 1)).toThrow();
  expect(() => scanDeadlineMs(1, Number.NaN)).toThrow();
  expect(scanDeadlineMs(MAX_SCAN_BYTES, 999999999)).toBe(600_000);
});

it("paces upload frames until drain and keeps the same absolute deadline", async () => {
  vi.useFakeTimers();
  try {
    const sock = socket();
    s.connect.mockReturnValue(sock);
    sock.write.mockReturnValueOnce(true).mockReturnValueOnce(false).mockReturnValue(true);
    const pending = scanBytes(new Uint8Array([1,2,3,4]), { host:"scanner",port:3310,timeoutMs:1000,chunkBytes:2 });
    sock.emit("connect");
    expect(sock.write).toHaveBeenCalledTimes(2);
    expect(sock.setTimeout).toHaveBeenCalledWith(1125);
    await vi.advanceTimersByTimeAsync(500);
    sock.emit("drain");
    expect(sock.write).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(625);
    expect(await pending).toEqual({kind:"error",reason:"scan timeout"});
    sock.emit("drain");
    expect(sock.write).toHaveBeenCalledTimes(4);
  } finally { vi.useRealTimers(); }
});

it("allows a healthy accepted upload to finish after the former fixed 30 second deadline", async () => {
  vi.useFakeTimers();
  try {
    const sock=socket();
    s.connect.mockReturnValue(sock);
    sock.write.mockReturnValueOnce(true).mockReturnValueOnce(false);
    const pending=scanBytes(new Uint8Array(64*1024*1024),{host:"scanner",port:3310,timeoutMs:30000,chunkBytes:1024*1024});
    sock.emit("connect");
    await vi.advanceTimersByTimeAsync(31000);
    expect(sock.destroy).not.toHaveBeenCalled();
    sock.write.mockReturnValue(true);
    sock.emit("drain");
    sock.emit("data",Buffer.from("stream: OK\0"));
    sock.emit("end");
    expect(await pending).toEqual({kind:"clean"});
    expect(vi.getTimerCount()).toBe(0);
  } finally {vi.useRealTimers();}
});
