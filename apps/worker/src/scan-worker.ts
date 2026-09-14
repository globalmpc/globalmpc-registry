import type postgres from "postgres";
import type { ScanVerdict } from "./scanner.js";

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
  /** Reads a quarantine object. null if absent. */
  get(key: string): Promise<Uint8Array | null>;
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

    // Increment the attempt count **before** scanning. If the scanner dies on a particular file,
    // that file does not block the queue forever.
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

/** Records the failure and releases the lease at once. The next loop retries immediately. */
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
    // The DB has the row but the object is missing. No automatic cleanup — a storage outage and
    // an actual loss are indistinguishable here.
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
    // A failed report equals no scan. Leave the state and retry — patching the DB directly here
    // would create a bypass path.
    await recordFailure(sql, row.id, `report_error: ${String(error)}`);
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
