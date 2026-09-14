import type postgres from "postgres";
import type { ScanVerdict } from "./scanner.js";

/**
 * quarantine 업로드 검사 루프 — 05 §5.2.
 *
 * `quarantined` 상태의 업로드를 하나씩 집어 스캐너에 넘기고 **결과를 API로**
 * 보고한다.
 *
 * 상태를 DB에 직접 쓰지 않는 이유: 같은 전이에 쓰기 경로가 둘이면 한쪽만
 * 느슨해진다. API에는 상태기계 검사·감사 기록·If-Match가 걸려 있고, worker가
 * 그것을 우회하면 그 보장이 "API를 통해 들어온 것에 한해서"가 된다.
 *
 * **DB 트랜잭션을 쥔 채 API를 부르지 않는다.** `FOR UPDATE`로 잠근 행을 API가
 * 다시 잠그려 하면 교착한다. 대신 lease를 걸고 트랜잭션을 닫은 뒤 검사한다.
 *
 * **오류를 감염으로 기록하지 않는다.** 감염 판정은 되돌릴 수 없으므로
 * (`scanned_infected → promoted` 경로가 상태기계에 없다), 스캐너 장애로 그 상태를
 * 만들면 정상 파일이 영구히 막힌다. 오류는 상태를 그대로 두고 다시 시도한다.
 */

export interface ScanStore {
  /** quarantine 객체를 읽는다. 없으면 null. */
  get(key: string): Promise<Uint8Array | null>;
}

/**
 * 검사 함수.
 *
 * 주입하는 이유: 감염·타임아웃·연결 실패 세 갈래가 이 코드의 핵심인데, 실제
 * 데몬으로는 그것들을 재현하기 어렵다. 재현할 수 없는 경우가 정확히 이 코드가
 * 다뤄야 하는 경우다.
 */
export type Scan = (bytes: Uint8Array) => Promise<ScanVerdict>;

/**
 * 검사 결과 보고.
 *
 * API의 `scan-result` route를 부른다. 실패하면 상태는 그대로 남고 다음 루프에서
 * 다시 시도된다 — 보고하지 못한 것을 검사하지 않은 것과 같게 다룬다.
 */
export type ReportResult = (input: {
  readonly uploadId: string;
  readonly version: number;
  readonly result: "clean" | "infected";
  readonly detail?: string;
}) => Promise<void>;

export type Log = (record: Record<string, unknown>) => void;

export interface ScanOptions {
  readonly maxAttempts: number;
  /** lease 유지 시간. 검사 + 보고에 걸리는 시간보다 넉넉해야 한다. */
  readonly leaseMs: number;
}

export interface ScanStepResult {
  readonly handled: boolean;
  readonly uploadId?: string;
  readonly verdict?: ScanVerdict["kind"];
  readonly signature?: string;
}

interface LeasedUpload {
  readonly id: string;
  readonly tenant_id: string;
  readonly object_key: string;
  readonly version: number;
}

/**
 * 한 건에 lease를 건다.
 *
 * `FOR UPDATE SKIP LOCKED`는 이 짧은 트랜잭션 안에서만 유지된다. 트랜잭션이
 * 닫힌 뒤의 중복은 `scan_leased_until`이 막는다 — 만료 전까지 다른 worker가
 * 같은 행을 집지 않고, 만료되면 가져갈 수 있어 죽은 worker의 파일이 영원히
 * 남지 않는다.
 */
