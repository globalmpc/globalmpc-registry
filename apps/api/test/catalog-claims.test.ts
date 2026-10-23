import { canonicalBytes, keccak256 } from "@mpc/canonical";
import { hashSnapshotInput, snapshotClaimFingerprint } from "../src/services/evidence-snapshot.js";
import { describe, expect, it } from "vitest";
import { validateCatalogValues } from "../src/services/catalog-claims.js";
const definition = { fields: [
  { key: "amount", label: "Amount", type: "number", required: true },
  { key: "issued", label: "Issued", type: "date", required: true },
  { key: "active", label: "Active", type: "boolean", required: false },
  { key: "name", label: "Name", type: "string", required: false },
] };
const valid = { amount: "12345678901234567890.123456789", issued: "2024-02-29" };
describe("catalog claim declared fields", () => {
  it("preserves decimal precision and accepts actual boolean false", () => {
    expect(() => validateCatalogValues(definition, { ...valid, active: false })).not.toThrow();
  });
  it.each([
    { ...valid, amount: "1e8" }, { ...valid, amount: "0.1" + "0".repeat(38) },
    { ...valid, issued: "2025-02-29" }, { ...valid, issued: "2026-04-31" },
    { ...valid, issued: "0000-01-01" }, { ...valid, active: "true" },
    { ...valid, name: " " }, { ...valid, injected: "unreviewed" },
    { issued: valid.issued },
  ])("rejects invalid/missing/undeclared values: %j", (values) => {
    expect(() => validateCatalogValues(definition, values)).toThrow();
  });
});

describe("structured evidence snapshot versioning", () => {
  const legacy = { claimIds: ["c"], artifactIds: [], receiptIds: [], claimFingerprints: [{ id: "c", valueText: "Summary", grade: "unverified" }] };
  it("preserves legacy snapshot bytes", () => {
    const historical = { snapshotVersion: "1", claimIds: ["c"], artifactIds: [], receiptIds: [], claims: legacy.claimFingerprints };
    expect(hashSnapshotInput(legacy)).toBe(keccak256(canonicalBytes(historical)));
  });
  const row = { id: "c", value_text: "Summary", grade: "unverified", catalog_entry_id: "catalog", catalog_version: 1,
    structured_values: { number: "123" }, document_upload_ids: ["doc2", "doc1"] };
  const hash = (input = row) => hashSnapshotInput({ ...legacy, claimFingerprints: [snapshotClaimFingerprint(input)] });
  it("binds catalog identity/version, structured values and documents independently of the summary", () => {
    expect(hash()).not.toBe(hashSnapshotInput(legacy));
    expect(hash({ ...row, catalog_entry_id: "other" })).not.toBe(hash());
    expect(hash({ ...row, catalog_version: 2 })).not.toBe(hash());
    expect(hash({ ...row, structured_values: { number: "456" } })).not.toBe(hash());
    expect(hash({ ...row, document_upload_ids: ["doc1"] })).not.toBe(hash());
    expect(hash({ ...row, document_upload_ids: ["doc1", "doc2"] })).toBe(hash());
  });
});
