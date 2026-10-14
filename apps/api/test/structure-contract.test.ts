import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NINE_STRUCTURES } from "@mpc/api-contract";
import { classifyIp, hashUserAgent } from "../src/device.js";

/**
 * 13 §13.13 — the event half of the nine-structure linkage.
 *
 * The contract lists which domain events each structure emits. A list nobody checks drifts: an
 * event renamed in a route would leave the contract naming an event that no longer exists. This
 * reads the API source and requires each listed event type to be enqueued somewhere.
 */

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : full.endsWith(".ts") ? [full] : [];
  });
}

const emitted = new Set(
  sourceFiles(SRC).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(/eventType: "([a-z_.]+)"/g)].map((match) => match[1]!),
  ),
);

describe("nine structures — event linkage (13 §13.13)", () => {
  it("found the API's event emissions at all", () => {
    // With an empty set every check below would fail for the wrong reason; with a broken
    // pattern the reverse check would pass vacuously.
    expect(emitted.size).toBeGreaterThan(5);
  });

  it("every event the contract lists is emitted by the API", () => {
    const missing = NINE_STRUCTURES.flatMap((structure) =>
      structure.events
        .filter((event) => !emitted.has(event))
        .map((event) => `${structure.name}: ${event}`),
    );
    expect(missing).toEqual([]);
  });
});

describe("audit device metadata (02 §2.7)", () => {
  it("classifies the client address without scoring it", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("::1")).toBe("loopback");
    expect(classifyIp("10.1.2.3")).toBe("private");
    expect(classifyIp("::ffff:192.168.0.9")).toBe("private");
    expect(classifyIp("169.254.1.1")).toBe("link_local");
    expect(classifyIp("203.0.113.7")).toBe("public");
    expect(classifyIp("not-an-ip")).toBe("unknown");
    expect(classifyIp(undefined)).toBeNull();
  });

  it("keeps a hash of the user agent, never the string", () => {
    const hash = hashUserAgent("Mozilla/5.0 test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(hashUserAgent("Mozilla/5.0 test"));
    expect(hashUserAgent("")).toBeNull();
    expect(hashUserAgent(undefined)).toBeNull();
  });
});
