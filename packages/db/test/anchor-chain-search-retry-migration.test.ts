import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0102_anchor_chain_search_retry.sql";

/**
 * 0102 — a transaction row carries when its chain searches began failing and when it may be
 * claimed again.
 *
 * Seeds a hashed row under the preceding schema, migrates forward, and checks that it keeps every
 * value it had and reads both new columns as NULL ("no search failing, claimable now"), that the
 * worker can set and clear them as itself, and that the recorded (hash, contract) pair stays
 * frozen while it does (0101).
 */
describeDb("migration 0102: anchor chain search retry", () => {
  const dbName = `m0102_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const transaction = randomUUID();
  const hash = `0x${"4e".repeat(32)}`;
  const contract = `0x${"cc".repeat(20)}`;
  const row = async () =>
    (await sql`SELECT * FROM chain.transactions WHERE id = ${transaction}`)[0]!;
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

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0102-${tenant.slice(0, 8)}`}, 'Probe')`;
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, tx_hash, contract_address)
      VALUES (${transaction}, ${tenant}, ${`probe:${transaction}`}, 5611, 'submitted', ${hash}, ${contract})
    `;
    before = { ...(await row()) };
    expect(before).not.toHaveProperty("retry_after");

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("keeps every value of an earlier row and reads it as claimable with no failing search", async () => {
    expect(await row()).toEqual({ ...before, chain_search_failed_since: null, retry_after: null });
  });

  it("lets the worker set and clear both, without unfreezing the recorded contract", async () => {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE mpc_worker`;
      await tx`
        UPDATE chain.transactions
        SET chain_search_failed_since = now(), retry_after = now() + interval '1 minute'
        WHERE id = ${transaction}
      `;
    });
    expect((await row())["retry_after"]).toBeInstanceOf(Date);

    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE mpc_worker`;
      await tx`
        UPDATE chain.transactions SET chain_search_failed_since = NULL, retry_after = NULL
        WHERE id = ${transaction}
      `;
    });
    expect(await row()).toMatchObject({ chain_search_failed_since: null, retry_after: null });

    await expect(sql`
      UPDATE chain.transactions SET contract_address = ${`0x${"dd".repeat(20)}`}, retry_after = NULL
      WHERE id = ${transaction}
    `).rejects.toThrow(/cannot be changed/);
  });
});
