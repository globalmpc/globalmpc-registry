import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations, runsOutsideTransaction } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0107_anchor_contract_registry.sql";

const contract = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;

/**
 * 0107 — every anchor contract used on a chain is kept in `chain.anchor_contracts`, whatever later
 * happens to the rows that named it.
 *
 * Seeds rows and a proposal naming contracts on two chains under the preceding schema, migrates
 * forward, and checks the backfill; that a row or proposal naming a contract registers it, as the
 * API or the worker, and that the entry survives the row moving away; that the registry is
 * append-only; and that the worker may only read and add to it.
 */
describeDb("migration 0107: anchor contract registry", () => {
  const dbName = `m0107_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const rows = { a: randomUUID(), b: randomUUID(), none: randomUUID(), proposal: randomUUID() };

  /** Runs `body` as `role` in the tenant, the way the API and worker connect. */
  function as<T>(role: "mpc_app" | "mpc_worker", body: (tx: postgres.TransactionSql) => Promise<T>) {
    return sql.begin(async (tx) => {
      await tx.unsafe(`SET LOCAL ROLE ${role}`);
      await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
      return body(tx);
    });
  }
  const registry = async () =>
    (
      await sql<{ chain_id: number; contract_address: string }[]>`
        SELECT chain_id, contract_address FROM chain.anchor_contracts ORDER BY chain_id, contract_address
      `
    ).map((r) => `${r.chain_id}:${r.contract_address}`);
  const transaction = (id: string, chainId: number, contractAddress: string | null, txHash: string | null) => sql`
    INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, tx_hash, contract_address)
    VALUES (${id}, ${tenant}, ${`probe:${id}`}, ${chainId}, 'dropped', ${txHash}, ${contractAddress})
  `;

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

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0107-${tenant.slice(0, 8)}`}, 'Probe')`;
    await transaction(rows.a, 5611, contract("0a"), hash("1a"));
    await transaction(rows.b, 97, contract("0b"), hash("1b"));
    await transaction(rows.none, 5611, null, null);
    await sql`
      INSERT INTO chain.anchor_proposals (
        id, tenant_id, transaction_id, chain_id, safe_address, contract_address, calldata, calldata_hash
      ) VALUES (
        ${rows.proposal}, ${tenant}, ${rows.none}, 5611, ${contract("5a")}, ${contract("0e")}, '0x00', ${hash("ab")}
      )
    `;

    expect(runsOutsideTransaction(all[index]!)).toBe(false);
    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("backfills every contract a row or proposal named, with its chain", async () => {
    expect(await registry()).toEqual([`97:${contract("0b")}`, `5611:${contract("0a")}`, `5611:${contract("0e")}`]);
  });

  it("registers a contract a row names, as the API or the worker, and keeps it after the row moves away", async () => {
    // As the worker: recording a hash and its contract.
    await as("mpc_worker", (tx) => tx`
      UPDATE chain.transactions SET tx_hash = ${hash("1c")}, contract_address = ${contract("0c")}
      WHERE id = ${rows.none}
    `);
    expect(await registry()).toContain(`5611:${contract("0c")}`);

    // As the API, which holds no privilege on the registry: an inserted row names one.
    const inserted = randomUUID();
    await as("mpc_app", (tx) => tx`
      INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, tx_hash, contract_address)
      VALUES (${inserted}, ${tenant}, ${`probe:${inserted}`}, 56, 'dropped', ${hash("1d")}, ${contract("0d")})
    `);
    expect(await registry()).toContain(`56:${contract("0d")}`);

    // Reject a chain change retaining a contract: later updates must not invent provenance.
    await expect(sql`UPDATE chain.transactions SET chain_id = 204, tx_hash = ${hash("1e")} WHERE id = ${rows.b}`).rejects.toMatchObject({ code: "23514" });
    await sql`UPDATE chain.transactions SET chain_id = 204, tx_hash = NULL, contract_address = NULL WHERE id = ${rows.b}`;
    expect(await registry()).not.toContain(`204:${contract("0b")}`);
    // Its contract changing there does.
    await sql`UPDATE chain.transactions SET tx_hash = ${hash("1f")}, contract_address = ${contract("0f")} WHERE id = ${rows.b}`;
    expect(await registry()).toContain(`204:${contract("0f")}`);
    expect(await registry()).not.toContain(`204:${contract("0b")}`);

    // Moved away, contract cleared: the entry stays. Nothing on 5611 names 0c any more.
    await sql`
      UPDATE chain.transactions SET chain_id = 97, tx_hash = NULL, contract_address = NULL WHERE id = ${rows.none}
    `;
    expect(
      await sql`SELECT 1 FROM chain.transactions WHERE chain_id = 5611 AND contract_address = ${contract("0c")}`,
    ).toHaveLength(0);
    expect(await registry()).toContain(`5611:${contract("0c")}`);
  });

  it("registers the contract of a proposal", async () => {
    await sql`
      INSERT INTO chain.anchor_proposals (
        id, tenant_id, transaction_id, chain_id, safe_address, contract_address, calldata, calldata_hash
      ) VALUES (
        ${randomUUID()}, ${tenant}, ${rows.a}, 97, ${contract("5a")}, ${contract("0f")}, '0x00', ${hash("ac")}
      )
    `;
    expect(await registry()).toContain(`97:${contract("0f")}`);
    // A proposal cannot retain its old contract while changing chains.
    await expect(sql`UPDATE chain.anchor_proposals SET chain_id = 205 WHERE id = ${rows.proposal}`).rejects.toMatchObject({ code: "23514" });
    expect(await registry()).not.toContain(`205:${contract("0e")}`);

  });

  it("is append-only, even for its owner", async () => {
    const before = await registry();
    await expect(sql`UPDATE chain.anchor_contracts SET chain_id = 1`).rejects.toThrow(/append-only: UPDATE/);
    await expect(sql`DELETE FROM chain.anchor_contracts`).rejects.toThrow(/append-only: DELETE/);
    await expect(sql`TRUNCATE chain.anchor_contracts`).rejects.toThrow(/TRUNCATE rejected/);
    expect(await registry()).toEqual(before);
  });

  it("holds lowercase addresses only", async () => {
    await expect(
      sql`INSERT INTO chain.anchor_contracts (chain_id, contract_address) VALUES (1, ${`0x${"AB".repeat(20)}`})`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("lets the worker read and add, and nothing else; the API not at all", async () => {
    const privileges = await sql<{ role: string; privilege: string; granted: boolean }[]>`
      SELECT r AS role, p AS privilege, has_table_privilege(r, 'chain.anchor_contracts', p) AS granted
      FROM unnest(ARRAY['mpc_worker', 'mpc_app']) r,
           unnest(ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
      ORDER BY 1, 2
    `;
    expect(privileges.filter((p) => p.granted).map((p) => `${p.role}:${p.privilege}`)).toEqual([
      "mpc_worker:INSERT",
      "mpc_worker:SELECT",
    ]);
    // The worker's startup registration, repeated, is a no-op.
    for (let i = 0; i < 2; i++) {
      await as("mpc_worker", (tx) => tx`
        INSERT INTO chain.anchor_contracts (chain_id, contract_address) VALUES (5611, ${contract("01")})
        ON CONFLICT DO NOTHING
      `);
    }
    expect((await registry()).filter((r) => r === `5611:${contract("01")}`)).toHaveLength(1);
    await expect(
      as("mpc_app", (tx) => tx`SELECT * FROM chain.anchor_contracts`),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (await sql`SELECT has_function_privilege('mpc_worker', 'chain.register_anchor_contract()', 'EXECUTE') AS ok`)[0]!["ok"],
    ).toBe(false);
  });

  it("runs again from the top after a partial failure", async () => {
    const target = listMigrations().find((migration) => migration.name === TARGET)!;
    const before = await registry();
    await sql`DELETE FROM core.schema_migrations WHERE name = ${TARGET}`;
    expect(await runMigrations(sql, listMigrations().filter((m) => m.name <= TARGET))).toEqual([TARGET]);
    expect(runsOutsideTransaction(target)).toBe(false);
    expect(await registry()).toEqual(before);
    // Each trigger exists once.
    const triggers = await sql<{ tgname: string }[]>`
      SELECT tgname FROM pg_trigger
      WHERE NOT tgisinternal AND tgname LIKE ANY (ARRAY['%register_contract%', 'anchor_contracts_%'])
      ORDER BY 1
    `;
    expect(triggers.map((t) => t.tgname)).toEqual([
      "anchor_contracts_no_delete",
      "anchor_contracts_no_truncate",
      "anchor_contracts_no_update",
      "anchor_proposals_register_contract_on_insert",
      "anchor_proposals_register_contract_on_update",
      "transactions_register_contract_on_insert",
      "transactions_register_contract_on_update",
    ]);
  });
});

/**
 * 0107's backfill run by a role that owns the tables but neither is a superuser nor has
 * BYPASSRLS — the shape of a managed service's admin (Aurora's `rds_superuser` member). Both
 * tables it reads force row-level security on their owner, so a plain read sees no tenant's rows
 * and would record an empty registry without any error.
 */
describeDb("migration 0107: backfill as an owner that does not bypass row-level security", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const dbName = `m0107_owner_probe_${suffix}`;
  const owner = `m0107_owner_${suffix}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenants = [randomUUID(), randomUUID()] as const;
  const txRow = randomUUID();
  const proposalTx = randomUUID();

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    // One connection: the session's role below holds for every statement the runner sends.
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

    const all = listMigrations();
    const index = all.findIndex((migration) => migration.name === TARGET);
    await runMigrations(sql, all.slice(0, index));

    for (const [i, tenant] of tenants.entries()) {
      await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0107o-${i}-${tenant.slice(0, 8)}`}, 'Probe')`;
    }
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, intent_key, chain_id, state, tx_hash, contract_address)
      VALUES (${txRow}, ${tenants[0]}, ${`probe:${txRow}`}, 5611, 'dropped', ${hash("2a")}, ${contract("aa")}),
             (${proposalTx}, ${tenants[1]}, ${`probe:${proposalTx}`}, 97, 'dropped', NULL, NULL)
    `;
    await sql`
      INSERT INTO chain.anchor_proposals (
        id, tenant_id, transaction_id, chain_id, safe_address, contract_address, calldata, calldata_hash
      ) VALUES (
        ${randomUUID()}, ${tenants[1]}, ${proposalTx}, 97, ${contract("5b")}, ${contract("bb")}, '0x00', ${hash("2b")}
      )
    `;

    // What the migration touches, owned by (or granted to) that role, as when it created them.
    await sql.unsafe(`
      ALTER TABLE chain.transactions OWNER TO ${owner};
      ALTER TABLE chain.anchor_proposals OWNER TO ${owner};
      ALTER TABLE chain.anchor_batches OWNER TO ${owner};
      ALTER TABLE core.schema_migrations OWNER TO ${owner};
      GRANT CREATE ON DATABASE ${dbName} TO ${owner};
      GRANT USAGE, CREATE ON SCHEMA core, chain TO ${owner};
      GRANT EXECUTE ON FUNCTION core.reject_history_mutation(), core.reject_truncate() TO ${owner};
    `);
    await sql.unsafe(`SET ROLE ${owner}`);
    const [who] = await sql<{ user: string; bypasses: boolean }[]>`
      SELECT current_user AS user, rolsuper OR rolbypassrls AS bypasses FROM pg_roles WHERE rolname = current_user
    `;
    expect(who).toEqual({ user: owner, bypasses: false });
    // Precondition: as this role, without a tenant, neither table shows a row.
    expect(await sql`SELECT 1 FROM chain.transactions UNION ALL SELECT 1 FROM chain.anchor_proposals`).toHaveLength(0);

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
    await sql`RESET ROLE`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin?.end();
  });

  it("registers the contracts of every tenant's rows and proposals", async () => {
    const rows = await sql<{ chain_id: number; contract_address: string }[]>`
      SELECT chain_id, contract_address FROM chain.anchor_contracts ORDER BY chain_id, contract_address
    `;
    expect(rows.map((r) => `${r.chain_id}:${r.contract_address}`)).toEqual([
      `97:${contract("bb")}`,
      `5611:${contract("aa")}`,
    ]);
  });

  it("gives up waiting behind an open transaction instead of queueing every reader, and reruns", async () => {
    const forced = async () =>
      (
        await sql<{ f: boolean }[]>`
          SELECT bool_and(relforcerowsecurity) AS f FROM pg_class
          WHERE oid IN ('chain.transactions'::regclass, 'chain.anchor_proposals'::regclass)
        `
      )[0]!.f;
    await sql`DELETE FROM core.schema_migrations WHERE name = ${TARGET}`;
    // A reader left in an open transaction: CREATE TRIGGER does not conflict with it, lifting
    // FORCE (ACCESS EXCLUSIVE) does.
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    const reader = postgres(url.toString(), { onnotice: () => {}, max: 1 });
    const upTo = listMigrations().filter((m) => m.name <= TARGET);
    try {
      const open = await reader.reserve();
      await open.unsafe("BEGIN");
      await open`SELECT 1 FROM chain.anchor_proposals LIMIT 1`;
      await sql.unsafe(`SET ROLE ${owner}`);
      const started = Date.now();
      await expect(runMigrations(sql, upTo)).rejects.toMatchObject({ code: "55P03" });
      expect(Date.now() - started).toBeLessThan(15_000);
      await sql`RESET ROLE`;
      expect(await sql`SELECT 1 FROM core.schema_migrations WHERE name = ${TARGET}`).toHaveLength(0);
      expect(await forced()).toBe(true);

      await open.unsafe("COMMIT");
      open.release();
      await sql.unsafe(`SET ROLE ${owner}`);
      expect(await runMigrations(sql, upTo)).toEqual([TARGET]);
    } finally {
      await sql`RESET ROLE`;
      await reader.end();
    }
    expect(await forced()).toBe(true);
  }, 30_000);

  it("leaves row-level security forced on both tables", async () => {
    const tables = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
      WHERE oid IN ('chain.transactions'::regclass, 'chain.anchor_proposals'::regclass)
      ORDER BY relname
    `;
    expect(tables).toEqual([
      { relname: "anchor_proposals", relrowsecurity: true, relforcerowsecurity: true },
      { relname: "transactions", relrowsecurity: true, relforcerowsecurity: true },
    ]);
  });
});
