import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0100_anchor_l1_data_fee.sql";

/**
 * 0100 — the gas and send ledgers carry the L1 data fee.
 *
 * Seeds a spent receipt and an open send under the preceding schema, migrates forward, and checks
 * that both keep every value they had and read an L1 fee of 0 — exact for the chains anchored on
 * before — that a negative fee is refused, and that the worker's grants are what they were: it
 * records the new columns on insert and cannot rewrite what a send reserved.
 */
describeDb("migration 0100: anchor L1 data fee", () => {
  const dbName = `m0100_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  const hex = (seed: string) => `0x${seed.replace(/-/g, "").repeat(2)}`;
  const tenant = randomUUID();
  const transaction = randomUUID();
  const spentHash = hex(randomUUID());
  const openHash = hex(randomUUID());

  const ledgers = async () => ({
    spend: await sql`SELECT * FROM chain.gas_spend ORDER BY tx_hash`,
    sends: await sql`SELECT * FROM chain.anchor_sends ORDER BY tx_hash`,
  });

  const grants = () => sql<{ table_name: string; privilege_type: string }[]>`
    SELECT table_name, privilege_type FROM information_schema.role_table_grants
    WHERE grantee = 'mpc_worker' AND table_schema = 'chain'
      AND table_name IN ('gas_spend', 'anchor_sends')
    ORDER BY table_name, privilege_type
  `;
  const columnUpdates = () => sql<{ column_name: string }[]>`
    SELECT column_name FROM information_schema.column_privileges
    WHERE grantee = 'mpc_worker' AND table_schema = 'chain' AND table_name = 'anchor_sends'
      AND privilege_type = 'UPDATE'
    ORDER BY column_name
  `;

  let before: {
    spend: readonly Record<string, unknown>[];
    sends: readonly Record<string, unknown>[];
    grants: readonly unknown[];
    columnUpdates: readonly unknown[];
  };

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

    const all = listMigrations();
    const index = all.findIndex((migration) => migration.name === TARGET);
    expect(index).toBeGreaterThan(0);
    await runMigrations(sql, all.slice(0, index));

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0100-${tenant.slice(0, 8)}`}, 'Probe')`;
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, tx_hash)
      VALUES (${transaction}, ${tenant}, ${`probe:${transaction}`}, 31337, 'submitted', ${openHash})
    `;
    await sql`
      INSERT INTO chain.gas_spend (chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price)
      VALUES (31337, ${spentHash}, ${transaction}, ${tenant}, 145926, 1000000000)
    `;
    await sql`
      INSERT INTO chain.anchor_sends (
        chain_id, tx_hash, transaction_id, tenant_id, signer, nonce, gas_limit, max_fee_per_gas
      ) VALUES (31337, ${openHash}, ${transaction}, ${tenant}, ${`0x${"5a".repeat(20)}`}, 3, 200000, 2000000000)
    `;

    before = { ...(await ledgers()), grants: await grants(), columnUpdates: await columnUpdates() };
    expect(before.spend[0]).not.toHaveProperty("l1_fee");

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("keeps every ledger value and reads an L1 fee of 0 for earlier rows", async () => {
    const after = await ledgers();
    expect(after.spend).toEqual(before.spend.map((row) => ({ ...row, l1_fee: "0" })));
    expect(after.sends).toEqual(before.sends.map((row) => ({ ...row, l1_fee_bound: "0" })));
  });

  it("refuses a negative L1 fee in either ledger", async () => {
    await expect(sql`
      INSERT INTO chain.gas_spend (chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price, l1_fee)
      VALUES (31337, ${hex(randomUUID())}, ${transaction}, ${tenant}, 1, 1, -1)
    `).rejects.toThrow(/check constraint/);
    await expect(sql`
      INSERT INTO chain.anchor_sends (chain_id, tx_hash, transaction_id, tenant_id, l1_fee_bound)
      VALUES (31337, ${hex(randomUUID())}, ${transaction}, ${tenant}, -1)
    `).rejects.toThrow(/check constraint/);
  });

  it("leaves the worker's grants as they were", async () => {
    expect(await grants()).toEqual(before.grants);
    expect(await columnUpdates()).toEqual(before.columnUpdates);
  });

  it("lets the worker record both fees on insert, and not rewrite a reservation", async () => {
    const rollback = new Error("rollback probe");
    const sendHash = hex(randomUUID());
    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE mpc_worker`;
        await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
        await tx`
          INSERT INTO chain.anchor_sends (chain_id, tx_hash, transaction_id, tenant_id, signer, nonce, gas_limit, max_fee_per_gas, l1_fee_bound)
          VALUES (5611, ${sendHash}, ${transaction}, ${tenant}, ${`0x${"5a".repeat(20)}`}, 4, 200000, 1000000, 217600000130)
        `;
        await tx`
          INSERT INTO chain.gas_spend (chain_id, tx_hash, transaction_id, tenant_id, gas_used, effective_gas_price, l1_fee)
          VALUES (5611, ${sendHash}, ${transaction}, ${tenant}, 145926, 1000000, 108800000065)
        `;
        throw rollback;
      }),
    ).rejects.toBe(rollback);

    await expect(
      sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE mpc_worker`;
        await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
        await tx`UPDATE chain.anchor_sends SET l1_fee_bound = 0 WHERE tx_hash = ${openHash}`;
      }),
    ).rejects.toThrow(/permission denied/);
  });
});
