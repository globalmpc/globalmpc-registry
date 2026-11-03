import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { createAuthPurgeSweep } from "../src/auth-purge.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Auth record purge — migrations 0108 and 0125.
 *
 * Held here: a session is deleted a day after it expired or was revoked and not before; a live
 * session is never touched; the worker role may run it; and the sweep runs once per interval.
 * SIWE nonces went with wallet sign-in (0125): the purge reports sessions only.
 */
describeDb("auth record purge", () => {
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const subject = randomUUID();
  const identity = randomUUID();

  beforeAll(async () => {
    sql = await connectIsolated("auth_purge");
    // Everything either purge sweeps starts empty: sessions (0108), the email-code
    // records (0113), login transactions and identities (0120), and — by CASCADE, since they
    // belong to their session — second-factor proofs, WebAuthn challenges (0115) and wallet
    // binding challenges (0122), named here so the list says what it empties.
    await sql`
      TRUNCATE core.sessions, core.email_outbox, core.email_challenges,
        core.auth_rate_events, core.email_test_sink, core.oidc_login_transactions, core.external_identities,
        core.wallet_binding_challenges CASCADE
    `;
    await sql`INSERT INTO core.tenants (id, slug, display_name) VALUES (${tenant}, ${`t-${tenant.slice(0, 8)}`}, 'Purge tenant')`;
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name) VALUES (${subject}, ${tenant}, 'person', 'Signer')`;
    await sql`
      INSERT INTO core.external_identities (id, tenant_id, subject_id, provider, issuer, subject_key, linked_via)
      VALUES (${identity}, ${tenant}, ${subject}, 'google', 'https://accounts.google.com', ${`purge-${subject}`}, 'link')
    `;
  });

  afterAll(async () => {
    await sql.end();
  });

  const hash = () => `0x${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "")}`;

  /**
   * A login transaction `createdAgo` ago, completed as a sign-in in this database transaction —
   * the only way a Google session can exist (0120). `tx` is the transaction the session is
   * inserted in.
   */
  async function completedSignIn(tx: postgres.TransactionSql, createdAgo: string): Promise<string> {
    const id = randomUUID();
    await tx`
      INSERT INTO core.oidc_login_transactions (
        id, provider, purpose, state_hash, binding_hash, nonce_hash, redirect_uri, tenant_id, subject_id,
        identity_id, created_at, expires_at, claimed_at, completed_at, completed_txid, outcome
      ) VALUES (
        ${id}, 'google', 'sign_in', ${hash().slice(2)}, ${hash().slice(2)}, ${hash().slice(2)},
        'http://localhost:3000/auth/oidc/google/callback', ${tenant}, ${subject}, ${identity},
        now() - ${createdAgo}::interval, now() - ${createdAgo}::interval + interval '10 minutes',
        now() - ${createdAgo}::interval, now() - ${createdAgo}::interval, pg_current_xact_id(), 'session'
      )
    `;
    return id;
  }

  /** A session issued two days ago (so it may have ended up to that long ago) that ended `endedAgo` ago, by expiry or revocation. */
  async function session(how: "expired" | "revoked" | "live", endedAgo: string): Promise<string> {
    const id = randomUUID();
    await sql.begin(async (tx) => {
      const transaction = await completedSignIn(tx, "2 days");
      await tx`
        INSERT INTO core.sessions (
          id, token_hash, tenant_id, subject_id, first_factor, oidc_transaction_id, issued_at, expires_at,
          revoked_at, revoked_reason
        ) VALUES (
          ${id}, ${hash()}, ${tenant}, ${subject}, 'google', ${transaction},
          now() - interval '2 days',
          ${how === "expired" ? tx`now() - ${endedAgo}::interval` : tx`now() + interval '1 hour'`},
          ${how === "revoked" ? tx`now() - ${endedAgo}::interval` : null},
          ${how === "revoked" ? "logout" : null}
        )
      `;
    });
    return id;
  }

  it("deletes what ended over a day ago, and keeps the rest", async () => {
    const old = [await session("expired", "25 hours"), await session("revoked", "25 hours")];
    const recent = [await session("expired", "23 hours"), await session("revoked", "1 hour"), await session("live", "0")];

    // As the worker connects.
    const [purged] = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_worker");
      return tx<{ purged_sessions: number }[]>`
        SELECT * FROM core.purge_auth_records()
      `;
    });
    expect(purged).toEqual({ purged_sessions: 2 });

    const sessions = (await sql<{ id: string }[]>`SELECT id FROM core.sessions`).map((row) => row.id);
    expect(sessions.sort()).toEqual([...recent].sort());
    for (const id of old) expect(sessions).not.toContain(id);
    expect(await sql`SELECT to_regclass('core.siwe_nonces') AS t`).toEqual([{ t: null }]);
  });

  it("takes a purged session's second-factor proof and WebAuthn challenges with it (0115)", async () => {
    const id = await session("revoked", "25 hours");
    const code = randomUUID();
    const proof = randomUUID();
    await sql`
      INSERT INTO core.recovery_codes (id, tenant_id, subject_id, set_id, code_hash, consumed_at, consumed_by_session_id)
      VALUES (${code}, ${tenant}, ${subject}, ${randomUUID()}, ${"c".repeat(64)}, now() - interval '2 days', ${id})
    `;
    await sql`
      INSERT INTO core.session_factor_proofs (id, tenant_id, subject_id, session_id, factor, recovery_code_id)
      VALUES (${proof}, ${tenant}, ${subject}, ${id}, 'recovery_code', ${code})
    `;
    await sql`
      UPDATE core.sessions SET second_factor = 'recovery_code', second_factor_at = issued_at,
        second_factor_proof_id = ${proof}, recovery_limited = true
      WHERE id = ${id}
    `;
    await sql`
      INSERT INTO core.webauthn_challenges (id, tenant_id, subject_id, session_id, purpose, challenge, created_at, expires_at)
      VALUES (${randomUUID()}, ${tenant}, ${subject}, ${id}, 'authentication', ${"A".repeat(43)},
              now() - interval '2 days', now() - interval '2 days' + interval '5 minutes')
    `;

    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_worker");
      await tx`SELECT * FROM core.purge_auth_records()`;
    });
    expect(await sql`SELECT 1 FROM core.sessions WHERE id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM core.session_factor_proofs WHERE session_id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM core.webauthn_challenges WHERE session_id = ${id}`).toHaveLength(0);
    // The spent code is history, not session state: it stays spent.
    expect(await sql`SELECT consumed_at FROM core.recovery_codes WHERE id = ${code}`).toHaveLength(1);
  });

  /**
   * A binding challenge belongs to the session that asked for it (0122): it lives at most five
   * minutes, and spent or not it goes when the session is purged. The wallet it bound stays — a
   * binding is not session state.
   */
  it("takes a purged session's wallet binding challenges with it, and keeps the wallet (0122)", async () => {
    const id = await session("revoked", "25 hours");
    const kept = await session("live", "0");
    const wallet = randomUUID();
    const address = `0x${randomUUID().replace(/-/g, "").slice(0, 20)}${"0".repeat(20)}`;
    await sql`
      INSERT INTO core.wallet_identities (id, tenant_id, subject_id, wallet_address, chain_id, bound_at, bound_via)
      VALUES (${wallet}, ${tenant}, ${subject}, ${address}, 31337, now() - interval '2 days', 'proof')
    `;
    const challenge = (session: string, spent: boolean) => sql`
      INSERT INTO core.wallet_binding_challenges (
        id, tenant_id, subject_id, session_id, wallet_address, chain_id, nonce, issued_at, expires_at,
        consumed_at, wallet_identity_id
      ) VALUES (
        ${randomUUID()}, ${tenant}, ${subject}, ${session}, ${address}, 31337, ${hash()},
        now() - interval '2 days', now() - interval '2 days' + interval '5 minutes',
        ${spent ? sql`now() - interval '2 days'` : null}, ${spent ? wallet : null}
      )
    `;
    await challenge(id, true);
    await challenge(id, false);
    await challenge(kept, false);

    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_worker");
      await tx`SELECT * FROM core.purge_auth_records()`;
    });
    expect(await sql`SELECT 1 FROM core.wallet_binding_challenges WHERE session_id = ${id}`).toHaveLength(0);
    expect(await sql`SELECT 1 FROM core.wallet_binding_challenges WHERE session_id = ${kept}`).toHaveLength(1);
    expect(await sql`SELECT 1 FROM core.wallet_identities WHERE id = ${wallet}`).toHaveLength(1);
  });

  it("deletes login transactions a day old that back no session, and keeps the rest (0121)", async () => {
    const stale = await sql.begin((tx) => completedSignIn(tx, "25 hours"));
    const recent = await sql.begin((tx) => completedSignIn(tx, "23 hours"));
    const backing = await session("live", "0");
    const [backed] = await sql<{ oidc_transaction_id: string }[]>`SELECT oidc_transaction_id FROM core.sessions WHERE id = ${backing}`;

    const [purged] = await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL ROLE mpc_worker");
      return tx<{ purge_oidc_records: number }[]>`SELECT core.purge_oidc_records()`;
    });
    expect(purged!.purge_oidc_records).toBeGreaterThanOrEqual(1);
    const left = (await sql<{ id: string }[]>`SELECT id FROM core.oidc_login_transactions`).map((row) => row.id);
    expect(left).not.toContain(stale);
    expect(left).toContain(recent);
    // Two days old, but a live session names it.
    expect(left).toContain(backed!.oidc_transaction_id);
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE mpc_app");
        await tx`SELECT core.purge_oidc_records()`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("is not callable by the API role", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE mpc_app");
        await tx`SELECT * FROM core.purge_auth_records()`;
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("takes no cut-off from the caller, so a future time cannot purge live records", async () => {
    const live = await session("live", "0");
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE mpc_worker");
        await tx`SELECT * FROM core.purge_auth_records(now() + interval '30 days')`;
      }),
    ).rejects.toThrow(/does not exist/);
    expect(await sql`SELECT 1 FROM core.sessions WHERE id = ${live}`).toHaveLength(1);
  });

  it("runs once per interval and reports what it removed", async () => {
    let clock = 1_000_000;
    const purge = createAuthPurgeSweep(sql, 60_000, () => clock);
    await session("expired", "36 hours");

    // The session goes first, so the login transaction behind it — two days old — goes in the
    // same pass.
    expect(await purge()).toEqual({ ran: true, purgedSessions: 1, purgedEmailChallenges: 0, purgedEmailMail: 0, purgedRateEvents: 0, purgedOidcTransactions: 1 });
    clock += 30_000;
    expect(await purge()).toEqual({ ran: false, purgedSessions: 0, purgedEmailChallenges: 0, purgedEmailMail: 0, purgedRateEvents: 0, purgedOidcTransactions: 0 });
    clock += 30_000;
    expect(await purge()).toEqual({ ran: true, purgedSessions: 0, purgedEmailChallenges: 0, purgedEmailMail: 0, purgedRateEvents: 0, purgedOidcTransactions: 0 });
  });
});
