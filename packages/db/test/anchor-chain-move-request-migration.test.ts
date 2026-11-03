import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations, runsOutsideTransaction } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0105_anchor_chain_move_request.sql";
const VALIDATE = "0106_anchor_chain_move_request_index.sql";
const CHECKS = [
  "transactions_move_checked_only_while_requested",
  "transactions_move_requested_together",
  "transactions_move_to_other_chain",
];

/**
 * 0105 — a transaction row can carry a request to move to another chain; 0106 validates its checks
 * and indexes pending requests without blocking writers.
 *
 * Seeds a hashed row under the preceding schema, migrates forward, and checks that it keeps every
 * value and reads as not requested; that the request is set and cleared together and never names
 * the row's own chain; that the API and the worker can write it as themselves; and that the
 * worker's later reset onto the requested chain passes the table's triggers — the recorded
 * (hash, contract) pair stays frozen until the same UPDATE clears it.
 */
describeDb("migration 0105: anchor chain move request", () => {
  const dbName = `m0105_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const transaction = randomUUID();
  const hash = `0x${"5e".repeat(32)}`;
  const contract = `0x${"cc".repeat(20)}`;
  const row = async () =>
    (await sql`SELECT * FROM chain.transactions WHERE id = ${transaction}`)[0]!;
  let before: Record<string, unknown>;

  /** Runs `body` as `role` in the row's tenant, the way the API and worker connect. */
  function as<T>(role: "mpc_app" | "mpc_worker", body: (tx: postgres.TransactionSql) => Promise<T>) {
    return sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
      return body(tx);
    });
  }

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

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0105-${tenant.slice(0, 8)}`}, 'Probe')`;
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, tx_hash, contract_address)
      VALUES (${transaction}, ${tenant}, ${`probe:${transaction}`}, 5611, 'dropped', ${hash}, ${contract})
    `;
    before = { ...(await row()) };
    expect(before).not.toHaveProperty("move_to_chain_id");

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
    // 0105 adds the checks without reading the table; they are enforced on writes already.
    expect(await checks()).toEqual(CHECKS.map((name) => ({ name, validated: false })));
    await expect(
      sql`UPDATE chain.transactions SET move_to_chain_id = 56 WHERE id = ${transaction}`,
    ).rejects.toMatchObject({ code: "23514" });
    expect(all[index + 1]!.name).toBe(VALIDATE);
    expect(await runMigrations(sql, all.slice(0, index + 2))).toEqual([VALIDATE]);
  }, 120_000);

  const checks = () =>
    sql<{ name: string; validated: boolean }[]>`
      SELECT conname AS name, convalidated AS validated FROM pg_constraint
      WHERE conrelid = 'chain.transactions'::regclass AND conname = ANY(${CHECKS})
      ORDER BY conname
    `;

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("keeps every value of an earlier row and reads it as not requested", async () => {
    expect(await row()).toEqual({
      ...before,
      move_to_chain_id: null,
      move_requested_at: null,
      move_checked_at: null,
      move_wait_reason: null,
    });
  });

  it("sets and clears the request only as a pair, and never for the row's own chain", async () => {
    const violation = { code: "23514" };
    await expect(
      sql`UPDATE chain.transactions SET move_to_chain_id = 56 WHERE id = ${transaction}`,
    ).rejects.toMatchObject(violation);
    await expect(
      sql`UPDATE chain.transactions SET move_requested_at = now() WHERE id = ${transaction}`,
    ).rejects.toMatchObject(violation);
    await expect(
      sql`UPDATE chain.transactions SET move_to_chain_id = 5611, move_requested_at = now() WHERE id = ${transaction}`,
    ).rejects.toMatchObject(violation);
    // What the worker last saw exists only while a request is pending.
    await expect(
      sql`UPDATE chain.transactions SET move_checked_at = now() WHERE id = ${transaction}`,
    ).rejects.toMatchObject(violation);
    await expect(
      sql`UPDATE chain.transactions SET move_wait_reason = 'open_send' WHERE id = ${transaction}`,
    ).rejects.toMatchObject(violation);
  });

  it("lets the API request a move and the worker clear it, as themselves", async () => {
    await as("mpc_app", (tx) => tx`
      UPDATE chain.transactions SET move_to_chain_id = 56, move_requested_at = now() WHERE id = ${transaction}
    `);
    expect(await row()).toMatchObject({ move_to_chain_id: 56, chain_id: 5611, tx_hash: hash });

    await as("mpc_worker", (tx) => tx`
      UPDATE chain.transactions SET move_checked_at = now(), move_wait_reason = 'open_send' WHERE id = ${transaction}
    `);
    expect(await row()).toMatchObject({ move_wait_reason: "open_send", move_checked_at: expect.any(Date) });
    // Clearing the request alone would leave the wait behind.
    await expect(
      as("mpc_worker", (tx) => tx`
        UPDATE chain.transactions SET move_to_chain_id = NULL, move_requested_at = NULL WHERE id = ${transaction}
      `),
    ).rejects.toMatchObject({ code: "23514" });

    await as("mpc_worker", (tx) => tx`
      UPDATE chain.transactions
      SET move_to_chain_id = NULL, move_requested_at = NULL, move_checked_at = NULL, move_wait_reason = NULL
      WHERE id = ${transaction}
    `);
    expect(await row()).toMatchObject({ move_to_chain_id: null, move_requested_at: null });
  });

  it("lets the worker carry the move out in one reset, which the triggers accept", async () => {
    await sql`
      UPDATE chain.transactions
      SET move_to_chain_id = 56, move_requested_at = now(), move_checked_at = now(), move_wait_reason = 'signer_pending'
      WHERE id = ${transaction}
    `;
    // The recorded (hash, contract) pair is still frozen (0101) while the request is pending.
    await expect(
      as("mpc_worker", (tx) => tx`
        UPDATE chain.transactions SET contract_address = NULL WHERE id = ${transaction}
      `),
    ).rejects.toThrow(/contract of a recorded transaction hash cannot be changed/);

    await as("mpc_worker", (tx) => tx`
      UPDATE chain.transactions
      SET state = 'created', attempts = 0, chain_id = move_to_chain_id,
          move_to_chain_id = NULL, move_requested_at = NULL,
          move_checked_at = NULL, move_wait_reason = NULL,
          tx_hash = NULL, contract_address = NULL, block_number = NULL, block_hash = NULL,
          confirmations = 0, confirmed_at = NULL, submitted_at = NULL,
          chain_search_failed_since = NULL, retry_after = NULL,
          last_error = 'moved_from_chain_5611', updated_at = now()
      WHERE id = ${transaction}
    `);
    expect(await row()).toMatchObject({
      chain_id: 56,
      state: "created",
      tx_hash: null,
      contract_address: null,
      move_to_chain_id: null,
      move_requested_at: null,
      move_checked_at: null,
      move_wait_reason: null,
    });
  });

  it("validates the checks and finds pending requests by chain through a valid partial index", async () => {
    expect(await checks()).toEqual(CHECKS.map((name) => ({ name, validated: true })));
    const [index] = await sql<{ definition: string; valid: boolean }[]>`
      SELECT pg_get_indexdef(indexrelid) AS definition, indisvalid AS valid
      FROM pg_index WHERE indexrelid = 'chain.transactions_move_requested_idx'::regclass
    `;
    expect(index!.valid).toBe(true);
    expect(index!.definition).toContain("(chain_id) WHERE (move_to_chain_id IS NOT NULL)");
  });

  it("0106 runs outside a transaction, and reruns over an INVALID index left by a failed run", async () => {
    const all = listMigrations();
    const upTo = all.slice(0, all.findIndex((migration) => migration.name === VALIDATE) + 1);
    expect(runsOutsideTransaction(upTo.at(-1)!)).toBe(true);
    const kept = await row();
    // As a concurrent build that failed leaves it, with the file unrecorded.
    await sql`
      UPDATE pg_index SET indisvalid = false
      WHERE indexrelid = 'chain.transactions_move_requested_idx'::regclass
    `;
    await sql`DELETE FROM core.schema_migrations WHERE name = ${VALIDATE}`;
    expect(await runMigrations(sql, upTo)).toEqual([VALIDATE]);
    const [rebuilt] = await sql<{ valid: boolean }[]>`
      SELECT indisvalid AS valid FROM pg_index
      WHERE indexrelid = 'chain.transactions_move_requested_idx'::regclass
    `;
    expect(rebuilt).toEqual({ valid: true });
    expect(await checks()).toEqual(CHECKS.map((name) => ({ name, validated: true })));
    expect(await row()).toEqual(kept);
  });
});
