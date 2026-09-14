import { createHash } from "node:crypto";
import type postgres from "postgres";
import { conflict } from "../errors.js";

/**
 * mutation 멱등성 — 07 §7.1.
 *
 * 같은 key로 같은 요청이 오면 저장된 응답을 그대로 돌려준다. 같은 key로 **다른**
 * 요청이 오면 거절한다. 클라이언트가 key를 재사용하면서 payload를 바꾸는 것은
 * 버그이며, 조용히 실행하면 중복 부작용이 생긴다.
 */
export function hashRequest(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/**
 * 외부 호출이 끼는 mutation을 위한 예약.
 *
 * `withIdempotency`는 트랜잭션 하나 안에서 일을 끝내는 경우를 위한 것이다.
 * 출처 조회처럼 **DB 밖으로 요청이 나가는** 작업은 그 안에 넣을 수 없다 — 외부
 * 응답을 기다리는 동안 트랜잭션과 잠금을 쥐고 있게 된다.
 *
 * 그래서 셋으로 나눈다: 먼저 예약하고, 외부를 부르고, 결과로 마감한다.
 * 예약이 먼저인 이유는 **재시도가 출처를 다시 부르지 않게** 하기 위해서다.
 * 등록부 rate limit은 우리 재시도 횟수를 모른다.
 */
export async function reserveIdempotency<T>(
  tx: postgres.TransactionSql,
  tenantId: string,
  key: string,
  requestHash: string,
): Promise<{ readonly replay: T } | { readonly replay: null }> {
  // 경쟁을 INSERT로 판정한다. 먼저 읽고 없으면 넣는 방식은 두 요청이 동시에
  // 통과할 수 있다.
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

  if (!previous) throw conflict("IDEMPOTENCY_IN_FLIGHT", "같은 요청이 처리 중이다");

  if (previous.request_hash !== requestHash) {
    throw conflict("IDEMPOTENCY_KEY_REUSE", "같은 key로 다른 요청이 왔다");
  }
  if (previous.response_snapshot === null) {
    throw conflict("IDEMPOTENCY_IN_FLIGHT", "같은 요청이 처리 중이다");
  }

  return { replay: previous.response_snapshot };
}

/**
 * 예약을 되돌린다.
 *
 * 외부 호출이나 뒤이은 쓰기가 실패했을 때 부른다. 없으면 그 key는 영원히
 * `IDEMPOTENCY_IN_FLIGHT`가 되고 클라이언트는 다시 시도할 방법이 없다.
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

/** 예약을 결과로 마감한다. 이후 같은 key는 이 응답을 그대로 받는다. */
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
      throw conflict("IDEMPOTENCY_KEY_REUSE", "같은 key로 다른 요청이 왔다");
    }
    if (previous.response_snapshot !== null) {
      return previous.response_snapshot;
    }
    throw conflict("IDEMPOTENCY_IN_FLIGHT", "같은 요청이 처리 중이다");
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
