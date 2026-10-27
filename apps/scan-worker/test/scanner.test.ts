import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import { MAX_SCAN_BYTES, parseClamResponse } from "../src/scanner.js";
import { scanBacklog, scanOnce, type ScanStore } from "../src/scan-worker.js";
import type { ScanVerdict } from "../src/scanner.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
  * Virus scanning — 05 §5.2.
 *
  * The core of this file is **distinguishing errors from infections**. An infected verdict is
  * irreversible (the state machine has no `scanned_infected → promoted` path), so producing that
  * state from a scanner fault would block a clean file permanently.
 */

describe("ClamAV response parsing", () => {
  it("reads a clean response as clean", () => {
    expect(parseClamResponse("stream: OK\0")).toEqual({ kind: "clean" });
  });

  it.each(["NOT OK\0", "stream: NOT OK\0", "error: OK\0", "stream: ERROR\nstream: OK\0"])(
    "does not promote a malformed success suffix: %s",
    (response) => expect(parseClamResponse(response).kind).toBe("error"),
  );

  it("extracts the signature name from an infected response", () => {
    // False positives can only be checked if we know what triggered the verdict.
    expect(parseClamResponse("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      kind: "infected",
      signature: "Eicar-Test-Signature",
    });
  });

  // clamd reports what it could not look inside as a heuristic `FOUND` (`AlertEncrypted*`,
  // `AlertExceedsMax` in docker/clamav/clamd.conf). Treating these as clean would let a malicious
  // file in a password-protected or oversized archive be promoted.
  it("reads an encrypted-archive heuristic as infected", () => {
    expect(parseClamResponse("stream: Heuristics.Encrypted.Zip FOUND\0")).toEqual({
      kind: "infected",
      signature: "Heuristics.Encrypted.Zip",
    });
  });

  it("reads a scan-limit heuristic as infected", () => {
    expect(parseClamResponse("stream: Heuristics.Limits.Exceeded.MaxRecursion FOUND\0")).toEqual({
      kind: "infected",
      signature: "Heuristics.Limits.Exceeded.MaxRecursion",
    });
  });

  it("does not read an ERROR response as infected", () => {
    const verdict = parseClamResponse("INSTREAM size limit exceeded. ERROR\0");
    expect(verdict.kind).toBe("error");
  });

  it("an empty response is also an error", () => {
    // Passing an undetermined result as clean is the same as having no scan.
    expect(parseClamResponse("").kind).toBe("error");
  });

  it("does not pass an unknown format as clean", () => {
    expect(parseClamResponse("something unexpected").kind).toBe("error");
  });
});

