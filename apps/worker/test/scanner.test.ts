import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import { parseClamResponse } from "../src/scanner.js";
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

  it("extracts the signature name from an infected response", () => {
    // False positives can only be checked if we know what triggered the verdict.
    expect(parseClamResponse("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      kind: "infected",
      signature: "Eicar-Test-Signature",
    });
  });

  // clamd reports what it could not look inside as a heuristic `FOUND` (`AlertEncrypted*`,
  // `AlertExceedsMax` in deploy/clamav/Dockerfile). Treating these as clean would let a malicious
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
      { state: string; scan_attempts: number; rejection_reason: string | null; version: number }[]
    >`
      SELECT state, scan_attempts, rejection_reason, version
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
