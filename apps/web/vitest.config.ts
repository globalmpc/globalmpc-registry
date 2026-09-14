import { defineConfig } from "vitest/config";

/**
 * Picks up only web unit tests.
 *
 * `e2e/` holds Playwright specs. Without narrowing the scope, vitest reads those files
 * as its own tests and breaks immediately on `@playwright/test` hooks.
 */
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
  },
});
