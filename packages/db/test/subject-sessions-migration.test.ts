import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TARGET = "0108_subject_sessions.sql";

const wallet = (byte: string) => `0x${byte.repeat(20)}`;
const hash = (byte: string) => `0x${byte.repeat(32)}`;

type Level = "wallet_only" | "identity_bound" | "high_assurance";

/**
 * Subjects and wallets in two tenants, under the schema before 0108:
 *
 * - `strong`: an active wallet_only and an active high_assurance wallet → high_assurance;
 * - `cut`: a disabled high_assurance and an active identity_bound wallet → identity_bound (a
 *   disabled wallet resolved to no subject, so its level was never reachable);
 * - `gone`: only a disabled wallet → wallet_only;
 * - `none`: no wallet at all → wallet_only;
 * - `other`: tenant B, an active identity_bound wallet → identity_bound.
 */
async function seed(sql: postgres.Sql, tenants: readonly [string, string]) {
  const subjects = {
    strong: randomUUID(),
    cut: randomUUID(),
    gone: randomUUID(),
    none: randomUUID(),
    other: randomUUID(),
  };
  for (const [i, tenant] of tenants.entries()) {
    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0108-${i}-${tenant.slice(0, 8)}`}, 'Probe')`;
  }
  for (const [name, id] of Object.entries(subjects)) {
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${id}, ${name === "other" ? tenants[1] : tenants[0]}, 'person', ${name})
    `;
  }
  const bind = async (tenant: string, subject: string, address: string, level: Level, disabled: boolean) => {
    await sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at, disabled_at
      ) VALUES (
        ${randomUUID()}, ${tenant}, ${subject}, ${address}, 31337, ${level}, now() - interval '1 day',
        ${disabled ? sql`now()` : null}
      )
    `;
  };
  await bind(tenants[0], subjects.strong, wallet("a1"), "wallet_only", false);
  await bind(tenants[0], subjects.strong, wallet("a2"), "high_assurance", false);
  await bind(tenants[0], subjects.cut, wallet("b1"), "high_assurance", true);
  await bind(tenants[0], subjects.cut, wallet("b2"), "identity_bound", false);
  await bind(tenants[0], subjects.gone, wallet("c1"), "high_assurance", true);
  await bind(tenants[1], subjects.other, wallet("d1"), "identity_bound", false);
  // A session issued before the cut-over.
  await sql`
    INSERT INTO core.sessions (id, token_hash, wallet_address, chain_id, expires_at)
    VALUES (${randomUUID()}, ${hash("e1")}, ${wallet("a2")}, 31337, now() + interval '1 hour')
  `;
  return subjects;
}

const EXPECTED: Record<string, Level> = {
  strong: "high_assurance",
  cut: "identity_bound",
  gone: "wallet_only",
  none: "wallet_only",
  other: "identity_bound",
};

async function levels(sql: postgres.Sql, subjects: Record<string, string>) {
  const rows = await sql<{ id: string; assurance_level: Level }[]>`
    SELECT id, assurance_level FROM core.subjects WHERE id IN ${sql(Object.values(subjects))}
  `;
  const byId = new Map(rows.map((row) => [row.id, row.assurance_level]));
  return Object.fromEntries(Object.entries(subjects).map(([name, id]) => [name, byId.get(id)]));
}

/**
 * 0108 — sessions are keyed by subject and identity assurance moves to the subject.
 *
 * Seeds the preceding schema, migrates forward, and checks: the backfill gives each subject the
 * level a session of it could reach before; every pre-existing session ends; and the sessions
 * table is reachable by the API only through its functions.
 */
