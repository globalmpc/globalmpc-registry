import { describe, expect, it } from "vitest";
import { keccak256, hexToBytes } from "../src/hash.js";
import { canonicalBytes } from "../src/jcs.js";
import { assertValidLeaf, hashLeaf, hashProjection, type RegistryLeaf } from "../src/leaf.js";

const VALID: RegistryLeaf = {
  registryType: "verification",
  entryVersionId: "01JZ0000000000000000000000",
  subjectId: "01JZ1111111111111111111111",
  version: "3",
  status: "published",
  serializationVersion: "1",
  policyVersion: "mn-core-1.2.0",
  schemaVersion: "verification-attestation-2",
  contentHash: "0x" + "ab".repeat(32),
};

describe("assertValidLeaf", () => {
  it("passes a valid leaf", () => {
    expect(() => assertValidLeaf(VALID)).not.toThrow();
  });

  it("rejects an unknown registryType", () => {
    expect(() => assertValidLeaf({ ...VALID, registryType: "offering" as never })).toThrowError(
      /registryType/,
    );
  });

  it("rejects an unknown status", () => {
    expect(() => assertValidLeaf({ ...VALID, status: "draft" as never })).toThrowError(/status/);
  });

  it("rejects a version with a leading zero", () => {
    expect(() => assertValidLeaf({ ...VALID, version: "03" })).toThrowError(/decimal string/);
  });

  it("allows version 0", () => {
    expect(() => assertValidLeaf({ ...VALID, version: "0" })).not.toThrow();
  });

  it("rejects empty fields", () => {
    expect(() => assertValidLeaf({ ...VALID, subjectId: "" })).toThrowError(/must not be empty/);
    expect(() => assertValidLeaf({ ...VALID, policyVersion: "" })).toThrowError(
      /must not be empty/,
    );
  });

  it("rejects a contentHash that is not 32 bytes", () => {
    expect(() => assertValidLeaf({ ...VALID, contentHash: "0xdead" })).toThrowError(/32-byte/);
  });

  it("rejects an unsupported serializationVersion", () => {
    expect(() =>
      assertValidLeaf({ ...VALID, serializationVersion: "2" as never }),
    ).toThrowError(/serializationVersion/);
  });
});

describe("hashLeaf", () => {
  it("is double keccak256 — never collides with an internal node", () => {
    const inner = keccak256(canonicalBytes(VALID as never));
    expect(hashLeaf(VALID)).toBe(keccak256(hexToBytes(inner)));
  });

  it("the same hash regardless of field definition order", () => {
    const reordered: RegistryLeaf = {
      contentHash: VALID.contentHash,
      schemaVersion: VALID.schemaVersion,
      policyVersion: VALID.policyVersion,
      serializationVersion: VALID.serializationVersion,
      status: VALID.status,
      version: VALID.version,
      subjectId: VALID.subjectId,
      entryVersionId: VALID.entryVersionId,
      registryType: VALID.registryType,
    };
    expect(hashLeaf(reordered)).toBe(hashLeaf(VALID));
  });

  it("changing any field changes the hash", () => {
    const base = hashLeaf(VALID);
    expect(hashLeaf({ ...VALID, version: "4" })).not.toBe(base);
    expect(hashLeaf({ ...VALID, status: "revoked" })).not.toBe(base);
    expect(hashLeaf({ ...VALID, policyVersion: "mn-core-1.2.1" })).not.toBe(base);
    expect(hashLeaf({ ...VALID, registryType: "project" })).not.toBe(base);
  });

  it("does not hash an unvalidated leaf", () => {
    expect(() => hashLeaf({ ...VALID, contentHash: "0x00" })).toThrowError(/32-byte/);
  });
});

describe("hashProjection", () => {
  it("produces the commitment of a public projection", () => {
    const projection = {
      projectKey: "MPC-XXX-999",
      hostCountry: "MNG",
      status: "registered",
      asOf: "2026-08-01",
      limitations: ["Legal title verification is outside the scope of this review"],
    };
    expect(hashProjection(projection)).toBe(keccak256(canonicalBytes(projection)));
  });

  it("the same commitment regardless of key order", () => {
    const a = hashProjection({ b: "2", a: "1" });
    const b = hashProjection({ a: "1", b: "2" });
    expect(a).toBe(b);
  });

  it("rejects a projection containing a number", () => {
    expect(() => hashProjection({ tonnage: 1200 } as never)).toThrowError(
      /JSON numbers are not allowed/,
    );
  });
});
