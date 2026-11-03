import type postgres from "postgres";
import { EmailParamsError, maskEmail, renderEmail, type EmailTemplate } from "./messages.js";
import type { EmailTransport } from "./transport.js";

/**
 * Account email delivery — account authentication WP2 (0113 `core.email_outbox`).
 *
 * The API never sends mail. Starting a sign-in, an invitation or an email change queues a row
 * here in the same transaction that issued the code, and this loop sends it. That keeps the
 * request's timing the same whether or not a message is really sent, and keeps the transport key
 * out of the API.
 *
 * **The code exists in plaintext only while the row is pending.** Whatever the outcome — sent,
 * failed, expired — the row is settled with `recipient` and `params` cleared (a CHECK in 0113
 * requires it). A row that outlived its code (`expires_at`) is settled `expired` unsent: a code
 * nobody can use any more is not worth delivering.
 *
 * **Claim, send and settle in one transaction**, as notification delivery does: `FOR UPDATE SKIP
 * LOCKED` holds only while the transaction is open, so two workers never send one row. A crash
 * mid-send leaves the row pending; Resend's idempotency key (the row id) stops the retry from
 * sending it twice.
 *
 * **Bounded retries.** A retryable failure (timeout, network, 429, 5xx) is tried again after
 * `backoffMs · 2^(attempt-1)`, up to `maxAttempts`; anything else fails at once. The person
 * can always ask for a new code.
 *
 * **Logs carry the row id, template, a masked address and a reason code** — never the code,
 * the link, the full address or a provider response.
 */

export interface EmailDeliveryOptions {
  readonly from: string;
  readonly maxAttempts: number;
  readonly backoffMs: number;
}

export interface EmailDeliveryResult {
  readonly handled: boolean;
  readonly sent: number;
  readonly failed: number;
}

interface PendingEmail {
  readonly id: string;
  readonly template: EmailTemplate;
  readonly recipient: string;
  readonly params: unknown;
  readonly attempts: number;
  readonly expired: boolean;
}

export async function deliverEmailOnce(
  sql: postgres.Sql,
  transport: EmailTransport,
  options: EmailDeliveryOptions,
  emit: (record: Record<string, unknown>) => void = () => undefined,
): Promise<EmailDeliveryResult> {
  return sql.begin(async (tx) => {
    const [row] = await tx<PendingEmail[]>`
      SELECT id, template, recipient, params, attempts, expires_at <= now() AS expired
      FROM core.email_outbox
      WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    if (!row) return { handled: false, sent: 0, failed: 0 };

    const settle = (state: "sent" | "failed" | "expired", attempts: number, error: string | null) => tx`
      UPDATE core.email_outbox
      SET state = ${state}, attempts = ${attempts}, last_error = ${error},
          recipient = NULL, params = NULL, next_attempt_at = NULL, settled_at = now()
      WHERE id = ${row.id}
    `;
    const log = { outboxId: row.id, template: row.template, to: maskEmail(row.recipient), transport: transport.kind };

    if (row.expired) {
      await settle("expired", row.attempts, row.attempts > 0 ? "expired_unsent" : null);
      emit({ level: "warn", msg: "email.expired_unsent", ...log });
      return { handled: true, sent: 0, failed: 0 };
    }

    let rendered;
    try {
      rendered = renderEmail(row.template, row.params);
    } catch (error) {
      if (!(error instanceof EmailParamsError)) throw error;
      await settle("failed", row.attempts, "invalid_params");
      emit({ level: "error", msg: "email.failed", reason: "invalid_params", ...log });
      return { handled: true, sent: 0, failed: 1 };
    }

    const attempt = row.attempts + 1;
    const outcome = await transport.send({
      id: row.id,
      template: row.template,
      to: row.recipient,
      from: options.from,
      subject: rendered.subject,
      text: rendered.text,
    }, tx);

    if (outcome.ok) {
      await settle("sent", attempt, null);
      emit({ level: "info", msg: "email.sent", attempt, ...log });
      return { handled: true, sent: 1, failed: 0 };
    }

    if (!outcome.retryable || attempt >= options.maxAttempts) {
      await settle("failed", attempt, outcome.reason);
      emit({ level: "error", msg: "email.failed", reason: outcome.reason, attempt, ...log });
      return { handled: true, sent: 0, failed: 1 };
    }

    const delayMs = options.backoffMs * 2 ** (attempt - 1);
    await tx`
      UPDATE core.email_outbox
      SET attempts = ${attempt}, last_error = ${outcome.reason},
          next_attempt_at = now() + ${delayMs} * interval '1 millisecond'
      WHERE id = ${row.id}
    `;
    emit({ level: "warn", msg: "email.retry_scheduled", reason: outcome.reason, attempt, delayMs, ...log });
    return { handled: true, sent: 0, failed: 1 };
  });
}
