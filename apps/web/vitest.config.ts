import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/**
 * Picks up only web unit tests.
 *
 * `e2e/` holds Playwright specs. Without narrowing the scope, vitest reads those files
 * as its own tests and breaks immediately on `@playwright/test` hooks.
 */
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  test: {
    name: "web",
    include: ["test/**/*.test.{ts,tsx}"],
  },
});
