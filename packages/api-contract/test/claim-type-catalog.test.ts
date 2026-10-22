import { describe, expect, it } from "vitest";
import { claimTypeDefinition, proposeClaimTypeRequest, claimTypeCatalogQuery, claimTypeCatalogList, ROUTES, ACTION_POLICIES } from "../src/index.js";
const definition = { fields: [{ key: "number", label: "Number", type: "string", required: true }] };
describe("claim type catalog contract", () => {
  it("accepts bounded declarations and normalizes absent descriptions", () => {
    expect(proposeClaimTypeRequest.parse({ claimType: "mining_licence", displayName: "Licence", definition, effectiveFrom: "2026-01-01T00:00:00Z", rationale: "Define fields" }).description).toBeNull();
    expect(claimTypeCatalogQuery.parse({})).toEqual({ limit: 50 });
    expect(claimTypeCatalogList.parse({ items: [], nextCursor: null })).toEqual({ items: [], nextCursor: null });
  });
  it("rejects impossible dates and precision loss while preserving leap days and milliseconds", () => {
    const body = { claimType: "mining_licence", displayName: "Licence", definition, rationale: "Define fields" };
    for (const effectiveFrom of ["0000-01-01T00:00:00Z", "2026-02-31T00:00:00Z", "2026-02-29T00:00:00Z", "2100-02-29T00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:00:00.1234Z"]) {
      expect(proposeClaimTypeRequest.safeParse({ ...body, effectiveFrom }).success).toBe(false);
    }
    for (const effectiveFrom of ["2024-02-29T00:00:00Z", "2000-02-29T00:00:00Z", "2026-01-01T00:00:00.1Z", "2026-01-01T00:00:00.12Z", "2026-01-01T00:00:00.123Z"]) {
      expect(proposeClaimTypeRequest.parse({ ...body, effectiveFrom }).effectiveFrom).toBe(effectiveFrom);
    }
  });
  it("catalog read schemas retain required response metadata", () => {
    const meta = { requestId: "request", asOf: "2026-01-01T00:00:00Z" };
    const list = ROUTES.find((route) => route.operationId === "listClaimTypes")!.responseSchema!;
    expect(list.parse({ items: [], nextCursor: null, ...meta })).toMatchObject(meta);
    expect(list.safeParse({ items: [], nextCursor: null }).success).toBe(false);
    const detail = ROUTES.find((route) => route.operationId === "getClaimTypeVersion")!.responseSchema!;
    const entry = { id: "a0000000-0000-4000-8000-000000000001", claimType: "mining_licence", catalogVersion: 1, displayName: "Licence", description: null, definition, effectiveFrom: meta.asOf, createdAt: meta.asOf };
    expect(detail.parse({ ...entry, ...meta })).toMatchObject(meta);
    expect(detail.safeParse(entry).success).toBe(false);
  });
  it("rejects executable, unbounded, duplicate and unknown field declarations", () => {
    for (const value of [ { fields: [] }, { ...definition, script: "return true" }, { fields: Array(51).fill(definition.fields[0]) }, { fields: Array(2).fill(definition.fields[0]) }, { fields: [{ ...definition.fields[0], type: "script" }] } ]) expect(claimTypeDefinition.safeParse(value).success).toBe(false);
    expect(claimTypeCatalogQuery.safeParse({ limit: 101 }).success).toBe(false);
    expect(claimTypeCatalogQuery.safeParse({ cursor: "invalid/" }).success).toBe(false);
  });
  it("keeps catalog reading separate from sensitive proposal reading", () => {
    expect(ROUTES.find((route) => route.operationId === "listClaimTypes")?.action).toBe("registry.read");
    expect(ROUTES.find((route) => route.operationId === "listClaimTypeProposals")?.action).toBe("review_registry.read");
    expect(ACTION_POLICIES["registry.read"]!.allowedRoles).toContain("data_steward");
    expect(ACTION_POLICIES["review_registry.read"]!.allowedRoles).not.toContain("data_steward");
  });
});