async function leaseOne(
  sql: postgres.Sql,
  options: ScanOptions,
): Promise<LeasedUpload | undefined> {
  const rows = (await sql.begin(async (tx) => {
    const [row] = await tx<LeasedUpload[]>`
      SELECT id, tenant_id, object_key, version
      FROM core.object_uploads
      WHERE state = 'quarantined'
        AND scan_attempts < ${options.maxAttempts}
        AND (scan_leased_until IS NULL OR scan_leased_until < now())
      ORDER BY uploaded_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;

    if (!row) return [];

    // 시도 횟수를 검사 **전에** 올린다. 스캐너가 특정 파일에서 죽어도 그 파일이
    // 큐를 영원히 막지 않는다.
    await tx`
      UPDATE core.object_uploads
      SET scan_attempts = scan_attempts + 1,
          scan_leased_until = now() + ${`${Math.max(1, Math.round(options.leaseMs / 1000))} seconds`}::interval
      WHERE id = ${row.id}
    `;

    return [row];
  })) as LeasedUpload[];

  return rows[0];
}

/** 실패를 기록하고 lease를 즉시 푼다. 다음 루프에서 바로 다시 시도된다. */
async function recordFailure(
  sql: postgres.Sql,
  uploadId: string,
  reason: string,
): Promise<void> {
  await sql`
    UPDATE core.object_uploads
    SET rejection_reason = ${reason.slice(0, 300)}, scan_leased_until = NULL
    WHERE id = ${uploadId}
  `;
}

export async function scanOnce(
  sql: postgres.Sql,
  store: ScanStore,
  scan: Scan,
  report: ReportResult,
  options: ScanOptions,
  log: Log,
): Promise<ScanStepResult> {
  const row = await leaseOne(sql, options);
  if (!row) return { handled: false };

  const bytes = await store.get(row.object_key);
  if (!bytes) {
    // 객체가 없는데 DB에는 있다. 자동으로 정리하지 않는다 — 저장소 장애와
    // 실제 유실을 여기서 구분할 수 없다.
    await recordFailure(sql, row.id, "scan_error: object missing");
    log({ level: "error", msg: "scan.object_missing", uploadId: row.id });
    return { handled: true, uploadId: row.id, verdict: "error" };
  }

  const verdict = await scan(bytes);

  if (verdict.kind === "error") {
    await recordFailure(sql, row.id, `scan_error: ${verdict.reason}`);
    log({ level: "warn", msg: "scan.failed", uploadId: row.id, reason: verdict.reason });
    return { handled: true, uploadId: row.id, verdict: "error" };
  }

  try {
    await report({
      uploadId: row.id,
      version: row.version,
      result: verdict.kind,
      ...(verdict.kind === "infected" ? { detail: verdict.signature } : {}),
    });
  } catch (error) {
    // 보고에 실패한 것은 검사하지 않은 것과 같다. 상태를 그대로 두고 다시
    // 시도한다 — 여기서 DB를 직접 고치면 우회 경로를 만드는 셈이다.
    await recordFailure(sql, row.id, `report_error: ${String(error)}`);
    log({ level: "error", msg: "scan.report_failed", uploadId: row.id, error: String(error) });
    return { handled: true, uploadId: row.id, verdict: "error" };
  }

  log({
    level: verdict.kind === "infected" ? "warn" : "info",
    msg: `scan.${verdict.kind}`,
    uploadId: row.id,
    // 파일명은 남기지 않는다. 로그가 restricted 정보의 통로가 된다.
    ...(verdict.kind === "infected" ? { signature: verdict.signature } : {}),
  });

  return {
    handled: true,
    uploadId: row.id,
    verdict: verdict.kind,
    ...(verdict.kind === "infected" ? { signature: verdict.signature } : {}),
  };
}

/** 검사 대기 통계. 시도 상한에 닿은 것은 사람이 봐야 한다. */
export async function scanBacklog(sql: postgres.Sql, maxAttempts: number): Promise<{
  readonly pending: number;
  readonly stuck: number;
}> {
  const [row] = await sql<{ pending: string; stuck: string }[]>`
    SELECT
      count(*) FILTER (WHERE state = 'quarantined' AND scan_attempts < ${maxAttempts})
        AS pending,
      count(*) FILTER (WHERE state = 'quarantined' AND scan_attempts >= ${maxAttempts})
        AS stuck
    FROM core.object_uploads
  `;

  return { pending: Number(row?.pending ?? 0), stuck: Number(row?.stuck ?? 0) };
}
