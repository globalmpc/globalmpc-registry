import { beforeEach, expect, it, vi } from "vitest";
import { keccak256 } from "@mpc/canonical";
const s = vi.hoisted(() => ({
  send: vi.fn(),
  sign: vi.fn(),
  configs: [] as unknown[],
  upload: vi.fn(),
}));
vi.mock("@aws-sdk/client-s3", () => {
  class Command {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client: class {
      constructor(config: unknown) {
        s.configs.push(config);
      }
      send = s.send;
    },
    PutObjectCommand: Command,
    GetObjectCommand: Command,
    CopyObjectCommand: Command,
  };
});
vi.mock("@aws-sdk/s3-request-presigner", () => ({ getSignedUrl: s.sign }));
vi.mock("@aws-sdk/lib-storage", () => ({
  Upload: class {
    constructor(
      private options: { params: { Body: AsyncIterable<Uint8Array> } },
    ) {}
    async done() {
      for await (const chunk of this.options.params.Body) s.upload(chunk);
    }
  },
}));
import { createS3ObjectStore } from "../src/s3-store.js";
beforeEach(() => {
  s.send.mockReset();
  s.sign.mockReset().mockResolvedValue("https://public.test/signed");
  s.configs.length = 0;
  s.upload.mockReset();
});
it.each([
  ["kms", { ServerSideEncryption: "aws:kms", SSEKMSKeyId: "key1" }],
  ["aes256", { ServerSideEncryption: "AES256" }],
  ["none", {}],
] as const)(
  "writes and copies with %s encryption and a verified byte hash",
  async (sse, encryption) => {
    const store = createS3ObjectStore({
      bucket: "evidence",
      region: "region1",
      sse,
      kmsKeyId: "key1",
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await store.put("quarantine/a", bytes, "application/pdf")).toEqual({
      key: "quarantine/a",
      byteSize: 3,
      contentType: "application/pdf",
      contentHash: keccak256(bytes),
    });
    expect(s.send.mock.calls[0]?.[0].input).toMatchObject({
      Bucket: "evidence",
      Key: "quarantine/a",
      Metadata: { "content-hash": keccak256(bytes) },
      ...encryption,
    });
    await store.copy("quarantine/a", "clean/a");
    expect(s.send.mock.calls[1]?.[0].input).toMatchObject({
      CopySource: "evidence/quarantine/a",
      Key: "clean/a",
      ...encryption,
    });
  },
);
it("hashes every streamed chunk and transfers them without changing byte order", async () => {
  const store = createS3ObjectStore({
    bucket: "evidence",
    region: "region1",
    sse: "none",
  });
  async function* chunks() {
    yield new Uint8Array([1, 2]);
    yield new Uint8Array([3]);
  }
  const result = await store.putStream("large", chunks(), "application/pdf");
  expect(result.contentHash).toBe(keccak256(new Uint8Array([1, 2, 3])));
  expect(result.byteSize).toBe(3);
  expect(s.upload.mock.calls.map((c) => [...c[0]])).toEqual([[1, 2], [3]]);
});
it("distinguishes absent objects from permission and transport errors", async () => {
  const store = createS3ObjectStore({
    bucket: "evidence",
    region: "region1",
    sse: "none",
  });
  s.send
    .mockResolvedValueOnce({
      Body: { transformToByteArray: async () => new Uint8Array([3, 4]) },
    })
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce({ name: "NoSuchKey" })
    .mockRejectedValueOnce(new Error("AccessDenied"));
  expect(await store.get("a")).toEqual(new Uint8Array([3, 4]));
  expect(await store.get("b")).toBeNull();
  expect(await store.get("c")).toBeNull();
  await expect(store.get("d")).rejects.toThrow("AccessDenied");
});
it("signs browser downloads against the public endpoint, clamps expiry and forces attachment", async () => {
  const store = createS3ObjectStore({
    bucket: "evidence",
    region: "region1",
    sse: "none",
    endpoint: "http://private.test",
    publicEndpoint: "https://public.test",
    forcePathStyle: true,
    credentials: { accessKeyId: "id", secretAccessKey: "secret" },
  });
  expect(await store.presignGet("a", 999999)).toBe(
    "https://public.test/signed",
  );
  expect(s.configs).toEqual([
    expect.objectContaining({
      endpoint: "http://private.test",
      forcePathStyle: true,
    }),
    expect.objectContaining({ endpoint: "https://public.test" }),
  ]);
  expect(s.sign).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      input: expect.objectContaining({
        ResponseContentDisposition: "attachment",
        ResponseContentType: "application/octet-stream",
      }),
    }),
    { expiresIn: 900 },
  );
});
