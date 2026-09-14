import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 공식 출처 조회 — 05 §5.12, OD-42.
 *
 * 이 파일이 지키는 것은 **응답을 사실대로 나누는가**와 **부르지 않은 것을 부른
 * 것처럼 남기지 않는가**다.
 */
describeDb("출처 조회", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;
  let operatorToken: string;

  /** 다음 응답. 테스트가 출처 역할을 한다. */
  let nextResponse: () => Response | Promise<Response>;
  /** 실제로 나간 요청. 부르지 않아야 할 때 부르지 않았는지 본다. */
  let calls: { url: string; headers: Record<string, string> }[] = [];

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    return nextResponse();
  }) as unknown as typeof fetch;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, {
      fetchImpl,
      // 테스트는 실제 DNS를 쓰지 않는다. 공개 주소로 해석된 것으로 둔다.
      resolveHost: async () => ["203.0.113.10"],
    });
    stewardToken = await signIn(app, fx.stewardA);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  beforeEach(() => {
    calls = [];
    nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
  });

  function collect(token: string, connectionId = fx.connectionA) {
    return app.inject({
      method: "POST",
      url: `/api/v1/source-connections/${connectionId}/collect`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: { projectId: fx.projectA, queryBasis: { licenseNumber: "MN-1" } },
    });
  }

  it("200과 스키마 일치는 확인으로 기록된다", async () => {
    const response = await collect(stewardToken);
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(body.result).toBe("confirmed_from_source");
    expect(body.confirmed).toBe(true);

    // 확인됐어도 authority가 선언한 한계는 반드시 붙는다.
    expect(body.limitations).toContain("economic_viability");
  });

  it("404는 출처 장애가 아니라 기록 없음이다", async () => {
    nextResponse = () => new Response("", { status: 404 });

    const body = (await collect(stewardToken)).json();
    // 이 둘을 섞으면 존재하지 않는 기록을 계속 재시도한다.
    expect(body.result).toBe("source_returned_no_record");
    expect(body.confirmed).toBe(false);
  });

  it("503은 출처 장애로 기록된다", async () => {
    nextResponse = () => new Response("", { status: 503 });
    expect((await collect(stewardToken)).json().result).toBe("source_unavailable");
  });

  it("리다이렉트를 따라가지 않는다", async () => {
    // 따라가면 등록부 조회가 내부 주소를 읽는 통로가 된다.
    nextResponse = () =>
      new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("manual_review_required");
    // 두 번째 요청이 나가지 않았다.
    expect(calls).toHaveLength(1);
  });

  it("JSON이 아니면 값을 추측하지 않는다", async () => {
    nextResponse = () => new Response("<html>점검 중</html>", { status: 200 });
    expect((await collect(stewardToken)).json().result).toBe("schema_changed");
  });

  it("실패도 receipt로 남는다", async () => {
    nextResponse = () => new Response("", { status: 404 });
    const receiptId = (await collect(stewardToken)).json().receiptId;

    const [row] = await fx.sql<{ result: string; raw_hash: string }[]>`
      SELECT result, raw_hash FROM core.source_receipts WHERE id = ${receiptId}
    `;
    expect(row?.result).toBe("source_returned_no_record");
    // 원문이 없으면 가짜 해시를 만들지 않는다.
    expect(row?.raw_hash).toBe(`0x${"0".repeat(64)}`);
  });

  it("확인됐을 때만 last_success_at이 갱신된다", async () => {
    await fx.sql`UPDATE core.source_connections SET last_success_at = NULL WHERE id = ${fx.connectionA}`;

    nextResponse = () => new Response("", { status: 503 });
    await collect(stewardToken);

    const [after] = await fx.sql<{ last_success_at: Date | null }[]>`
      SELECT last_success_at FROM core.source_connections WHERE id = ${fx.connectionA}
    `;
    // 장애 응답을 성공 시각으로 남기면 "언제 마지막으로 답을 받았나"가 거짓이 된다.
    expect(after?.last_success_at).toBeNull();

    // 선언된 필드가 있어야 확정이다(A7). `{ok:true}`는 이제 schema_changed다.
    nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
    await collect(stewardToken);

    const [ok] = await fx.sql<{ last_success_at: Date | null }[]>`
      SELECT last_success_at FROM core.source_connections WHERE id = ${fx.connectionA}
    `;
    expect(ok?.last_success_at).not.toBeNull();
  });

  /**
   * 응답 profile — 2026-09-10 실사 A7.
   *
   * 이전에는 200 + 유효 JSON이면 확정이었다. 출처가 "답할 수 없다"고 말한
   * 응답도 확인으로 기록됐다.
   */
  it("200이어도 선언된 필드가 없으면 확정하지 않는다", async () => {
    nextResponse = () => new Response(JSON.stringify({ unexpected: 1 }), { status: 200 });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("schema_changed");
    expect(body.confirmed).toBe(false);
  });

  it("200 본문의 업무 오류를 확인으로 읽지 않는다", async () => {
    nextResponse = () => new Response(JSON.stringify({ error: "unavailable" }), { status: 200 });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("manual_review_required");
    expect(body.detail).toContain("unavailable");
  });

  it("200으로 온 '기록 없음'을 확정으로 읽지 않는다", async () => {
    nextResponse = () =>
      new Response(JSON.stringify({ found: false }), { status: 200 });

    const body = (await collect(stewardToken)).json();
    expect(body.result).toBe("source_returned_no_record");
  });

  it("응답 형식이 선언되지 않은 연동은 확정하지 않는다", async () => {
    await fx.sql`
      UPDATE core.source_connections SET schema_fingerprint = NULL WHERE id = ${fx.connectionA}
    `;
    try {
      nextResponse = () => new Response(JSON.stringify({ licenseId: "MN-1" }), { status: 200 });
      const body = (await collect(stewardToken)).json();
      expect(body.result).toBe("manual_review_required");
      expect(body.confirmed).toBe(false);
    } finally {
      await fx.sql`
        UPDATE core.source_connections SET schema_fingerprint = ARRAY['licenseId']
        WHERE id = ${fx.connectionA}
      `;
    }
  });

  // AC-24: 실제 API가 없는 출처는 수동 확인으로 진행하되 `active API`나
  // 정부 협력으로 표시되지 않는다.
  it("pending_access인 연동은 호출되지 않는다", async () => {
    await fx.sql`UPDATE core.source_connections SET state = 'planned' WHERE id = ${fx.connectionA}`;

    const response = await collect(stewardToken);
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("SOURCE_NOT_CALLABLE");

    // 부르면 401을 받아 "인증 실패"로 남는다. 실제로는 협의가 안 된 것이다.
    expect(calls).toHaveLength(0);

    // receipt도 만들지 않는다 — 조회하지 않았으므로 조회 기록이 있으면 안 된다.
    const [count] = await fx.sql<{ n: string }[]>`
      SELECT count(*)::text AS n FROM core.source_receipts
      WHERE connection_id = ${fx.connectionA} AND result = 'access_not_authorized'
    `;
    expect(count?.n).toBe("0");

    await fx.sql`UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}`;
  });

  it("조회 권한이 없는 역할은 부를 수 없다", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/source-connections/${fx.connectionA}/collect`,
      headers: {
        authorization: `Bearer ${await signIn(app, fx.reviewerA)}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { projectId: fx.projectA, queryBasis: {} },
    });

    expect(response.statusCode).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("mpc_operator도 부를 수 있다", async () => {
    expect((await collect(operatorToken)).statusCode).toBe(200);
  });

  it("다른 tenant의 연동은 보이지 않는다", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/source-connections/${fx.connectionA}/collect`,
      headers: {
        authorization: `Bearer ${await signIn(app, fx.operatorB)}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { projectId: fx.projectA, queryBasis: {} },
    });

    expect(response.statusCode).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("같은 Idempotency-Key는 한 번만 조회한다", async () => {
    const key = idempotencyKey();
    const send = () =>
      app.inject({
        method: "POST",
        url: `/api/v1/source-connections/${fx.connectionA}/collect`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": key },
        payload: { projectId: fx.projectA, queryBasis: { licenseNumber: "MN-1" } },
      });

    const first = (await send()).json();
    const second = (await send()).json();

    expect(second.receiptId).toBe(first.receiptId);
    // 재시도가 출처에 부하를 만들면 안 된다.
    expect(calls).toHaveLength(1);
  });
});

