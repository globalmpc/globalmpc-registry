import { randomUUID } from "node:crypto";
import type postgres from "postgres";

/**
 * Outbox — 07 §7.5.
 *
 * Handles the domain transaction and the outbox insert in **the same transaction**.
 * If the domain change rolls back, the event disappears too. A separate publisher worker reads
 * this table and moves events to the queue with at-least-once delivery.
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
