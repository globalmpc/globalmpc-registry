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
  it("올바른 leaf를 통과시킨다", () => {
    expect(() => assertValidLeaf(VALID)).not.toThrow();
  });

  it("알 수 없는 registryType을 거절한다", () => {
    expect(() => assertValidLeaf({ ...VALID, registryType: "offering" as never })).toThrowError(
      /registryType/,
    );
  });

  it("알 수 없는 status를 거절한다", () => {
    expect(() => assertValidLeaf({ ...VALID, status: "draft" as never })).toThrowError(/status/);
  });

  it("선행 0이 있는 version을 거절한다", () => {
    expect(() => assertValidLeaf({ ...VALID, version: "03" })).toThrowError(/decimal string/);
  });

  it("version이 0인 것은 허용한다", () => {
    expect(() => assertValidLeaf({ ...VALID, version: "0" })).not.toThrow();
  });

  it("빈 필드를 거절한다", () => {
    expect(() => assertValidLeaf({ ...VALID, subjectId: "" })).toThrowError(/비어 있을 수 없다/);
    expect(() => assertValidLeaf({ ...VALID, policyVersion: "" })).toThrowError(
      /비어 있을 수 없다/,
    );
  });

  it("32바이트가 아닌 contentHash를 거절한다", () => {
    expect(() => assertValidLeaf({ ...VALID, contentHash: "0xdead" })).toThrowError(/32바이트/);
  });

  it("지원하지 않는 serializationVersion을 거절한다", () => {
    expect(() =>
      assertValidLeaf({ ...VALID, serializationVersion: "2" as never }),
    ).toThrowError(/serializationVersion/);
  });
});

describe("hashLeaf", () => {
  it("이중 keccak256이다 — 내부 노드와 충돌하지 않는다", () => {
    const inner = keccak256(canonicalBytes(VALID as never));
    expect(hashLeaf(VALID)).toBe(keccak256(hexToBytes(inner)));
  });

  it("필드 정의 순서가 달라도 같은 해시가 나온다", () => {
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

  it("어느 필드든 바뀌면 해시가 바뀐다", () => {
    const base = hashLeaf(VALID);
    expect(hashLeaf({ ...VALID, version: "4" })).not.toBe(base);
    expect(hashLeaf({ ...VALID, status: "revoked" })).not.toBe(base);
    expect(hashLeaf({ ...VALID, policyVersion: "mn-core-1.2.1" })).not.toBe(base);
    expect(hashLeaf({ ...VALID, registryType: "project" })).not.toBe(base);
  });

  it("검증되지 않은 leaf는 해시하지 않는다", () => {
    expect(() => hashLeaf({ ...VALID, contentHash: "0x00" })).toThrowError(/32바이트/);
  });
});

describe("hashProjection", () => {
  it("public projection의 커밋먼트를 만든다", () => {
    const projection = {
      projectKey: "MPC-XXX-999",
      hostCountry: "MNG",
      status: "registered",
      asOf: "2026-08-01",
      limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
    };
    expect(hashProjection(projection)).toBe(keccak256(canonicalBytes(projection)));
  });

  it("키 순서가 달라도 같은 커밋먼트다", () => {
    const a = hashProjection({ b: "2", a: "1" });
    const b = hashProjection({ a: "1", b: "2" });
    expect(a).toBe(b);
  });

  it("projection에 number가 있으면 거절한다", () => {
    expect(() => hashProjection({ tonnage: 1200 } as never)).toThrowError(
      /JSON number를 쓸 수 없다/,
    );
  });
});
