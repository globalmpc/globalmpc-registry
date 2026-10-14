import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { runMigrations, type Migration } from "./migrate.js";

/**
 * Migration and rollback verification — spec 13 §13.9 item 2.
 *
 * Migrations here are **forward-only**: there are no down scripts, and a release is rolled back
 * by restoring the database taken before it (`scripts/ops/restore.sh`) and redeploying the
 * previous image. So "rollback verification" means three things, and this check does all of
 * them against a real PostgreSQL:
 *
 * 1. **Forward:** a database at the previous release's schema, holding rows, accepts this
 *    release's migrations. A migration that only works on an empty database (a NOT NULL column
 *    without a default, a constraint existing rows break) fails here instead of in production.
 * 2. **Rollback:** a copy taken before the upgrade still has exactly the previous release's
 *    migrations and its rows — the restore target is what the previous image expects.
 * 3. **Roll forward again:** the same upgrade applied to that restored copy succeeds, so a
 *    rolled-back release can be redeployed.
 *
 * The copy is made with `CREATE DATABASE … TEMPLATE`, a byte-level copy of the database. It
 * stands in for the dump/restore pair, whose own correctness `scripts/ops/test-backup-restore.sh`
 * covers; mixing the two would make a failure here ambiguous.
 */

export interface RollbackCheckResult {
  readonly previous: readonly string[];
  readonly forward: readonly string[];
  readonly reapplied: readonly string[];
}

/** Database names are generated here and never taken from input, so quoting is sufficient. */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

function withDatabase(adminUrl: string, database: string): string {
  const url = new URL(adminUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Rows every release since 0001 can hold. The upgrade must carry them across unchanged. */
async function seed(sql: postgres.Sql): Promise<void> {
  const tenant = randomUUID();
  const org = randomUUID();
  const subject = randomUUID();
  await sql`
    INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, 'rollback-check', 'Rollback check')
  `;
  await sql`
    INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
    VALUES (${org}, ${tenant}, 'Rollback check org', 'MNG')
  `;
  await sql`
    INSERT INTO core.subjects (id, tenant_id, kind, display_name)
    VALUES (${subject}, ${tenant}, 'person', 'Rollback check person')
  `;
  await sql`
    INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
    VALUES (${randomUUID()}, ${tenant}, ${subject}, ${org}, 'mpc_operator')
  `;
  await sql`
    INSERT INTO core.projects (
      id, tenant_id, project_key, name, host_country_iso3, owner_organization_id
    ) VALUES (${randomUUID()}, ${tenant}, 'RB-1', 'Rollback check project', 'MNG', ${org})
  `;
}

async function counts(sql: postgres.Sql): Promise<string> {
  const [row] = await sql<{ tenants: number; bindings: number; projects: number }[]>`
    SELECT (SELECT count(*) FROM core.tenants)::int AS tenants,
           (SELECT count(*) FROM core.role_bindings)::int AS bindings,
           (SELECT count(*) FROM core.projects)::int AS projects
  `;
  return JSON.stringify(row);
}

async function appliedNames(sql: postgres.Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM core.schema_migrations ORDER BY name
  `;
  return rows.map((row) => row.name);
}

export async function checkMigrationRollback(input: {
  readonly adminUrl: string;
  readonly previous: readonly Migration[];
  readonly current: readonly Migration[];
}): Promise<RollbackCheckResult> {
  const stamp = `${Date.now()}_${randomUUID().slice(0, 8)}`;
  const upgraded = `mpc_rollback_${stamp}`;
  const snapshot = `mpc_rollback_${stamp}_snapshot`;
  const admin = postgres(input.adminUrl, { onnotice: () => {}, max: 1 });

  const expectedPrevious = input.previous.map((migration) => migration.name).sort();

  try {
    await admin.unsafe(`CREATE DATABASE ${ident(upgraded)}`);

    // 1. The previous release's schema, with rows in it.
    const release = postgres(withDatabase(input.adminUrl, upgraded), { onnotice: () => {}, max: 1 });
    try {
      await runMigrations(release, input.previous);
      await seed(release);
    } finally {
      await release.end();
    }

    // The pre-upgrade copy — what a restore would bring back.
    await admin.unsafe(`CREATE DATABASE ${ident(snapshot)} TEMPLATE ${ident(upgraded)}`);

    const upgrade = postgres(withDatabase(input.adminUrl, upgraded), { onnotice: () => {}, max: 1 });
    let forward: string[];
    let before: string;
    try {
      before = await counts(upgrade);
      forward = await runMigrations(upgrade, input.current);
      const after = await counts(upgrade);
      if (after !== before) {
        throw new Error(`Rows changed across the upgrade: before ${before}, after ${after}`);
      }
    } finally {
      await upgrade.end();
    }

    // 2. The restored copy is the previous release, exactly.
    const restored = postgres(withDatabase(input.adminUrl, snapshot), { onnotice: () => {}, max: 1 });
    let reapplied: string[];
    try {
      const names = await appliedNames(restored);
      if (JSON.stringify(names) !== JSON.stringify(expectedPrevious)) {
        throw new Error(
          `Restored copy does not hold exactly the previous release's migrations: ${names.join(", ")}`,
        );
      }
      const restoredCounts = await counts(restored);
      if (restoredCounts !== before) {
        throw new Error(`Restored rows differ: expected ${before}, got ${restoredCounts}`);
      }

      // 3. Rolling forward again after the rollback.
      reapplied = await runMigrations(restored, input.current);
    } finally {
      await restored.end();
    }

    if (JSON.stringify(reapplied) !== JSON.stringify(forward)) {
      throw new Error(
        `Re-applying after rollback ran different migrations: ${reapplied.join(", ")} vs ${forward.join(", ")}`,
      );
    }

    return { previous: expectedPrevious, forward, reapplied };
  } finally {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(snapshot)}`);
    await admin.unsafe(`DROP DATABASE IF EXISTS ${ident(upgraded)}`);
    await admin.end();
  }
}
