import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const FIRST = "0115_mfa_authenticators.sql";
const TARGETS = ["0115_mfa_authenticators.sql", "0116_session_second_factor.sql", "0117_mfa_reset_decision.sql"];

const hash = (byte: string) => `0x${byte.repeat(64)}`;

const NEW_TABLES = [
  "webauthn_credentials",
  "totp_authenticators",
  "recovery_codes",
  "webauthn_challenges",
  "session_factor_proofs",
  "mfa_reset_requests",
] as const;

/**
 * 0115–0117 — second factors (WP3).
 *
 * Seeds sessions under the schema before 0115 — one first-factor-only, one that merely *claims*
 * a passkey, as `core.create_subject_session` allowed until now — migrates forward, and checks:
 * the unproven claim is gone and the honest session survives; the new tables are tenant-isolated
 * and closed to the API role except through their functions; and a factor cannot be written
 * without its own proof even by the table owner.
 */
describeDb("migrations 0115–0117: second factors", () => {
  const dbName = `m0115_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenants = [randomUUID(), randomUUID()] as const;
  const subject = randomUUID();
  const honest = randomUUID();
  const claimed = randomUUID();

  const asApp = (
    body: (tx: postgres.TransactionSql) => postgres.PendingQuery<postgres.Row[]>,
    tenant: string | null = tenants[0],
  ) =>
    sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_app");
      if (tenant) await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
      return [...(await body(tx))];
    }) as Promise<postgres.Row[]>;

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

    const all = listMigrations();
    const index = all.findIndex((migration) => migration.name === FIRST);
    expect(index).toBeGreaterThan(0);
    await runMigrations(sql, all.slice(0, index));

    for (const [i, tenant] of tenants.entries()) {
      await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0115-${i}-${tenant.slice(0, 8)}`}, 'Probe')`;
    }
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${subject}, ${tenants[0]}, 'person', 'Holder')`;
    await asApp((tx) => tx`
      SELECT core.create_subject_session(${honest}, ${hash("a")}, ${subject}, 'google', NULL, 3600)
    `);
    await asApp((tx) => tx`
      SELECT core.create_subject_session(${claimed}, ${hash("b")}, ${subject}, 'google', 'passkey', 3600)
    `);

    const applied = await runMigrations(sql, all.slice(0, index + TARGETS.length));
    expect(applied).toEqual(TARGETS);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("deletes sessions whose second factor nothing proved, and keeps the others", async () => {
    const rows = await sql`SELECT id, second_factor, recovery_limited FROM core.sessions ORDER BY id`;
    expect(rows).toEqual([{ id: honest, second_factor: null, recovery_limited: false }]);
    const [resolved] = await asApp((tx) => tx`SELECT * FROM core.resolve_session(${hash("a")})`);
    expect(resolved).toMatchObject({ subject_id: subject, second_factor: null, recovery_limited: false });
  });

  it("no longer issues a session with a second factor", async () => {
    await expect(
      asApp((tx) => tx`
        SELECT core.create_subject_session(${randomUUID()}, ${hash("c")}, ${subject}, 'google', 'passkey', 3600)
      `),
    ).rejects.toThrow(/starts at its first factor/);
    await expect(
      asApp((tx) => tx`
        SELECT core.create_subject_session(${randomUUID()}, ${hash("d")}, ${subject}, 'google', 'totp', 3600)
      `),
    ).rejects.toThrow(/starts at its first factor/);
  });

  it("isolates every new table by tenant, forced, and opens none for writing to the API role", async () => {
    const rls = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'core' AND c.relname IN ${sql(NEW_TABLES as unknown as string[])}
      ORDER BY c.relname
    `;
    expect(rls).toHaveLength(NEW_TABLES.length);
    for (const row of rls) expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });

    const privileges = await sql<{ table: string; select: boolean; insert: boolean; update: boolean; delete: boolean }[]>`
      SELECT t AS table,
             has_table_privilege('mpc_app', 'core.' || t, 'SELECT') AS select,
             has_table_privilege('mpc_app', 'core.' || t, 'INSERT') AS insert,
             has_table_privilege('mpc_app', 'core.' || t, 'UPDATE') AS update,
             has_table_privilege('mpc_app', 'core.' || t, 'DELETE') AS delete
      FROM unnest(${NEW_TABLES as unknown as string[]}::text[]) AS t ORDER BY t
    `;
    const byTable = Object.fromEntries(privileges.map((row) => [row.table, row]));
    for (const table of ["webauthn_challenges", "session_factor_proofs"]) {
      expect(byTable[table], table).toMatchObject({ select: false, insert: false, update: false, delete: false });
    }
    for (const table of ["webauthn_credentials", "totp_authenticators", "recovery_codes"]) {
      expect(byTable[table], table).toMatchObject({ select: true, insert: false, update: false, delete: false });
    }
    // Proposing a reset inserts the proposal's own columns only; state, decision and window keep
    // their defaults, and deciding goes through `core.decide_mfa_reset`.
    expect(byTable["mfa_reset_requests"]).toMatchObject({ select: true, insert: false, update: false, delete: false });
    const columns = await sql<{ column: string; insert: boolean }[]>`
      SELECT c AS column, has_column_privilege('mpc_app', 'core.mfa_reset_requests', c, 'INSERT') AS insert
      FROM unnest(${[
        "id", "tenant_id", "subject_id", "reason", "requested_by_subject_id",
        "state", "decided_by_subject_id", "decided_at", "decision_reason", "enrolment_window_until", "version",
      ]}::text[]) AS c
    `;
    expect(columns.filter((row) => row.insert).map((row) => row.column).sort()).toEqual(
      ["id", "reason", "requested_by_subject_id", "subject_id", "tenant_id"],
    );

    // The internal helpers are not callable by the API role.
    for (const fn of ["mfa_raise_session", "mfa_revoke_other_sessions", "mfa_store_recovery_codes", "mfa_lock_session"]) {
      const [row] = await sql`
        SELECT bool_or(has_function_privilege('mpc_app', p.oid, 'EXECUTE')) AS callable
        FROM pg_proc p WHERE p.pronamespace = 'core'::regnamespace AND p.proname = ${fn}
      `;
      expect(row!.callable, fn).toBe(false);
    }
  });

  it("refuses a factor without its own proof, even to the table owner", async () => {
    await expect(
      sql`UPDATE core.sessions SET second_factor = 'passkey', second_factor_at = now() WHERE id = ${honest}`,
    ).rejects.toThrow(/violates check constraint/);

    // A proof needs consumed evidence of the same session: a recovery code it spent.
    const code = randomUUID();
    const proof = randomUUID();
    await sql`
      INSERT INTO core.recovery_codes (id, tenant_id, subject_id, set_id, code_hash)
      VALUES (${code}, ${tenants[0]}, ${subject}, ${randomUUID()}, ${"e".repeat(64)})
    `;
    await expect(
      sql`
        INSERT INTO core.session_factor_proofs (id, tenant_id, subject_id, session_id, factor, recovery_code_id)
        VALUES (${proof}, ${tenants[0]}, ${subject}, ${honest}, 'recovery_code', ${code})
      `,
    ).rejects.toThrow(/violates foreign key constraint/);
    // A proof row of one kind cannot carry another factor's evidence.
    await expect(
      sql`
        INSERT INTO core.session_factor_proofs (id, tenant_id, subject_id, session_id, factor, recovery_code_id)
        VALUES (${proof}, ${tenants[0]}, ${subject}, ${honest}, 'passkey', ${code})
      `,
    ).rejects.toThrow(/violates (check|foreign key) constraint/);

    await sql`UPDATE core.recovery_codes SET consumed_at = now(), consumed_by_session_id = ${honest} WHERE id = ${code}`;
    await sql`
      INSERT INTO core.session_factor_proofs (id, tenant_id, subject_id, session_id, factor, recovery_code_id)
      VALUES (${proof}, ${tenants[0]}, ${subject}, ${honest}, 'recovery_code', ${code})
    `;
    // The proof is of a recovery code: it cannot back a passkey claim, and it makes the session limited.
    await expect(
      sql`UPDATE core.sessions SET second_factor = 'passkey', second_factor_at = now(), second_factor_proof_id = ${proof}
          WHERE id = ${honest}`,
    ).rejects.toThrow(/violates (check|foreign key) constraint/);
    await expect(
      sql`UPDATE core.sessions SET second_factor = 'recovery_code', second_factor_at = now(), second_factor_proof_id = ${proof}
          WHERE id = ${honest}`,
    ).rejects.toThrow(/violates check constraint/);
    await sql`
      UPDATE core.sessions SET second_factor = 'recovery_code', second_factor_at = now(),
        second_factor_proof_id = ${proof}, recovery_limited = true
      WHERE id = ${honest}
    `;
    const [resolved] = await asApp((tx) => tx`SELECT * FROM core.resolve_session(${hash("a")})`);
    expect(resolved).toMatchObject({ second_factor: "recovery_code", recovery_limited: true });
  });

  it("purges an ended session together with its proofs and challenges", async () => {
    await sql`
      UPDATE core.sessions SET revoked_at = now() - interval '2 days', revoked_reason = 'probe'
      WHERE id = ${honest}
    `;
    await sql`SELECT * FROM core.purge_auth_records()`;
    expect(await sql`SELECT 1 FROM core.sessions WHERE id = ${honest}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM core.session_factor_proofs WHERE session_id = ${honest}`).toHaveLength(0);
    // The spent code stays spent: history, not session state.
    expect(await sql`SELECT 1 FROM core.recovery_codes WHERE consumed_by_session_id = ${honest}`).toHaveLength(1);
  });

  it("shows another tenant nothing", async () => {
    const [counts] = await asApp(
      (tx) => tx`
        SELECT (SELECT count(*) FROM core.recovery_codes)::int AS codes,
               (SELECT count(*) FROM core.webauthn_credentials)::int AS passkeys
      `,
      tenants[1],
    );
    expect(counts).toEqual({ codes: 0, passkeys: 0 });
  });
});
