import { describe, expect, it } from "vitest";
import { listMigrations } from "../src/migrate.js";
import { checkMigrationRollback } from "../src/rollback-check.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

/**
 * Migration/rollback verification — 13 §13.9 item 2.
 *
 * CI runs the same check against the real previous release (`pnpm check:migration-rollback`).
 * These cases pin the check itself: that it passes an upgrade that works on populated data, and
 * that it fails one that would only work on an empty database.
 */
describeDb("migration rollback check", () => {
  const all = listMigrations();
  const previous = all.slice(0, -3);

  it("passes when the newest migrations apply to a populated previous release", async () => {
    const result = await checkMigrationRollback({ adminUrl: url!, previous, current: all });

    expect(result.previous).toEqual(previous.map((m) => m.name));
    expect(result.forward).toEqual(all.slice(-3).map((m) => m.name));
    expect(result.reapplied).toEqual(result.forward);
  }, 60_000);

  it("fails an upgrade that only works on an empty database", async () => {
    const broken = {
      name: "9999_required_column_without_default.sql",
      sql: "ALTER TABLE core.projects ADD COLUMN rollback_probe TEXT NOT NULL;",
    };

    await expect(
      checkMigrationRollback({ adminUrl: url!, previous: all, current: [...all, broken] }),
    ).rejects.toThrow(/rollback_probe/);
  }, 60_000);
});
