import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type postgres from "postgres";
import { withTenant } from "@mpc/db";
import { conflict } from "../errors.js";

/**
 * Mutation idempotency — 07 §7.1.
 *
 * The same request with the same key returns the stored response as is. A **different**
 * request with the same key is rejected. A client reusing a key while changing the payload is
 * a bug, and silently executing it causes duplicate side effects.
 *
 * **What "the same request" covers.** Keys are stored per tenant, so the hash carries the rest:
 * the method, the path with its parameters filled in, and the acting subject, besides the
 * payload. Hashing the body alone let the same key and body sent to another resource, or by
 * another person in the tenant, replay a response that was never theirs. The query string is
 * left out — mutations do not read it.
 *
 * `payload` defaults to the body. Routes whose body is a stream pass what identifies it.
 */
export function hashRequest(request: FastifyRequest, payload: unknown = request.body): string {
  const scoped = {
    method: request.method,
    path: request.url.split("?")[0],
    subjectId: request.session?.subjectId ?? null,
    payload: payload ?? null,
  };
  return createHash("sha256").update(JSON.stringify(scoped)).digest("hex");
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
  sql: postgres.Sql,
  tenantId: string,
  key: string,
): Promise<void> {
  // Runs on the failure path, outside the failed transaction, so it sets the tenant itself —
  // without it RLS sees no rows and the key silently stays in flight.
  await withTenant(sql, { tenantId }, async (tx) => {
    await tx`
      DELETE FROM core.idempotency_keys
      WHERE key = ${key} AND tenant_id = ${tenantId} AND response_snapshot IS NULL
    `;
  });
}

/**
 * Releases the reservation on a failure path without hiding that failure.
 *
 * The release opens its own transaction and can itself fail. Throwing that error would replace
 * the one the client needs to see, so it is logged and the original error stands.
 */
export async function releaseIdempotencyAfterFailure(
  sql: postgres.Sql,
  tenantId: string,
  key: string,
  log: { error: (detail: Record<string, unknown>, message: string) => void },
): Promise<void> {
  try {
    await releaseIdempotency(sql, tenantId, key);
  } catch (releaseError) {
    log.error({ err: releaseError }, "idempotency release failed after an earlier error");
  }
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
