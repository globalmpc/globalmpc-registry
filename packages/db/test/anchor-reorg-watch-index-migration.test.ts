import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations, runsOutsideTransaction } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0104_anchor_reorg_watch_indexes.sql";

/**
 * 0104 — indexes for the anchor worker's watch-set lookups.
 *
 * Seeds transaction rows in every state the indexes split on under the preceding schema, migrates
 * forward, and checks that the rows are unchanged, that each index holds exactly the rows its
 * predicate names, and that the worker can still read and update through them as itself. That the
 * worker's own queries choose these indexes is checked against their real text in the anchor
 * worker's suite.
 */
describeDb("migration 0104: anchor reorg watch indexes", () => {
  const dbName = `m0104_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const rows = {
    watched: randomUUID(),
    legacy: randomUUID(),
    searching: randomUUID(),
    proposed: randomUUID(),
    created: randomUUID(),
  };
  const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
  let before: Record<string, unknown>[];
  const all = async () => sql`SELECT * FROM chain.transactions ORDER BY id`;

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

    const migrations = listMigrations();
    const index = migrations.findIndex((migration) => migration.name === TARGET);
    expect(index).toBeGreaterThan(0);
    await runMigrations(sql, migrations.slice(0, index));

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0104-${tenant.slice(0, 8)}`}, 'Probe')`;
    const confirmed = (id: string, n: number, extra: { deadline: boolean; searching: boolean }) => sql`
      INSERT INTO chain.transactions (
        id, tenant_id, intent_key, chain_id, state, tx_hash, block_number, block_hash,
        confirmations, confirmed_at, reorg_watch_until, chain_search_failed_since, retry_after
      ) VALUES (
        ${id}, ${tenant}, ${`probe:${id}`}, 5611, 'confirmed', ${hash(n)}, ${n}, ${hash(n)}, 3,
        now() - interval '10 minutes',
        ${extra.deadline ? sql`now() + interval '20 minutes'` : null},
        ${extra.searching ? sql`now() - interval '5 minutes'` : null},
        ${extra.searching ? sql`now()` : null}
      )
    `;
    await confirmed(rows.watched, 1, { deadline: true, searching: false });
    await confirmed(rows.legacy, 2, { deadline: false, searching: false });
    await confirmed(rows.searching, 3, { deadline: true, searching: true });
    for (const [id, state] of [[rows.proposed, "proposed"], [rows.created, "created"]] as const) {
      await sql`
        INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state)
        VALUES (${id}, ${tenant}, ${`probe:${id}`}, 5611, ${state})
      `;
    }
    before = (await all()).map((row) => ({ ...row }));

    expect(await runMigrations(sql, migrations.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("keeps every row as it was", async () => {
    expect((await all()).map((row) => ({ ...row }))).toEqual(before);
  });

  it("adds valid partial indexes that hold only the rows their predicates name", async () => {
    const indexes = await sql<{ name: string; valid: boolean; definition: string }[]>`
      SELECT c.relname AS name, i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS definition
      FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = 'chain.transactions'::regclass
        AND c.relname IN (
          'transactions_reorg_watch_idx', 'transactions_confirmed_at_idx',
          'transactions_confirmed_search_idx', 'transactions_proposed_idx'
        )
      ORDER BY c.relname
    `;
    expect(indexes.map(({ name, valid }) => ({ name, valid }))).toEqual([
      { name: "transactions_confirmed_at_idx", valid: true },
      { name: "transactions_confirmed_search_idx", valid: true },
      { name: "transactions_proposed_idx", valid: true },
      { name: "transactions_reorg_watch_idx", valid: true },
    ]);
    const definition = (name: string) => indexes.find((index) => index.name === name)!.definition;
    expect(definition("transactions_reorg_watch_idx")).toMatch(
      /\(reorg_watch_until, confirmed_at\) WHERE \(state = 'confirmed'/,
    );
    expect(definition("transactions_confirmed_at_idx")).toMatch(/\(confirmed_at\) WHERE \(state = 'confirmed'/);
    expect(definition("transactions_confirmed_search_idx")).toMatch(
      /\(chain_id\) WHERE \(\(state = 'confirmed'.*chain_search_failed_since IS NOT NULL\).*retry_after IS NOT NULL/,
    );
    expect(definition("transactions_proposed_idx")).toMatch(/\(chain_id\) WHERE \(state = 'proposed'/);

    // Which rows each index holds, read through the index alone: the other indexes this migration
    // adds are dropped inside a transaction that is rolled back, so on a table this small the
    // planner cannot pick a sibling instead.
    const probed = [
      "transactions_reorg_watch_idx",
      "transactions_confirmed_at_idx",
      "transactions_confirmed_search_idx",
      "transactions_proposed_idx",
    ];
    const rollback = new Error("rollback");
    const through = async (index: string, predicate: string) => {
      let ids: string[] = [];
      await sql
        .begin(async (tx) => {
          for (const other of probed.filter((name) => name !== index)) await tx.unsafe(`DROP INDEX chain.${other}`);
          await tx`SET LOCAL enable_seqscan = off`;
          await tx`SET LOCAL enable_bitmapscan = off`;
          const [plan] = await tx.unsafe(`EXPLAIN (FORMAT JSON) SELECT id FROM chain.transactions WHERE ${predicate}`);
          expect(JSON.stringify(plan)).toContain(index);
          ids = (await tx.unsafe<{ id: string }[]>(`SELECT id FROM chain.transactions WHERE ${predicate}`))
            .map((row) => row.id)
            .sort();
          throw rollback;
        })
        .catch((error: unknown) => {
          if (error !== rollback) throw error;
        });
      return ids;
    };
    expect(await through("transactions_reorg_watch_idx", "state = 'confirmed' AND reorg_watch_until > now()")).toEqual(
      [rows.watched, rows.searching].sort(),
    );
    expect(
      await through(
        "transactions_reorg_watch_idx",
        "state = 'confirmed' AND reorg_watch_until IS NULL AND confirmed_at > now() - interval '1 hour'",
      ),
    ).toEqual([rows.legacy]);
    expect(
      await through("transactions_confirmed_at_idx", "state = 'confirmed' AND confirmed_at > now() - interval '1 hour'"),
    ).toEqual([rows.watched, rows.legacy, rows.searching].sort());
    expect(
      await through("transactions_confirmed_search_idx", "state = 'confirmed' AND chain_search_failed_since IS NOT NULL"),
    ).toEqual([rows.searching]);
    expect(await through("transactions_proposed_idx", "state = 'proposed' AND chain_id = 5611")).toEqual([rows.proposed]);
  });

  it("runs outside a transaction, and rebuilds an index a failed run left INVALID", async () => {
    const target = listMigrations().find((migration) => migration.name === TARGET)!;
    expect(runsOutsideTransaction(target)).toBe(true);
    // As a concurrent build that failed leaves it, with the file unrecorded.
    await sql`
      UPDATE pg_index SET indisvalid = false
      WHERE indexrelid = 'chain.transactions_reorg_watch_idx'::regclass
    `;
    await sql`DELETE FROM core.schema_migrations WHERE name = ${TARGET}`;
    const migrations = listMigrations();
    const upTo = migrations.slice(0, migrations.findIndex((migration) => migration.name === TARGET) + 1);
    expect(await runMigrations(sql, upTo)).toEqual([TARGET]);
    const [rebuilt] = await sql<{ valid: boolean }[]>`
      SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'chain.transactions_reorg_watch_idx'::regclass
    `;
    expect(rebuilt).toEqual({ valid: true });
    expect((await all()).map((row) => ({ ...row }))).toEqual(before);
  });

  it("lets the worker read and update indexed rows as itself", async () => {
    await sql.begin(async (tx) => {
      await tx`SET LOCAL ROLE mpc_worker`;
      const seen = await tx`
        SELECT id FROM chain.transactions
        WHERE state = 'confirmed' AND reorg_watch_until > now()
        FOR NO KEY UPDATE SKIP LOCKED
      `;
      expect(seen).toHaveLength(2);
      await tx`
        UPDATE chain.transactions SET chain_search_failed_since = NULL, retry_after = NULL, updated_at = now()
        WHERE id = ${rows.searching}
      `;
    });
    const [left] = await sql`
      SELECT count(*)::int AS n FROM chain.transactions
      WHERE state = 'confirmed' AND (chain_search_failed_since IS NOT NULL OR retry_after IS NOT NULL)
    `;
    expect(left!["n"]).toBe(0);
  });
});
