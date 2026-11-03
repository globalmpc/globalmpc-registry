import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { listMigrations, migrationChecksum, normalizeMigrationSql, runMigrations, splitStatements, type Migration } from "../src/migrate.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
const original = readFileSync(new URL("./fixtures/0107_before_history_capture.sql", import.meta.url), "utf8");
const target = listMigrations().find((m) => m.name === "0107_anchor_contract_registry.sql")!;
const repair = listMigrations().find((m) => m.name === "0134_anchor_contract_history_capture.sql")!;
const preceding = listMigrations().filter((m) => m.name < target.name);
const contract = (byte: string) => `0x${byte.repeat(20)}`;

async function database(body: (sql: postgres.Sql, url: string) => Promise<void>) {
  const admin = postgres(process.env["DATABASE_URL"]!, { onnotice: () => {}, max: 1 });
  const name = `registry_capture_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const url = new URL(process.env["DATABASE_URL"]!);
  url.pathname = `/${name}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  const sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });
  try {
    await runMigrations(sql, preceding);
    await body(sql, url.toString());
  } finally {
    await sql.end();
    await admin.unsafe(`DROP DATABASE ${name}`);
    await admin.end();
  }
}

async function seed(sql: postgres.Sql, address = contract("ab")) {
  const tenant = randomUUID();
  const row = randomUUID();
  await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${tenant}, 'History probe')`;
  await sql`INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, tx_hash, contract_address) VALUES (${row}, ${tenant}, ${row}, 5611, 'dropped', ${`0x${"01".repeat(32)}`}, ${address})`;
  return { tenant, row };
}

async function waitForLock(control: postgres.ReservedSql, event: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    await control`SELECT pg_stat_clear_snapshot()`;
    const [row] = await control<{ count: number }[]>`SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event = ${event}`;
    if (row!.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No transaction waited for ${event}`);
}

