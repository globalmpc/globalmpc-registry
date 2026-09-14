import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { SOURCE_RESULTS, SOURCE_RESULT_BEHAVIOUR } from "@mpc/domain";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

describeDb("Source Receipt", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { operatorB: string; readerA: string; stewardA: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);

    // R1부터 인증은 SIWE 서명 → 세션 토큰이다. 테스트도 같은 경로를 지난다.
    tokens = {
      operatorB: await signIn(app, fx.operatorB),
      readerA: await signIn(app, fx.readerA),
      stewardA: await signIn(app, fx.stewardA),
    };
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function receiptBody(overrides: Record<string, unknown> = {}) {
    return {
      connectionId: fx.connectionA,
      authorityId: fx.authorityA,
      /**
       * 기본은 **확정이 아닌 결과**다 — 2026-09-10 실사 A1.
       *
       * 이 route는 사람이 결과를 적어 넣는 입구이며, `authenticated_api`의
       * 확정은 서버가 부른 경로(`/collect`)에서만 만들어진다. 기본값을 확정으로
       * 두면 다른 시험들이 그 사실을 지나쳐 버린다.
       */
      result: "source_returned_no_record",
      collectionMethod: "authenticated_api",
      queryBasis: { licenseNumber: "MV-012345" },
      endpointOrDocumentRef: "https://registry.example/api/licenses/MV-012345",
      authenticationMethod: "mtls+oauth2",
      rawHash: `0x${"ab".repeat(32)}`,
      sourceSchemaVersion: "2026-01",
      adapterVersion: "1.0.0",
      termsLicense: "data sharing agreement 2026-01",
      commercialReuse: "unconfirmed",
      disclosurePermission: "restricted",
      asOf: "2026-08-01T00:00:00.000Z",
      freshnessStatus: "fresh",
      limitations: ["이 조회는 광업권 등록 상태만 확인한다"],
      ...overrides,
    };
  }

  function create(wallet: string, body: Record<string, unknown>, key = idempotencyKey()) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/source-receipts`,
      headers: { authorization: `Bearer ${wallet}`, "idempotency-key": key },
      payload: body,
    });
  }

  it("확정을 뺀 11개 result가 retryable·nextAction과 함께 반환된다", async () => {
    for (const result of SOURCE_RESULTS.filter((r) => r !== "confirmed_from_source")) {
      const response = await create(tokens.stewardA, receiptBody({ result }));
      expect(response.statusCode, result).toBe(200);

      const body = response.json();
      expect(body.result, result).toBe(result);
      expect(body.retryable, result).toBe(SOURCE_RESULT_BEHAVIOUR[result].retryable);
      expect(body.nextAction, result).toBe(SOURCE_RESULT_BEHAVIOUR[result].nextAction);
    }
  });

  /**
   * A1 부정 테스트 — 2026-09-10 실사.
   *
   * 업로더가 `result: "confirmed_from_source"`를 적어 보내는 것만으로 API 수집
   * 확정이 만들어졌다. 그 기록은 서버가 실제로 출처를 부른 것과 구분되지 않는다.
   */
  it("API 수집 확정을 요청 본문으로 만들 수 없다", async () => {
    const response = await create(
      tokens.stewardA,
      receiptBody({ result: "confirmed_from_source" }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CONFIRMATION_REQUIRES_SERVER_COLLECTION");
  });

  it("AC-18: no record와 unavailable이 다른 응답을 만든다", async () => {
    const noRecord = (
      await create(tokens.stewardA, receiptBody({ result: "source_returned_no_record" }))
    ).json();
    const unavailable = (
      await create(tokens.stewardA, receiptBody({ result: "source_unavailable" }))
    ).json();

    // 출처가 "없다"고 답한 것은 재시도 대상이 아니다.
    expect(noRecord.retryable).toBe(false);
    expect(unavailable.retryable).toBe(true);
    expect(noRecord.nextAction).not.toBe(unavailable.nextAction);
  });

  it("불변조건 15: 확정이 아닌 result는 canonical acceptance 후보가 아니다", async () => {
    for (const result of SOURCE_RESULTS.filter((r) => r !== "confirmed_from_source")) {
      const body = (await create(tokens.stewardA, receiptBody({ result }))).json();
      expect(body.permitsCanonicalAcceptance, result).toBe(false);
    }
  });

  it("receipt는 수정할 수 없다", async () => {
    const created = (await create(tokens.stewardA, receiptBody())).json();
    await expect(
      fx.sql`
        UPDATE core.source_receipts SET result = 'confirmed_from_source' WHERE id = ${created.id}
      `,
    ).rejects.toThrow(/수정·삭제할 수 없다/);
  });

  it("raw hash 없이 등록할 수 없다", async () => {
    const response = await create(tokens.stewardA, receiptBody({ rawHash: undefined }));
    expect(response.statusCode).toBe(400);
  });

  it("잘못된 형식의 raw hash를 거절한다", async () => {
    const response = await create(tokens.stewardA, receiptBody({ rawHash: "0xdead" }));
    expect(response.statusCode).toBe(400);
  });

  it("알 수 없는 result를 거절한다 — 별칭을 만들 수 없다", async () => {
    const response = await create(tokens.stewardA, receiptBody({ result: "no_record" }));
    expect(response.statusCode).toBe(400);
  });

  it("API secret이 담긴 인증 방식을 거절한다 (05 §5.12)", async () => {
    // 인증 "방식"은 유한하다. 자유 문자열을 허용하면 토큰 값이 그대로 저장된다.
    const response = await create(tokens.stewardA,
      receiptBody({ authenticationMethod: "bearer sk-secret-token" }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("허용된 인증 방식만 받는다", async () => {
    for (const method of ["mtls", "oauth2", "signed_document", "manual_verification"]) {
      const response = await create(tokens.stewardA, receiptBody({ authenticationMethod: method }));
      expect(response.statusCode, method).toBe(200);
    }
  });

  it("저장된 receipt 어디에도 secret 값이 없다", async () => {
    const created = (await create(tokens.stewardA, receiptBody())).json();
    const [row] = await fx.sql`
      SELECT * FROM core.source_receipts WHERE id = ${created.id}
    `;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toMatch(/sk-[a-z0-9-]+/i);
    expect(serialized).not.toMatch(/bearer /i);
    // secret은 connection의 reference로만 존재한다.
    expect(serialized).not.toContain("vault://");
  });

  it("등록이 audit과 outbox를 남긴다", async () => {
    const created = (await create(tokens.stewardA, receiptBody())).json();

    const audits = await fx.sql`
      SELECT command FROM audit.events WHERE resource_id = ${created.id}
    `;
    expect(audits[0]?.["command"]).toBe("source_receipt.received");

    const events = await fx.sql`
      SELECT event_type FROM core.outbox WHERE aggregate_id = ${created.id}
    `;
    expect(events[0]?.["event_type"]).toBe("source_receipt.received");
  });

  it("목록이 tenant 안에서만 조회된다", async () => {
    await create(tokens.stewardA, receiptBody());

    const own = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/source-receipts`,
      headers: { authorization: `Bearer ${tokens.stewardA}` },
    });
    expect(own.json().items.length).toBeGreaterThan(0);

    const other = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/source-receipts`,
      headers: { authorization: `Bearer ${tokens.operatorB}` },
    });
    expect(other.json().items).toEqual([]);
  });

  it("권한 없는 계정은 등록할 수 없다", async () => {
    const response = await create(tokens.readerA, receiptBody());
    expect(response.statusCode).toBe(403);
  });
});

describeDb("Claim", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let tokens: { stewardA: string; operatorB: string; readerA: string };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    tokens = {
      stewardA: await signIn(app, fx.stewardA),
      operatorB: await signIn(app, fx.operatorB),
      readerA: await signIn(app, fx.readerA),
    };

  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function claimBody(overrides: Record<string, unknown> = {}) {
    return {
      claimType: "mining_right_registration",
      valueText: "MV-012345",
      unit: null,
      asOf: "2026-08-01",
      sourceCoordinate: { document: "license-extract", page: "1" },
      evidenceTier: "P1",
      verificationState: "analyst_checked",
      attestationTypes: [],
      ...overrides,
    };
  }

  function create(wallet: string, body: Record<string, unknown>, key = idempotencyKey()) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${wallet}`, "idempotency-key": key },
      payload: body,
    });
  }

  it("grade를 도메인 규칙으로 계산해 저장한다", async () => {
    const response = await create(tokens.stewardA,
      claimBody({
        evidenceTier: "P1",
        verificationState: "independently_assured",
        attestationTypes: ["professional_signoff", "independent_assurance"],
      }),
    );
    expect(response.json().grade).toBe("verified");
  });

  it("근거 등급이 낮으면 grade가 내려간다", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ evidenceTier: "P4", verificationState: "machine_checked" }),
    );
    expect(response.json().grade).toBe("self_reported");
  });

  it("근거가 없으면 unverified다", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ evidenceTier: null, verificationState: "unreviewed" }),
    );
    expect(response.json().grade).toBe("unverified");
  });

  it("미해결 conflict가 생기면 grade가 재계산된다", async () => {
    const created = (
      await create(tokens.stewardA,
        claimBody({
          evidenceTier: "P1",
          verificationState: "independently_assured",
          attestationTypes: ["professional_signoff", "independent_assurance"],
        }),
      )
    ).json();
    expect(created.grade).toBe("verified");

    const conflicted = await app.inject({
      method: "POST",
      url: `/api/v1/claims/${created.id}/conflicts`,
      headers: {
        authorization: `Bearer ${tokens.stewardA}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${created.version}"`,
      },
      payload: { conflictType: "estimate_conflict" },
    });

    expect(conflicted.statusCode).toBe(200);
    // attestation은 그대로지만 unresolved conflict가 생겨 verified가 깨진다.
    expect(conflicted.json().grade).toBe("partially_verified");
  });

  describe("동시 수정 (If-Match)", () => {
    async function recordConflict(claimId: string, version: unknown, headers: Record<string, string> = {}) {
      return app.inject({
        method: "POST",
        url: `/api/v1/claims/${claimId}/conflicts`,
        headers: {
          authorization: `Bearer ${tokens.stewardA}`,
          "idempotency-key": idempotencyKey(),
          ...(version === undefined ? {} : { "if-match": String(version) }),
          ...headers,
        },
        payload: { conflictType: "estimate_conflict" },
      });
    }

    it("If-Match 없이 보내면 428이고 무엇이 빠졌는지 말한다", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const response = await recordConflict(created.id, undefined);

      // 412가 아니다. 412면 "버전이 틀렸다"로 읽혀 헤더 누락이 가려진다.
      expect(response.statusCode).toBe(428);
      expect(response.json().code).toBe("IF_MATCH_REQUIRED");
    });

    it("낡은 버전으로 보내면 412이고 현재 버전을 알려준다", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();

      const first = await recordConflict(created.id, `"${created.version}"`);
      expect(first.statusCode).toBe(200);

      // 같은 버전을 다시 쓴다 — 첫 기록을 못 본 사람의 요청이다.
      const second = await recordConflict(created.id, `"${created.version}"`);
      expect(second.statusCode).toBe(412);
      expect(second.json().code).toBe("RESOURCE_VERSION_MISMATCH");
      expect(second.json().details.currentVersion).toBe(String(created.version + 1));
      // 재시도해도 결과가 같다. 다시 읽고 판단해야 한다.
      expect(second.json().retryable).toBe(false);
    });

    it("현재 버전을 다시 읽으면 이어서 기록할 수 있다", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const first = await recordConflict(created.id, `"${created.version}"`);

      const next = await recordConflict(created.id, `"${first.json().version}"`);
      expect(next.statusCode).toBe(200);
    });

    it("동시에 두 요청이 오면 하나만 성공한다", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();

      // 같은 버전을 본 두 사람이 동시에 기록한다. 잠금이 없으면 둘 다 통과하고
      // 한쪽 판단이 흔적 없이 사라진다.
      const [a, b] = await Promise.all([
        recordConflict(created.id, `"${created.version}"`),
        recordConflict(created.id, `"${created.version}"`),
      ]);

      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([200, 412]);
    });

    it("W/ 접두사와 따옴표 없는 형식도 받는다", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const weak = await recordConflict(created.id, `W/"${created.version}"`);
      expect(weak.statusCode).toBe(200);

      const bare = await recordConflict(created.id, String(weak.json().version));
      expect(bare.statusCode).toBe(200);
    });

    it("버전 형식이 아니면 400이다", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const response = await recordConflict(created.id, '"abc"');
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("IF_MATCH_INVALID");
    });
  });

  it("수치를 number로 보내면 거절한다", async () => {
    const response = await create(tokens.stewardA, claimBody({ valueText: 1200 }));
    expect(response.statusCode).toBe(400);
  });

  it("단위 없는 수치 claim을 거절한다", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ claimType: "resource_estimate", valueText: "1200", unit: null }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("단위가 있으면 수치 claim을 받는다", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ claimType: "resource_estimate", valueText: "1200000", unit: "t" }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().valueText).toBe("1200000");
    expect(response.json().unit).toBe("t");
  });

  it("큰 수치가 정밀도를 잃지 않는다", async () => {
    const huge = "123456789012345678901234567890";
    const response = await create(tokens.stewardA,
      claimBody({ claimType: "resource_estimate", valueText: huge, unit: "t" }),
    );
    expect(response.json().valueText).toBe(huge);
  });

  it("목록이 tenant 안에서만 조회된다", async () => {
    await create(tokens.stewardA, claimBody());

    const other = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${tokens.operatorB}` },
    });
    expect(other.json().items).toEqual([]);
  });

  it("권한 없는 계정은 등록할 수 없다", async () => {
    const response = await create(tokens.readerA, claimBody());
    expect(response.statusCode).toBe(403);
  });
});
