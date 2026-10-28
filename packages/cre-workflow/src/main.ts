import { Runner } from "@chainlink/cre-sdk";
import { parseConfig, type Config } from "./protocol.js";
import { initWorkflow } from "./workflow.js";

/** WASM entry point. `cre-compile` appends the `main()` call with its error responder. */
export async function main(): Promise<void> {
  const runner = await Runner.newRunner<Config>({ configParser: parseConfig });
  await runner.run(initWorkflow);
}
