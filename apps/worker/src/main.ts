import postgres from "postgres";
import { resolveSecret } from "@mpc/config";
import { createHeartbeat } from "./heartbeat.js";
import { deliverOnce, deliveryBacklog } from "./notification-delivery.js";
import { backlogStats, publishBatch, type OutboxRow } from "./outbox-publisher.js";

/**
 * Outbox 발행 루프.
 *
 * R0에서는 발행 대상이 로그다. 실제 broker(pg-boss)는 consumer가 생기는 R1에서
 * 연결한다 — consumer 없는 큐를 먼저 붙이면 어디로 가는지 알 수 없는 이벤트가
 * 쌓인다.
 */

const databaseUrl = process.env["DATABASE_URL"];
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL이 필요하다\n");
  process.exit(1);
}

const POLL_INTERVAL_MS = Number(process.env["OUTBOX_POLL_MS"] ?? "1000");
const BACKOFF_MS = Number(process.env["OUTBOX_BACKOFF_MS"] ?? "5000");

/**
 * 알림 webhook 배달.
 *
 * 네 번째 프로세스를 만들지 않고 이 루프에 얹는다. 배달은 outbox 발행과 같은
 * 모양의 일이고(대기 행을 집어 밖으로 보낸다), 프로세스가 늘면 그만큼 죽어 있을
 * 수 있는 자리가 는다.
 *
 * **수신처가 없으면 아무 일도 하지 않는다.** 조회는 매 주기 돌지만 대기 행이
 * 없으므로 즉시 돌아온다 — sink를 만들지 않은 배포에 부담을 주지 않는다.
 */
const NOTIFY_MAX_ATTEMPTS = Number(process.env["NOTIFY_MAX_ATTEMPTS"] ?? "5");
const NOTIFY_BACKOFF_MS = Number(process.env["NOTIFY_BACKOFF_MS"] ?? "30000");
const NOTIFY_TIMEOUT_MS = Number(process.env["NOTIFY_TIMEOUT_MS"] ?? "10000");

const sql = postgres(databaseUrl, { onnotice: () => {} });

function emit(record: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

const publish = async (event: OutboxRow): Promise<void> => {
  // payload를 그대로 찍지 않는다. 이벤트 payload에 PII를 넣지 않기로 했지만,
  // 로그는 그 약속이 깨졌을 때 최초 유출 경로가 된다.
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

while (running) {
  try {
    const result = await publishBatch(sql, publish);

    // 알림 배달도 같은 주기에 한 건씩 처리한다.
    const delivery = await deliverOnce(
      sql,
      {
        maxAttempts: NOTIFY_MAX_ATTEMPTS,
        backoffMs: NOTIFY_BACKOFF_MS,
        timeoutMs: NOTIFY_TIMEOUT_MS,
        resolveSecret: (reference) => resolveSecret("NOTIFY_SINK_SECRET", reference),
      },
      emit,
    );

    // 발행할 것이 없어도 신호를 남긴다.
    await heartbeat({ published: result.published, delivered: delivery.delivered });

    if (delivery.failed > 0) {
      // 굳어 버린 배달을 조용히 두면 아무도 보내지 못하고 있는 것을 모른다.
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

    // 둘 다 할 일이 없을 때만 쉰다. 하나라도 처리했으면 밀린 것이 더 있을 수
    // 있고, 그때 쉬면 배달이 폴링 간격만큼씩 늦어진다.
    if (result.published === 0 && !delivery.handled) {
      await sleep(POLL_INTERVAL_MS);
    }
  } catch (error) {
    // 발행 실패는 재시도한다. published_at을 찍지 않았으므로 이벤트는 남아 있다.
    emit({ level: "error", msg: "outbox.loop.failed", error: String(error) });
    await sleep(BACKOFF_MS);
  }
}

emit({ level: "info", msg: "outbox.worker.stopped" });
await sql.end();
