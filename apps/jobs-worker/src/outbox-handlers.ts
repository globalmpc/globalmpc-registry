import type postgres from "postgres";
import type { OutboxHandler } from "./outbox-publisher.js";
import { projectExportHandler } from "./project-export.js";

/**
 * The outbox consumers — 07 §7.5.
 *
 * One list, shared by the publishing loop and the replay command, so a dry run reports exactly
 * the side effects the loop would perform.
 */

export type Emit = (record: Record<string, unknown>) => void;

/**
 * The event stream as a structured log line.
 *
 * Never prints the payload. Event payloads are agreed to carry no PII, but if that promise
 * breaks, the log becomes the first leak path.
 */
export function logHandler(emit: Emit): OutboxHandler {
  return {
    name: "log",
    version: "1",
    accepts: () => true,
    handle: async (event) => {
      emit({
        level: "info",
        msg: "outbox.published",
        eventId: event.id,
        eventType: event.event_type,
        aggregateId: event.aggregate_id,
        aggregateVersion: event.aggregate_version,
        correlationId: event.correlation_id,
      });
    },
  };
}

export function buildOutboxHandlers(sql: postgres.Sql, emit: Emit): readonly OutboxHandler[] {
  return [logHandler(emit), projectExportHandler(sql)];
}
