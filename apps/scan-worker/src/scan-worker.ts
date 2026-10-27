import type postgres from "postgres";
import { MAX_SCAN_BYTES, scanDeadlineMs, type ScanVerdict } from "./scanner.js";

/**
 * Quarantine upload scan loop — 05 §5.2.
 *
 * Claims `quarantined` uploads one at a time, hands them to the scanner, and reports **the
 * result through the API**.
 *
 * Why state is not written to the DB directly: two write paths for one transition let one of
 * them go lax. The API enforces state machine checks, audit records, and If-Match; a worker
 * bypassing it would narrow those guarantees to "only what came through the API".
 *
 * **Never call the API while holding a DB transaction.** The API would try to re-lock the row
 * held by `FOR UPDATE` and deadlock. Instead, take a lease, close the transaction, then scan.
 *
 * **Never record an error as infected.** An infected verdict is irreversible (the state
 * machine has no `scanned_infected → promoted` path), so producing it from a scanner outage
 * blocks clean files permanently. On error, leave the state as is and retry.
 */

export interface ScanStore {
  /** Reads a quarantine object. On abort, settle only after transport/body cleanup. null if absent. */
  get(key: string, signal?: AbortSignal): Promise<Uint8Array | null>;
}

/**
 * Scan function.
 *
 * Injected because the three branches — infected, timeout, connection failure — are the core
 * of this code, and a real daemon makes them hard to reproduce. The cases that cannot be
 * reproduced are exactly the ones this code must handle.
 */
export type Scan = (bytes: Uint8Array) => Promise<ScanVerdict>;

/**
 * Scan result report.
 *
 * Calls the API `scan-result` route. On failure the state stays and the next loop retries —
 * an unreported scan is treated the same as no scan.
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
  /** Lease duration. Must comfortably exceed scan + report time. */
  readonly leaseMs: number;
  readonly scannerTimeoutMs?: number;
  /** Tests may lower the object read deadline; production defaults to 60 seconds. */
  readonly objectReadTimeoutMs?: number;
  /** Production checks PING before claiming a row; test doubles may omit the transport probe. */
  readonly scannerAvailable?: () => Promise<boolean>;
}

export interface ScanStepResult {
  readonly handled: boolean;
  readonly scannerUnavailable?: true;
  readonly uploadId?: string;
  readonly verdict?: ScanVerdict["kind"];
  readonly signature?: string;
}

interface LeasedUpload {
  readonly id: string;
  readonly tenant_id: string;
  readonly object_key: string;
  readonly version: number;
  readonly byte_size: string;
  readonly scan_attempts: number;
  readonly lease_token: string;
}

/**
 * Leases one row.
 *
 * `FOR UPDATE SKIP LOCKED` holds only within this short transaction. After it closes,
 * `scan_leased_until` prevents duplicates — no other worker claims the row before expiry, and
 * after expiry it can be taken, so a dead worker's file is not stranded forever.
 */