describeDb("atomic anchor contract history capture", () => {
  it.each([false, true])("blocks destructive writers through trigger install and backfill (partial old install: %s)", async (partial) => {
    await database(async (sql, url) => {
      const { row } = await seed(sql);
      if (partial) {
        // A prior non-transactional run stopped immediately before its backfill and record.
        const statements = splitStatements(original);
        for (const statement of statements.slice(0, -1)) await sql.unsafe(statement);
      }
      const statements = splitStatements(target.sql);
      const backfills = statements.flatMap((statement, index) => {
        const code = normalizeMigrationSql(statement);
        return code.startsWith("DO $$") && code.includes("SELECT DISTINCT chain_id, contract_address FROM chain.transactions")
          ? [index] : [];
      });
      expect(backfills, "expected exactly one parsed backfill DO statement").toHaveLength(1);
      const pause = "SELECT pg_advisory_xact_lock(1070034);";
      statements.splice(backfills[0]!, 0, pause);
      expect(statements.filter((statement) => normalizeMigrationSql(statement) === pause)).toHaveLength(1);
      const paused: Migration = { ...target, sql: statements.join("\n") };
      const controlSql = postgres(url, { onnotice: () => {}, max: 1 });
      const writer = postgres(url, { onnotice: () => {}, max: 1 });
      const control = await controlSql.reserve();
      let migration: Promise<string[]> | undefined;
      let write: Promise<unknown> | undefined;
      try {
        await control.unsafe("BEGIN");
        await control`SELECT pg_advisory_xact_lock(1070034)`;
        migration = runMigrations(sql, [...preceding, paused]);
        await waitForLock(control, "advisory");
        write = writer`UPDATE chain.transactions SET tx_hash = NULL, contract_address = NULL WHERE id = ${row}`.execute();
        await waitForLock(control, "relation");
        await control.unsafe("COMMIT");
        expect(await migration).toEqual([target.name]);
        await write;
        expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE chain_id = 5611 AND contract_address = ${contract("ab")}`).toHaveLength(1);
        const verification = await sql`SELECT basis FROM chain.anchor_contract_registry_verification`;
        expect(verification).toEqual([]);
      } finally {
        await control.unsafe("ROLLBACK");
        await Promise.allSettled([migration, write]);
        control.release();
        await controlSql.end();
        await writer.end();
      }
    });
  }, 120_000);

  it("automatically verifies only a genuinely empty fresh anchor history", async () => {
    await database(async (sql) => {
      await runMigrations(sql, [...preceding, target]);
      expect(await sql`SELECT basis FROM chain.anchor_contract_registry_verification`).toEqual([{ basis: "atomic_initialization" }]);
    });
  }, 120_000);

  it("keeps a deployed 0106 history unverified when its last contract was already cleared", async () => {
    await database(async (sql) => {
      const { tenant, row } = await seed(sql);
      const batch = randomUUID();
      const digest = `0x${"03".repeat(32)}`;
      await sql`INSERT INTO chain.anchor_batches (id, tenant_id, batch_id, merkle_root, manifest_hash, manifest_object_key, schema_version, record_count) VALUES (${batch}, ${tenant}, ${digest}, ${digest}, ${digest}, 'original-manifest', '1', 1)`;
      await sql`UPDATE chain.transactions SET batch_id = ${batch}, tx_hash = NULL, contract_address = NULL WHERE id = ${row}`;
      // Even deleting a transaction cannot erase the durable batch provenance.
      await sql`DELETE FROM chain.transactions WHERE id = ${row}`;
      await runMigrations(sql, [...preceding, target]);
      expect(await sql`SELECT 1 FROM chain.anchor_contracts`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM chain.anchor_contract_registry_verification`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM chain.anchor_batches WHERE id = ${batch}`).toHaveLength(1);
    });
  }, 120_000);

  it("upgrades the exact applied old checksum, repairs capture, and requires reconciliation", async () => {
    await database(async (sql) => {
      const { tenant, row } = await seed(sql);
      const old = { ...target, sql: original };
      await runMigrations(sql, [...preceding, old]);
      expect((await sql`SELECT checksum FROM core.schema_migrations WHERE name = ${target.name}`)[0]!.checksum).toBe(migrationChecksum(original));
      // Emulate the old installation gap: the only row naming this pair vanished before backfill.
      // There is no surviving evidence from which the repair could reconstruct it.
      const lost = randomUUID();
      await sql`ALTER TABLE chain.transactions DISABLE TRIGGER transactions_register_contract_on_insert`;
      await sql`INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, contract_address) VALUES (${lost}, ${tenant}, ${lost}, 5611, 'dropped', ${contract("ee")})`;
      await sql`ALTER TABLE chain.transactions ENABLE TRIGGER transactions_register_contract_on_insert`;
      await sql`UPDATE chain.transactions SET contract_address = NULL WHERE id = ${lost}`;
      expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE contract_address = ${contract("ee")}`).toHaveLength(0);
      // The checksum upgrade skips old 0107; the new migration performs the actual schema repair.
      // Even permissive owner defaults must not let an application/worker approve history.
      await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA chain GRANT ALL ON TABLES TO mpc_app, mpc_worker`;
      const upgrade = await runMigrations(sql, [...preceding, target, repair]);
      expect(upgrade).toEqual([repair.name]);
      expect((await sql`SELECT checksum FROM core.schema_migrations WHERE name = ${target.name}`)[0]!.checksum).toBe(migrationChecksum(target.sql));
      expect(await sql`SELECT 1 FROM chain.anchor_contract_registry_verification`).toHaveLength(0);
      expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE contract_address = ${contract("ee")}`).toHaveLength(0);
      // A stored OLD identity survives clearing/replacement even if an older partial registry missed it.
      for (const [before, after] of [["bc", null], ["cd", "de"]] as const) {
        await sql`ALTER TABLE chain.transactions DISABLE TRIGGER transactions_register_contract_on_update`;
        await sql`UPDATE chain.transactions SET tx_hash = NULL, contract_address = ${contract(before)} WHERE id = ${row}`;
        await sql`ALTER TABLE chain.transactions ENABLE TRIGGER transactions_register_contract_on_update`;
        await sql`UPDATE chain.transactions SET contract_address = ${after === null ? null : contract(after)} WHERE id = ${row}`;
        expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE chain_id = 5611 AND contract_address = ${contract(before)}`).toHaveLength(1);
        if (after) expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE chain_id = 5611 AND contract_address = ${contract(after)}`).toHaveLength(1);
      }
      await expect(sql`UPDATE chain.transactions SET chain_id = 97 WHERE id = ${row}`).rejects.toMatchObject({ code: "23514" });
      await sql`UPDATE chain.transactions SET chain_id = 97, tx_hash = NULL, contract_address = NULL WHERE id = ${row}`;
      await sql`UPDATE chain.transactions SET contract_address = ${contract("ef")} WHERE id = ${row}`;
      expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE chain_id = 97 AND contract_address = ${contract("de")}`).toHaveLength(0);
      const proposalTx = randomUUID();
      const proposal = randomUUID();
      await sql`INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state) VALUES (${proposalTx}, ${tenant}, ${proposalTx}, 5611, 'dropped')`;
      await sql`ALTER TABLE chain.anchor_proposals DISABLE TRIGGER anchor_proposals_register_contract_on_insert`;
      await sql`INSERT INTO chain.anchor_proposals (id, tenant_id, transaction_id, chain_id, safe_address, contract_address, calldata, calldata_hash) VALUES (${proposal}, ${tenant}, ${proposalTx}, 5611, ${contract("01")}, ${contract("ac")}, '0x00', ${`0x${"02".repeat(32)}`})`;
      await sql`ALTER TABLE chain.anchor_proposals ENABLE TRIGGER anchor_proposals_register_contract_on_insert`;
      await sql`UPDATE chain.anchor_proposals SET contract_address = ${contract("ad")} WHERE id = ${proposal}`;
      expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE chain_id = 5611 AND contract_address IN (${contract("ac")}, ${contract("ad")})`).toHaveLength(2);
      await expect(sql`UPDATE chain.anchor_proposals SET chain_id = 97 WHERE id = ${proposal}`).rejects.toMatchObject({ code: "23514" });
      expect(await sql`SELECT 1 FROM chain.anchor_contracts WHERE chain_id = 97 AND contract_address = ${contract("ad")}`).toHaveLength(0);
      const privileges = await sql`SELECT has_table_privilege('mpc_worker', 'chain.anchor_contract_registry_verification', 'SELECT') AS can_read, has_table_privilege('mpc_worker', 'chain.anchor_contract_registry_verification', 'INSERT') AS can_approve, has_table_privilege('mpc_app', 'chain.anchor_contract_registry_verification', 'SELECT') AS app_read`;
      expect(privileges).toEqual([{ can_read: true, can_approve: false, app_read: false }]);
      await sql`BEGIN`;
      await sql`SET LOCAL ROLE mpc_worker`;
      await expect(sql`INSERT INTO chain.anchor_contract_registry_verification (id, basis, evidence_note) VALUES (true, 'operator_reconciliation', 'untrusted worker')`).rejects.toMatchObject({ code: "42501" });
      await sql`ROLLBACK`;
      // The migration owner records the external reconciliation; it is a durable, immutable audit.
      await sql`INSERT INTO chain.anchor_contract_registry_verification (id, basis, evidence_note) VALUES (true, 'operator_reconciliation', 'Reviewed original chain contracts and deployment inventory')`;
      const [verified] = await sql`SELECT * FROM chain.anchor_contract_registry_verification`;
      expect(verified).toMatchObject({ basis: "operator_reconciliation", evidence_note: "Reviewed original chain contracts and deployment inventory" });
      expect(verified!.verified_at).toBeInstanceOf(Date);
      expect(verified!.verified_by).toBeTruthy();
      await expect(sql`UPDATE chain.anchor_contract_registry_verification SET evidence_note = 'overwrite'`).rejects.toThrow(/append-only/);
      await expect(sql`DELETE FROM chain.anchor_contract_registry_verification`).rejects.toThrow(/append-only/);
      await expect(sql`TRUNCATE chain.anchor_contract_registry_verification`).rejects.toThrow(/TRUNCATE rejected/);
    });
  }, 120_000);
});
