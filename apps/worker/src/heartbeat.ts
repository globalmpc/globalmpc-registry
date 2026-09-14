import type postgres from "postgres";

/**
 * worker 생존 신호.
 *
 * **왜 필요한가:** worker 셋(outbox·anchor·scan)이 살아 있는지 알 방법이 없었다.
 * 특히 `scan`은 compose 프로파일로 꺼 둘 수 있고, 꺼져 있으면 업로드가
 * `quarantined`에서 멈춘다. 그 정지는 **오류가 아니라 대기처럼 보인다.**
 *
 * 쌓인 행을 세는 것으로는 부족하다. 업로드가 아직 없는 배포에서는 0이고, 그 0은
 * "정상"과 구분되지 않는다. worker가 스스로 남기는 신호는 큐가 비어 있어도 나온다.
 *
 * **실패해도 루프를 멈추지 않는다.** 신호를 못 남긴 것과 일을 못 한 것은 다르며,
 * 전자 때문에 후자를 멈추면 관측이 가용성을 깎는다. 대신 조용히 넘기지 않고
 * 호출자가 로그를 남길 수 있게 결과를 돌려준다.
 */
export type WorkerKind = "outbox" | "anchor" | "scan";

export async function recordHeartbeat(
  sql: postgres.Sql,
  kind: WorkerKind,
  detail?: Record<string, unknown>,
): Promise<boolean> {
  try {
    await sql`
      INSERT INTO core.worker_heartbeats (worker_kind, last_seen_at, detail)
      VALUES (${kind}, now(), ${detail ? sql.json(detail as never) : null})
      ON CONFLICT (worker_kind) DO UPDATE
      SET last_seen_at = now(), detail = EXCLUDED.detail
    `;
    return true;
  } catch {
    return false;
  }
}

/**
 * 매 주기가 아니라 **간격을 두고** 남긴다.
 *
 * scan worker의 기본 주기는 3초다. 그대로 쓰면 초당 한 번씩 UPDATE가 돌고, 그
 * 부하는 신호가 주는 값보다 크다. 알림은 분 단위로 판정하므로 15초면 충분하다.
 */
export function createHeartbeat(
  sql: postgres.Sql,
  kind: WorkerKind,
  intervalMs = 15_000,
): (detail?: Record<string, unknown>) => Promise<void> {
  let lastAt = 0;
  return async (detail) => {
    const now = Date.now();
    if (now - lastAt < intervalMs) return;
    lastAt = now;
    await recordHeartbeat(sql, kind, detail);
  };
}
