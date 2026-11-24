import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import { MAX_SCAN_BYTES, parseClamResponse } from "../src/scanner.js";
import { resolveScanSubject, scanBacklog, scanOnce, type ScanStore } from "../src/scan-worker.js";
import type { ScanVerdict } from "../src/scanner.js";
import { keccak256 } from "viem";

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
  let scanSql: postgres.Sql;
  /** The deployed login's attributes: `mpc_worker_login` is BYPASSRLS (`login-roles`). */
  let bypassSql: postgres.Sql;
  const scanRole = `scan_rls_${randomUUID().replaceAll("-", "")}`;
  const bypassRole = `scan_bypass_${randomUUID().replaceAll("-", "")}`;
  let subjectId: string;
  let projectId: string;
  let uploadId: string;

  const logs: Record<string, unknown>[] = [];
  const log = (record: Record<string, unknown>) => {
    logs.push(record);
  };

  /** Scanner double. A real daemon makes timeouts and connection failures hard to reproduce. */
  let verdict: ScanVerdict = { kind: "clean" };
  const scan = async () => verdict;
  // Each case's worker acts as a fresh scan service subject bound to that case's project, so
  // uploads other cases (or other suites sharing the database) leave behind are out of its reach.
  const options = {
    maxAttempts: 3,
    leaseMs: 60_000,
    get subjectId() {
      return subjectId;
    },
  };

  /** A scan service subject, as `service-token ensure` creates one, optionally bound to a project. */
  async function scanSubject(project: string | null, scopes = ["scan_result"]): Promise<{ id: string; token: string }> {
    const id = randomUUID();
    const token = `mpcsvc_${randomUUID().replaceAll("-", "")}`;
    await sql`INSERT INTO core.subjects (id, kind, display_name, assurance_level)
      VALUES (${id}, 'service', 'scan-worker', 'high_assurance')`;
    await sql`INSERT INTO core.role_bindings (id, subject_id, role, project_id)
      VALUES (${randomUUID()}, ${id}, 'scan_service', ${project})`;
    await sql`INSERT INTO core.service_tokens (id, subject_id, label, token_hash, scopes, expires_at)
      VALUES (${randomUUID()}, ${id}, 'scan-worker', ${keccak256(new TextEncoder().encode(token))},
              ${scopes}::text[], now() + interval '1 day')`;
    return { id, token };
  }

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
    await sql.unsafe(`CREATE ROLE ${scanRole} NOLOGIN NOSUPERUSER NOBYPASSRLS IN ROLE mpc_worker`);
    scanSql = postgres(process.env["DATABASE_URL"]!, {
      max: 2, onnotice: () => {}, prepare: false, connection: { role: scanRole },
    });
    await sql.unsafe(`CREATE ROLE ${bypassRole} NOLOGIN NOSUPERUSER BYPASSRLS IN ROLE mpc_worker`);
    bypassSql = postgres(process.env["DATABASE_URL"]!, {
      max: 2, onnotice: () => {}, prepare: false, connection: { role: bypassRole },
    });
  });

  afterAll(async () => {
    await scanSql?.end();
    await bypassSql?.end();
    await sql.unsafe(`DROP ROLE IF EXISTS ${scanRole}`);
    await sql.unsafe(`DROP ROLE IF EXISTS ${bypassRole}`);
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

    projectId = randomUUID();
    uploadId = randomUUID();
    const orgId = randomUUID();

    await sql`
      INSERT INTO core.organizations (id, legal_name, jurisdiction)
      VALUES (${orgId}, 'scan org', 'MNG')
    `;
    await sql`
      INSERT INTO core.projects (
        id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${`SCAN-${projectId.slice(0, 6)}`}, 'scan project',
        'MNG', ARRAY['copper'], ${orgId}
      )
    `;
    subjectId = (await scanSubject(projectId)).id;

    const key = `quarantine/${uploadId}`;
    objects.set(key, new Uint8Array([1, 2, 3]));

    await sql`
      INSERT INTO core.object_uploads (
        id, project_id, object_key, content_hash, byte_size,
        content_type, sensitivity, state
      ) VALUES (
        ${uploadId}, ${projectId}, ${key}, ${`0x${"11".repeat(32)}`},
        3, 'application/pdf', 'restricted', 'quarantined'
      )
    `;
  });

  const step = () => scanOnce(scanSql, store, scan, report, options, log);

  async function stateOf() {
    const [row] = await sql<
      { state: string; scan_attempts: number; scan_leased_until: string | null; rejection_reason: string | null; version: number }[]
    >`
      SELECT state, scan_attempts, scan_leased_until::text, rejection_reason, version
      FROM core.object_uploads WHERE id = ${uploadId}
    `;
    return row!;
  }

  it("processes what its service subject reaches with RLS enforced and releases pooled actor context", async () => {
    const [role] = await scanSql<{ rolsuper: boolean; rolbypassrls: boolean }[]>`
      SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user`;
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false });
    expect(await scanSql`SELECT id FROM core.object_uploads WHERE id=${uploadId}`).toEqual([]);
    expect(await scanBacklog(scanSql, options.maxAttempts, subjectId)).toEqual({ pending: 1, stuck: 0 });
    expect((await step()).verdict).toBe("clean");
    expect((await stateOf()).state).toBe("scanned_clean");
    // Once the actor transaction ends, every pooled connection must again see no rows.
    await Promise.all([1, 2].map(async () => {
      expect(await scanSql`SELECT id FROM core.object_uploads WHERE id=${uploadId}`).toEqual([]);
    }));
  });

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

  it("gives the attempt back when the API refuses the worker's token, so the file is retried", async () => {
    // As the API client throws it: the status, and a message that never quotes the token.
    reportError = Object.assign(new Error("401 SERVICE_TOKEN_INVALID: unknown token"), { status: 401 });
    for (let i = 0; i < options.maxAttempts + 2; i += 1) {
      const result = await step();
      expect(result.verdict).toBe("error");
      // The loop backs off on this flag instead of leasing again at once.
      expect(result.unauthorized).toBe(true);
    }
    const [row] = await sql<{ scan_attempts: number; state: string }[]>`
      SELECT scan_attempts, state FROM core.object_uploads WHERE id = ${uploadId}
    `;
    expect(row).toEqual({ scan_attempts: 0, state: "quarantined" });
    expect(logs.some((record) => record["msg"] === "scan.report_unauthorized")).toBe(true);

    // Once the token is registered, the next pass reports it.
    reportError = null;
    await step();
    expect((await stateOf()).state).toBe("scanned_clean");
  });

  it("still counts the attempt when reporting fails for another reason", async () => {
    reportError = Object.assign(new Error("500 INTERNAL"), { status: 500 });
    expect((await step()).unauthorized).toBeUndefined();
    const [row] = await sql<{ scan_attempts: number }[]>`
      SELECT scan_attempts FROM core.object_uploads WHERE id = ${uploadId}
    `;
    expect(row!.scan_attempts).toBe(1);
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
    const leaseOnly = { subjectId, maxAttempts: 3, leaseMs: 60_000 };
    const slowScan = () => new Promise<ScanVerdict>(() => {});

    void scanOnce(scanSql, store, slowScan, report, leaseOnly, log);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await scanOnce(scanSql, store, scan, report, leaseOnly, log);
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

    const backlog = await scanBacklog(scanSql, options.maxAttempts, subjectId);
    // Only uploads this subject reaches are counted, so earlier cases' rows are not.
    expect(backlog).toEqual({ pending: 0, stuck: 1 });
  });

  it.each([
    ["with RLS enforced", () => scanSql, false],
    ["as the deployed BYPASSRLS worker login", () => bypassSql, true],
  ] as const)("never leases, scans or counts an upload of a project its subject does not reach, %s", async (_label, db, bypasses) => {
    const [role] = await db()<{ rolbypassrls: boolean }[]>`SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user`;
    expect(role!.rolbypassrls).toBe(bypasses);
    // A scan subject bound to one project reaches no other: leasing another project's upload
    // would scan a file the API refuses to take a report on and burn its attempts.
    const otherOrg = randomUUID();
    await sql`
      INSERT INTO core.organizations (id, legal_name, jurisdiction)
      VALUES (${otherOrg}, 'other org', 'MNG')
    `;
    const otherProject = randomUUID();
    await sql`
      INSERT INTO core.projects (
        id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${otherProject}, ${`OTH-${otherProject.slice(0, 6)}`}, 'other project',
        'MNG', ARRAY['copper'], ${otherOrg}
      )
    `;
    const otherUpload = randomUUID();
    const otherKey = `quarantine/${otherUpload}`;
    objects.set(otherKey, new Uint8Array([4, 5, 6]));
    // Older than this project's upload, so it would be first in line without the reach filter.
    await sql`
      INSERT INTO core.object_uploads (
        id, project_id, object_key, content_hash, byte_size,
        content_type, sensitivity, state, uploaded_at
      ) VALUES (
        ${otherUpload}, ${otherProject}, ${otherKey}, ${`0x${"22".repeat(32)}`},
        3, 'application/pdf', 'restricted', 'quarantined', now() - interval '1 day'
      )
    `;
    const otherState = () => sql<{ state: string; scan_attempts: number; scan_leased_until: string | null; version: number }[]>`
      SELECT state, scan_attempts, scan_leased_until::text, version FROM core.object_uploads WHERE id = ${otherUpload}
    `;
    const [before] = await otherState();
    const keys: string[] = [];
    const watched: ScanStore = { async get(key) { keys.push(key); return objects.get(key) ?? null; } };

    expect((await scanOnce(db(), watched, scan, report, options, log)).uploadId).toBe(uploadId);
    expect((await scanOnce(db(), watched, scan, report, options, log)).handled).toBe(false);
    expect(keys).toEqual([`quarantine/${uploadId}`]);
    expect(reported.map((entry) => entry.uploadId)).toEqual([uploadId]);
    const [after] = await otherState();
    expect(after).toEqual(before);
    expect(after).toMatchObject({ state: "quarantined", scan_attempts: 0, scan_leased_until: null });
    // Nor does it show up in this worker's backlog; a subject bound to that project sees it.
    expect(await scanBacklog(db(), options.maxAttempts, subjectId)).toEqual({ pending: 0, stuck: 0 });
    const otherSubject = (await scanSubject(otherProject)).id;
    expect((await scanBacklog(db(), options.maxAttempts, otherSubject)).pending).toBe(1);
    await sql`UPDATE core.object_uploads SET scan_attempts = 999 WHERE id = ${otherUpload}`;
  });

  it("reaches every project's uploads as a Registry-wide scan subject, as deployed", async () => {
    const registryWide = (await scanSubject(null)).id;
    expect((await scanBacklog(scanSql, options.maxAttempts, registryWide)).pending).toBeGreaterThanOrEqual(1);
    const [seen] = await scanSql.begin(async (tx) => {
      await tx`SELECT set_config('app.actor_subject_id', ${registryWide}, true)`;
      return tx`SELECT id FROM core.object_uploads WHERE id = ${uploadId}`;
    });
    expect(seen).toEqual({ id: uploadId });
  });

  it("leases nothing for a subject without a live binding, or without any subject", async () => {
    const revoked = (await scanSubject(projectId)).id;
    await sql`UPDATE core.role_bindings SET revoked_at = now() WHERE subject_id = ${revoked}`;
    const suspended = (await scanSubject(projectId)).id;
    await sql`UPDATE core.subjects SET suspended_at = now() WHERE id = ${suspended}`;
    for (const nobody of [revoked, suspended, randomUUID()]) {
      expect(await scanBacklog(scanSql, options.maxAttempts, nobody)).toEqual({ pending: 0, stuck: 0 });
      expect((await scanOnce(scanSql, store, scan, report, { ...options, subjectId: nobody }, log)).handled).toBe(false);
    }
    expect((await stateOf()).scan_attempts).toBe(0);
  });

  it("resolves its subject from a live scan_result token and from nothing else", async () => {
    const live = await scanSubject(projectId);
    expect(await resolveScanSubject(scanSql, live.token)).toBe(live.id);
    expect(await resolveScanSubject(scanSql, `mpcsvc_${randomUUID().replaceAll("-", "")}`)).toBeUndefined();
    const creOnly = await scanSubject(projectId, ["cre_report"]);
    expect(await resolveScanSubject(scanSql, creOnly.token)).toBeUndefined();
    const revoked = await scanSubject(projectId);
    await sql`UPDATE core.service_tokens SET revoked_at = now() WHERE subject_id = ${revoked.id}`;
    expect(await resolveScanSubject(scanSql, revoked.token)).toBeUndefined();
  });

  it("does all of this as the worker role, which resolves its own token and reads no token table", async () => {
    // One connection, so the role holds for every statement.
    const worker = postgres(process.env["DATABASE_URL"]!, { max: 1, onnotice: () => {}, prepare: false });
    try {
      await worker`SET ROLE mpc_worker`;
      const { id, token } = await scanSubject(projectId);
      const resolved = await resolveScanSubject(worker, token);
      expect(resolved).toBe(id);
      expect((await scanOnce(worker, store, scan, report, { ...options, subjectId: resolved! }, log)).verdict).toBe("clean");
      expect((await stateOf()).state).toBe("scanned_clean");
      await expect(worker`SELECT token_hash FROM core.service_tokens LIMIT 1`).rejects.toThrow(/permission denied/);
    } finally {
      await worker.end();
    }
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
      expect(await scanOnce(scanSql, countedStore, countedScan, report, guarded, log))
        .toEqual({ handled: false, scannerUnavailable: true });
    }
    expect(await stateOf()).toEqual(before);
    expect(reads).toBe(0);
    expect(scans).toBe(0);
    expect(reported).toEqual([]);
    available = true;
    expect((await scanOnce(scanSql, countedStore, countedScan, report, guarded, log)).verdict).toBe("clean");
    expect((await stateOf()).state).toBe("scanned_clean");
    expect((await stateOf()).scan_attempts).toBe(1);
    expect(reads).toBe(1);
    expect(scans).toBe(1);
  });

  it("refunds only pre-connect outages that race the successful readiness probe", async () => {
    const guarded = { ...options, scannerAvailable: async () => true };
    const disconnected = async (): Promise<ScanVerdict> => ({ kind: "error", reason: "connection refused", unavailable: true });
    for (let poll = 0; poll < 3; poll++) {
      expect((await scanOnce(scanSql, store, disconnected, report, guarded, log)).scannerUnavailable).toBe(true);
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
      expect((await scanOnce(scanSql, store, connectedFailure, report, guarded, log)).handled).toBe(true);
    }
    expect((await scanOnce(scanSql, store, connectedFailure, report, guarded, log)).handled).toBe(false);
    expect((await stateOf()).scan_attempts).toBe(3);
    expect((await stateOf()).state).toBe("quarantined");
    expect(reported).toEqual([]);
  });

  it("never refunds or releases a replacement worker's lease after its own lease expires", async () => {
    let startedFirst!: () => void;
    let finishFirst!: (result: ScanVerdict) => void;
    const firstStarted = new Promise<void>((resolve) => { startedFirst = resolve; });
    const first = scanOnce(scanSql, store, () => {
      startedFirst();
      return new Promise<ScanVerdict>((resolve) => { finishFirst = resolve; });
    }, report, options, log);
    await firstStarted;
    await sql`UPDATE core.object_uploads SET scan_leased_until = now() - interval '1 second' WHERE id = ${uploadId}`;
    let startedSecond!: () => void;
    let finishSecond!: (result: ScanVerdict) => void;
    const secondStarted = new Promise<void>((resolve) => { startedSecond = resolve; });
    const second = scanOnce(scanSql, store, () => {
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
      (id,project_id,object_key,content_hash,byte_size,content_type,sensitivity,state)
      VALUES(${uploadId},${projectId},${`quarantine/${uploadId}`},${`0x${"22".repeat(32)}`},
        ${MAX_SCAN_BYTES},'application/pdf','restricted','quarantined')`;
    let started!: () => void;
    let finish!: (bytes: Uint8Array | null) => void;
    const reading = new Promise<void>((resolve) => { started=resolve; });
    const pending = scanOnce(scanSql, {get: () => { started(); return new Promise((resolve) => { finish=resolve; }); }}, scan, report, options, log);
    await reading;
    const [lease] = await sql<{remaining:number}[]>`SELECT extract(epoch FROM(scan_leased_until-now()))::float8 AS remaining FROM core.object_uploads WHERE id=${uploadId}`;
    expect(lease!.remaining).toBeGreaterThan(450);
    expect(lease!.remaining).toBeLessThanOrEqual(461);
    finish(null);
    await pending;
  });

  it.each(["reject", "late-bytes"])("awaits aborted read cleanup before releasing its lease (%s)", async mode => {
    let aborted!: () => void;
    const sawAbort = new Promise<void>(resolve => { aborted = resolve; });
    let settle!: () => void;
    let scans = 0;
    const slowStore: ScanStore = { get: (_key, signal) => new Promise((resolve, reject) => {
      expect(signal).toBeDefined();
      signal!.addEventListener("abort", () => {
        aborted();
        settle = () => mode === "reject" ? reject(signal!.reason) : resolve(new Uint8Array([1,2,3]));
      }, {once:true});
    }) };
    const pending = scanOnce(scanSql, slowStore, async () => { scans++; return {kind:"clean"}; }, report,
      {...options,objectReadTimeoutMs:5}, log);
    await sawAbort;
    expect((await stateOf()).scan_leased_until).not.toBeNull();
    expect((await scanOnce(scanSql, store, scan, report, options, log)).handled).toBe(false);
    settle();
    expect((await pending).verdict).toBe("error");
    expect(scans).toBe(0);
    expect(reported).toEqual([]);
    expect((await stateOf()).state).toBe("quarantined");
    expect((await stateOf()).scan_leased_until).toBeNull();
    expect((await step()).verdict).toBe("clean");
    expect((await stateOf()).scan_attempts).toBe(2);
  });

  it("does not scan or report an object whose bytes differ from leased size metadata", async () => {
    let scans=0;
    const result=await scanOnce(scanSql,{get:async()=>new Uint8Array(4)},async()=>{scans++;return {kind:"clean"};},report,options,log);
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
