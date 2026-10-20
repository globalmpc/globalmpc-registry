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
