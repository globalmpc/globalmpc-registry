import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const FIRST = "0112_account_email.sql";
const SESSIONS = "0113_email_challenges_and_invitations.sql";

const hash = () => `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;

/**
 * 0112–0114 — account email, email challenges, invitations and email change (WP2).
 *
 * Migrates up to 0113 with an `email_code` session issued the old way (no challenge), then to the
 * end, and checks what the database itself guarantees: addresses are normalized, unique and on
 * persons only; the application role cannot write one; challenges, mail and rate events are
 * unreadable by it; an invitation lasts exactly 72 hours; mail holds a code only while pending;
 * and an `email_code` session exists only with a challenge consumed in its transaction.
 */
describeDb("migrations 0112–0114: account email", () => {
  const dbName = `m0112_probe_${process.pid}_${Date.now()}`;
  let admin: postgres.Sql;
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const otherTenant = randomUUID();
  const person = randomUUID();
  const service = randomUUID();
  const oldSession = randomUUID();

  const asApp = <T extends postgres.Row[]>(
    body: (tx: postgres.TransactionSql) => postgres.PendingQuery<T>,
    tenantId: string | null = tenant,
  ) =>
    sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_app");
      if (tenantId) await tx`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
      return [...(await body(tx))];
    }) as unknown as Promise<T>;

  beforeAll(async () => {
    admin = postgres(DATABASE_URL!, { onnotice: () => {}, max: 1 });
    await admin.unsafe(`CREATE DATABASE ${dbName}`);
    const url = new URL(DATABASE_URL!);
    url.pathname = `/${dbName}`;
    sql = postgres(url.toString(), { onnotice: () => {}, max: 1 });

    const all = listMigrations();
    const first = all.findIndex((migration) => migration.name === FIRST);
    const sessions = all.findIndex((migration) => migration.name === SESSIONS);
    expect(first).toBeGreaterThan(0);
    await runMigrations(sql, all.slice(0, sessions));

    for (const id of [tenant, otherTenant]) {
      await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${id}, ${`m0112-${id.slice(0, 8)}`}, 'Probe')`;
    }
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${person}, ${tenant}, 'person', 'P')`;
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${service}, ${tenant}, 'service', 'S')`;
    // Issued before 0113 the way WP1 allowed: an email_code session with no challenge behind it.
    await sql`
      INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, expires_at)
      VALUES (${oldSession}, ${hash()}, ${tenant}, ${person}, 'email_code', now() + interval '1 hour')
    `;

    await runMigrations(sql);
  }, 180_000);

  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin?.end();
  });

  it("ends email_code sessions that no challenge stands behind", async () => {
    expect(await sql`SELECT 1 FROM core.sessions WHERE id = ${oldSession}`).toHaveLength(0);
  });

  it("normalizes addresses and refuses what is not one address", async () => {
    const [row] = await sql<{ email: string }[]>`SELECT core.normalize_email('  Mixed.Case@Example.COM ') AS email`;
    expect(row!.email).toBe("mixed.case@example.com");
    for (const bad of ["no-at", "a@@example.com", "a@b@example.com", "a@localhost", "a b@example.com", "a@example..com", `${"x".repeat(250)}@example.com`]) {
      await expect(sql`SELECT core.normalize_email(${bad})`, bad).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("keeps an address normalized, unique across tenants, and on persons only", async () => {
    await expect(sql`UPDATE core.subjects SET email = 'Upper@Example.com' WHERE id = ${person}`).rejects.toMatchObject({ code: "23514" });
    await sql`UPDATE core.subjects SET email = 'p@example.com' WHERE id = ${person}`;
    await expect(
      sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name, email) VALUES (${randomUUID()}, ${otherTenant}, 'person', 'Q', 'p@example.com')`,
    ).rejects.toMatchObject({ code: "23505" });
    await expect(sql`UPDATE core.subjects SET email = 's@example.com' WHERE id = ${service}`).rejects.toMatchObject({ code: "23514" });
  });

  it("does not let the application role write an address or read the code tables", async () => {
    await expect(asApp((tx) => tx`UPDATE core.subjects SET email = 'x@example.com' WHERE id = ${person}`)).rejects.toThrow(/permission denied/);
    await expect(
      asApp((tx) => tx`INSERT INTO core.subjects (id, tenant_id, kind, display_name, email) VALUES (${randomUUID()}, ${tenant}, 'person', 'X', 'x@example.com')`),
    ).rejects.toThrow(/permission denied/);
    // The columns it still writes.
    await asApp((tx) => tx`UPDATE core.subjects SET display_name = 'Renamed' WHERE id = ${person}`);

    for (const table of ["email_challenges", "email_outbox", "email_test_sink", "auth_rate_events"]) {
      await expect(asApp((tx) => tx.unsafe(`SELECT 1 FROM core.${table}`)), table).rejects.toThrow(/permission denied/);
    }
    // It reads invitations and email changes of its own tenant only, and writes neither.
    await expect(asApp((tx) => tx`DELETE FROM core.invitations`)).rejects.toThrow(/permission denied/);
    await expect(asApp((tx) => tx`DELETE FROM core.email_change_requests`)).rejects.toThrow(/permission denied/);

    // Internal helpers are not callable by it; the lookup by address is not either.
    await expect(asApp((tx) => tx`SELECT core.find_person_by_email('p@example.com')`)).rejects.toThrow(/permission denied/);
    await expect(asApp((tx) => tx`SELECT * FROM core.purge_email_auth_records()`)).rejects.toThrow(/permission denied/);
  });

  it("holds an invitation to exactly 72 hours", async () => {
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${randomUUID()}, ${tenant}, 'Probe Org', 'MNG') RETURNING id
    `;
    const insert = (lifetime: string) => sql`
      INSERT INTO core.invitations (id, tenant_id, organization_id, email, token_hash, invited_by_subject_id, state, created_at, expires_at)
      VALUES (${randomUUID()}, ${tenant}, ${org!.id}, ${`i-${randomUUID().slice(0, 6)}@example.com`}, ${hash()}, ${person}, 'pending', now(), now() + ${lifetime}::interval)
    `;
    await expect(insert("73 hours")).rejects.toMatchObject({ code: "23514" });
    await insert("72 hours");
  });

  it("keeps a code in mail only while it is pending", async () => {
    await expect(sql`
      INSERT INTO core.email_outbox (id, template, recipient, params, state, settled_at, expires_at)
      VALUES (${randomUUID()}, 'sign_in_code', 'p@example.com', '{"code":"12345678"}', 'sent', now(), now() + interval '10 minutes')
    `).rejects.toMatchObject({ code: "23514" });
    await expect(sql`
      INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at, last_error)
      VALUES (${randomUUID()}, 'sign_in_code', 'p@example.com', '{}', 'pending', now() + interval '10 minutes', 'Bad Request: p@example.com')
    `).rejects.toMatchObject({ code: "23514" });
  });

  it("issues an email_code session only with a challenge consumed in the same transaction", async () => {
    // Not through the general session function.
    await expect(
      asApp((tx) => tx`SELECT core.create_subject_session(${randomUUID()}, ${hash()}, ${person}, 'email_code', NULL, 3600)`),
    ).rejects.toThrow();
    // Not by a row without a challenge, even as the migration role.
    await expect(sql`
      INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, expires_at)
      VALUES (${randomUUID()}, ${hash()}, ${tenant}, ${person}, 'email_code', now() + interval '1 hour')
    `).rejects.toMatchObject({ code: "23514" });

    // Through the code path: start, then verify with the same HMAC.
    const hmac = Buffer.alloc(32, 7);
    const [started] = await asApp<{ status: string }[]>((tx) => tx`
      SELECT status FROM core.start_email_challenge(
        'sign_in', 'p@example.com', NULL, ${randomUUID()}, ${hmac}, '12345678', 'ek', 'ik'
      )
    `, null);
    expect(started!.status).toBe("issued");
    const [verified] = await asApp<{ status: string }[]>((tx) => tx`
      SELECT status FROM core.verify_sign_in_code('p@example.com', ${hmac}, 'ek', 'ik', ${randomUUID()}, ${hash()}, 3600)
    `, null);
    expect(verified!.status).toBe("session_created");

    // A challenge already consumed cannot be attached to another session later.
    const [consumed] = await sql<{ id: string }[]>`
      SELECT id FROM core.email_challenges WHERE consumed_txid IS NOT NULL LIMIT 1
    `;
    await expect(sql`
      INSERT INTO core.sessions (id, token_hash, tenant_id, subject_id, first_factor, expires_at, email_challenge_id)
      VALUES (${randomUUID()}, ${hash()}, ${tenant}, ${person}, 'email_code', now() + interval '1 hour', ${consumed!.id})
    `).rejects.toThrow();
  });

  it("lets the worker settle mail and purge, and nothing more", async () => {
    const asWorker = (body: (tx: postgres.TransactionSql) => postgres.PendingQuery<postgres.Row[]>) =>
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE mpc_worker");
        return [...(await body(tx))];
      });
    await asWorker((tx) => tx`SELECT * FROM core.purge_email_auth_records()`);
    await asWorker((tx) => tx`SELECT id FROM core.email_outbox LIMIT 1`);
    await expect(asWorker((tx) => tx`SELECT 1 FROM core.email_challenges`)).rejects.toThrow(/permission denied/);
    await expect(asWorker((tx) => tx`DELETE FROM core.email_outbox`)).rejects.toThrow(/permission denied/);
  });
});
