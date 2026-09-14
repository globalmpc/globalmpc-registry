import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/api", "apps/worker", "apps/web"],
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
    minWorkers: 1,
  },
});
