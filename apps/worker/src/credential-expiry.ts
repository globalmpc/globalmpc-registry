import type postgres from "postgres";

/**
 * Credential expiry sweep — migration 0051.
 *
 * A credential's expiry date passes without anyone touching the credential, so no trigger sees
 * it. This asks the database once per interval to move the active attestations signed with an
 * expired credential to re-review. The database decides what counts and leaves the credential row
 * alone; running it twice moves nothing new.
 *
 * Rides on the outbox loop for the same reason the document expiry sweep does.
 */

/** Hourly, matching the document sweep. Expiry is a date on a licence, not a live signal. */
export const DEFAULT_CREDENTIAL_SWEEP_MS = 60 * 60 * 1000;

export interface CredentialSweepResult {
  readonly ran: boolean;
  readonly flagged: number;
}

export function createCredentialExpirySweep(
  sql: postgres.Sql,
  intervalMs: number = DEFAULT_CREDENTIAL_SWEEP_MS,
  now: () => number = Date.now,
): () => Promise<CredentialSweepResult> {
  let lastAttempt: number | null = null;

  return async function sweepIfDue(): Promise<CredentialSweepResult> {
    const current = now();
    if (lastAttempt !== null && current - lastAttempt < intervalMs) {
      return { ran: false, flagged: 0 };
    }

    // Counted from the attempt, not the success, so a failing sweep does not retry every cycle.
    lastAttempt = current;
    const [row] = await sql<{ flagged: number }[]>`
      SELECT core.sweep_credential_expiry(now()) AS flagged
    `;
    return { ran: true, flagged: row?.flagged ?? 0 };
  };
}
