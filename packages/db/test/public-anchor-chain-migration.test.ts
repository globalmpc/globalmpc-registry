import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0099_public_anchor_chain_id.sql";

/**
 * 0099 — public proofs and hash lookups return the stored transaction chain.
 *
 * Seeds an anchored record under the preceding schema, migrates forward, and checks that the
 * functions now carry the chain the transaction was stored with, that nothing stored changed,
 * and that the public boundary is the same: same grants, same SECURITY DEFINER settings, the
 * same columns plus `chain_id` only, and unpublished versions still hidden.
 */
describeDb("migration 0099: public anchor chain", () => {
  const dbName = `m0099_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;

  const hex = (seed: string) => `0x${seed.replace(/-/g, "").repeat(2)}`;
  const tenant = randomUUID();
  const entry = randomUUID();
  const draftEntry = randomUUID();
  const published = randomUUID();
  const draft = randomUUID();
  const batch = randomUUID();
  /** A second batch whose transaction row is still `created`: queued on a chain, not sent. */
  const queuedEntry = randomUUID();
  const queued = randomUUID();
  const queuedBatch = randomUUID();
  const txHash = hex(randomUUID());
  const blockHash = hex(randomUUID());

  const stored = () => sql`
    SELECT v.id, v.status::text, v.content_hash, v.source_snapshot_hash, l.leaf_hash,
           b.batch_id, b.merkle_root, b.manifest_hash, t.chain_id, t.tx_hash, t.state::text,
           t.block_number, t.block_hash
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

  let before: {
    rows: readonly unknown[];
    lookup: readonly unknown[];
    proof: readonly unknown[];
    shapes: Record<string, unknown>;
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

    // An anchored, confirmed record on the local chain, plus a draft leaf in the same batch.
    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0099-${tenant.slice(0, 8)}`}, 'Probe')`;
    await sql`
      INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key) VALUES
        (${entry}, ${tenant}, 'project', ${randomUUID()}, ${`PRJ-${entry.slice(0, 8)}`}),
        (${draftEntry}, ${tenant}, 'project', ${randomUUID()}, ${`PRJ-${draftEntry.slice(0, 8)}`})
    `;
    await sql`
      INSERT INTO core.registry_entry_versions (
        id, tenant_id, entry_id, version, status, public_projection, content_hash,
        source_snapshot_hash, policy_version, schema_version, serialization_version, published_at
      ) VALUES
        (${published}, ${tenant}, ${entry}, 1, 'published', '{}'::jsonb, ${hex(published)},
         ${hex(entry)}, '1', '1', '1', now()),
        (${draft}, ${tenant}, ${draftEntry}, 1, 'draft', NULL, NULL,
         ${hex(draftEntry)}, '1', '1', '1', NULL)
    `;
    await sql`
      INSERT INTO chain.anchor_batches (
        id, tenant_id, batch_id, merkle_root, manifest_hash, manifest_object_key, schema_version, record_count
      ) VALUES (${batch}, ${tenant}, ${hex(batch)}, ${hex(tenant)}, ${`0x${"33".repeat(32)}`}, 'manifests/m0099.json', '1', 2)
    `;
    await sql`
      INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index) VALUES
        (${batch}, ${hex(published)}, ${published}, 0),
        (${batch}, ${hex(draft)}, ${draft}, 1)
    `;
    await sql`
      INSERT INTO chain.transactions (
        id, tenant_id, batch_id, intent_key, chain_id, tx_hash, state, block_number, block_hash
      ) VALUES (${randomUUID()}, ${tenant}, ${batch}, ${`anchor:${hex(batch)}`}, 31337, ${txHash}, 'confirmed', 42, ${blockHash})
    `;

    await sql`
      INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
      VALUES (${queuedEntry}, ${tenant}, 'project', ${randomUUID()}, ${`PRJ-${queuedEntry.slice(0, 8)}`})
    `;
    await sql`
      INSERT INTO core.registry_entry_versions (
        id, tenant_id, entry_id, version, status, public_projection, content_hash,
        source_snapshot_hash, policy_version, schema_version, serialization_version, published_at
      ) VALUES (${queued}, ${tenant}, ${queuedEntry}, 1, 'published', '{}'::jsonb, ${hex(queued)},
                ${hex(queuedEntry)}, '1', '1', '1', now())
    `;
    await sql`
      INSERT INTO chain.anchor_batches (
        id, tenant_id, batch_id, merkle_root, manifest_hash, manifest_object_key, schema_version, record_count
      ) VALUES (${queuedBatch}, ${tenant}, ${hex(queuedBatch)}, ${hex(queued)}, ${`0x${"44".repeat(32)}`}, 'manifests/m0099-q.json', '1', 1)
    `;
    await sql`
      INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
      VALUES (${queuedBatch}, ${hex(queued)}, ${queued}, 0)
    `;
    await sql`
      INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id)
      VALUES (${randomUUID()}, ${tenant}, ${queuedBatch}, ${`anchor:${hex(queuedBatch)}`}, 31337)
    `;

    before = {
      rows: await stored(),
      lookup: await sql`SELECT * FROM core.public_hash_lookup(${txHash})`,
      proof: await sql`SELECT * FROM core.public_inclusion_proof(${published})`,
      shapes: {
        lookup: (await functionShape("public_hash_lookup"))[0],
        proof: (await functionShape("public_inclusion_proof"))[0],
      },
    };
    expect(before.lookup).toHaveLength(1);
    expect(before.lookup[0]).not.toHaveProperty("chain_id");

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("leaves every stored anchor row and hash as it was", async () => {
    expect(await stored()).toEqual(before.rows);
  });

  it("hash lookup returns the same row plus the stored chain", async () => {
    const after = await sql`SELECT * FROM core.public_hash_lookup(${txHash})`;
    expect(after).toEqual([{ ...(before.lookup[0] as object), chain_id: 31337 }]);
    // The draft leaf in the same batch is still not exposed, by any of its hashes.
    expect(await sql`SELECT * FROM core.public_hash_lookup(${hex(draft)})`).toEqual([]);
  });

  it("inclusion proof returns the same row plus the stored chain", async () => {
    const after = await sql`SELECT * FROM core.public_inclusion_proof(${published})`;
    expect(after).toEqual([{ ...(before.proof[0] as object), chain_id: 31337 }]);
    expect(await sql`SELECT * FROM core.public_inclusion_proof(${draft})`).toEqual([]);
  });

  it("names no chain for a transaction that has no hash yet", async () => {
    // The row records the chain it is queued for; nothing has been sent there.
    expect(await sql`SELECT chain_id, transaction_hash FROM core.public_hash_lookup(${hex(queuedBatch)})`).toEqual([
      { chain_id: null, transaction_hash: null },
    ]);
    expect(await sql`SELECT chain_id, transaction_hash FROM core.public_inclusion_proof(${queued})`).toEqual([
      { chain_id: null, transaction_hash: null },
    ]);
  });

  it("keeps the public boundary: grants, definer settings, and only chain_id added", async () => {
    for (const name of ["public_hash_lookup", "public_inclusion_proof"] as const) {
      const [shape] = await functionShape(name);
      const was = before.shapes[name === "public_hash_lookup" ? "lookup" : "proof"] as NonNullable<typeof shape>;
      expect(shape!.args, name).toBe(was.args);
      expect(shape!.result, name).toBe(was.result.replace(/\)$/, ", chain_id integer)"));
      expect(shape!.secdef, name).toBe(true);
      expect(shape!.config, name).toEqual(was.config);
      expect(shape!.acl, name).toEqual(was.acl);
      // No PUBLIC entry (`=X/owner`): only the app role may call it.
      expect(shape!.acl!.some((entry) => entry.startsWith("=")), name).toBe(false);
      expect(shape!.acl!.some((entry) => entry.startsWith("mpc_app=X/")), name).toBe(true);
    }
  });
});