describeDb("migration 0108: subject sessions", () => {
  const dbName = `m0108_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenants = [randomUUID(), randomUUID()] as const;
  let subjects: Awaited<ReturnType<typeof seed>>;

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
    subjects = await seed(sql, tenants);
    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("gives every subject the highest level among its active wallets, across tenants", async () => {
    expect(await levels(sql, subjects)).toEqual(EXPECTED);
  });

  it("ends every session issued before the cut-over", async () => {
    expect(await sql`SELECT 1 FROM core.sessions`).toHaveLength(0);
  });

  it("leaves no governance wallet designated", async () => {
    expect(await sql`SELECT 1 FROM core.subjects WHERE governance_wallet_id IS NOT NULL`).toHaveLength(0);
  });

  it("issues sessions only through its functions, to person subjects only", async () => {
    const asApp = (
      body: (tx: postgres.TransactionSql) => postgres.PendingQuery<postgres.Row[]>,
      tenant: string | null = tenants[0],
    ) =>
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE mpc_app");
        if (tenant) await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
        return [...(await body(tx))];
      }) as Promise<postgres.Row[]>;

    await expect(asApp((tx) => tx`SELECT 1 FROM core.sessions`)).rejects.toThrow(/permission denied/);

    const [issued] = await asApp((tx) => tx`
      SELECT core.create_subject_session(
        ${randomUUID()}, ${hash("f1")}, ${subjects.strong}, 'google', 'passkey', 3600
      ) AS expires_at
    `);
    expect(issued!.expires_at.getTime()).toBeGreaterThan(Date.now());
    const [resolved] = await asApp((tx) => tx`
      SELECT * FROM core.resolve_session(${hash("f1")})
    `);
    expect(resolved).toMatchObject({ subject_id: subjects.strong, assurance_level: "high_assurance" });

    // A subject is issued a session only inside its own tenant's context: not from another
    // tenant's, and not from none.
    for (const context of [tenants[1], null]) {
      await expect(
        asApp(
          (tx) => tx`
            SELECT core.create_subject_session(
              ${randomUUID()}, ${hash("x1")}, ${subjects.strong}, 'google', 'passkey', 3600
            )
          `,
          context,
        ),
      ).rejects.toThrow(/not in the current tenant/);
    }

    // Revoking from another tenant's context ends none of the subject's sessions.
    const [crossRevoke] = await asApp(
      (tx) => tx`SELECT core.revoke_subject_sessions(${subjects.strong}, 'probe') AS revoked`,
      tenants[1],
    );
    expect(crossRevoke!.revoked).toBe(0);
    expect(await asApp((tx) => tx`SELECT * FROM core.resolve_session(${hash("f1")})`)).toHaveLength(1);

    // More than the 8-hour absolute lifetime is refused.
    await expect(
      asApp((tx) => tx`
        SELECT * FROM core.create_subject_session(
          ${randomUUID()}, ${hash("f2")}, ${subjects.strong}, 'google', NULL, 8 * 3600 + 1
        )
      `),
    ).rejects.toThrow();

    // A legacy wallet session resolves to the wallet's subject, and is refused once it is disabled.
    const [legacy] = await asApp((tx) => tx`
      SELECT * FROM core.create_wallet_session(${randomUUID()}, ${hash("f3")}, ${wallet("b2")}, 31337, 3600)
    `);
    expect(legacy!.subject_id).toBe(subjects.cut);
    await sql`UPDATE core.wallet_identities SET disabled_at = now() WHERE wallet_address = ${wallet("b2")}`;
    expect(await asApp((tx) => tx`SELECT * FROM core.resolve_session(${hash("f3")})`)).toHaveLength(0);

    // The worker purges; the API cannot.
    await expect(asApp((tx) => tx`SELECT * FROM core.purge_auth_records()`)).rejects.toThrow(/permission denied/);
  });

  it("holds a session's factors to what can be proven", async () => {
    const insert = (columns: Record<string, unknown>) =>
      sql`
        INSERT INTO core.sessions ${sql({
          id: randomUUID(),
          token_hash: hash(randomUUID().replace(/-/g, "").slice(0, 2)),
          expires_at: sql`now() + interval '1 hour'` as never,
          ...columns,
        } as never)}
      `;
    // An account factor without a subject.
    await expect(insert({ first_factor: "email_code" })).rejects.toMatchObject({ code: "23514" });
    // A second factor on a legacy wallet session.
    await expect(
      insert({ first_factor: "siwe_legacy", wallet_address: wallet("a1"), chain_id: 31337, second_factor: "totp", second_factor_at: new Date() }),
    ).rejects.toMatchObject({ code: "23514" });
    // A wallet on an account session.
    await expect(
      insert({ tenant_id: tenants[0], subject_id: subjects.strong, first_factor: "google", wallet_address: wallet("a1"), chain_id: 31337 }),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

/**
 * 0108's backfill run by a role that owns the tables but neither is a superuser nor has
 * BYPASSRLS. Subjects and wallets force row-level security on their owner, so a plain read sees
 * no row and every subject would stay `wallet_only` without an error — every reviewer, approver
 * and operator losing their roles at once.
 */
describeDb("migration 0108: backfill as an owner that does not bypass row-level security", () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const dbName = `m0108_owner_probe_${suffix}`;
  const owner = `m0108_owner_${suffix}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenants = [randomUUID(), randomUUID()] as const;
  let subjects: Awaited<ReturnType<typeof seed>>;

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    await admin.unsafe(`CREATE ROLE ${owner} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

    const all = listMigrations();
    const index = all.findIndex((migration) => migration.name === TARGET);
    await runMigrations(sql, all.slice(0, index));
    subjects = await seed(sql, tenants);

    await sql.unsafe(`
      ALTER TABLE core.subjects OWNER TO ${owner};
      ALTER TABLE core.wallet_identities OWNER TO ${owner};
      ALTER TABLE core.sessions OWNER TO ${owner};
      ALTER TABLE core.schema_migrations OWNER TO ${owner};
      ALTER FUNCTION core.create_session(UUID, TEXT, TEXT, INTEGER, INTEGER) OWNER TO ${owner};
      ALTER FUNCTION core.resolve_session_token(TEXT) OWNER TO ${owner};
      ALTER FUNCTION core.resolve_wallet_session(TEXT, INTEGER) OWNER TO ${owner};
      ALTER FUNCTION core.revoke_session(TEXT) OWNER TO ${owner};
      GRANT REFERENCES ON core.tenants TO ${owner};
      GRANT CREATE ON DATABASE ${dbName} TO ${owner};
      GRANT USAGE, CREATE ON SCHEMA core TO ${owner};
    `);
    await sql.unsafe(`SET ROLE ${owner}`);
    const [who] = await sql<{ bypasses: boolean }[]>`
      SELECT rolsuper OR rolbypassrls AS bypasses FROM pg_roles WHERE rolname = current_user
    `;
    expect(who).toEqual({ bypasses: false });
    // Precondition: as this role, without a tenant, neither table shows a row.
    expect(await sql`SELECT 1 FROM core.subjects UNION ALL SELECT 1 FROM core.wallet_identities`).toHaveLength(0);

    expect(await runMigrations(sql, all.slice(0, index + 1))).toEqual([TARGET]);
    await sql`RESET ROLE`;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.unsafe(`DROP ROLE IF EXISTS ${owner}`);
    await admin?.end();
  });

  it("backfills every tenant's subjects and puts row-level security back", async () => {
    expect(await levels(sql, subjects)).toEqual(EXPECTED);
    const [forced] = await sql<{ f: boolean }[]>`
      SELECT bool_and(relforcerowsecurity) AS f FROM pg_class
      WHERE oid IN ('core.subjects'::regclass, 'core.wallet_identities'::regclass, 'core.sessions'::regclass)
    `;
    expect(forced!.f).toBe(true);
  });
});
