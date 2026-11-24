import type postgres from "postgres";

/**
 * Connection parameters every runtime client opens with.
 *
 * **"Today" is the UTC day.** Document expiry is judged against `current_date` — the expiry sweep,
 * the document graph, detection after an upload — and `current_date` follows the session time
 * zone. Left unset, that is whatever the server or database default happens to be, so the day a
 * document turns expired would move with the deployment. A project in UTC+8 therefore sees a
 * document expire at 08:00 local time; that is the price of one boundary for every jurisdiction.
 * The anchor gas cap counts its day in UTC for the same reason (`anchor-submitter.ts`).
 */
export const SESSION_CONNECTION = { TimeZone: "UTC" } as const;

/**
 * Actor session context.
 *
 * 02 §2.5: every query runs inside the caller's scope. `subjectId` must come from a resolved,
 * live session or service token, never from request input. Row-level security then admits only
 * what that subject's live role bindings reach (migrations 0168, 0169); a query that does not go
 * through this function sees no rows. The default being "nothing" rather than "allow everything"
 * is intentional.
 */
export interface ActorContext {
  readonly subjectId: string;
}

export async function withActor<T>(
  sql: postgres.Sql,
  context: ActorContext,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.actor_subject_id', ${context.subjectId}, true)`;
    return work(tx);
  }) as Promise<T>;
}
