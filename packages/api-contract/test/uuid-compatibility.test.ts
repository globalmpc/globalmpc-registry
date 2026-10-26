import { expect, it } from "vitest";
import { auditExportQuery } from "../src/exports.js";
import { structuredClaimInput } from "../src/structured-claims.js";

// PostgreSQL UUIDs and existing clients do not require RFC version/variant bits.
// Zod 4 uuid() tightened that contract; guid() retains the original hex format.
it.each([
  "aaaaaaaa-0000-0000-0000-000000000001",
  "00000000-0000-0000-0000-000000000000",
  "AAAAAAAA-0000-0000-0000-000000000001",
  "e653b807-513c-4e1e-9df9-54cc6a03626c",
])("accepts the existing UUID wire format %s", projectId => {
  expect(auditExportQuery.parse({ projectId }).projectId).toBe(projectId);
  expect(structuredClaimInput.documentUploadIds.parse([projectId])).toEqual([projectId]);
});

it.each([
  "gaaaaaaa-0000-0000-0000-000000000001",
  "aaaaaaaa000000000000000000000001",
  "aaaaaaaa-0000-0000-0000-00000000001",
  " aaaaaaaa-0000-0000-0000-000000000001",
  "aaaaaaaa-0000-0000-0000-000000000001/other",
])("rejects malformed UUID input %s", projectId => {
  expect(auditExportQuery.safeParse({ projectId }).success).toBe(false);
  expect(structuredClaimInput.documentUploadIds.safeParse([projectId]).success).toBe(false);
});