async function leaseOne(
  sql: postgres.Sql,
  options: ScanOptions,
): Promise<LeasedUpload | undefined> {
  const rows = (await sql.begin(async (tx) => {
    const [row] = await tx<LeasedUpload[]>`
      SELECT id, tenant_id, object_key, version, byte_size
      FROM core.object_uploads
      WHERE state = 'quarantined'
        AND scan_attempts < ${options.maxAttempts}
        AND (scan_leased_until IS NULL OR scan_leased_until < now())
      ORDER BY uploaded_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;

    if (!row) return [];

    // Include storage (60s) and all bounded API login/report requests (<=90s + 30s margin).
    // Oversized legacy rows still get a bounded attempt and fail validation, rather than
    // blocking every later upload before a lease can be obtained.
    const scanBudget = scanDeadlineMs(Math.min(Number(row.byte_size), MAX_SCAN_BYTES), options.scannerTimeoutMs);
    const leaseMs = Math.max(options.leaseMs, (options.objectReadTimeoutMs ?? 60_000) + scanBudget + 120_000);
    // Increment the attempt count **before** scanning. If the scanner dies on a particular file,
    // that file does not block the queue forever.
    const [leased] = await tx<LeasedUpload[]>`
      UPDATE core.object_uploads
      SET scan_attempts = scan_attempts + 1,
          scan_leased_until = now() + ${`${Math.max(1, Math.ceil(leaseMs / 1000))} seconds`}::interval
      WHERE id = ${row.id}
      RETURNING id, tenant_id, object_key, version, byte_size, scan_attempts,
                scan_leased_until::text AS lease_token
    `;

    return leased ? [leased] : [];
  })) as LeasedUpload[];

  return rows[0];
}

/** Release only this exact lease; a late worker must not change a replacement worker's budget. */
async function recordFailure(
  sql: postgres.Sql,
  row: LeasedUpload,
  reason: string,
  refundAttempt = false,
): Promise<void> {
  await sql`
    UPDATE core.object_uploads
    SET rejection_reason = ${reason.slice(0, 300)}, scan_leased_until = NULL,
        scan_attempts = scan_attempts - ${refundAttempt ? 1 : 0}
    WHERE id = ${row.id} AND state = 'quarantined' AND version = ${row.version}
      AND scan_attempts = ${row.scan_attempts}
      AND scan_leased_until = ${row.lease_token}::text::timestamptz
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
  if (options.scannerAvailable && !(await options.scannerAvailable())) {
    log({ level: "warn", msg: "scan.unavailable" });
    return { handled: false, scannerUnavailable: true };
  }
  const row = await leaseOne(sql, options);
  if (!row) return { handled: false };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("object read timeout")), options.objectReadTimeoutMs ?? 60_000);
  let bytes: Uint8Array | null;
  try {
    // Await transport cancellation before releasing the lease: a timeout race alone leaves
    // the old S3 download alive while the next attempt allocates another response buffer.
    bytes = await store.get(row.object_key, controller.signal);
    controller.signal.throwIfAborted();
  } catch {
    await recordFailure(sql, row, "scan_error: object read failed or timed out");
    log({ level: "error", msg: "scan.object_read_failed", uploadId: row.id });
    return { handled: true, uploadId: row.id, verdict: "error" };
  } finally { clearTimeout(timer); }
  if (!bytes) {
    // The DB has the row but the object is missing. No automatic cleanup — a storage outage and
    // an actual loss are indistinguishable here.
    await recordFailure(sql, row, "scan_error: object missing");
    log({ level: "error", msg: "scan.object_missing", uploadId: row.id });
    return { handled: true, uploadId: row.id, verdict: "error" };
  }

  if (bytes.byteLength !== Number(row.byte_size)) {
    await recordFailure(sql, row, "scan_error: object size does not match upload metadata");
    return { handled: true, uploadId: row.id, verdict: "error" };
  }
  const verdict = await scan(bytes);

  if (verdict.kind === "error" && verdict.unavailable) {
    // No connection accepted these bytes. Refund a pre-connect outage, but never a reset or
    // timeout after connection: a pathological upload may itself have killed the parser.
    await recordFailure(sql, row, "scan_unavailable", true);
    log({ level: "warn", msg: "scan.unavailable", uploadId: row.id });
    return { handled: false, scannerUnavailable: true, uploadId: row.id, verdict: "error" };
  }

  if (verdict.kind === "error") {
    await recordFailure(sql, row, `scan_error: ${verdict.reason}`);
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
    // A failed report equals no scan. Leave the state and retry — patching the DB directly here
    // would create a bypass path.
    await recordFailure(sql, row, `report_error: ${String(error)}`);
    log({ level: "error", msg: "scan.report_failed", uploadId: row.id, error: String(error) });
    return { handled: true, uploadId: row.id, verdict: "error" };
  }

  log({
    level: verdict.kind === "infected" ? "warn" : "info",
    msg: `scan.${verdict.kind}`,
    uploadId: row.id,
    // No file names. The log would become a channel for restricted information.
    ...(verdict.kind === "infected" ? { signature: verdict.signature } : {}),
  });

  return {
    handled: true,
    uploadId: row.id,
    verdict: verdict.kind,
    ...(verdict.kind === "infected" ? { signature: verdict.signature } : {}),
  };
}

/** Scan queue stats. Uploads at the attempt cap need a person to look at them. */
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
