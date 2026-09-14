import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/**
 * Outbox — 07 §7.5.
 *
 * 도메인 transaction과 outbox insert를 **같은 transaction**에서 처리한다.
 * 도메인 변경이 롤백되면 이벤트도 사라진다. 별도 발행 worker가 이 테이블을 읽어
 * 큐로 옮기며 at-least-once로 전달한다.
 */
export interface DomainEvent {
  readonly tenantId: string;
  readonly eventType: string;
  readonly aggregateId: string;
  readonly aggregateVersion: number;
  readonly projectId?: string;
  readonly payload: Record<string, unknown>;
  readonly correlationId: string;
  readonly causationId?: string;
}

export async function enqueueEvent(
  tx: postgres.TransactionSql,
  event: DomainEvent,
): Promise<string> {
  const id = randomUUID();

  await tx`
    INSERT INTO core.outbox (
      id, tenant_id, event_type, schema_version, aggregate_id, aggregate_version,
      project_id, payload, correlation_id, causation_id
    ) VALUES (
      ${id}, ${event.tenantId}, ${event.eventType}, 1,
      ${event.aggregateId}, ${event.aggregateVersion},
      ${event.projectId ?? null}, ${tx.json(event.payload as never)},
      ${event.correlationId}, ${event.causationId ?? null}
    )
  `;

  return id;
}
