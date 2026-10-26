import { expect, it } from "vitest";
import { auditExportQuery } from "../src/exports.js";
import { recordFactConfirmationRequest } from "../src/project-registry.js";
import { correctClaimRequest } from "../src/resources.js";
import { structuredClaimValues } from "../src/structured-claims.js";

const correction = {
  valueText: "9007199254740993.000000000000000001",
  sourceCoordinate: { page: "12" },
  reason: "Correct the reported reserve",
};

it("keeps omitted catalog and attachment fields absent while applying nullable correction defaults", () => {
  expect(correctClaimRequest.parse(correction)).toEqual({
    ...correction,
    unit: null,
    asOf: null,
    sourceReceiptId: null,
    evidenceTier: null,
  });
});

it("preserves explicit null structured data and an explicit empty attachment list", () => {
  expect(correctClaimRequest.parse({
    ...correction, catalogEntryId: null, structuredValues: null, documentUploadIds: [], unit: "",
  })).toEqual({
    ...correction, catalogEntryId: null, structuredValues: null, documentUploadIds: [], unit: "",
    asOf: null, sourceReceiptId: null, evidenceTier: null,
  });
  expect(correctClaimRequest.safeParse({ ...correction, documentUploadIds: null }).success).toBe(false);
});

it("does not turn empty identifiers or empty correction text into nullable defaults", () => {
  for (const field of ["catalogEntryId", "sourceReceiptId", "valueText", "reason"]) {
    expect(correctClaimRequest.safeParse({ ...correction, [field]: "" }).success, field).toBe(false);
  }
});

it("accepts a leap day and rejects impossible or non-date calendar inputs in both requests", () => {
  for (const asOf of ["2024-02-29", "2000-02-29"]) {
    expect(correctClaimRequest.parse({ ...correction, asOf }).asOf).toBe(asOf);
    expect(recordFactConfirmationRequest.parse({ status: "pending", reason: "Awaiting evidence", asOf }).asOf).toBe(asOf);
  }
  for (const asOf of ["2023-02-29", "1900-02-29", "2024-04-31", "2024-2-9", "2024-02-29T00:00:00Z", ""]) {
    expect(correctClaimRequest.safeParse({ ...correction, asOf }).success, asOf).toBe(false);
    expect(recordFactConfirmationRequest.safeParse({ status: "pending", reason: "Awaiting evidence", asOf }).success, asOf).toBe(false);
  }
});

it("preserves decimal strings and boolean values without numeric conversion", () => {
  const values = { reserve: "9007199254740993.000000000000000001", verified: false };
  expect(structuredClaimValues.parse(values)).toEqual(values);
  expect(correctClaimRequest.parse({ ...correction, structuredValues: values }).structuredValues).toEqual(values);
  for (const reserve of [1.25, 0, null, { amount: "1.25" }]) {
    expect(structuredClaimValues.safeParse({ reserve }).success).toBe(false);
  }
});

it("validates structured field names while retaining empty declared values", () => {
  expect(structuredClaimValues.parse({ reserve_tonnes: "", verified: true })).toEqual({ reserve_tonnes: "", verified: true });
  for (const key of ["Reserve", "reserve-tonnes", "", "1reserve"]) {
    expect(structuredClaimValues.safeParse({ [key]: "10" }).success, key).toBe(false);
  }
});

it("defaults pending confirmation evidence and date without inventing a namespace", () => {
  expect(recordFactConfirmationRequest.parse({ status: "pending", reason: "  Awaiting evidence  " })).toEqual({
    status: "pending", reason: "Awaiting evidence", evidence: null, asOf: null,
  });
});

it("accepts explicit confirmation namespaces but rejects unknown fields and namespaces", () => {
  for (const factScope of ["legacy", "catalog"]) {
    expect(recordFactConfirmationRequest.parse({ status: "pending", reason: "Awaiting evidence", factScope }).factScope).toBe(factScope);
  }
  for (const extra of [{ factScope: null }, { factScope: "other" }, { namespace: "catalog" }]) {
    expect(recordFactConfirmationRequest.safeParse({ status: "pending", reason: "Awaiting evidence", ...extra }).success).toBe(false);
  }
});

it("requires real evidence for confirmed facts even when nullable defaults apply", () => {
  const confirmed = { status: "confirmed", reason: "Checked receipt", evidence: { kind: "source_receipt", id: "aaaaaaaa-0000-0000-0000-000000000001" } };
  expect(recordFactConfirmationRequest.parse(confirmed)).toEqual({ ...confirmed, asOf: null });
  for (const evidence of [undefined, null, {}]) {
    expect(recordFactConfirmationRequest.safeParse({ ...confirmed, evidence }).success).toBe(false);
  }
});

it("rejects omissions of required correction and confirmation fields", () => {
  for (const field of ["valueText", "sourceCoordinate", "reason"]) {
    const input: Record<string, unknown> = { ...correction };
    delete input[field];
    expect(correctClaimRequest.safeParse(input).success, field).toBe(false);
  }
  for (const input of [{ reason: "Awaiting evidence" }, { status: "pending" }, { status: "pending", reason: "  " }]) {
    expect(recordFactConfirmationRequest.safeParse(input).success).toBe(false);
  }
});

it("coerces audit page limits and preserves arbitrary precision cursor strings", () => {
  expect(auditExportQuery.parse({})).toEqual({ limit: 1000 });
  expect(auditExportQuery.parse({ limit: "5000", afterId: "900719925474099312345" })).toEqual({ limit: 5000, afterId: "900719925474099312345" });
  expect(auditExportQuery.parse({ limit: "1" })).toEqual({ limit: 1 });
});

it("rejects fractional, out-of-range and non-numeric audit limits and malformed cursors", () => {
  for (const limit of ["1.5", 1.5, "0", "5001", "", null, "NaN", "Infinity"]) {
    expect(auditExportQuery.safeParse({ limit }).success, String(limit)).toBe(false);
  }
  for (const afterId of [1, "-1", "1.5", "1e3", ""]) {
    expect(auditExportQuery.safeParse({ afterId }).success, String(afterId)).toBe(false);
  }
  expect(auditExportQuery.safeParse({ limit: "10", unknownFilter: "ignored?" }).success).toBe(false);
});
