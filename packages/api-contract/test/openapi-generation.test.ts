import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
const output = vi.hoisted(() => ({ write: vi.fn() }));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  writeFileSync: output.write,
}));
it("generates the checked-in OpenAPI contract including auth, query and concurrency headers", async () => {
  await import("../src/build-openapi.js");
  expect(output.write).toHaveBeenCalledOnce();
  const generated = JSON.parse(output.write.mock.calls[0]![1]);
  const committed = JSON.parse(
    readFileSync(new URL("../openapi.json", import.meta.url), "utf8"),
  );
  expect(generated).toEqual(committed);
  const correction = generated.paths["/api/v1/claims/{claimId}/versions"].post;
  const request = correction.requestBody.content["application/json"].schema.definitions.correctClaimRequest;
  // Request defaults remain optional on the wire; response objects describe the complete output.
  expect(new Set(request.required)).toEqual(new Set(["valueText", "sourceCoordinate", "reason"]));
  for (const field of ["unit", "asOf", "sourceReceiptId", "evidenceTier"]) {
    expect(request.properties[field].default).toBeNull();
  }
  expect(request.properties.catalogEntryId).not.toHaveProperty("default");
  expect(request.properties.documentUploadIds).not.toHaveProperty("default");
  const response = correction.responses["200"].content["application/json"].schema.definitions.correctClaimResponse;
  expect(response.additionalProperties).toBe(false);
  expect(response.required).toEqual(expect.arrayContaining(["catalogEntryId", "documentUploadIds", "unit", "asOf"]));
  const operations = Object.values(generated.paths).flatMap((p) =>
    Object.values(p as Record<string, unknown>),
  ) as { tags: string[]; security?: unknown; parameters: { name: string }[] }[];
  expect(
    operations.some((op) =>
      op.parameters.some((p) => p.name === "Idempotency-Key"),
    ),
  ).toBe(true);
  expect(
    operations.some((op) => op.parameters.some((p) => p.name === "If-Match")),
  ).toBe(true);
  expect(
    operations
      .filter((op) => op.tags.includes("workspace"))
      .every((op) => op.security !== undefined),
  ).toBe(true);
  expect(
    operations
      .filter((op) => op.tags.includes("public"))
      .every((op) => op.security === undefined),
  ).toBe(true);
});
