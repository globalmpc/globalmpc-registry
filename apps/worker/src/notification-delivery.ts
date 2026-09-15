import { createHmac } from "node:crypto";
import type postgres from "postgres";
import {
  assertEndpointReachable,
  dnsResolver,
  EndpointNotAllowedError,
  isAllowedWebhookSecretReference,
  pinnedFetch,
  ResponseTooLargeError,
  type HostResolver,
  type PinnedFetch,
} from "@mpc/config";

/**
 * Notification webhook delivery.
 *
 * In-app notifications are visible only when someone opens the app. When an urgent one — a public
 * record withdrawal — arrives late, citations continue in the meantime. This module pushes it to
 * the endpoint the tenant designated.
 *
 * **Why webhook, not email**: storing an email address means this system holds personal data,
 * the class uploads currently reject with 422 (OD-18). A receiving URL belongs to the tenant,
 * not to a person.
 *
 * **Signed.** Without a signature anyone who knows the URL can forge a notification, and a
 * notification is a signal that makes people act. The receiver recomputes the HMAC with the
 * same secret and compares.
 *
 * **The body carries what the in-app notification carries.** Summary and link only — no
 * projection, no evidence. The endpoint is a system we do not control.
 *
 * **The receiver is judged like a source endpoint (W-087).** The URL is set by a tenant operator
 * and called from inside our network, so it is resolved right before sending, refused if any
 * address is private or reserved, and the connection is pinned to the checked addresses with no
 * redirects followed. What is stored about a failure is a category — the admin screen shows it,
 * and a status code or connection error per URL would turn this path into a scanner.
 */

export interface DeliverableNotification {
  readonly notification_id: string;
  readonly sink_id: string;
  readonly tenant_id: string;
  readonly url: string;
  readonly secret_reference: string;
  readonly kind: string;
  readonly summary: string;
  readonly link: string;
  readonly occurred_at: Date;
  readonly attempts: number;
}

/**
 * What a failed delivery records. Mirrors the CHECK in 0044 and the API contract enum.
 *
 * Deliberately coarse. "No such name" and "private name" are both `rejected_destination` so the
 * category does not say which internal names exist.
 */
export const DELIVERY_ERROR_CATEGORIES = [
  "rejected_destination",
  "secret_unavailable",
  "http_error",
  "timeout",
  "network_error",
  "response_too_large",
] as const;

export type DeliveryErrorCategory = (typeof DELIVERY_ERROR_CATEGORIES)[number];

/** Response cap. A webhook reply is not read; anything large is not a receiver we know. */
export const WEBHOOK_MAX_RESPONSE_BYTES = 64 * 1024;

export interface DeliveryOptions {
  /** Attempt cap. Past it the delivery settles as `failed` — no retrying forever. */
  readonly maxAttempts: number;
  /** First retry interval (ms). Doubles on each attempt. */
  readonly backoffMs: number;
  /** Resolves a reference to the actual secret. Injected by the worker — this module reads no files. */
  readonly resolveSecret: (reference: string) => string;
  /** Pinned transport. Swapped by tests. */
  readonly fetchImpl?: PinnedFetch;
  /** Name resolution for the pre-send check. Swapped by tests — they use no real DNS. */
  readonly resolveHost?: HostResolver;
  /** Time allowed per request. Without it a dead endpoint holds the loop. */
  readonly timeoutMs?: number;
}

export interface DeliveryResult {
  readonly handled: boolean;
  readonly delivered: number;
  readonly failed: number;
}

interface DeliveryFailure {
  readonly category: DeliveryErrorCategory;
  /** HTTP status, for the worker log only. Never stored. */
  readonly status?: number;
}

