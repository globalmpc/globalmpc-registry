import type postgres from "postgres";

/**
 * Document expiry sweep — migration 0045.
 *
 * A validity date passes without anyone touching the document, so no request is there to notice
 * it. This asks the database once per interval to raise impacts for documents past their date and
 * for the documents resting on them. The database decides what counts; running it twice raises
 * nothing new.
 *
 * Rides on the outbox loop instead of a fourth process, for the same reason notification delivery
 * does: each extra process is one more place that can be dead.
 */

/** Hourly. A validity date is a calendar day; checking every second would buy nothing. */
export const DEFAULT_EXPIRY_SWEEP_MS = 60 * 60 * 1000;

export interface ExpirySweepResult {
  readonly ran: boolean;
  readonly flagged: number;
}

export function createExpirySweep(
  sql: postgres.Sql,
  intervalMs: number = DEFAULT_EXPIRY_SWEEP_MS,
  now: () => number = Date.now,
): () => Promise<ExpirySweepResult> {
  let lastAttempt: number | null = null;

  return async function sweepIfDue(): Promise<ExpirySweepResult> {
    const current = now();
    if (lastAttempt !== null && current - lastAttempt < intervalMs) {
      return { ran: false, flagged: 0 };
    }

    // Counted from the attempt, not the success: a failing sweep retries on the next interval
    // instead of every loop cycle, which would flood the log with the same error.
    lastAttempt = current;
    const [row] = await sql<{ flagged: number }[]>`
      SELECT core.sweep_document_expiry(current_date) AS flagged
    `;
    return { ran: true, flagged: row?.flagged ?? 0 };
  };
}