/**
 * DB 제약 — 0019.
 *
 * 애플리케이션이 우회해도 남는 규칙이다.
 */
describeDb("연동 설정 제약", () => {
  let fx: TestFixture;

  beforeAll(async () => {
    fx = await setupFixture();
  });

  afterAll(async () => {
    await fx.close();
  });

  it("호출 대상 없이 active가 될 수 없다", async () => {
    await expect(
      fx.sql`
        UPDATE core.source_connections SET endpoint = NULL WHERE id = ${fx.connectionA}
      `,
    ).rejects.toThrow(/source_connections_active_needs_endpoint/);
  });

  it("http endpoint를 거절한다", async () => {
    // 등록부로 가는 요청이 평문으로 나갈 수 없다.
    await expect(
      fx.sql`
        UPDATE core.source_connections
        SET endpoint = 'http://registry.example.test/x' WHERE id = ${fx.connectionA}
      `,
    ).rejects.toThrow(/source_connections_endpoint_check/);
  });

  it("URL 안의 자격증명을 거절한다", async () => {
    // URL에 든 비밀은 로그·감사·에러 메시지에 그대로 남는다.
    //
    // 제약 이름으로 본다. PostgreSQL의 오류 문구는 서버 로케일을 따르므로
    // 영어 문구로 대조하면 한국어 로케일에서 통과하지 못한다 — 제약은
    // 걸렸는데 테스트만 실패한다.
    await expect(
      fx.sql`
        UPDATE core.source_connections
        SET endpoint = 'https://user:pass@registry.example.test/x' WHERE id = ${fx.connectionA}
      `,
    ).rejects.toThrow(/source_connections_endpoint_check/);
  });
});
