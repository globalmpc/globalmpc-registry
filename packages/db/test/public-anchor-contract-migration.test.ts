import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0101_public_anchor_contract_address.sql";

/**
 * 0101 — public proofs and hash lookups return the stored anchor contract, and a recorded
 * (hash, contract) pair is frozen.
 *
 * Seeds anchors under the preceding schema — one with its contract recorded, one from before the
 * worker recorded it, one queued with no hash — migrates forward, and checks that the functions
 * add only the stored contract (NULL with no hash, NULL where none was stored), that nothing
 * stored changed, that the public boundary is the same, and that the guard holds.
 */
describeDb("migration 0101: public anchor contract", () => {
  const dbName = `m0101_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  const hex = (seed: string) => `0x${seed.replace(/-/g, "").repeat(2)}`;
  const CONTRACT = `0x${"c1".repeat(20)}`;
  const OTHER = `0x${"c2".repeat(20)}`;
  const tenant = randomUUID();

  interface Anchor {
    entry: string;
    version: string;
    batch: string;
    transaction: string;
    txHash: string | null;
    contract: string | null;
  }
  const anchor = (txHash: string | null, contract: string | null): Anchor => ({
    entry: randomUUID(),
    version: randomUUID(),
    batch: randomUUID(),
    transaction: randomUUID(),
    txHash,
    contract,
  });
  /** Sent, with the contract the worker recorded. */
  const recorded = anchor(hex(randomUUID()), CONTRACT);
  /** Sent before the worker recorded the contract. */
  const legacy = anchor(hex(randomUUID()), null);
  /** Queued: a contract on the row from an earlier attempt, but no hash now. */
  const queued = anchor(null, CONTRACT);
  const anchors = [recorded, legacy, queued];

  const stored = () => sql`
    SELECT v.id, v.status::text, v.content_hash, l.leaf_hash, b.batch_id, b.merkle_root,
           t.chain_id, t.contract_address, t.tx_hash, t.state::text, t.block_number
    FROM core.registry_entry_versions v
    JOIN chain.anchor_batch_leaves l ON l.entry_version_id = v.id
    JOIN chain.anchor_batches b ON b.id = l.batch_id
    JOIN chain.transactions t ON t.batch_id = b.id
    ORDER BY v.id
  `;

  const functionShape = (name: string) => sql<
    { args: string; result: string; secdef: boolean; config: string[] | null; acl: string[] | null }[]
  >`
    SELECT pg_get_function_identity_arguments(p.oid) AS args,
           pg_get_function_result(p.oid) AS result,
           p.prosecdef AS secdef, p.proconfig AS config, p.proacl::text[] AS acl
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'core' AND p.proname = ${name}
  `;

  const tableAcl = () => sql<{ acl: string[] | null }[]>`
    SELECT relacl::text[] AS acl FROM pg_class WHERE oid = 'chain.transactions'::regclass
  `;

  let before: {
    rows: readonly unknown[];
    lookups: Map<string, readonly unknown[]>;
    proofs: Map<string, readonly unknown[]>;
    shapes: Record<string, unknown>;
    tableAcl: unknown;
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

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0101-${tenant.slice(0, 8)}`}, 'Probe')`;
    for (const [i, a] of anchors.entries()) {
      await sql`
        INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
        VALUES (${a.entry}, ${tenant}, 'project', ${randomUUID()}, ${`PRJ-${a.entry.slice(0, 8)}`})
      `;
      await sql`
        INSERT INTO core.registry_entry_versions (
          id, tenant_id, entry_id, version, status, public_projection, content_hash,
          source_snapshot_hash, policy_version, schema_version, serialization_version, published_at
        ) VALUES (${a.version}, ${tenant}, ${a.entry}, 1, 'published', '{}'::jsonb, ${hex(a.version)},
                  ${hex(a.entry)}, '1', '1', '1', now())
      `;
      await sql`
        INSERT INTO chain.anchor_batches (
          id, tenant_id, batch_id, merkle_root, manifest_hash, manifest_object_key, schema_version, record_count
        ) VALUES (${a.batch}, ${tenant}, ${hex(a.batch)}, ${hex(a.version)}, ${`0x${"33".repeat(32)}`},
                  ${`manifests/m0101-${i}.json`}, '1', 1)
      `;
      await sql`
        INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
        VALUES (${a.batch}, ${hex(a.version)}, ${a.version}, 0)
      `;
      await sql`
        INSERT INTO chain.transactions (
          id, tenant_id, batch_id, intent_key, chain_id, contract_address, tx_hash, state,
          block_number, block_hash
        ) VALUES (${a.transaction}, ${tenant}, ${a.batch}, ${`anchor:${hex(a.batch)}`}, 5611,
                  ${a.contract}, ${a.txHash}, ${a.txHash ? "confirmed" : "created"},
                  ${a.txHash ? 42 : null}, ${a.txHash ? `0x${"cd".repeat(32)}` : null})
      `;
    }

    before = {
      rows: await stored(),
      lookups: new Map(
        await Promise.all(
          anchors.map(async (a) => [a.version, await sql`SELECT * FROM core.public_hash_lookup(${hex(a.batch)})`] as const),
        ),
      ),
      proofs: new Map(
        await Promise.all(
          anchors.map(async (a) => [a.version, await sql`SELECT * FROM core.public_inclusion_proof(${a.version})`] as const),
        ),
      ),
      shapes: {
        lookup: (await functionShape("public_hash_lookup"))[0],
        proof: (await functionShape("public_inclusion_proof"))[0],
      },
      tableAcl: (await tableAcl())[0],
    };
    for (const a of anchors) {
      expect(before.lookups.get(a.version)).toHaveLength(1);
      expect(before.lookups.get(a.version)![0]).not.toHaveProperty("contract_address");
    }

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("leaves every stored anchor row as it was — no contract is back-filled", async () => {
    expect(await stored()).toEqual(before.rows);
  });

  it.each([
    ["the recorded contract", recorded, CONTRACT],
    ["no contract for an anchor recorded without one", legacy, null],
    ["no contract while the transaction has no hash, though the row names one", queued, null],
  ])("hash lookup and proof add %s", async (_label, a, expected) => {
    const lookup = await sql`SELECT * FROM core.public_hash_lookup(${hex(a.batch)})`;
    expect(lookup).toEqual([{ ...(before.lookups.get(a.version)![0] as object), contract_address: expected }]);
    const proof = await sql`SELECT * FROM core.public_inclusion_proof(${a.version})`;
    expect(proof).toEqual([{ ...(before.proofs.get(a.version)![0] as object), contract_address: expected }]);
  });

  it("keeps the public boundary: grants, definer settings, and only contract_address added", async () => {
    for (const name of ["public_hash_lookup", "public_inclusion_proof"] as const) {
      const [shape] = await functionShape(name);
      const was = before.shapes[name === "public_hash_lookup" ? "lookup" : "proof"] as NonNullable<typeof shape>;
      expect(shape!.args, name).toBe(was.args);
      expect(shape!.result, name).toBe(was.result.replace(/\)$/, ", contract_address text)"));
      expect(shape!.secdef, name).toBe(true);
      expect(shape!.config, name).toEqual(was.config);
      expect(shape!.acl, name).toEqual(was.acl);
      expect(shape!.acl!.some((entry) => entry.startsWith("=")), name).toBe(false);
      expect(shape!.acl!.some((entry) => entry.startsWith("mpc_app=X/")), name).toBe(true);
    }
    expect((await tableAcl())[0]).toEqual(before.tableAcl);
  });

  describe("a recorded (hash, contract) pair is frozen", () => {
    const contractOf = async (a: Anchor) =>
      (await sql<{ contract_address: string | null }[]>`
        SELECT contract_address FROM chain.transactions WHERE id = ${a.transaction}
      `)[0]!.contract_address;

    it("rejects rewriting the contract of a recorded hash", async () => {
      await expect(
        sql`UPDATE chain.transactions SET contract_address = ${OTHER} WHERE id = ${recorded.transaction}`,
      ).rejects.toMatchObject({ code: "23514" });
      expect(await contractOf(recorded)).toBe(CONTRACT);
    });

    it("rejects clearing it", async () => {
      await expect(
        sql`UPDATE chain.transactions SET contract_address = NULL WHERE id = ${recorded.transaction}`,
      ).rejects.toMatchObject({ code: "23514" });
    });

    it("rejects back-filling an anchor recorded without one", async () => {
      await expect(
        sql`UPDATE chain.transactions SET contract_address = ${CONTRACT} WHERE id = ${legacy.transaction}`,
      ).rejects.toMatchObject({ code: "23514" });
      expect(await contractOf(legacy)).toBeNull();
    });

    it("allows other updates of a recorded row", async () => {
      await sql`UPDATE chain.transactions SET confirmations = 12, updated_at = now() WHERE id = ${recorded.transaction}`;
      expect(await contractOf(recorded)).toBe(CONTRACT);
    });

    it("allows the contract to change only together with a new hash, or before any hash", async () => {
      // No hash yet: the worker records the contract it is about to send to.
      await sql`UPDATE chain.transactions SET contract_address = ${OTHER} WHERE id = ${queued.transaction}`;
      expect(await contractOf(queued)).toBe(OTHER);
      // A resubmission clears the hash; the next send records hash and contract together.
      await sql`
        UPDATE chain.transactions SET state = 'created', tx_hash = NULL, block_number = NULL, block_hash = NULL
        WHERE id = ${legacy.transaction}
      `;
      const next = hex(randomUUID());
      await sql`
        UPDATE chain.transactions SET state = 'submitted', tx_hash = ${next}, contract_address = ${OTHER}
        WHERE id = ${legacy.transaction}
      `;
      expect(await contractOf(legacy)).toBe(OTHER);
      expect(
        await sql`SELECT contract_address, transaction_hash FROM core.public_inclusion_proof(${legacy.version})`,
      ).toEqual([{ contract_address: OTHER, transaction_hash: next }]);
    });
  });
});
