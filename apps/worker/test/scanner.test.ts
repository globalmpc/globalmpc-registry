import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { runMigrations } from "@mpc/db";
import { parseClamResponse } from "../src/scanner.js";
import { scanBacklog, scanOnce, type ScanStore } from "../src/scan-worker.js";
import type { ScanVerdict } from "../src/scanner.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 바이러스 검사 — 05 §5.2.
 *
 * 이 파일의 중심은 **오류와 감염을 구분한다**는 것이다. 감염 판정은 되돌릴 수
 * 없으므로(상태기계에 `scanned_infected → promoted` 경로가 없다) 스캐너 장애로
 * 그 상태를 만들면 정상 파일이 영구히 막힌다.
 */

describe("ClamAV 응답 해석", () => {
  it("정상 응답을 clean으로 읽는다", () => {
    expect(parseClamResponse("stream: OK\0")).toEqual({ kind: "clean" });
  });

  it("감염 응답에서 서명명을 뽑는다", () => {
    // 무엇으로 판정했는지가 있어야 오탐을 확인할 수 있다.
    expect(parseClamResponse("stream: Eicar-Test-Signature FOUND\0")).toEqual({
      kind: "infected",
      signature: "Eicar-Test-Signature",
    });
  });

  it("ERROR 응답을 감염으로 읽지 않는다", () => {
    const verdict = parseClamResponse("INSTREAM size limit exceeded. ERROR\0");
    expect(verdict.kind).toBe("error");
  });

  it("빈 응답도 오류다", () => {
    // 판정하지 못한 것을 정상으로 넘기면 검사가 없는 것과 같아진다.
    expect(parseClamResponse("").kind).toBe("error");
  });

  it("모르는 형식을 정상으로 넘기지 않는다", () => {
    expect(parseClamResponse("something unexpected").kind).toBe("error");
  });
});

