import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
const s = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock("node:net", () => ({ connect: s.connect }));
import { scanBytes } from "../src/scanner.js";
afterEach(() => vi.clearAllMocks());
function socket() {
  return Object.assign(new EventEmitter(), {
    write: vi.fn(),
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
    });
    expect(sock.destroy).toHaveBeenCalledOnce();
  },
);
