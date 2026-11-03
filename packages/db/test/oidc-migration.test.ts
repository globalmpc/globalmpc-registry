import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const FIRST = "0120_external_identities.sql";
const TARGETS = ["0120_external_identities.sql", "0121_oidc_functions.sql"];
const NEW_TABLES = ["external_identities", "oidc_login_transactions"] as const;

const hash = (byte: string) => `0x${byte.repeat(64)}`;
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const GOOGLE = "https://accounts.google.com";
const REDIRECT = "http://localhost:3000/auth/oidc/google/callback";

/**
 * 0120–0121 — Google and Microsoft sign-in (WP4).
 *
 * Seeds Google and Microsoft sessions under the schema before 0120, which
 * `core.create_subject_session` issued to anyone who asked, migrates forward, and checks: those
 * sessions are gone; the new tables are tenant-isolated and closed to the API role; the API
 * role can no longer mint a session by naming a factor; and even the table owner cannot insert
 * a Google session without a login transaction this same database transaction completed for
 * that subject — not a link, not one completed earlier, not someone else's.
 */
describeDb("migrations 0120–0121: Google and Microsoft sign-in", () => {
  const dbName = `m0120_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenants = [randomUUID(), randomUUID()] as const;
  const subject = randomUUID();
  const other = randomUUID();
  const seeded = [randomUUID(), randomUUID()];

  const asApp = <T extends postgres.Row>(
    body: (tx: postgres.TransactionSql) => postgres.PendingQuery<T[]>,
    tenant: string | null = tenants[0],
  ) =>
    sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_app");
      if (tenant) await tx`SELECT set_config('app.current_tenant', ${tenant}, true)`;
      return [...(await body(tx))];
    }) as Promise<T[]>;

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
      await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`m0120-${i}-${tenant.slice(0, 8)}`}, 'Probe')`;
    }
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${subject}, ${tenants[0]}, 'person', 'Holder')`;
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${other}, ${tenants[0]}, 'person', 'Other')`;
    // Before 0120, any caller could name the factor and get the session.
    await asApp((tx) => tx`SELECT core.create_subject_session(${seeded[0]!}, ${hash("a")}, ${subject}, 'google', NULL, 3600)`);
    await asApp((tx) => tx`SELECT core.create_subject_session(${seeded[1]!}, ${hash("b")}, ${subject}, 'microsoft', NULL, 3600)`);

    const applied = await runMigrations(sql, all.slice(0, index + TARGETS.length));
    expect(applied).toEqual(TARGETS);
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  /** A new person in tenant 0 with a linked Google identity (owner inserts, as a fixture). */
  async function identity(key = `k-${randomUUID()}`) {
    const id = randomUUID();
    const subjectId = randomUUID();
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${subjectId}, ${tenants[0]}, 'person', 'Linked')`;
    await sql`
      INSERT INTO core.external_identities (id, tenant_id, subject_id, provider, issuer, subject_key, linked_via)
      VALUES (${id}, ${tenants[0]}, ${subjectId}, 'google', ${GOOGLE}, ${key}, 'link')
    `;
    return { id, key, subjectId };
  }

  /** A sign-in transaction started and claimed through the functions, ready to complete. */
  async function claimed() {
    const transactionId = randomUUID();
    const state = randomUUID();
    const binding = randomUUID();
    const [started] = await asApp<{ status: string }>((tx) => tx`
      SELECT status FROM core.start_oidc_transaction(
        ${transactionId}, 'google', 'sign_in', ${sha(state)}, ${sha(binding)}, ${sha(randomUUID())},
        ${randomBytes(48)}, ${REDIRECT}, NULL, NULL, NULL, ${randomUUID()}
      )
    `, null);
    expect(started!.status).toBe("started");
    const [claim] = await asApp<{ status: string }>((tx) => tx`
      SELECT status FROM core.claim_oidc_transaction(${sha(state)}, ${sha(binding)}, 'google', NULL)
    `, null);
    expect(claim!.status).toBe("claimed");
    return transactionId;
  }

  it("deletes the Google and Microsoft sessions issued without a provider", async () => {
    expect(await sql`SELECT id FROM core.sessions WHERE id IN ${sql(seeded)}`).toEqual([]);
  });

  it("isolates both tables by tenant, forced, and grants the API role nothing on them", async () => {
    const rls = await sql<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[]>`
      SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'core' AND c.relname IN ${sql(NEW_TABLES as unknown as string[])}
    `;
    expect(rls).toHaveLength(NEW_TABLES.length);
    for (const row of rls) expect(row, row.relname).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    for (const role of ["mpc_app", "mpc_worker"]) {
      for (const table of NEW_TABLES) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
          const [row] = await sql<{ granted: boolean }[]>`
            SELECT has_table_privilege(${role}, ${`core.${table}`}, ${privilege}) AS granted
          `;
          expect(row!.granted, `${role} ${privilege} ${table}`).toBe(false);
        }
      }
    }
  });

  it("no longer lets anyone name a first factor into a session", async () => {
    await expect(
      asApp((tx) => tx`SELECT core.create_subject_session(${randomUUID()}, ${hash("c")}, ${subject}, 'google', NULL, 3600)`),
    ).rejects.toThrow(/permission denied/);
    // Even its owner: the function refuses every first factor now.
    await expect(
      sql`SELECT core.create_subject_session(${randomUUID()}, ${hash("d")}, ${subject}, 'microsoft', NULL, 3600)`,
    ).rejects.toThrow();
    // The internal helpers are not the API role's.
    for (const fn of ["core.insert_oidc_session", "core.oidc_complete", "core.oidc_lock_claimed", "core.lock_external_identity"]) {
      const [row] = await sql<{ granted: boolean }[]>`
        SELECT bool_or(has_function_privilege('mpc_app', p.oid, 'EXECUTE')) AS granted
        FROM pg_proc p WHERE p.oid::regproc::text = ${fn} OR (p.pronamespace = 'core'::regnamespace AND 'core.' || p.proname = ${fn})
      `;
      expect(row!.granted, fn).toBe(false);
    }
  });

  it("refuses a Google session without a transaction, even from the owner", async () => {
    await expect(sql`
      INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, expires_at)
      VALUES (${randomUUID()}, ${hash("e")}, ${tenants[0]}, ${subject}, 'google', now() + interval '1 hour')
    `).rejects.toThrow(/check constraint|violates/);
  });

  it("a completed sign-in makes exactly one session, for its subject, in its transaction", async () => {
    const holder = await identity();
    const transactionId = await claimed();
    const sessionId = randomUUID();
    const [done] = await asApp<{ status: string; subject_id: string; tenant_id: string }>((tx) => tx`
      SELECT * FROM core.complete_oidc_sign_in(${transactionId}, ${GOOGLE}, ${holder.key}, ${sessionId}, ${hash("f")}, 3600)
    `, null);
    expect(done).toMatchObject({ status: "session_created", subject_id: holder.subjectId, tenant_id: tenants[0] });

    // Completing again, or naming the same transaction from a later database transaction, fails.
    await expect(
      asApp((tx) => tx`SELECT * FROM core.complete_oidc_sign_in(${transactionId}, ${GOOGLE}, ${holder.key}, ${randomUUID()}, ${hash("1")}, 3600)`, null),
    ).rejects.toThrow(/OIDC_TRANSACTION_INVALID/);
    await expect(sql`
      INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, oidc_transaction_id, expires_at)
      VALUES (${randomUUID()}, ${hash("2")}, ${tenants[0]}, ${holder.subjectId}, 'google', ${transactionId}, now() + interval '1 hour')
    `).rejects.toThrow(/did not complete/);
  });

  it("a transaction completed in this database transaction backs no other subject's session", async () => {
    const holder = await identity();
    const transactionId = await claimed();
    await expect(sql.begin(async (tx) => {
      await tx`SELECT * FROM core.complete_oidc_sign_in(${transactionId}, ${GOOGLE}, ${holder.key}, ${randomUUID()}, ${hash("3")}, 3600)`;
      await tx`
        INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, oidc_transaction_id, expires_at)
        VALUES (${randomUUID()}, ${hash("4")}, ${tenants[0]}, ${other}, 'google', ${transactionId}, now() + interval '1 hour')
      `;
    })).rejects.toThrow(/did not complete/);
  });

  it("a link transaction never backs a session", async () => {
    // The link's session: a Google sign-in through the functions. The owner then writes a
    // completed link row by hand — exactly what the trigger has to stop.
    const holder = await identity();
    const anchorId = randomUUID();
    const signIn = await claimed();
    await asApp((tx) => tx`
      SELECT * FROM core.complete_oidc_sign_in(${signIn}, ${GOOGLE}, ${holder.key}, ${anchorId}, ${hash("5")}, 3600)
    `, null);
    const anchor = { id: anchorId };
    await expect(sql.begin(async (tx) => {
      const id = randomUUID();
      await tx`
        INSERT INTO core.oidc_login_transactions (
          id, provider, purpose, state_hash, binding_hash, nonce_hash, redirect_uri, tenant_id, subject_id,
          session_id, identity_id, created_at, expires_at, claimed_at, completed_at, completed_txid, outcome
        ) VALUES (
          ${id}, 'google', 'link', ${sha(randomUUID())}, ${sha(randomUUID())}, ${sha(randomUUID())}, ${REDIRECT},
          ${tenants[0]}, ${holder.subjectId}, ${anchor.id}, ${holder.id}, now(), now() + interval '10 minutes', now(), now(),
          pg_current_xact_id(), 'session'
        )
      `;
      await tx`
        INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, oidc_transaction_id, expires_at)
        VALUES (${randomUUID()}, ${hash("6")}, ${tenants[0]}, ${holder.subjectId}, 'google', ${id}, now() + interval '1 hour')
      `;
    })).rejects.toThrow(/did not complete/);
  });

  it("an identity is unique across tenants, and a Microsoft issuer must name a directory", async () => {
    const holder = await identity();
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${randomUUID()}, ${tenants[1]}, 'person', 'B')`;
    const [b] = await sql<{ id: string }[]>`SELECT id FROM core.subjects WHERE tenant_id = ${tenants[1]} LIMIT 1`;
    await expect(sql`
      INSERT INTO core.external_identities (id, tenant_id, subject_id, provider, issuer, subject_key, linked_via)
      VALUES (${randomUUID()}, ${tenants[1]}, ${b!.id}, 'google', ${GOOGLE}, ${holder.key}, 'link')
    `).rejects.toThrow(/duplicate key|unique/);
    // Microsoft: the issuer must name a directory GUID.
    await expect(sql`
      INSERT INTO core.external_identities (id, tenant_id, subject_id, provider, issuer, subject_key, idp_tenant, linked_via)
      VALUES (${randomUUID()}, ${tenants[1]}, ${b!.id}, 'microsoft', 'https://login.microsoftonline.com/common/v2.0',
              ${randomUUID()}, NULL, 'link')
    `).rejects.toThrow(/check constraint|violates/);
  });
});
