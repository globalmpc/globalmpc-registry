import type postgres from "postgres";

/**
 * Auth record purge — migrations 0108 and 0125.
 *
 * Expired or revoked sessions can never be used again, but nothing deletes them on its own. Once
 * per interval this asks the database to remove them (`core.purge_auth_records`) a day after they
 * ended. They are not history — the audit trail records who signed in and out — and keeping them
 * only grows the table every lookup reads. (SIWE nonces went with wallet sign-in in 0125.)
 *
 * The same pass runs `core.purge_email_auth_records` (0114): pending mail whose code expired is
 * settled `expired` with its address and code cleared, settled mail and email challenges older
 * than a day are deleted, and so are rate-limit events and test-sink rows past their day.
 *
 * And `core.purge_oidc_records` (0121): Google / Microsoft login transactions a day old that no
 * session names — finished, refused or abandoned, their secrets already gone at the claim.
 *
 * Wallet binding challenges (0122) need no pass of their own: each belongs to its session
 * (`ON DELETE CASCADE`) and lives five minutes, so it goes when the session is purged.
 *
 * Rides on the outbox loop like the expiry sweeps; running it twice deletes nothing new.
 */

/** Hourly. A session that ended lingers at most a day plus this before it is deleted. */
export const DEFAULT_AUTH_PURGE_MS = 60 * 60 * 1000;

export interface AuthPurgeResult {
  readonly ran: boolean;
  readonly purgedSessions: number;
  readonly purgedEmailChallenges: number;
  readonly purgedEmailMail: number;
  readonly purgedRateEvents: number;
  readonly purgedOidcTransactions: number;
}

const NOTHING = {
  purgedSessions: 0,
  purgedEmailChallenges: 0,
  purgedEmailMail: 0,
  purgedRateEvents: 0,
  purgedOidcTransactions: 0,
} as const;

export function createAuthPurgeSweep(
  sql: postgres.Sql,
  intervalMs: number = DEFAULT_AUTH_PURGE_MS,
  now: () => number = Date.now,
): () => Promise<AuthPurgeResult> {
  let lastAttempt: number | null = null;

  return async function purgeIfDue(): Promise<AuthPurgeResult> {
    const current = now();
    if (lastAttempt !== null && current - lastAttempt < intervalMs) {
      return { ran: false, ...NOTHING };
    }

    // Counted from the attempt, not the success, so a failing purge does not retry every cycle.
    lastAttempt = current;
    const [row] = await sql<{ purged_sessions: number }[]>`
      SELECT purged_sessions FROM core.purge_auth_records()
    `;
    const [email] = await sql<
      { purged_challenges: number; purged_mail: number; purged_rate_events: number }[]
    >`
      SELECT purged_challenges, purged_mail, purged_rate_events FROM core.purge_email_auth_records()
    `;
    const [oidc] = await sql<{ purged: number }[]>`SELECT core.purge_oidc_records() AS purged`;
    return {
      ran: true,
      purgedSessions: row?.purged_sessions ?? 0,
      purgedEmailChallenges: email?.purged_challenges ?? 0,
      purgedEmailMail: email?.purged_mail ?? 0,
      purgedRateEvents: email?.purged_rate_events ?? 0,
      purgedOidcTransactions: oidc?.purged ?? 0,
    };
  };
}
