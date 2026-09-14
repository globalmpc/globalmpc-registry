import { defineConfig } from "vitest/config";

/**
 * design-system's own config. Without it, vitest picks up the repository root
 * `vitest.config.ts` from the parent directory, resolves its `projects`
 * (apps/api and others) relative to this folder, and fails to start.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.{js,mjs,ts}"],
  },
});
