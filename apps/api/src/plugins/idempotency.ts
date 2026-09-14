import { createHash } from "node:crypto";
import type postgres from "postgres";
import { conflict } from "../errors.js";

/**
 * Mutation idempotency — 07 §7.1.
 *
 * The same request with the same key returns the stored response as is. A **different**
 * request with the same key is rejected. A client reusing a key while changing the payload is
 * a bug, and silently executing it causes duplicate side effects.
 */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/**
 * Reservation for mutations that involve an external call.
 *
 * `withIdempotency` is for work finished within one transaction. Work that **sends requests
 * outside the DB**, like source lookup, cannot go inside it — it would hold the transaction and
 * locks while waiting for the external response.
 *
 * So it is split into three: reserve first, call out, then settle with the result.
 * Reserving first ensures **a retry does not call the source again**.
 * The registry's rate limit does not know our retry count.
 */
export async function reserveIdempotency<T>(
  tx: postgres.TransactionSql,
  tenantId: string,
  key: string,
  requestHash: string,
): Promise<{ readonly replay: T } | { readonly replay: null }> {
  // Decide races with INSERT. Reading first and inserting when absent lets two concurrent
  // requests both pass.
  const inserted = await tx`
    INSERT INTO core.idempotency_keys (key, tenant_id, request_hash)
    VALUES (${key}, ${tenantId}, ${requestHash})
    ON CONFLICT (key, tenant_id) DO NOTHING
    RETURNING key
  `;

  if (inserted.length > 0) return { replay: null };

  const [previous] = await tx<{ request_hash: string; response_snapshot: T | null }[]>`
    SELECT request_hash, response_snapshot
    FROM core.idempotency_keys
    WHERE key = ${key} AND tenant_id = ${tenantId}
  `;

  if (!previous) throw conflict("IDEMPOTENCY_IN_FLIGHT", "The same request is in progress");

  if (previous.request_hash !== requestHash) {
    throw conflict("IDEMPOTENCY_KEY_REUSE", "A different request arrived with the same key");
  }
  if (previous.response_snapshot === null) {
    throw conflict("IDEMPOTENCY_IN_FLIGHT", "The same request is in progress");
  }

  return { replay: previous.response_snapshot };
}

/**
 * Releases the reservation.
 *
 * Called when the external call or a subsequent write fails. Without it the key stays
 * `IDEMPOTENCY_IN_FLIGHT` forever and the client has no way to retry.
 */
export async function releaseIdempotency(
  sql: postgres.Sql | postgres.TransactionSql,
  tenantId: string,
  key: string,
): Promise<void> {
  await sql`
    DELETE FROM core.idempotency_keys
    WHERE key = ${key} AND tenant_id = ${tenantId} AND response_snapshot IS NULL
  `;
}

/** Settles the reservation with a result. Later calls with the same key get this response. */
export async function completeIdempotency<T>(
  tx: postgres.TransactionSql,
  tenantId: string,
  key: string,
  result: T,
): Promise<void> {
  await tx`
    UPDATE core.idempotency_keys
    SET response_snapshot = ${tx.json(result as never)}, response_status = 200
    WHERE key = ${key} AND tenant_id = ${tenantId}
  `;
}

export async function withIdempotency<T>(
  tx: postgres.TransactionSql,
  tenantId: string,
  key: string,
  requestHash: string,
  work: () => Promise<T>,
): Promise<T> {
  const existing = await tx<
    { request_hash: string; response_snapshot: T | null }[]
  >`
    SELECT request_hash, response_snapshot
    FROM core.idempotency_keys
    WHERE key = ${key} AND tenant_id = ${tenantId}
  `;

  const previous = existing[0];
  if (previous) {
    if (previous.request_hash !== requestHash) {
      throw conflict("IDEMPOTENCY_KEY_REUSE", "A different request arrived with the same key");
    }
    if (previous.response_snapshot !== null) {
      return previous.response_snapshot;
    }
    throw conflict("IDEMPOTENCY_IN_FLIGHT", "The same request is in progress");
  }

  await tx`
    INSERT INTO core.idempotency_keys (key, tenant_id, request_hash)
    VALUES (${key}, ${tenantId}, ${requestHash})
  `;

  const result = await work();

  await tx`
    UPDATE core.idempotency_keys
    SET response_snapshot = ${tx.json(result as never)}, response_status = 200
    WHERE key = ${key} AND tenant_id = ${tenantId}
  `;

  return result;
}
