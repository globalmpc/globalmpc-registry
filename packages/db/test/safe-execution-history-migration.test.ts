import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;
const HASH = `0x${"a1".repeat(32)}`;
const OTHER = `0x${"b2".repeat(32)}`;
const ADDRESS = `0x${"c3".repeat(20)}`;
describeDb("migration 0135: immutable Safe execution history", () => {
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const db = `safe_history_${process.pid}_${Date.now()}`;
  const tenant = randomUUID();
  const transaction = randomUUID();
  const proposal = randomUUID();
  const as = <T>(role: string, work: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
    await tx.unsafe(`SET LOCAL ROLE ${role}`);
    await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
    return work(tx);
  });
  const insert = (tx: postgres.TransactionSql, hash = HASH) => tx`
    INSERT INTO chain.safe_execution_history (proposal_id, transaction_id, tenant_id, chain_id, execution_tx_hash)
    VALUES (${proposal}, ${transaction}, ${tenant}, 31337, ${hash})`;
  beforeAll(async () => {
    admin = postgres(process.env["DATABASE_URL"]!, { onnotice: () => {} });
    await admin.unsafe(`CREATE DATABASE ${db}`);
    const url = new URL(process.env["DATABASE_URL"]!); url.pathname = `/${db}`;
    sql = postgres(url.toString(), { onnotice: () => {} });
    const migrations = listMigrations();
    await runMigrations(sql, migrations.filter((migration) => migration.name < "0135"));
    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`safe-${tenant}`}, 'Safe history')`;
    await sql`INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state)
      VALUES (${transaction}, ${tenant}, ${`safe:${transaction}`}, 31337, 'failed')`;
    await sql`INSERT INTO chain.anchor_proposals (id, tenant_id, transaction_id, chain_id, safe_address, contract_address, calldata, calldata_hash, state)
      VALUES (${proposal}, ${tenant}, ${transaction}, 31337, ${ADDRESS}, ${ADDRESS}, '0x00', ${HASH}, 'executed')`;
    await runMigrations(sql);
  }, 120_000);
  afterAll(async () => { await sql?.end(); await admin?.unsafe(`DROP DATABASE IF EXISTS ${db}`); await admin?.end(); });
  it("does not infer an execution mapping for historical executed proposals", async () => {
    expect(await sql`SELECT * FROM chain.safe_execution_history`).toHaveLength(0);
  });
  it("lets the worker append multiple real outer hashes, never replace the earlier one", async () => {
    await as("mpc_worker", (tx) => insert(tx));
    await as("mpc_worker", (tx) => insert(tx, OTHER));
    expect(await sql`SELECT * FROM chain.safe_execution_history WHERE proposal_id = ${proposal}`).toHaveLength(2);
  });
  it("supports explicit replacement evidence for a frozen rejected proposal", async () => {
    const rejected = randomUUID();
    await sql`INSERT INTO chain.anchor_proposals (id, tenant_id, transaction_id, chain_id, safe_address, contract_address, calldata, calldata_hash, state)
      VALUES (${rejected}, ${tenant}, ${transaction}, 31337, ${ADDRESS}, ${ADDRESS}, '0x00', ${OTHER}, 'rejected')`;
    await expect(sql`INSERT INTO chain.safe_execution_history (proposal_id, transaction_id, tenant_id, chain_id, execution_tx_hash)
      VALUES (${rejected}, ${transaction}, ${tenant}, 31337, ${OTHER})`).rejects.toMatchObject({ code: "23514" });
    await sql`INSERT INTO chain.safe_execution_history (proposal_id, transaction_id, tenant_id, chain_id, execution_tx_hash, evidence_kind, evidence_note)
      VALUES (${rejected}, ${transaction}, ${tenant}, 31337, ${OTHER}, 'nonce_replacement', 'Verified same Safe and nonce in replacement receipt')`;
    expect(await sql`SELECT 1 FROM chain.safe_execution_history WHERE proposal_id = ${rejected}`).toHaveLength(1);
    await expect(sql`UPDATE chain.anchor_proposals SET state = 'executed' WHERE id = ${rejected}`).rejects.toMatchObject({ code: "23514" });
  });
  it("denies application reads and writes", async () => {
    await expect(as("mpc_app", (tx) => tx`SELECT * FROM chain.safe_execution_history`)).rejects.toMatchObject({ code: "42501" });
    await expect(as("mpc_app", (tx) => insert(tx, `0x${"d4".repeat(32)}`))).rejects.toMatchObject({ code: "42501" });
  });
  it("rejects mutation and truncation even by the table owner", async () => {
    await expect(sql`UPDATE chain.safe_execution_history SET execution_tx_hash = ${OTHER} WHERE execution_tx_hash = ${HASH}`).rejects.toMatchObject({ code: "P0001" });
    await expect(sql`DELETE FROM chain.safe_execution_history WHERE execution_tx_hash = ${HASH}`).rejects.toMatchObject({ code: "P0001" });
    await expect(sql`TRUNCATE chain.safe_execution_history`).rejects.toMatchObject({ code: "P0001" });
  });
  it("freezes executed proposal identity and state, including legacy unmapped rows", async () => {
    await expect(sql`UPDATE chain.anchor_proposals SET state = 'expired' WHERE id = ${proposal}`).rejects.toMatchObject({ code: "23514" });
    await expect(sql`UPDATE chain.anchor_proposals SET chain_id = 5611 WHERE id = ${proposal}`).rejects.toMatchObject({ code: "23514" });
  });
  it("requires a matching executed proposal and lower-case outer hash", async () => {
    await expect(as("mpc_worker", (tx) => insert(tx, HASH.toUpperCase()))).rejects.toMatchObject({ code: "23514" });
    await expect(as("mpc_worker", (tx) => tx`INSERT INTO chain.safe_execution_history (proposal_id, transaction_id, tenant_id, chain_id, execution_tx_hash)
      VALUES (${proposal}, ${transaction}, ${tenant}, 5611, ${HASH})`)).rejects.toMatchObject({ code: "23514" });
  });
});