describeDb("scan worker", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let projectId: string;
  let uploadId: string;

  const logs: Record<string, unknown>[] = [];
  const log = (record: Record<string, unknown>) => {
    logs.push(record);
  };

  /** Scanner double. A real daemon makes timeouts and connection failures hard to reproduce. */
  let verdict: ScanVerdict = { kind: "clean" };
  const scan = async () => verdict;
  const options = { maxAttempts: 3, leaseMs: 60_000 };

  /**
    * Report double.
   *
    * In reality the API changes the state, so this updates the DB instead. What this test checks is
    * "when it reports and when it does not".
   */
  let reportError: Error | null = null;
  const reported: { uploadId: string; result: string }[] = [];
  const report = async (input: {
    uploadId: string;
    version: number;
    result: "clean" | "infected";
    detail?: string;
  }) => {
    if (reportError) throw reportError;
    reported.push({ uploadId: input.uploadId, result: input.result });
    await sql`
      UPDATE core.object_uploads
      SET state = ${input.result === "clean" ? "scanned_clean" : "scanned_infected"},
          scanned_at = now(),
          version = version + 1,
          rejection_reason = ${input.detail ?? null}
      WHERE id = ${input.uploadId}
    `;
  };

  const store: ScanStore = {
    async get(key) {
      return objects.get(key) ?? null;
    },
  };
  const objects = new Map<string, Uint8Array>();

  beforeAll(async () => {
    sql = postgres(process.env["DATABASE_URL"]!, { onnotice: () => {}, prepare: false });
    await runMigrations(sql);
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    logs.length = 0;
    objects.clear();
    reported.length = 0;
    reportError = null;
    verdict = { kind: "clean" };

    // If another case's pending upload is picked first, there is no telling what was verified.
    // Rows cannot be deleted — object_uploads is append-only (0007). Only remove them from the queue.
    await sql`
      UPDATE core.object_uploads
      SET scan_attempts = 999
      WHERE state = 'quarantined'
    `;

    tenantId = randomUUID();
    projectId = randomUUID();
    uploadId = randomUUID();

    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenantId}, ${`scan-${tenantId.slice(0, 8)}`}, 'scan test')
    `;
    await sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${randomUUID()}, ${tenantId}, 'scan org', 'MNG')
    `;
    const [org] = await sql<{ id: string }[]>`
      SELECT id FROM core.organizations WHERE tenant_id = ${tenantId} LIMIT 1
    `;
    await sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${tenantId}, ${`SCAN-${projectId.slice(0, 6)}`}, 'scan project',
        'MNG', ARRAY['copper'], ${org!.id}
      )
    `;

    const key = `quarantine/${tenantId}/${uploadId}`;
    objects.set(key, new Uint8Array([1, 2, 3]));

    await sql`
      INSERT INTO core.object_uploads (
        id, tenant_id, project_id, object_key, content_hash, byte_size,
        content_type, sensitivity, state
      ) VALUES (
        ${uploadId}, ${tenantId}, ${projectId}, ${key}, ${`0x${"11".repeat(32)}`},
        3, 'application/pdf', 'restricted', 'quarantined'
      )
    `;
  });

  const step = () => scanOnce(sql, store, scan, report, options, log);

  async function stateOf() {
    const [row] = await sql<
      { state: string; scan_attempts: number; scan_leased_until: string | null; rejection_reason: string | null; version: number }[]
    >`
      SELECT state, scan_attempts, scan_leased_until::text, rejection_reason, version
      FROM core.object_uploads WHERE id = ${uploadId}
    `;
    return row!;
  }

  it("moves a clean verdict to scanned_clean and bumps the version", async () => {
    const before = await stateOf();
    const result = await step();

    expect(result.verdict).toBe("clean");
    const after = await stateOf();
    expect(after.state).toBe("scanned_clean");
    expect(after.version).toBe(before.version + 1);
  });

  it("records the signature name for an infected verdict", async () => {
    verdict = { kind: "infected", signature: "Eicar-Test-Signature" };
    const result = await step();

    expect(result.verdict).toBe("infected");
    const after = await stateOf();
    expect(after.state).toBe("scanned_infected");
    // Without knowing what triggered the verdict, false positives cannot be checked.
    expect(after.rejection_reason).toBe("Eicar-Test-Signature");
  });

  it("does not record a scan failure as infected", async () => {
    verdict = { kind: "error", reason: "scan timeout" };
    const result = await step();

    expect(result.verdict).toBe("error");
    const after = await stateOf();
    // An infected verdict is irreversible. Producing it from a scanner fault would block a clean
    // file permanently.
    expect(after.state).toBe("quarantined");
    expect(after.rejection_reason).toContain("scan_error");
  });

  it("resumes once the scanner comes back after a failure", async () => {
    verdict = { kind: "error", reason: "connection refused" };
    await step();

    verdict = { kind: "clean" };
    await step();
    expect((await stateOf()).state).toBe("scanned_clean");
  });

  it("does not change state when reporting fails", async () => {
    reportError = new Error("503 UNAVAILABLE");
    const result = await step();

    expect(result.verdict).toBe("error");
    const after = await stateOf();
    // Not reported is the same as not scanned. Fixing the DB directly would create a path that
    // bypasses the API's state machine checks.
    expect(after.state).toBe("quarantined");
    expect(after.rejection_reason).toContain("report_error");
  });

  it("does not change state when the object is missing", async () => {
    objects.clear();
    const result = await step();

    expect(result.verdict).toBe("error");
    // Store outage and actual loss cannot be told apart here. No automatic cleanup.
    expect((await stateOf()).state).toBe("quarantined");
  });

  it("increments the attempt count before reading", async () => {
    verdict = { kind: "error", reason: "boom" };
    await step();
    // Even if the scanner dies on a particular file, that file does not block the queue forever.
    expect((await stateOf()).scan_attempts).toBe(1);
  });

  it("another worker does not pick it up while the lease is valid", async () => {
    // A second worker reading the same file during a long scan is wasteful, and if the two results
    // disagree there is no telling which is right.
    const leaseOnly = { maxAttempts: 3, leaseMs: 60_000 };
    const slowScan = () => new Promise<ScanVerdict>(() => {});

    void scanOnce(sql, store, slowScan, report, leaseOnly, log);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await scanOnce(sql, store, scan, report, leaseOnly, log);
    expect(second.handled).toBe(false);
  });

  it("stops picking up once the attempt cap is reached", async () => {
    verdict = { kind: "error", reason: "boom" };
    await step();
    await step();
    await step();

    const next = await step();
    expect(next.handled).toBe(false);

    // Not marked infected. The state stays quarantined; only attempts stop.
    expect((await stateOf()).state).toBe("quarantined");
  });

  it("backlog counts stuck items separately", async () => {
    verdict = { kind: "error", reason: "boom" };
    await step();
    await step();
    await step();

    const backlog = await scanBacklog(sql, options.maxAttempts);
    // Rows left by earlier cases are counted too, so check a minimum. The point here is
    // "pending and stuck are counted separately", not the absolute number.
    expect(backlog.pending).toBe(0);
    expect(backlog.stuck).toBeGreaterThanOrEqual(1);
  });

  it("preserves upload attempts across three unavailable polls and scans after recovery", async () => {
    let available = false;
    let reads = 0;
    let scans = 0;
    const guarded = { ...options, scannerAvailable: async () => available };
    const countedStore = { get: async (key: string) => { reads++; return store.get(key); } };
    const countedScan = async (): Promise<ScanVerdict> => { scans++; return { kind: "clean" }; };
    const before = await stateOf();
    for (let poll = 0; poll < 3; poll++) {
      expect(await scanOnce(sql, countedStore, countedScan, report, guarded, log))
        .toEqual({ handled: false, scannerUnavailable: true });
    }
    expect(await stateOf()).toEqual(before);
    expect(reads).toBe(0);
    expect(scans).toBe(0);
    expect(reported).toEqual([]);
    available = true;
    expect((await scanOnce(sql, countedStore, countedScan, report, guarded, log)).verdict).toBe("clean");
    expect((await stateOf()).state).toBe("scanned_clean");
    expect((await stateOf()).scan_attempts).toBe(1);
    expect(reads).toBe(1);
    expect(scans).toBe(1);
  });

  it("refunds only pre-connect outages that race the successful readiness probe", async () => {
    const guarded = { ...options, scannerAvailable: async () => true };
    const disconnected = async (): Promise<ScanVerdict> => ({ kind: "error", reason: "connection refused", unavailable: true });
    for (let poll = 0; poll < 3; poll++) {
      expect((await scanOnce(sql, store, disconnected, report, guarded, log)).scannerUnavailable).toBe(true);
      const after = await stateOf();
      expect(after.scan_attempts).toBe(0);
      expect(after.scan_leased_until).toBeNull();
      expect(after.state).toBe("quarantined");
    }
    expect(reported).toEqual([]);
    expect((await step()).verdict).toBe("clean");
    expect((await stateOf()).state).toBe("scanned_clean");
    expect((await stateOf()).scan_attempts).toBe(1);
  });

  it("still exhausts the budget when connected scans fail on the same file", async () => {
    const guarded = { ...options, scannerAvailable: async () => true };
    const connectedFailure = async (): Promise<ScanVerdict> => ({ kind: "error", reason: "connection reset after upload" });
    for (let attempt = 0; attempt < 3; attempt++) {
      expect((await scanOnce(sql, store, connectedFailure, report, guarded, log)).handled).toBe(true);
    }
    expect((await scanOnce(sql, store, connectedFailure, report, guarded, log)).handled).toBe(false);
    expect((await stateOf()).scan_attempts).toBe(3);
    expect((await stateOf()).state).toBe("quarantined");
    expect(reported).toEqual([]);
  });

  it("never refunds or releases a replacement worker's lease after its own lease expires", async () => {
    let startedFirst!: () => void;
    let finishFirst!: (result: ScanVerdict) => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const first = scanOnce(sql, store, () => {
      startedFirst();
      return new Promise<ScanVerdict>((resolve) => { finishFirst = resolve; });
    }, report, options, log);
    await firstStarted;
    await sql`UPDATE core.object_uploads SET scan_leased_until = now() - interval '1 second' WHERE id = ${uploadId}`;
    let startedSecond!: () => void;
    let finishSecond!: (result: ScanVerdict) => void;
    const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
    const second = scanOnce(sql, store, () => {
      startedSecond();
      return new Promise<ScanVerdict>((resolve) => { finishSecond = resolve; });
    }, report, options, log);
    await secondStarted;
    const replacement = await stateOf();
    expect(replacement.scan_attempts).toBe(2);
    expect(replacement.scan_leased_until).not.toBeNull();
    finishFirst({ kind: "error", reason: "connection refused", unavailable: true });
    await first;
    expect(await stateOf()).toEqual(replacement);
    finishSecond({ kind: "error", reason: "file-specific scan failure" });
    await second;
    expect((await stateOf()).scan_attempts).toBe(2);
    expect((await stateOf()).scan_leased_until).toBeNull();
  });

  it("leases the maximum accepted file for its full read, scan and report budget", async () => {
    await sql`UPDATE core.object_uploads SET scan_attempts=999 WHERE id=${uploadId}`;
    uploadId=randomUUID();
    await sql`INSERT INTO core.object_uploads
      (id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state)
      VALUES(${uploadId},${tenantId},${projectId},${`quarantine/${tenantId}/${uploadId}`},${`0x${"22".repeat(32)}`},
        ${MAX_SCAN_BYTES},'application/pdf','restricted','quarantined')`;
    let started!: () => void;
    let finish!: (bytes: Uint8Array | null) => void;
    const reading = new Promise<void>((resolve) => { started=resolve; });
    const pending = scanOnce(sql, {get: () => { started(); return new Promise((resolve) => { finish=resolve; }); }}, scan, report, options, log);
    await reading;
    const [lease] = await sql<{remaining:number}[]>`SELECT extract(epoch FROM(scan_leased_until-now()))::float8 AS remaining FROM core.object_uploads WHERE id=${uploadId}`;
    expect(lease!.remaining).toBeGreaterThan(450);
    expect(lease!.remaining).toBeLessThanOrEqual(461);
    finish(null);
    await pending;
  });

  it("discards a timed-out object read without scanning its late result", async () => {
    let finish!: (bytes: Uint8Array) => void;
    let scans=0;
    const result = await scanOnce(sql, {get: () => new Promise((resolve) => { finish=resolve; })}, async () => { scans++; return {kind:"clean"}; }, report,
      {...options,objectReadTimeoutMs:5}, log);
    expect(result.verdict).toBe("error");
    finish(new Uint8Array([1,2,3]));
    await Promise.resolve();
    expect(scans).toBe(0);
    expect(reported).toEqual([]);
    expect((await stateOf()).state).toBe("quarantined");
    expect((await stateOf()).scan_leased_until).toBeNull();
  });

  it("does not scan or report an object whose bytes differ from leased size metadata", async () => {
    let scans=0;
    const result=await scanOnce(sql,{get:async()=>new Uint8Array(4)},async()=>{scans++;return {kind:"clean"};},report,options,log);
    expect(result.verdict).toBe("error");
    expect(scans).toBe(0);
    expect(reported).toEqual([]);
  });

  it("does nothing when no uploads are pending", async () => {
    // `promoted` requires an artifact (DB CHECK). The goal is to remove it from the queue, so
    // `rejected` is used.
    // A rejection requires a reason (DB CHECK) — a rejection without a reason is not stored.
    await sql`
      UPDATE core.object_uploads
      SET state = 'rejected', rejection_reason = 'test cleanup'
      WHERE id = ${uploadId}
    `;
    expect((await step()).handled).toBe(false);
  });
});
