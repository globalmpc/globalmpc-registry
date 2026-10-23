import postgres from "postgres";
import { createLedgerSweep, createLedgerSweepRunner } from "./evidence-ledger.js";
import { resolveSecret, resolveWebhookSecret } from "@mpc/config";
import { SESSION_CONNECTION } from "@mpc/db";
import { createCredentialExpirySweep, DEFAULT_CREDENTIAL_SWEEP_MS } from "./credential-expiry.js";
import { createExpirySweep, DEFAULT_EXPIRY_SWEEP_MS } from "./document-expiry.js";
import { createHeartbeat } from "@mpc/db";
import { deliverOnce, deliveryBacklog } from "./notification-delivery.js";
import { buildOutboxHandlers } from "./outbox-handlers.js";
import {
  DEFAULT_OUTBOX_MAX_ATTEMPTS,
  backlogStats,
  createDispatcher,
  publishBatch,
} from "./outbox-publisher.js";

/**
 * Outbox publishing loop.
 *
 * Events are delivered to in-process consumers (`outbox-handlers.ts`): the structured event log
 * and the project export builder. Each consumer deduplicates through `core.inbox`; a failing
 * event is retried with backoff and dead-lettered at the attempt cap (0065 explains why the
 * outbox table is the queue rather than a second broker).
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
/** Attempts per event before it is dead-lettered. Same default as notification delivery. */
const MAX_ATTEMPTS = Number(
  process.env["OUTBOX_MAX_ATTEMPTS"] ?? String(DEFAULT_OUTBOX_MAX_ATTEMPTS),
);

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

/** Credential expiry sweep interval (`credential-expiry.ts`). */
const CREDENTIAL_SWEEP_MS = Number(
  process.env["CREDENTIAL_EXPIRY_SWEEP_MS"] ?? String(DEFAULT_CREDENTIAL_SWEEP_MS),
);

const sql = postgres(databaseUrl, { onnotice: () => {}, connection: SESSION_CONNECTION });

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const dispatcher = createDispatcher(sql, buildOutboxHandlers(sql, emit));

let running = true;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    running = false;
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

emit({ level: "info", msg: "outbox.worker.started", pollIntervalMs: POLL_INTERVAL_MS });

const heartbeat = createHeartbeat(sql, "outbox", 15_000, process.env["WORKER_HEALTH_FILE"]);
const sweepExpiry = createExpirySweep(sql, EXPIRY_SWEEP_MS);
// Reserve a separate connection so a long assessment cannot exhaust delivery's pool.
const ledgerSql = postgres(databaseUrl, { max: 1, onnotice: () => {}, connection: SESSION_CONNECTION });
const ledgerRunner = createLedgerSweepRunner(createLedgerSweep(ledgerSql), (ledger) => {
  if (ledger.ran && ledger.recorded > 0) emit({ level: "info", msg: "evidence_ledger.assessed", recorded: ledger.recorded });
}, (error) => {
  emit({ level: "error", msg: "evidence_ledger.sweep_failed", error: String(error) });
});
const sweepCredentials = createCredentialExpirySweep(sql, CREDENTIAL_SWEEP_MS);

while (running) {
  try {
    const result = await publishBatch(sql, dispatcher.publish, {
      maxAttempts: MAX_ATTEMPTS,
      backoffMs: BACKOFF_MS,
      onDeadLetter: async (event) => {
        emit({
          level: "error",
          msg: "outbox.event.dead_lettered",
          eventId: event.id,
          eventType: event.event_type,
        });
        // Settling a consumer's own state (an export job marked failed) must not undo the
        // dead-letter mark or stop the batch. It is logged; a replay settles it again.
        try {
          await dispatcher.onDeadLetter(event);
        } catch (error) {
          emit({ level: "error", msg: "outbox.dead_letter.settle_failed", eventId: event.id, error: String(error) });
        }
      },
    });

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

    // Same isolation as the document sweep: a failure is reported and retried next interval.
    try {
      const credentials = await sweepCredentials();
      if (credentials.ran && credentials.flagged > 0) {
        emit({ level: "info", msg: "credential.expiry.flagged", flagged: credentials.flagged });
      }
    } catch (error) {
      emit({ level: "error", msg: "credential.expiry.sweep_failed", error: String(error) });
    }

    ledgerRunner.kick();

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
        deadLettered: stats.deadLettered,
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

await ledgerRunner.stop();
await ledgerSql.end();
emit({ level: "info", msg: "outbox.worker.stopped" });
await sql.end();
