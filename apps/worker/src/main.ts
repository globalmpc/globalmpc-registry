import postgres from "postgres";
import { resolveSecret, resolveWebhookSecret } from "@mpc/config";
import { createExpirySweep, DEFAULT_EXPIRY_SWEEP_MS } from "./document-expiry.js";
import { createHeartbeat } from "./heartbeat.js";
import { deliverOnce, deliveryBacklog } from "./notification-delivery.js";
import { backlogStats, publishBatch, type OutboxRow } from "./outbox-publisher.js";

/**
 * Outbox publishing loop.
 *
 * In R0 the publish target is the log. The real broker (pg-boss) is wired in R1, when a consumer
 * exists — attaching a queue with no consumer first piles up events with no known destination.
 */

// Accepts a `file:` reference like the other workers — the local stack passes the connection
// string as a mounted secret, not as a value.
let databaseUrl: string;
try {
  databaseUrl = resolveSecret("DATABASE_URL", process.env["DATABASE_URL"]);
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
}

const POLL_INTERVAL_MS = Number(process.env["OUTBOX_POLL_MS"] ?? "1000");
const BACKOFF_MS = Number(process.env["OUTBOX_BACKOFF_MS"] ?? "5000");

/**
 * Notification webhook delivery.
 *
 * Rides on this loop instead of a fourth process. Delivery has the same shape as outbox
 * publishing (claim a pending row, send it out), and each extra process is one more place that
 * can be dead.
 *
 * **With no receivers it does nothing.** The query runs every cycle but returns immediately with
 * no pending rows — no load on deployments that never created a sink.
 */
const NOTIFY_MAX_ATTEMPTS = Number(process.env["NOTIFY_MAX_ATTEMPTS"] ?? "5");
const NOTIFY_BACKOFF_MS = Number(process.env["NOTIFY_BACKOFF_MS"] ?? "30000");
const NOTIFY_TIMEOUT_MS = Number(process.env["NOTIFY_TIMEOUT_MS"] ?? "10000");

/** Document expiry sweep interval (`document-expiry.ts`). */
const EXPIRY_SWEEP_MS = Number(
  process.env["DOCUMENT_EXPIRY_SWEEP_MS"] ?? String(DEFAULT_EXPIRY_SWEEP_MS),
);

const sql = postgres(databaseUrl, { onnotice: () => {} });

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const publish = async (event: OutboxRow): Promise<void> => {
  // Never print the payload as is. Event payloads are agreed to carry no PII, but if that
  // promise breaks, the log becomes the first leak path.
  emit({
    level: "info",
    msg: "outbox.published",
    eventId: event.id,
    eventType: event.event_type,
    aggregateId: event.aggregate_id,
    aggregateVersion: event.aggregate_version,
    correlationId: event.correlation_id,
  });
};

let running = true;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

emit({ level: "info", msg: "outbox.worker.started", pollIntervalMs: POLL_INTERVAL_MS });

const heartbeat = createHeartbeat(sql, "outbox");
const sweepExpiry = createExpirySweep(sql, EXPIRY_SWEEP_MS);

while (running) {
  try {
    const result = await publishBatch(sql, publish);

    // A failing sweep must not hold up publishing. It is reported and retried on the next
    // interval; the documents stay as they are meanwhile.
    try {
      const expiry = await sweepExpiry();
      if (expiry.ran && expiry.flagged > 0) {
        emit({ level: "info", msg: "document.expiry.flagged", flagged: expiry.flagged });
      }
    } catch (error) {
      emit({ level: "error", msg: "document.expiry.sweep_failed", error: String(error) });
    }

    // Notification delivery also handles one item per cycle.
    const delivery = await deliverOnce(
      sql,
      {
        maxAttempts: NOTIFY_MAX_ATTEMPTS,
        backoffMs: NOTIFY_BACKOFF_MS,
        timeoutMs: NOTIFY_TIMEOUT_MS,
        resolveSecret: (reference) => resolveWebhookSecret(reference),
      },
      emit,
    );

    // Emit the signal even when there is nothing to publish.
    await heartbeat({ published: result.published, delivered: delivery.delivered });

    if (delivery.failed > 0) {
      // Left silent, stuck deliveries hide the fact that nothing is getting through.
      emit({ level: "warn", msg: "notification.delivery.backlog", ...(await deliveryBacklog(sql)) });
    }

    if (result.failed > 0) {
      const stats = await backlogStats(sql);
      emit({
        level: "warn",
        msg: "outbox.publish.partial_failure",
        failed: result.failed,
        published: result.published,
        pending: stats.pending,
        oldestPendingAt: stats.oldestPendingAt?.toISOString() ?? null,
      });
      await sleep(BACKOFF_MS);
      continue;
    }

    // Sleep only when both are idle. If either handled something, more may be queued, and
    // sleeping then delays delivery by a polling interval each time.
    if (result.published === 0 && !delivery.handled) {
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    // Publish failures are retried. published_at was not stamped, so the event remains.
    emit({ level: "error", msg: "outbox.loop.failed", error: String(error) });
    await sleep(BACKOFF_MS);
  }
}

emit({ level: "info", msg: "outbox.worker.stopped" });
await sql.end();
