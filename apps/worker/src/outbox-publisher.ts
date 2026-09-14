import type postgres from "postgres";

/**
 * Outbox 발행 — 07 §7.5.
 *
 * **at-least-once다.** 발행에 성공한 뒤에 `published_at`을 기록하므로, 발행 직후
 * 크래시가 나면 같은 이벤트가 다시 나갈 수 있다. 그래서 consumer는 `core.inbox`에
 * `(eventId, handlerVersion)`으로 중복을 제거한다.
 *
 * 반대 순서(먼저 표시하고 발행)로 하면 at-most-once가 되어 이벤트가 사라진다.
 * 중복은 consumer가 흡수할 수 있지만 소실은 복구할 수 없다.
 */

export interface OutboxRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly event_type: string;
  readonly schema_version: number;
  readonly aggregate_id: string;
  readonly aggregate_version: number;
  readonly project_id: string | null;
  readonly payload: Record<string, unknown>;
  readonly correlation_id: string;
  readonly causation_id: string | null;
  readonly occurred_at: Date;
}

export type Publish = (event: OutboxRow) => Promise<void>;

export interface PublishResult {
  readonly published: number;
  readonly failed: number;
}

/**
 * 미발행 이벤트를 한 배치 발행한다.
 *
 * 한 이벤트의 발행이 실패해도 나머지를 계속 시도한다. 하나가 막혀 전체가 멈추면
 * 무관한 이벤트까지 지연된다. 실패한 이벤트는 `published_at`이 비어 있으므로
 * 다음 호출에서 다시 시도된다.
 */
export async function publishBatch(
  sql: postgres.Sql,
  publish: Publish,
  limit = 100,
): Promise<PublishResult> {
  const rows = await sql<OutboxRow[]>`
    SELECT * FROM core.outbox
    WHERE published_at IS NULL
    ORDER BY occurred_at, id
    LIMIT ${limit}
  `;

  let published = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await publish(row);
    } catch {
      failed += 1;
      continue;
    }
    await sql`UPDATE core.outbox SET published_at = now() WHERE id = ${row.id}`;
    published += 1;
  }

  return { published, failed };
}

/**
 * consumer 측 중복 제거 — 07 §7.5.
 *
 * at-least-once 전달을 받는 쪽에서 같은 이벤트를 두 번 처리하지 않게 한다.
 * `handlerVersion`을 키에 포함하는 이유: handler 로직이 바뀌면 과거 이벤트를
 * 다시 처리해야 할 수 있다.
 */
export async function claimEvent(
  sql: postgres.Sql,
  eventId: string,
  handlerVersion: string,
): Promise<boolean> {
  const rows = await sql`
    INSERT INTO core.inbox (event_id, handler_version)
    VALUES (${eventId}, ${handlerVersion})
    ON CONFLICT (event_id, handler_version) DO NOTHING
    RETURNING event_id
  `;
  return rows.length > 0;
}

export interface BacklogStats {
  readonly pending: number;
  readonly oldestPendingAt: Date | null;
}

/**
 * 미발행 backlog. 운영 화면과 알림이 쓴다.
 *
 * 06 §6.8: 장애 시 hidden success를 만들지 않는다. backlog가 쌓이는 것을
 * 관측할 수 없으면 이벤트가 멈춘 것을 아무도 모른다.
 */
export async function backlogStats(sql: postgres.Sql): Promise<BacklogStats> {
  const [row] = await sql<{ pending: string; oldest: Date | null }[]>`
    SELECT count(*)::text AS pending, min(occurred_at) AS oldest
    FROM core.outbox WHERE published_at IS NULL
  `;
  return {
    pending: Number(row?.pending ?? "0"),
    oldestPendingAt: row?.oldest ?? null,
  };
}
