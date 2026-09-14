import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Governance — 04 §4.5, OD-06.
 *
 * 이 파일의 중심은 **투표가 오프체인 사실을 만들지 않는다**(불변조건 12)와
 * **표를 무시하고 결과를 선언할 수 없다**는 두 가지다.
 */
describeDb("Governance", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let proposerToken: string;
  let voterToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    proposerToken = await signIn(app, fx.proposerA);
    voterToken = await signIn(app, fx.voterA);
    stewardToken = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function propose(token: string, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        space: "protocol",
        proposalType: "attestation_schema_approval",
        title: "스키마 변경",
        rationale: "현행 스키마가 한계를 담지 못한다",
        ...body,
      },
    });
  }

  function transition(id: string, version: number, toState: string, reason = "다음 단계") {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/transitions`,
      headers: {
        authorization: `Bearer ${proposerToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { toState, reason },
    });
  }

  function vote(token: string, id: string, choice: string, weight: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/votes`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: { choice, weight },
    });
  }

  /**
   * draft → voting까지 밀어 준다. 상태기계를 매번 다시 쓰지 않는다.
   *
   * `eligibleWeight`를 기본으로 넣는다 — 온체인 토큰이 없는 제안은 정족수의
   * 분모를 사람이 정해야 투표를 열 수 있다.
   */
  async function openVoting(body: Record<string, unknown> = {}) {
    const created = (await propose(proposerToken, { eligibleWeight: "100", ...body })).json();
    let version = created.version;
    for (const state of ["review", "announced", "voting"]) {
      version = (await transition(created.id, version, state)).json().version;
    }
    return { id: created.id as string, version: version as number };
  }

  it("제안에는 이유가 필요하다", async () => {
    const response = await propose(proposerToken, { rationale: "" });
    expect(response.statusCode).toBe(400);
  });

  it("투표 권한만 있는 계정은 제안할 수 없다", async () => {
    const response = await propose(voterToken, {});
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("protocol_proposer");
  });

  it("space 밖의 대상은 제안할 수 없다", async () => {
    // protocol governance가 특정 프로젝트의 처분을 정할 수 없다.
    const response = await propose(proposerToken, {
      proposalType: "project_data_room_publication",
    });
    expect(response.statusCode).toBe(422);
  });

  it("투표로 정할 수 없는 대상은 거절한다", async () => {
    // 법적 사실·개인 자격·검토 결과는 투표로 만들어지지 않는다.
    const response = await propose(proposerToken, {
      proposalType: "readiness_override",
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("GOVERNANCE_TARGET_FORBIDDEN");
  });

  it("응답이 만들지 않는 것을 매번 밝힌다", async () => {
    const response = await propose(proposerToken, {});
    const limitations = response.json().limitations as string[];

    // 거버넌스 결과를 법적 승인으로 읽는 것이 가장 위험한 오해다.
    expect(limitations.join(" ")).toContain("법적 사실");
    expect(limitations.join(" ")).toContain("자동으로 일어나지 않는다");
  });

  it("투표 기간이 아니면 표를 받지 않는다", async () => {
    const created = (await propose(proposerToken, {})).json();
    const response = await vote(voterToken, created.id, "for", "100");

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("VOTING_NOT_OPEN");
  });

  it("투표 기간에는 표가 집계된다", async () => {
    const { id } = await openVoting();

    const response = await vote(voterToken, id, "for", "100");
    expect(response.statusCode).toBe(200);
    expect(response.json().tally.forWeight).toBe("100");
  });

  it("같은 사람이 다시 던지면 갱신된다", async () => {
    const { id } = await openVoting();

    await vote(voterToken, id, "for", "100");
    const changed = await vote(voterToken, id, "against", "100");

    // 두 표가 남으면 어느 것이 유효한지 판정이 필요해진다.
    expect(changed.json().tally.forWeight).toBe("0");
    expect(changed.json().tally.againstWeight).toBe("100");
  });

  it("큰 무게도 정밀도를 잃지 않는다", async () => {
    // 토큰 무게는 18 decimals다. JSON number로 다루면 값이 바뀐다.
    const { id } = await openVoting();
    const huge = "1000000000000000000000000";

    const response = await vote(voterToken, id, "for", huge);
    expect(response.json().tally.forWeight).toBe(huge);
  });

  it("집계와 다른 결과로 마감할 수 없다", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "against", "100");

    // 반대만 있는데 succeeded로 마감하려 한다.
    const response = await transition(id, version, "succeeded", "통과로 처리");
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("TALLY_MISMATCH");
    expect(response.json().details.computed).toBe("defeated");
  });

  it("집계와 같은 결과로는 마감된다", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "against", "100");

    const response = await transition(id, version, "defeated", "반대가 많다");
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("defeated");
  });

  it("지나온 경로가 남는다", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "for", "100");
    await transition(id, version, "succeeded", "찬성이 많다");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/governance/proposals/${id}`,
      headers: { authorization: `Bearer ${proposerToken}` },
    });

    // 정족수 미달로 끝난 것과 취소된 것은 현재 상태만으로 구분되지 않는다.
    const transitions = detail.json().transitions as { toState: string }[];
    expect(transitions.map((item) => item.toState)).toEqual([
      "review",
      "announced",
      "voting",
      "succeeded",
    ]);
  });

  it("상태 전이에 If-Match가 필요하다", async () => {
    const created = (await propose(proposerToken, {})).json();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${created.id}/transitions`,
      headers: {
        authorization: `Bearer ${proposerToken}`,
        "idempotency-key": idempotencyKey(),
      },
      payload: { toState: "review", reason: "검토 시작" },
    });
    expect(response.statusCode).toBe(428);
  });

  it("허용되지 않는 전이는 다음에 할 수 있는 것을 알려준다", async () => {
    const created = (await propose(proposerToken, {})).json();

    // draft에서 바로 voting으로 갈 수 없다.
    const response = await transition(created.id, created.version, "voting");
    expect(response.statusCode).toBe(409);
    expect(response.json().details.allowedTransitions).toContain("review");
  });

  it("투표 마감 뒤에는 표를 바꿀 수 없다", async () => {
    const { id, version } = await openVoting();
    await vote(voterToken, id, "for", "100");
    await transition(id, version, "succeeded", "찬성이 많다");

    // DB 트리거가 막는다. 집계가 끝난 뒤 표가 하나 바뀌면 기록된 결과와 어긋난다.
    const response = await vote(voterToken, id, "against", "100");
    expect(response.statusCode).toBe(409);
  });

  it("거버넌스 권한이 없으면 투표할 수 없다", async () => {
    const { id } = await openVoting();
    const response = await vote(stewardToken, id, "for", "100");
    expect(response.statusCode).toBe(403);
  });

  it("다른 tenant의 제안은 보이지 않는다", async () => {
    await propose(proposerToken, {});

    const response = await app.inject({
      method: "GET",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  /**
   * 정족수의 분모 — 09 §9.6.
   *
   * 던진 표의 합을 분모로 쓰면 `참여 × D >= 참여 × N`이 항상 참이라 정족수가
   * 통과만 한다. 그러면 `no_quorum`이 구조적으로 나올 수 없고, 한 표만 있어도
   * 마감된다. "참여가 부족해서"와 "반대가 많아서"는 다음에 할 일이 다르다.
   */
  it("정족수 기준 없이는 투표를 열 수 없다", async () => {
    const created = (await propose(proposerToken, {})).json();
    let version = created.version;
    for (const state of ["review", "announced"]) {
      version = (await transition(created.id, version, state)).json().version;
    }

    const response = await transition(created.id, version, "voting");
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("ELIGIBLE_WEIGHT_REQUIRED");
  });

  it("정족수는 던진 표가 아니라 투표권 전체를 분모로 한다", async () => {
    const { id } = await openVoting({
      eligibleWeight: "1000",
      quorumNumerator: 1,
      quorumDenominator: 4,
    });

    // 1000의 1/4 = 250이 필요한데 100만 던졌다.
    const response = await vote(voterToken, id, "for", "100");
    expect(response.json().tally.quorumMet).toBe(false);
    expect(response.json().tally.provisionalOutcome).toBe("no_quorum");
  });

  it("정족수를 채우면 통과 판정이 된다", async () => {
    const { id } = await openVoting({
      eligibleWeight: "1000",
      quorumNumerator: 1,
      quorumDenominator: 4,
    });

    const response = await vote(voterToken, id, "for", "250");
    expect(response.json().tally.quorumMet).toBe(true);
    expect(response.json().tally.provisionalOutcome).toBe("succeeded");
  });

  it("정족수 기준이 어디서 왔는지 응답이 밝힌다", async () => {
    const { id } = await openVoting({ eligibleWeight: "1000" });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/governance/proposals/${id}`,
      headers: { authorization: `Bearer ${proposerToken}` },
    });

    // 사람이 넣은 값으로 계산된 정족수를 온체인 근거로 읽으면 안 된다.
    expect(detail.json().eligibleWeight).toBe("1000");
    expect(detail.json().eligibleWeightSource).toBe("manual");
  });

  it("투표를 연 뒤에는 정족수 기준을 바꿀 수 없다", async () => {
    const { id } = await openVoting({ eligibleWeight: "1000" });

    // 분모를 고칠 수 있으면 결과를 고칠 수 있다.
    await expect(
      fx.sql`UPDATE core.governance_proposals SET eligible_weight = 1 WHERE id = ${id}`,
    ).rejects.toThrow(/바꿀 수 없다/);
  });

  it("투표를 연 감사 기록이 분모의 출처를 남긴다", async () => {
    const { id } = await openVoting({ eligibleWeight: "1000" });

    const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit.events
      WHERE resource_id = ${id} AND command = 'governance.proposal.transitioned'
      ORDER BY occurred_at DESC LIMIT 1
    `;

    // 나중에 "그때 분모가 어디서 왔나"를 물으면 답할 수 있어야 한다.
    expect(event!.detail).toMatchObject({
      toState: "voting",
      eligibleWeight: "1000",
      eligibleWeightSource: "manual",
    });
  });

  it("정족수 미달로 마감할 수 있다", async () => {
    // 분모가 던진 표의 합이던 동안에는 `no_quorum`이 구조적으로 도달할 수
    // 없었다. 정족수 미달과 부결은 다음에 할 일이 다르다(09 §9.6).
    const { id, version } = await openVoting({
      eligibleWeight: "1000",
      quorumNumerator: 1,
      quorumDenominator: 4,
    });
    await vote(voterToken, id, "for", "100");

    const response = await transition(id, version, "no_quorum", "참여가 부족하다");
    expect(response.statusCode).toBe(200);
    expect(response.json().state).toBe("no_quorum");
  });

  it("정족수의 분모가 0인 제안은 만들 수 없다", async () => {
    // 0으로 나누는 것이 아니라 `참여 × D >= 0 × N`이 항상 참이 된다 —
    // 분모를 두고도 정족수가 통과만 하는 상태로 되돌아간다.
    const response = await propose(proposerToken, { eligibleWeight: "0" });
    expect(response.statusCode).toBe(400);
  });
});

/**
 * 온체인 스냅숏 — 09 §9.1, 04 §4.5.
 *
 * 토큰이 연결됐을 때 **어느 space가 어느 토큰을 읽는가**를 고정한다.
 * protocol space의 voter는 MPC holder이고 project space의 voter는 해당 AT
 * holder다(09 §9.1). 토큰 주소 하나를 양쪽에 쓰면 MPC 보유자가 남의 프로젝트
 * 처분에 무게를 갖는다 — 02 §2.4 규칙 7·8이 금지하는 것이다.
 */
describeDb("Governance — 온체인 스냅숏", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let proposerToken: string;

  /** 총공급 조회 실패를 재현한다. 실패는 "모른다"이지 0이 아니다. */
  let totalSupplyFails = false;

  const TOTAL_SUPPLY = 10_000_000_000n * 10n ** 18n;

  /** 잘못된 주소를 읽으면 0이 나온다. 0은 분모로 쓸 수 없다. */
  let totalSupplyValue = TOTAL_SUPPLY;

  const chain = {
    tokenAddress: `0x${"ab".repeat(20)}`,
    chainId: 97,
    confirmationDepth: 12,
    headBlockNumber: async () => 1000,
    readBalance: async () => 5n,
    readTotalSupply: async () => {
      if (totalSupplyFails) throw new Error("archive node required");
      return totalSupplyValue;
    },
  };

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, { governanceChain: chain });
    proposerToken = await signIn(app, fx.proposerA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function openVoting(body: Record<string, unknown>) {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/v1/governance/proposals",
        headers: { authorization: `Bearer ${proposerToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          space: "protocol",
          proposalType: "attestation_schema_approval",
          title: "스키마 변경",
          rationale: "현행 스키마가 한계를 담지 못한다",
          ...body,
        },
      })
    ).json();

    let version = created.version;
    let last;
    for (const state of ["review", "announced", "voting"]) {
      last = await app.inject({
        method: "POST",
        url: `/api/v1/governance/proposals/${created.id}/transitions`,
        headers: {
          authorization: `Bearer ${proposerToken}`,
          "idempotency-key": idempotencyKey(),
          "if-match": `"${version}"`,
        },
        payload: { toState: state, reason: "다음 단계" },
      });
      if (last.statusCode !== 200) break;
      version = last.json().version;
    }
    return last!;
  }

  it("protocol 제안은 스냅숏 블록과 총공급을 고정한다", () => {
    return openVoting({}).then((response) => {
      expect(response.statusCode).toBe(200);
      const body = response.json();

      // head가 아니라 확정된 블록을 쓴다(1000 - 12).
      expect(body.snapshotBlock).toBe("988");
      expect(body.weightSource).toBe("onchain_snapshot");
      expect(body.eligibleWeight).toBe(TOTAL_SUPPLY.toString());
      expect(body.eligibleWeightSource).toBe("onchain_total_supply");
    });
  });

  it("project 제안은 MPC 토큰으로 무게를 읽지 않는다", async () => {
    const response = await openVoting({
      space: "project",
      projectId: fx.projectA,
      proposalType: "independent_valuation_request",
      eligibleWeight: "100",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();

    // project space의 voter는 해당 AT holder다. AT 컨트랙트는 아직 없으므로
    // 온체인 스냅숏 경로가 열리면 안 된다.
    expect(body.snapshotBlock).toBeNull();
    expect(body.weightSource).toBe("manual");
    expect(body.eligibleWeightSource).toBe("manual");
  });

  it("총공급을 읽지 못하면 투표를 열 수 없다", async () => {
    totalSupplyFails = true;
    try {
      const response = await openVoting({});

      // 조회 실패를 0으로 읽으면 정족수가 항상 통과한다.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ELIGIBLE_WEIGHT_UNAVAILABLE");
    } finally {
      totalSupplyFails = false;
    }
  });

  it("총공급이 0으로 읽히면 투표를 열 수 없다", async () => {
    totalSupplyValue = 0n;
    try {
      const response = await openVoting({});

      // 조회는 성공했지만 분모로 쓸 수 없다 — 0이면 정족수가 항상 통과한다.
      // 잘못된 주소를 읽어도 0이 나오므로 조용히 통과시키면 안 된다.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("ELIGIBLE_WEIGHT_ZERO");
    } finally {
      totalSupplyValue = TOTAL_SUPPLY;
    }
  });
});
