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

describe("저장소 키 규칙", () => {
  it("quarantine 키가 tenant로 분리된다", () => {
    const a = quarantineKey("tenant-a", "upload-1");
    const b = quarantineKey("tenant-b", "upload-1");
    expect(a).not.toBe(b);
    expect(a.startsWith("quarantine/tenant-a/")).toBe(true);
  });

  it("quarantine 경로와 evidence 경로가 겹치지 않는다", () => {
    expect(quarantineKey("t", "u")).not.toContain("evidence/");
    expect(evidenceKey("t", "a")).not.toContain("quarantine/");
  });

  it("키에 파일명이 들어가지 않는다 — 문서 제목도 누출되면 안 된다", () => {
    const key = quarantineKey("tenant-a", "upload-1");
    expect(key).not.toContain(".pdf");
    expect(key.split("/")).toHaveLength(3);
  });
});

describe("content hash", () => {
  it("바이트에서 keccak256을 만든다", () => {
    expect(computeContentHash(new TextEncoder().encode("abc"))).toBe(
      "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
    );
  });

  it("내용이 다르면 해시가 다르다", () => {
    const a = computeContentHash(new TextEncoder().encode("a"));
    const b = computeContentHash(new TextEncoder().encode("b"));
    expect(a).not.toBe(b);
  });

  it("같은 내용은 같은 해시다 — 중복 업로드를 탐지할 수 있다", () => {
    const bytes = new TextEncoder().encode("same content");
    expect(computeContentHash(bytes)).toBe(computeContentHash(new Uint8Array(bytes)));
  });
});

describe("메모리 저장소", () => {
  it("저장하고 읽는다", async () => {
    const store = createMemoryObjectStore();
    const body = new TextEncoder().encode("evidence bytes");

    const stored = await store.put("quarantine/t/u", body, "application/pdf");
    expect(stored.byteSize).toBe(body.byteLength);
    expect(stored.contentHash).toBe(computeContentHash(body));

    expect(await store.get("quarantine/t/u")).toEqual(body);
  });

  it("없는 키는 null이다", async () => {
    const store = createMemoryObjectStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("presigned URL의 수명이 상한을 넘지 않는다", async () => {
    const store = createMemoryObjectStore();
    await store.put("k", new Uint8Array([1]), "text/plain");

    const url = await store.presignGet("k", 86_400);
    expect(url).toContain(`ttl=${MAX_PRESIGN_TTL_SECONDS}`);
  });

  it("quarantine에서 evidence로 복사한다 — 원본은 남는다", async () => {
    const store = createMemoryObjectStore();
    const body = new TextEncoder().encode("x");
    await store.put(quarantineKey("t", "u"), body, "text/plain");

    await store.copy(quarantineKey("t", "u"), evidenceKey("t", "a"));

    expect(await store.get(evidenceKey("t", "a"))).toEqual(body);
    expect(await store.get(quarantineKey("t", "u"))).toEqual(body);
  });

  it("없는 객체를 복사하면 실패한다", async () => {
    const store = createMemoryObjectStore();
    await expect(store.copy("missing", "target")).rejects.toThrow();
  });
});

describe("업로드 상태기계", () => {
  it("정상 경로", () => {
    expect(canTransitionUpload("received", "quarantined")).toBe(true);
    expect(canTransitionUpload("quarantined", "scanned_clean")).toBe(true);
    expect(canTransitionUpload("scanned_clean", "promoted")).toBe(true);
  });

  it("quarantine을 건너뛸 수 없다", () => {
    expect(canTransitionUpload("received", "scanned_clean")).toBe(false);
    expect(canTransitionUpload("received", "promoted")).toBe(false);
  });

  it("검사 없이 승격할 수 없다", () => {
    expect(canTransitionUpload("quarantined", "promoted")).toBe(false);
  });

  it("감염 판정은 되돌릴 수 없다", () => {
    expect(canTransitionUpload("scanned_infected", "scanned_clean")).toBe(false);
    expect(canTransitionUpload("scanned_infected", "quarantined")).toBe(false);
  });

  it("감염 파일이 promoted에 도달하는 경로가 없다", () => {
    expect(infectedCanNeverBePromoted()).toBe(true);
  });

  it("promoted와 rejected는 종착 상태다", () => {
    for (const state of UPLOAD_STATES) {
      expect(canTransitionUpload("promoted", state)).toBe(false);
      expect(canTransitionUpload("rejected", state)).toBe(false);
    }
  });
});
