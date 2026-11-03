import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0122_wallet_signing_keys.sql";

const address = (byte: string) => `0x${byte.repeat(40)}`;

/**
 * 0122 — wallets as signing keys (WP5).
 *
 * Seeds two people with a wallet each under the schema before 0122, migrates, and checks that the
 * existing rows read as operator-bound, that the application role can no longer attach a wallet
 * or move one, and that the challenge table and governance wallet hold their invariants even for
 * the table owner.
 */
describeDb("migration 0122: wallet signing keys", () => {
  const dbName = `m0122_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const alice = randomUUID();
  const bob = randomUUID();
  const aliceWallet = randomUUID();
  const bobWallet = randomUUID();

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

    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0122-${tenant.slice(0, 8)}`}, 'Probe')`;
    for (const [subject, wallet, byte] of [
      [alice, aliceWallet, "a"],
      [bob, bobWallet, "b"],
    ] as const) {
      await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${subject}, ${tenant}, 'person', 'Holder')`;
      await sql`
        INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at)
        VALUES (${wallet}, ${tenant}, ${subject}, ${address(byte)}, 31337, now())
      `;
    }

    const applied = await runMigrations(sql, all.slice(0, index + 1));
    expect(applied).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("reads every existing binding as operator-bound", async () => {
    const rows = await sql`SELECT id, bound_via FROM core.wallet_identities ORDER BY wallet_address`;
    expect(rows).toEqual([
      { id: aliceWallet, bound_via: "operator" },
      { id: bobWallet, bound_via: "operator" },
    ]);
  });

  it("leaves the application role no way to attach or move a wallet", async () => {
    const [grants] = await sql<Record<string, boolean>[]>`
      SELECT
        has_table_privilege('mpc_app', 'core.wallet_identities', 'INSERT') AS insert_wallet,
        has_column_privilege('mpc_app', 'core.wallet_identities', 'subject_id', 'UPDATE') AS move_wallet,
        has_column_privilege('mpc_app', 'core.wallet_identities', 'wallet_address', 'UPDATE') AS readdress_wallet,
        has_column_privilege('mpc_app', 'core.wallet_identities', 'assurance_level', 'UPDATE') AS rate_wallet,
        has_column_privilege('mpc_app', 'core.wallet_identities', 'bound_via', 'UPDATE') AS relabel_wallet,
        has_column_privilege('mpc_app', 'core.wallet_identities', 'disabled_at', 'UPDATE') AS disable_wallet,
        has_column_privilege('mpc_app', 'core.subjects', 'governance_wallet_id', 'UPDATE') AS point_governance,
        has_column_privilege('mpc_app', 'core.subjects', 'governance_wallet_id', 'INSERT') AS seed_governance,
        has_table_privilege('mpc_app', 'core.wallet_binding_challenges', 'INSERT') AS write_challenge,
        has_table_privilege('mpc_app', 'core.wallet_binding_challenges', 'UPDATE') AS spend_challenge
    `;
    expect(grants).toEqual({
      insert_wallet: false,
      move_wallet: false,
      readdress_wallet: false,
      rate_wallet: false,
      relabel_wallet: false,
      // The admin disable (AC-27) stays a one-person act on the row.
      disable_wallet: true,
      point_governance: false,
      seed_governance: false,
      write_challenge: false,
      spend_challenge: false,
    });
  });

  it("isolates binding challenges by tenant, forced", async () => {
    const [table] = await sql<{ relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'core' AND c.relname = 'wallet_binding_challenges'
    `;
    expect(table).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
  });

  it("keeps a governance wallet the subject's own, even for the table owner", async () => {
    await expect(sql`UPDATE core.subjects SET governance_wallet_id = ${bobWallet} WHERE id = ${alice}`).rejects.toThrow(
      /subjects_governance_wallet_own/,
    );
    await sql`UPDATE core.subjects SET governance_wallet_id = ${aliceWallet} WHERE id = ${alice}`;
    // And the wallet cannot move away from under the designation.
    await expect(sql`UPDATE core.wallet_identities SET subject_id = ${bob} WHERE id = ${aliceWallet}`).rejects.toThrow(
      /subjects_governance_wallet_own/,
    );
  });

  it("refuses a challenge living longer than five minutes, or spent without a binding", async () => {
    const session = randomUUID();
    // Any session row will do: the CHECKs under test are the challenge's own. An account session
    // needs a consumed email challenge or login transaction behind it (0113, 0120), so a legacy
    // wallet session stands in.
    await sql`
      INSERT INTO core.sessions (id, token_hash, first_factor, wallet_address, chain_id, expires_at)
      VALUES (${session}, ${`0x${"c".repeat(64)}`}, 'siwe_legacy', ${address("a")}, 31337, now() + interval '1 hour')
    `;
    const challenge = (overrides: { expires: string; consumed?: boolean }) => sql`
      INSERT INTO core.wallet_binding_challenges (
        id, tenant_id, subject_id, session_id, wallet_address, chain_id, nonce, issued_at, expires_at, consumed_at
      ) VALUES (
        ${randomUUID()}, ${tenant}, ${alice}, ${session}, ${address("d")}, 31337,
        ${`0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`}, now(),
        now() + ${overrides.expires}::interval, ${overrides.consumed ? sql`now()` : null}
      )
    `;
    await expect(challenge({ expires: "6 minutes" })).rejects.toThrow(/wallet_binding_challenges_ttl/);
    await expect(challenge({ expires: "1 minute", consumed: true })).rejects.toThrow(
      /wallet_binding_challenges_consumed_together/,
    );
  });
});
