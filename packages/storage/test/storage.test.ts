import { describe, expect, it } from "vitest";
import {
  MAX_PRESIGN_TTL_SECONDS,
  UPLOAD_STATES,
  canTransitionUpload,
  computeContentHash,
  createMemoryObjectStore,
  evidenceKey,
  infectedCanNeverBePromoted,
  quarantineKey,
} from "../src/storage.js";

describe("store key rules", () => {
  it("keys are named by the upload or artifact id alone", () => {
    expect(quarantineKey("upload-1")).toBe("quarantine/upload-1");
    expect(evidenceKey("artifact-1")).toBe("evidence/artifact-1");
  });

  it("quarantine and evidence paths do not overlap", () => {
    expect(quarantineKey("u")).not.toContain("evidence/");
    expect(evidenceKey("a")).not.toContain("quarantine/");
  });

  it("keys contain no file name — not even a document title may leak", () => {
    const key = quarantineKey("upload-1");
    expect(key).not.toContain(".pdf");
    expect(key.split("/")).toHaveLength(2);
  });
});

describe("content hash", () => {
  it("computes keccak256 from bytes", () => {
    expect(computeContentHash(new TextEncoder().encode("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("different contents yield different hashes", () => {
    const a = computeContentHash(new TextEncoder().encode("a"));
    const b = computeContentHash(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });

  it("the same contents yield the same hash — duplicate uploads are detectable", () => {
    const bytes = new TextEncoder().encode("same content");
    expect(computeContentHash(bytes)).toBe(computeContentHash(new Uint8Array(bytes)));
  });
});

describe("memory store", () => {
  it("stores and reads", async () => {
    const store = createMemoryObjectStore();
    const body = new TextEncoder().encode("evidence bytes");

    const stored = await store.put("quarantine/t/u", body, "application/pdf");
    expect(stored.byteSize).toBe(body.byteLength);
    expect(stored.contentHash).toBe(computeContentHash(body));

    expect(await store.get("quarantine/t/u")).toEqual(body);
  });

  it("a missing key is null", async () => {
    const store = createMemoryObjectStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("presigned URL lifetime does not exceed the cap", async () => {
    const store = createMemoryObjectStore();
    await store.put("k", new Uint8Array([1]), "text/plain");

    const url = await store.presignGet("k", 86_400);
    expect(url).toContain(`ttl=${MAX_PRESIGN_TTL_SECONDS}`);
  });

  it("copies from quarantine to evidence — the source remains", async () => {
    const store = createMemoryObjectStore();
    const body = new TextEncoder().encode("x");
    await store.put(quarantineKey("u"), body, "text/plain");

    await store.copy(quarantineKey("u"), evidenceKey("a"));

    expect(await store.get(evidenceKey("a"))).toEqual(body);
    expect(await store.get(quarantineKey("u"))).toEqual(body);
  });

  it("copying a missing object fails", async () => {
    const store = createMemoryObjectStore();
    await expect(store.copy("missing", "target")).rejects.toThrow();
  });
});

describe("upload state machine", () => {
  it("normal path", () => {
    expect(canTransitionUpload("received", "quarantined")).toBe(true);
    expect(canTransitionUpload("quarantined", "scanned_clean")).toBe(true);
    expect(canTransitionUpload("scanned_clean", "promoted")).toBe(true);
  });

  it("cannot skip quarantine", () => {
    expect(canTransitionUpload("received", "scanned_clean")).toBe(false);
    expect(canTransitionUpload("received", "promoted")).toBe(false);
  });

  it("cannot promote without a scan", () => {
    expect(canTransitionUpload("quarantined", "promoted")).toBe(false);
  });

  it("an infected verdict is irreversible", () => {
    expect(canTransitionUpload("scanned_infected", "scanned_clean")).toBe(false);
    expect(canTransitionUpload("scanned_infected", "quarantined")).toBe(false);
  });

  it("no path takes an infected file to promoted", () => {
    expect(infectedCanNeverBePromoted()).toBe(true);
  });

  it("promoted and rejected are terminal states", () => {
    for (const state of UPLOAD_STATES) {
      expect(canTransitionUpload("promoted", state)).toBe(false);
      expect(canTransitionUpload("rejected", state)).toBe(false);
    }
  });
});
