import { createHmac } from "node:crypto";
import type postgres from "postgres";

/**
 * 알림 webhook 배달.
 *
 * 앱 안 알림은 앱을 열어야 보인다. 급한 것 — 공개 기록 철회 — 이 늦으면 그 사이
 * 인용이 계속된다. 이 모듈이 그것을 tenant가 지정한 수신처로 밀어낸다.
 *
 * **메일이 아니라 webhook인 이유**: 메일 주소를 저장하는 순간 이 시스템은
 * 개인정보를 보관하게 되고, 그것은 지금 업로드에서 422로 거절하고 있는 등급이다
 * (OD-18). 수신 URL은 tenant의 것이지 사람의 것이 아니다.
 *
 * **서명한다.** 서명이 없으면 URL을 아는 누구나 알림을 위조할 수 있고, 알림은
 * 사람을 움직이게 하는 신호다. 받는 쪽은 같은 비밀로 HMAC을 다시 계산해 맞춘다.
 *
 * **본문에 담는 것은 앱 안 알림과 같다.** 요약과 링크뿐이며 projection도 증빙도
 * 담지 않는다 — 수신처는 우리가 통제하지 않는 시스템이다.
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

export interface DeliveryOptions {
  /** 시도 상한. 넘으면 `failed`로 굳는다 — 영원히 두드리지 않는다. */
  readonly maxAttempts: number;
  /** 첫 재시도 간격(ms). 시도마다 두 배로 늘린다. */
  readonly backoffMs: number;
  /** 참조를 실제 비밀로 푼다. worker가 주입한다 — 이 모듈은 파일을 읽지 않는다. */
  readonly resolveSecret: (reference: string) => string;
  readonly fetchImpl?: typeof fetch;
  /** 한 번의 요청에 허용할 시간. 없으면 죽은 수신처가 루프를 잡아 둔다. */
  readonly timeoutMs?: number;
}

export interface DeliveryResult {
  readonly handled: boolean;
  readonly delivered: number;
  readonly failed: number;
}

/** 서명 헤더 값. 받는 쪽이 재계산할 수 있게 형식을 고정한다. */
export function signPayload(secret: string, body: string, timestamp: string): string {
  // timestamp를 함께 서명한다. 없으면 가로챈 요청을 나중에 그대로 재생할 수 있다.
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

/**
 * 대기 중인 배달 하나를 처리한다.
 *
 * `scanOnce`와 같은 모양이다 — 한 건씩 집고, 처리했는지를 돌려준다. 배치로
 * 묶지 않는 이유는 한 수신처가 느릴 때 나머지가 그 뒤에 서지 않게 하기 위해서다.
 */
export async function deliverOnce(
  sql: postgres.Sql,
  options: DeliveryOptions,
  emit: (record: Record<string, unknown>) => void = () => undefined,
): Promise<DeliveryResult> {
  const doFetch = options.fetchImpl ?? fetch;

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

  let secret: string;
  try {
    secret = options.resolveSecret(row.secret_reference);
  } catch (error) {
    /**
     * 비밀을 풀지 못하면 **재시도해도 같다.** 설정이 고쳐져야 하는 것이므로
     * 시도 상한을 기다리지 않고 바로 굳힌다 — 그 사이 로그가 같은 오류로 찬다.
     */
    await sql`
      UPDATE core.notification_deliveries
      SET state = 'failed', attempts = ${attempt},
          last_error = ${`비밀 참조를 풀지 못했다: ${String(error)}`}
      WHERE notification_id = ${row.notification_id} AND sink_id = ${row.sink_id}
    `;
    emit({ level: "error", msg: "notification.secret_unresolved", sinkId: row.sink_id });
    return { handled: true, delivered: 0, failed: 1 };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  let failure: string | null = null;

  try {
    const response = await doFetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-mpc-timestamp": timestamp,
        "x-mpc-signature": signPayload(secret, body, timestamp),
        // 재시도를 받는 쪽이 알아볼 수 있게 한다. at-least-once이므로 중복이 온다.
        "x-mpc-delivery-attempt": String(attempt),
        "idempotency-key": `${row.notification_id}:${row.sink_id}`,
      },
      body,
      signal: controller.signal,
    });
    if (!response.ok) failure = `HTTP ${response.status}`;
  } catch (error) {
    failure = String(error instanceof Error ? error.message : error);
  } finally {
    clearTimeout(timer);
  }

  if (failure === null) {
    await sql`
      UPDATE core.notification_deliveries
      SET state = 'delivered', attempts = ${attempt}, delivered_at = now(), last_error = NULL
      WHERE notification_id = ${row.notification_id} AND sink_id = ${row.sink_id}
    `;
    return { handled: true, delivered: 1, failed: 0 };
  }

  // 상한에 닿으면 굳힌다. 앱 안 알림은 그대로 남아 있으므로 정보가 사라지지는
  // 않는다 — 사라지는 것은 "보냈다"는 사실뿐이고, 그것을 사실대로 적는다.
  const exhausted = attempt >= options.maxAttempts;
  const backoff = options.backoffMs * 2 ** (attempt - 1);

  await sql`
    UPDATE core.notification_deliveries
    SET state = ${exhausted ? "failed" : "pending"},
        attempts = ${attempt},
        last_error = ${failure},
        next_attempt_at = now() + ${`${Math.round(backoff / 1000)} seconds`}::interval
    WHERE notification_id = ${row.notification_id} AND sink_id = ${row.sink_id}
  `;

  emit({
    level: exhausted ? "error" : "warn",
    msg: exhausted ? "notification.delivery.failed" : "notification.delivery.retry",
    sinkId: row.sink_id,
    attempt,
    error: failure,
  });

  return { handled: true, delivered: 0, failed: exhausted ? 1 : 0 };
}

/** 굳어 버린 배달 수. 조용히 두면 아무도 보내지 못하고 있는 것을 모른다. */
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
