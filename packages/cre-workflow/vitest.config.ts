import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * `@chainlink/cre-sdk/test` imports `bun:test`. Alias it to Vitest and inline the SDK so
 * the alias also applies inside the dependency. The root config extends this file.
 */
export default defineConfig({
  resolve: { alias: { "bun:test": fileURLToPath(new URL("./test/support/bun-test.ts", import.meta.url)) } },
  test: {
    name: "@mpc/cre-workflow",
    include: ["test/**/*.test.ts"],
    server: { deps: { inline: [/@chainlink\/cre-sdk/] } },
  },
});