describeDb("검사 worker", () => {
  let sql: postgres.Sql;
  let tenantId: string;
  let projectId: string;
  let uploadId: string;

  const logs: Record<string, unknown>[] = [];
  const log = (record: Record<string, unknown>) => {
    logs.push(record);
  };

  /** 스캐너 대역. 실제 데몬으로는 타임아웃·연결 실패를 재현하기 어렵다. */
  let verdict: ScanVerdict = { kind: "clean" };
  const scan = async () => verdict;
  const options = { maxAttempts: 3, leaseMs: 60_000 };

  /**
   * 보고 대역.
   *
   * 실제로는 API가 상태를 바꾸므로 여기서 DB를 대신 갱신한다. 이 테스트가 보는
   * 것은 "언제 보고하고 언제 하지 않는가"다.
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

    // 다른 케이스의 대기 업로드가 먼저 집히면 무엇을 검증했는지 알 수 없다.
    // 지울 수는 없다 — object_uploads는 append-only다(0007). 대기 목록에서만 뺀다.
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

  it("정상 판정이면 scanned_clean으로 옮기고 버전을 올린다", async () => {
    const before = await stateOf();
    const result = await step();

    expect(result.verdict).toBe("clean");
    const after = await stateOf();
    expect(after.state).toBe("scanned_clean");
    expect(after.version).toBe(before.version + 1);
  });

  it("감염 판정이면 서명명을 남긴다", async () => {
    verdict = { kind: "infected", signature: "Eicar-Test-Signature" };
    const result = await step();

    expect(result.verdict).toBe("infected");
    const after = await stateOf();
    expect(after.state).toBe("scanned_infected");
    // 무엇으로 판정했는지가 없으면 오탐을 확인할 수 없다.
    expect(after.rejection_reason).toBe("Eicar-Test-Signature");
  });

  it("검사 실패를 감염으로 기록하지 않는다", async () => {
    verdict = { kind: "error", reason: "scan timeout" };
    const result = await step();

    expect(result.verdict).toBe("error");
    const after = await stateOf();
    // 감염 판정은 되돌릴 수 없다. 스캐너 장애로 그 상태를 만들면 정상 파일이
    // 영구히 막힌다.
    expect(after.state).toBe("quarantined");
    expect(after.rejection_reason).toContain("scan_error");
  });

  it("실패 뒤 스캐너가 돌아오면 이어서 진행한다", async () => {
    verdict = { kind: "error", reason: "connection refused" };
    await step();

    verdict = { kind: "clean" };
    await step();
    expect((await stateOf()).state).toBe("scanned_clean");
  });

  it("보고에 실패하면 상태를 바꾸지 않는다", async () => {
    reportError = new Error("503 UNAVAILABLE");
    const result = await step();

    expect(result.verdict).toBe("error");
    const after = await stateOf();
    // 보고하지 못한 것은 검사하지 않은 것과 같다. DB를 직접 고치면 API의
    // 상태기계 검사를 우회하는 경로가 생긴다.
    expect(after.state).toBe("quarantined");
    expect(after.rejection_reason).toContain("report_error");
  });

  it("객체가 없으면 상태를 바꾸지 않는다", async () => {
    objects.clear();
    const result = await step();

    expect(result.verdict).toBe("error");
    // 저장소 장애와 실제 유실을 여기서 구분할 수 없다. 자동으로 정리하지 않는다.
    expect((await stateOf()).state).toBe("quarantined");
  });

  it("시도 횟수를 읽기 전에 올린다", async () => {
    verdict = { kind: "error", reason: "boom" };
    await step();
    // 스캐너가 특정 파일에서 죽어도 그 파일이 큐를 영원히 막지 않는다.
    expect((await stateOf()).scan_attempts).toBe(1);
  });

  it("lease가 유효한 동안 다른 worker가 집지 않는다", async () => {
    // 검사가 오래 걸리는 사이 두 번째 worker가 같은 파일을 읽으면 낭비이고,
    // 두 결과가 엇갈리면 어느 것이 맞는지 알 수 없다.
    const leaseOnly = { maxAttempts: 3, leaseMs: 60_000 };
    const slowScan = () => new Promise<ScanVerdict>(() => {});

    void scanOnce(sql, store, slowScan, report, leaseOnly, log);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await scanOnce(sql, store, scan, report, leaseOnly, log);
    expect(second.handled).toBe(false);
  });

  it("시도 상한에 닿으면 더 집지 않는다", async () => {
    verdict = { kind: "error", reason: "boom" };
    await step();
    await step();
    await step();

    const next = await step();
    expect(next.handled).toBe(false);

    // 감염으로 표시하지 않는다. 상태는 quarantined에 남고 시도만 멈춘다.
    expect((await stateOf()).state).toBe("quarantined");
  });

  it("backlog가 막힌 것을 따로 센다", async () => {
    verdict = { kind: "error", reason: "boom" };
    await step();
    await step();
    await step();

    const backlog = await scanBacklog(sql, options.maxAttempts);
    // 앞 케이스가 남긴 행도 함께 세므로 최소값으로 확인한다. 여기서 보려는 것은
    // "대기와 막힌 것을 분리해서 센다"이지 절대 수치가 아니다.
    expect(backlog.pending).toBe(0);
    expect(backlog.stuck).toBeGreaterThanOrEqual(1);
  });

  it("대기 중인 업로드가 없으면 아무것도 하지 않는다", async () => {
    // `promoted`는 artifact를 요구한다(DB CHECK). 대기 목록에서 빼는 것이
    // 목적이므로 `rejected`를 쓴다.
    // 반려에는 사유가 필수다(DB CHECK) — 이유 없는 반려는 저장되지 않는다.
    await sql`
      UPDATE core.object_uploads
      SET state = 'rejected', rejection_reason = '테스트 정리'
      WHERE id = ${uploadId}
    `;
    expect((await step()).handled).toBe(false);
  });
});
