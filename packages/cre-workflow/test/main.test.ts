import { describe, expect, test, vi } from "vitest";

const runner = { run: vi.fn(async () => undefined) };
const newRunner = vi.fn(async () => runner);
vi.mock("@chainlink/cre-sdk", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@chainlink/cre-sdk")>()),
  Runner: { newRunner },
}));

describe("main", () => {
  test("parses configuration with the strict parser and registers the workflow", async () => {
    const { main } = await import("../src/main.js");
    const { parseConfig } = await import("../src/protocol.js");
    const { initWorkflow } = await import("../src/workflow.js");
    await main();
    expect(newRunner).toHaveBeenCalledWith({ configParser: parseConfig });
    expect(runner.run).toHaveBeenCalledWith(initWorkflow);
  });
});
