import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0125_remove_siwe_login.sql";

const tokenHash = () => `0x${createHash("sha256").update(randomUUID()).digest("hex")}`;

/**
 * 0125 — wallet sign-in removed (WP7, D3).
 *
 * Seeds wallet sessions in every state under the schema before 0125, migrates, and checks that
 * none is left live, that an ended one keeps how it ended, that no role can make a live one again,
 * that the SIWE function and nonce table are gone, and that the purge and resolver keep their
 * grants with the narrower shapes.
 */
describeDb("migration 0125: wallet sign-in removed", () => {
  const dbName = `m0125_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const live = randomUUID();
  const expired = randomUUID();
  const loggedOut = randomUUID();
  const address = `0x${"ab".repeat(20)}`;

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

    for (const [id, expiresAt, revokedReason] of [
      [live, "now() + interval '1 hour'", null],
      [expired, "now() - interval '1 hour'", null],
      [loggedOut, "now() + interval '1 hour'", "logout"],
    ] as const) {
      await sql`
        INSERT INTO core.sessions (id, token_hash, first_factor, wallet_address, chain_id, issued_at, expires_at, revoked_at, revoked_reason)
        VALUES (
          ${id}, ${tokenHash()}, 'siwe_legacy', ${address}, 31337, now() - interval '2 hours', ${sql.unsafe(expiresAt)},
          ${revokedReason === null ? null : sql`now() - interval '30 minutes'`}, ${revokedReason}
        )
      `;
    }
    await sql`
      INSERT INTO core.siwe_nonces (nonce, wallet_address, chain_id, issued_at, expires_at)
      VALUES (${randomUUID().replace(/-/g, "")}, ${address}, 31337, now(), now() + interval '5 minutes')
    `;

    const applied = await runMigrations(sql, all.slice(0, index + 1));
    expect(applied).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("revokes every wallet session that had not ended by revocation, and keeps how the others ended", async () => {
    const rows = await sql<{ id: string; revoked: boolean; revoked_reason: string | null }[]>`
      SELECT id, revoked_at IS NOT NULL AS revoked, revoked_reason FROM core.sessions ORDER BY id
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(live)).toMatchObject({ revoked: true, revoked_reason: "legacy_wallet_login_removed" });
    // Expired is not revoked: the constraint holds for every row, so it is revoked too.
    expect(byId.get(expired)).toMatchObject({ revoked: true, revoked_reason: "legacy_wallet_login_removed" });
    expect(byId.get(loggedOut)).toMatchObject({ revoked: true, revoked_reason: "logout" });
  });

  it("refuses a live wallet session, inserted or revived, even for the table owner", async () => {
    await expect(sql`
      INSERT INTO core.sessions (id, token_hash, first_factor, wallet_address, chain_id, expires_at)
      VALUES (${randomUUID()}, ${tokenHash()}, 'siwe_legacy', ${address}, 31337, now() + interval '1 hour')
    `).rejects.toThrow(/sessions_no_live_wallet_login/);
    await expect(
      sql`UPDATE core.sessions SET revoked_at = NULL, revoked_reason = NULL WHERE id = ${live}`,
    ).rejects.toThrow(/sessions_no_live_wallet_login/);
  });

  it("drops the SIWE session function and the nonce table", async () => {
    const [gone] = await sql<{ fn: string | null; nonces: string | null }[]>`
      SELECT to_regprocedure('core.create_wallet_session(uuid,text,text,integer,integer)')::text AS fn,
             to_regclass('core.siwe_nonces')::text AS nonces
    `;
    expect(gone).toEqual({ fn: null, nonces: null });
  });

  it("purges sessions only, for the worker and not the API", async () => {
    const [grants] = await sql<Record<string, boolean>[]>`
      SELECT
        has_function_privilege('mpc_worker', 'core.purge_auth_records()', 'EXECUTE') AS worker_purges,
        has_function_privilege('mpc_app', 'core.purge_auth_records()', 'EXECUTE') AS app_purges,
        has_function_privilege('mpc_app', 'core.resolve_session(text)', 'EXECUTE') AS app_resolves
    `;
    expect(grants).toEqual({ worker_purges: true, app_purges: false, app_resolves: true });

    const purged = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_worker");
      return tx`SELECT * FROM core.purge_auth_records()`;
    });
    // Ended under a day ago: kept for incident response.
    expect(purged).toEqual([{ purged_sessions: 0 }]);
  });

  it("resolves no wallet session", async () => {
    const [row] = await sql<{ token: string }[]>`SELECT token_hash AS token FROM core.sessions WHERE id = ${live}`;
    const token = row!.token;
    const resolved = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_app");
      return tx`SELECT * FROM core.resolve_session(${token})`;
    });
    expect(resolved).toEqual([]);
  });
});
