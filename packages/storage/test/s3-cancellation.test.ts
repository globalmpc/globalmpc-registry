import { createServer } from "node:http";
import { getEventListeners } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { createS3ObjectStore } from "../src/s3-store.js";
import { createMemoryObjectStore } from "../src/storage.js";

it("does not read a memory object when cancellation was already requested", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before read"));
  await expect(createMemoryObjectStore().get("missing", controller.signal)).rejects.toThrow("cancelled before read");
});

it.each(["before-headers", "streaming-body"])("cancels real S3 HTTP I/O %s without overlapping retries", async phase => {
  let active = 0;
  let maximum = 0;
  let requested!: () => void;
  const server = createServer((request, response) => {
    active++;
    maximum = Math.max(maximum, active);
    let interval: ReturnType<typeof setInterval> | undefined;
    response.on("close", () => { active--; clearInterval(interval); });
    if (request.url?.includes("recovered")) { response.end("recovered"); return; }
    if (phase === "streaming-body") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      response.write(Buffer.alloc(1024));
      interval = setInterval(() => response.write(Buffer.alloc(1024)), 5);
    }
    requested();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test HTTP listener was not bound");
  const store = createS3ObjectStore({ bucket: "quarantine", region: "us-east-1", sse: "none",
    endpoint: `http://127.0.0.1:${address.port}`, forcePathStyle: true,
    credentials: { accessKeyId: "local-test", secretAccessKey: "local-test" } });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const controller = new AbortController();
      const arrived = new Promise<void>(resolve => { requested = resolve; });
      const pending = store.get(`slow-${attempt}`, controller.signal);
      const rejected = expect(pending).rejects.toThrow("read timed out");
      await arrived;
      if (phase === "streaming-body") await delay(20);
      controller.abort(new Error("read timed out"));
      await rejected;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      // Local cancellation settles before the remote peer necessarily observes the socket
      // closing. Wait for its actual close event before measuring the next request's overlap.
      await expect.poll(() => active, { timeout: 5000 }).toBe(0);
    }
    expect(maximum).toBe(1);
    expect(Buffer.from((await store.get("recovered"))!).toString()).toBe("recovered");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
