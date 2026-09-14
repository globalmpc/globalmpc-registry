import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 워크스페이스 집계.
 *
 * 두 화면이 없던 이유는 데이터가 없어서가 아니라 프로젝트 하나를 열어야만 보이는
 * 구조였기 때문이다. 여기서 보는 것은 **집계가 tenant 경계를 지키는가**와
 * **"내가 할 일"과 "내가 기다리는 것"이 섞이지 않는가**다.
 */
describeDb("워크스페이스 집계", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorAToken: string;
  let operatorBToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorAToken = await signIn(app, fx.operatorA);
    operatorBToken = await signIn(app, fx.operatorB);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  it("게시 상태를 프로젝트를 열지 않고 낸다", async () => {
    const publicKey = `WS-${randomUUID().slice(0, 8)}`;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorAToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["법률 권리 확인은 이 검토 범위 밖이다"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    const listed = await get(operatorAToken, "/api/v1/registry-entries");
    expect(listed.statusCode).toBe(200);

    const mine = listed
      .json()
      .items.find((item: { publicKey: string }) => item.publicKey === publicKey);
    expect(mine).toBeDefined();
    expect(mine.status).toBe("published");
    // 게시와 anchor는 다른 사건이다. 한 칸에 합치면 "게시됐으니 체인에 있다"로
    // 읽힌다.
    expect(mine.anchored).toBe(false);
  });

  it("다른 tenant의 기록을 내지 않는다", async () => {
    const a = await get(operatorAToken, "/api/v1/registry-entries");
    const b = await get(operatorBToken, "/api/v1/registry-entries");

    const aKeys = new Set(a.json().items.map((item: { entryId: string }) => item.entryId));
    for (const item of b.json().items) {
      expect(aKeys.has(item.entryId)).toBe(false);
    }
  });

  it("내가 기다리는 것과 결정해야 하는 것을 섞지 않는다", async () => {
    const subject = (
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/subjects",
        headers: {
          authorization: `Bearer ${operatorAToken}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: { displayName: `My work target ${randomUUID().slice(0, 6)}` },
      })
    ).json();

    await app.inject({
      method: "POST",
      url: "/api/v1/admin/role-grants",
      headers: { authorization: `Bearer ${operatorAToken}`, "idempotency-key": idempotencyKey() },
      payload: { subjectId: subject.id, role: "auditor", reason: "감사 담당" },
    });

    const mine = (await get(operatorAToken, "/api/v1/my-work")).json();

    // 내가 제안했다 — 내가 할 일은 없다.
    expect(mine.waitingOnOthers.some((item: { id: string }) => item.id)).toBe(true);
    // 같은 제안이 "결정해야 하는 것"에도 있으면 두 목록의 의미가 사라진다.
    const waitingIds = new Set(mine.waitingOnOthers.map((item: { id: string }) => item.id));
    for (const item of mine.unassigned) {
      if (item.kind === "role_grant_decision") {
        expect(waitingIds.has(item.id)).toBe(false);
      }
    }
  });

  it("아무에게도 배정되지 않은 것을 따로 낸다", async () => {
    // 배정된 일만 보이면 아무도 맡지 않은 일이 영원히 보이지 않는다.
    const response = await get(operatorAToken, "/api/v1/my-work");

    expect(response.statusCode).toBe(200);
    expect(Array.isArray(response.json().unassigned)).toBe(true);
    expect(Array.isArray(response.json().assignedToMe)).toBe(true);
  });
});