/** Signature header value. The format is fixed so the receiver can recompute it. */
export function signPayload(secret: string, body: string, timestamp: string): string {
  // Sign the timestamp too. Without it an intercepted request can be replayed verbatim later.
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * The signing secret, or null when it cannot be used.
 *
 * The namespace is checked here as well as at registration — a row written before the rule, or
 * by hand, must not make the worker read an arbitrary variable or file.
 */
function readSecret(
  row: DeliverableNotification,
  options: DeliveryOptions,
): { readonly secret: string } | { readonly reason: "outside_namespace" | "unresolvable" } {
  if (!isAllowedWebhookSecretReference(row.secret_reference)) {
    return { reason: "outside_namespace" };
  }
  try {
    return { secret: options.resolveSecret(row.secret_reference) };
  } catch {
    return { reason: "unresolvable" };
  }
}

function classifyTransportError(error: unknown, timedOut: boolean): DeliveryErrorCategory {
  if (timedOut) return "timeout";
  if (error instanceof ResponseTooLargeError) return "response_too_large";
  return "network_error";
}

/** Checks the destination, then sends once to the checked addresses. Null on success. */
async function send(
  row: DeliverableNotification,
  request: { readonly body: string; readonly headers: Readonly<Record<string, string>> },
  options: DeliveryOptions,
): Promise<DeliveryFailure | null> {
  let addresses: readonly string[];
  try {
    addresses = await assertEndpointReachable(row.url, options.resolveHost ?? dnsResolver);
  } catch (error) {
    if (error instanceof EndpointNotAllowedError) return { category: "rejected_destination" };
    return { category: "network_error" };
  }

  const doFetch = options.fetchImpl ?? pinnedFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);

  try {
    const response = await doFetch(new URL(row.url), {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
      // A 3xx is a failure, not a hop. Following it would change the address after the check.
      redirect: "manual",
      pinnedAddresses: addresses,
      maxResponseBytes: WEBHOOK_MAX_RESPONSE_BYTES,
    });
    return response.ok ? null : { category: "http_error", status: response.status };
  } catch (error) {
    return { category: classifyTransportError(error, controller.signal.aborted) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Processes one pending delivery.
 *
 * Same shape as `scanOnce` — claim one row, return whether it was handled. Not batched so that
 * one slow endpoint does not make the rest queue behind it.
 */
export async function deliverOnce(
  sql: postgres.Sql,
  options: DeliveryOptions,
  emit: (record: Record<string, unknown>) => void = () => undefined,
): Promise<DeliveryResult> {
  const [row] = await sql<DeliverableNotification[]>`
    SELECT d.notification_id, d.sink_id, d.tenant_id, d.attempts,
           s.url, s.secret_reference,
           n.kind::text AS kind, n.summary, n.link, n.occurred_at
    FROM core.notification_deliveries d
    JOIN core.notification_sinks s ON s.id = d.sink_id
    JOIN core.notifications n ON n.id = d.notification_id
    WHERE d.state = 'pending'
      AND d.next_attempt_at <= now()
      AND s.state = 'active'
    ORDER BY d.next_attempt_at
    FOR UPDATE OF d SKIP LOCKED
    LIMIT 1
  `;

  if (!row) return { handled: false, delivered: 0, failed: 0 };

  const attempt = row.attempts + 1;
  const body = JSON.stringify({
    kind: row.kind,
    summary: row.summary,
    link: row.link,
    occurredAt: row.occurred_at.toISOString(),
    notificationId: row.notification_id,
  });
  const timestamp = new Date().toISOString();

  const secret = readSecret(row, options);
  if (!("secret" in secret)) {
    /**
     * An unusable secret **stays unusable on retry.** The config must be fixed, so settle
     * immediately instead of waiting for the attempt cap — meanwhile the log fills with the same
     * error. Stored as one category whatever the reason, so the admin screen does not say which
     * variables or files exist on the worker.
     */
    await sql`
      UPDATE core.notification_deliveries
      SET state = 'failed', attempts = ${attempt}, last_error = 'secret_unavailable'
      WHERE notification_id = ${row.notification_id} AND sink_id = ${row.sink_id}
    `;
    emit({
      level: "error",
      msg: "notification.secret_unavailable",
      sinkId: row.sink_id,
      reason: secret.reason,
    });
    return { handled: true, delivered: 0, failed: 1 };
  }

  const failure = await send(
    row,
    {
      body,
      headers: {
        "content-type": "application/json",
        "x-mpc-timestamp": timestamp,
        "x-mpc-signature": signPayload(secret.secret, body, timestamp),
        // Lets the receiver recognize retries. Delivery is at-least-once, so duplicates arrive.
        "x-mpc-delivery-attempt": String(attempt),
        "idempotency-key": `${row.notification_id}:${row.sink_id}`,
      },
    },
    options,
  );

  if (failure === null) {
    await sql`
      UPDATE core.notification_deliveries
      SET state = 'delivered', attempts = ${attempt}, delivered_at = now(), last_error = NULL
      WHERE notification_id = ${row.notification_id} AND sink_id = ${row.sink_id}
    `;
    return { handled: true, delivered: 1, failed: 0 };
  }

  // Settle at the cap. The in-app notification remains, so no information is lost — only the
  // fact of "sent" is missing, and the row records exactly that.
  const exhausted = attempt >= options.maxAttempts;
  const backoff = options.backoffMs * 2 ** (attempt - 1);

  await sql`
    UPDATE core.notification_deliveries
    SET state = ${exhausted ? "failed" : "pending"},
        attempts = ${attempt},
        last_error = ${failure.category},
        next_attempt_at = now() + ${`${Math.round(backoff / 1000)} seconds`}::interval
    WHERE notification_id = ${row.notification_id} AND sink_id = ${row.sink_id}
  `;

  emit({
    level: exhausted ? "error" : "warn",
    msg: exhausted ? "notification.delivery.failed" : "notification.delivery.retry",
    sinkId: row.sink_id,
    attempt,
    error: failure.category,
    ...(failure.status === undefined ? {} : { status: failure.status }),
  });

  return { handled: true, delivered: 0, failed: exhausted ? 1 : 0 };
}

/** Delivery counts by state. Left silent, nobody notices that nothing is being sent. */
export async function deliveryBacklog(
  sql: postgres.Sql,
): Promise<{ pending: number; failed: number }> {
  const [row] = await sql<{ pending: string; failed: string }[]>`
    SELECT count(*) FILTER (WHERE state = 'pending') AS pending,
           count(*) FILTER (WHERE state = 'failed')  AS failed
    FROM core.notification_deliveries
  `;
  return { pending: Number(row?.pending ?? 0), failed: Number(row?.failed ?? 0) };
}
