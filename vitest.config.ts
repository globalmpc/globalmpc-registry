import { defineConfig } from "vitest/config";
import { readdirSync, readFileSync } from "node:fs";

// Referenced directories do not inherit the root configuration in Vitest 5.
// Inline projects retain the shared single-worker budget across every DB suite.
const roots = [
  ...readdirSync("packages", { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}`),
  "apps/api", "apps/jobs-worker", "apps/anchor-worker", "apps/scan-worker",
];

// Split CI by project without skipping DB-dependent suites or running files twice.
// API/worker projects contain DB integration tests and run together with packages/db.
// With no mode override, local `pnpm test` still runs every project.
export default defineConfig(({ mode }) => {
  const integrationRoot = (root: string) => root === "packages/db" || root.startsWith("apps/");
  const selectedRoots = roots.filter((root) =>
    mode === "unit" ? !integrationRoot(root) : mode === "integration" ? integrationRoot(root) : true,
  );
  return {
    test: {
      coverage: {
        provider: "v8",
        reportsDirectory: "coverage/app",
        reporter: ["text-summary", "lcov", "json-summary"],
        // Include untested first-party sources, including routes and React screens.
        include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
        exclude: ["**/*.d.ts", "**/*.test.*", "**/*.spec.*", "**/node_modules/**"],
      },
      projects: [
        ...selectedRoots.map((root) => ({
          extends: true as const,
          test: {
            root,
            name: JSON.parse(readFileSync(`${root}/package.json`, "utf8")).name as string,
          },
        })),
        ...(mode === "integration" ? [] : [{
          extends: "./apps/web/vitest.config.ts",
          test: { name: "web", root: "apps/web", fileParallelism: false, maxWorkers: 1 },
        }]),
      ],
      /**
       * The DB tests share one PostgreSQL instance.
       * `packages/db` verifies the schema lifecycle itself and therefore runs DROP SCHEMA;
       * `apps/*` isolate themselves on top of it with unique tenants. In parallel, one side's
       * DROP cuts into the middle of the other side's tests.
       *
       * **`fileParallelism` alone does not prevent this.** It applies only within a project,
       * not across projects — `packages/db` migrations and
       * `apps/api`'s `setupFixture` run concurrently and
       * `duplicate key value violates unique constraint "pg_namespace_nspname_index"`
       * break it. Collapsing to a single worker makes it serial across project boundaries too.
       *
       * Measured (2026-09-09): without these two lines, 3 of 4 runs failed; with them, 5 of 5 passed.
       * Duration is the same 33s — parallelism does not actually save any time.
       */
      fileParallelism: false,
      maxWorkers: 1,
    },
  };
});
