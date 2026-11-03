import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0103_anchor_reorg_watch_until.sql";

/**
 * 0103 — a confirmed transaction row records until when its worker watches it for reorgs.
 *
 * Seeds a confirmed row under the preceding schema, migrates forward, and checks that it keeps
 * every value it had and reads the deadline as NULL ("unknown", the 24 h floor), that the worker
 * can write it as itself, and that a write changing `confirmed_at` alone — as the previous
 * release and the API's resubmission do — never leaves a deadline from another confirmation.
 */
describeDb("migration 0103: anchor reorg watch deadline", () => {
  const dbName = `m0103_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const transaction = randomUUID();
  const hash = `0x${"4f".repeat(32)}`;
  const block = `0x${"b1".repeat(32)}`;
  const row = async () =>
    (await sql`SELECT * FROM chain.transactions WHERE id = ${transaction}`)[0]!;
  const asWorker = (statement: (tx: postgres.TransactionSql) => Promise<unknown>) =>
    sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE mpc_worker`;
      await statement(tx);
    });
  let before: Record<string, unknown>;

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

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0103-${tenant.slice(0, 8)}`}, 'Probe')`;
    await sql`
      INSERT INTO chain.transactions (
        id, tenant_id, intent_key, chain_id, state, tx_hash, block_number, block_hash,
        confirmations, confirmed_at
      ) VALUES (
        ${transaction}, ${tenant}, ${`probe:${transaction}`}, 5611, 'confirmed', ${hash}, 100,
        ${block}, 3, now() - interval '2 hours'
      )
    `;
    before = { ...(await row()) };
    expect(before).not.toHaveProperty("reorg_watch_until");

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("keeps every value of an earlier row and reads its deadline as unknown", async () => {
    expect(await row()).toEqual({ ...before, reorg_watch_until: null });
  });

  it("lets the worker store a deadline with a confirmation, and keeps it while nothing else changes", async () => {
    await asWorker((tx) => tx`
      UPDATE chain.transactions
      SET confirmed_at = now(), reorg_watch_until = now() + interval '30 minutes', updated_at = now()
      WHERE id = ${transaction}
    `);
    const stored = await row();
    expect(stored["reorg_watch_until"]).toBeInstanceOf(Date);

    // A recheck that only stamps the time keeps the deadline.
    await asWorker((tx) => tx`UPDATE chain.transactions SET updated_at = now() WHERE id = ${transaction}`);
    expect((await row())["reorg_watch_until"]).toEqual(stored["reorg_watch_until"]);
  });

  it("clears a deadline when confirmed_at changes without it", async () => {
    await asWorker((tx) => tx`
      UPDATE chain.transactions
      SET confirmed_at = now(), reorg_watch_until = now() + interval '30 minutes'
      WHERE id = ${transaction}
    `);
    // The previous release re-confirming after a reorg: a new confirmed_at, the old deadline.
    await asWorker((tx) => tx`
      UPDATE chain.transactions SET confirmed_at = now() + interval '1 hour' WHERE id = ${transaction}
    `);
    expect((await row())["reorg_watch_until"]).toBeNull();

    // A resubmission resetting the row to `created`.
    await asWorker((tx) => tx`
      UPDATE chain.transactions
      SET confirmed_at = now(), reorg_watch_until = now() + interval '30 minutes'
      WHERE id = ${transaction}
    `);
    await sql`
      UPDATE chain.transactions
      SET state = 'created', tx_hash = NULL, block_number = NULL, block_hash = NULL,
          confirmations = 0, confirmed_at = NULL
      WHERE id = ${transaction}
    `;
    expect(await row()).toMatchObject({ state: "created", confirmed_at: null, reorg_watch_until: null });
  });
});
