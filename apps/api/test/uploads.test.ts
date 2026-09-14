import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 파일 업로드 — 05 §5.2, 06 §6.7.
 *
 * 이 파일이 확인하는 것의 핵심은 **감염 파일이 evidence가 되는 경로가 없다**는
 * 것이다. 나머지는 그 보장이 성립하기 위한 조건이다.
 */
describeDb("업로드", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;
  let operatorToken: string;
  let scanToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    stewardToken = await signIn(app, fx.stewardA);
    operatorToken = await signIn(app, fx.operatorA);
    scanToken = await signIn(app, fx.scanServiceA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  let counter = 0;
  function upload(token: string, body: Record<string, unknown> = {}) {
    counter += 1;
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        // 케이스마다 다른 내용을 쓴다. content hash가 프로젝트 안에서 UNIQUE라
        // 같은 내용을 쓰면 두 번째부터 기존 행이 돌아온다.
        contentBase64: Buffer.from(`license extract ${counter}`).toString("base64"),
        contentType: "application/pdf",
        originalFilename: "mining-license.pdf",
        ...body,
      },
    });
  }

  describe("content type 제한", () => {
    it("실행 가능한 문서 형식을 거절한다", async () => {
      /**
       * 저장소 오리진은 우리 권한 검사를 지나지 않는다. `text/html`로 저장되면
       * 다운로드 링크를 여는 것만으로 그 오리진에서 실행된다.
       */
      const response = await upload(stewardToken, { contentType: "text/html" });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("REQUEST_INVALID");
    });

    it("svg도 거절한다 — 스크립트를 담을 수 있다", async () => {
      const response = await upload(stewardToken, { contentType: "image/svg+xml" });
      expect(response.statusCode).toBe(400);
    });

    it("파라미터가 붙은 형식은 media type으로 판정한다", async () => {
      const response = await upload(stewardToken, { contentType: "text/csv; charset=utf-8" });
      expect(response.statusCode).toBe(200);
      // 저장은 정규화된 값으로 한다. 파라미터까지 저장하면 같은 형식이 갈라진다.
      expect(response.json().contentType).toBe("text/csv");
    });
  });

  function scan(uploadId: string, version: number, result: "clean" | "infected") {
    return app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadId}/scan-result`,
      headers: {
        // 검사 서비스만 결과를 만들 수 있다. steward는 파일을 올린 쪽이다.
        authorization: `Bearer ${scanToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { result },
    });
  }

  function promote(uploadId: string, version: number) {
    return app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadId}/promote`,
      headers: {
        authorization: `Bearer ${stewardToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: {},
    });
  }

  it("업로드는 quarantine으로 들어간다", async () => {
    const response = await upload(stewardToken);

    expect(response.statusCode).toBe(200);
    // evidence가 아니다. 검사를 통과해야 승격된다.
    expect(response.json().state).toBe("quarantined");
    expect(response.json().promotedArtifactId).toBeNull();
  });

  it("저장소 키에 파일명이 들어가지 않는다", async () => {
    const created = (await upload(stewardToken)).json();

    const [row] = await fx.sql<{ object_key: string }[]>`
      SELECT object_key FROM core.object_uploads WHERE id = ${created.id}
    `;
    // 키는 로그·URL·오류 메시지를 타고 흐른다. 문서 제목도 새어 나가면 안 된다.
    expect(row!.object_key).not.toContain("mining-license");
    expect(row!.object_key).toContain("quarantine/");
  });

  it("다음에 할 수 있는 것을 서버가 알려준다", async () => {
    const created = (await upload(stewardToken)).json();
    expect(created.nextActions).toContain("검사 결과 기록");
  });

  it("검사를 통과하면 evidence로 승격되고 artifact가 생긴다", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "clean");
    expect(scanned.json().state).toBe("scanned_clean");

    const promoted = await promote(created.id, scanned.json().version);
    expect(promoted.statusCode).toBe(200);
    expect(promoted.json().state).toBe("promoted");

    const [artifact] = await fx.sql<{ content_hash: string; object_key: string }[]>`
      SELECT content_hash, object_key FROM core.artifacts
      WHERE id = ${promoted.json().promotedArtifactId}
    `;
    expect(artifact!.content_hash).toBe(created.contentHash);
    expect(artifact!.object_key).toContain("evidence/");
  });

  it("감염 판정된 파일은 승격되지 않는다", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "infected");
    expect(scanned.json().state).toBe("scanned_infected");

    // 상태기계에 `scanned_infected → promoted` 경로가 없다.
    const promoted = await promote(created.id, scanned.json().version);
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json().code).toBe("INVALID_STATE_TRANSITION");
  });

  it("감염 판정은 되돌릴 수 없다", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "infected");

    // 재검사로 clean이 될 수 없다. 다시 보려면 새로 올린다.
    const recheck = await scan(created.id, scanned.json().version, "clean");
    expect(recheck.statusCode).toBe(409);
    expect(scanned.json().nextActions).not.toContain("evidence로 승격");
  });

  it("감염 파일의 다운로드 링크를 만들지 않는다", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "infected");
    expect(scanned.statusCode).toBe(200);

    const link = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${created.id}/download-link`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });
    expect(link.statusCode).toBe(422);
    expect(link.json().code).toBe("UPLOAD_INFECTED");
  });

  it("다운로드 링크는 단기이며 무엇을 우회하지 않는지 밝힌다", async () => {
    const created = (await upload(stewardToken)).json();

    const link = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${created.id}/download-link`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });

    expect(link.statusCode).toBe(200);
    // 영구 URL을 만들지 않는다(06 §6.7).
    expect(link.json().expiresInSeconds).toBeLessThanOrEqual(900);
    // 링크를 받은 사람은 권한 검사를 다시 지나지 않는다.
    expect(link.json().warning).toContain("로그인 없이");
  });

  it("같은 내용을 두 번 올리면 기존 업로드를 돌려준다", async () => {
    const body = {
      contentBase64: Buffer.from("identical content").toString("base64"),
      contentType: "application/pdf",
      originalFilename: "same.pdf",
    };

    const first = await upload(stewardToken, body);
    const second = await upload(stewardToken, body);

    // 두 번 저장하면 evidence가 갈라지고 어느 쪽이 검토 대상인지 모르게 된다.
    expect(second.json().id).toBe(first.json().id);
  });

  describe("multipart 스트리밍", () => {
    function streamUpload(token: string, content: string, filename = "big.pdf") {
      const boundary = "----mpcboundary";
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\n` +
            `content-disposition: form-data; name="file"; filename="${filename}"\r\n` +
            `content-type: application/pdf\r\n\r\n`,
        ),
        Buffer.from(content),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);

      return app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads/stream`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": idempotencyKey(),
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      });
    }

    it("스트리밍으로 올려도 quarantine으로 들어간다", async () => {
      const response = await streamUpload(stewardToken, `stream content ${Date.now()}`);

      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("quarantined");
    });

    it("base64 경로와 같은 content hash를 만든다", async () => {
      const content = `same bytes ${Date.now()}`;
      const viaStream = (await streamUpload(stewardToken, content)).json();
      const viaBase64 = (
        await upload(stewardToken, {
          contentBase64: Buffer.from(content).toString("base64"),
        })
      ).json();

      // 두 경로가 다른 해시를 만들면 같은 파일이 두 evidence가 된다.
      expect(viaBase64.contentHash).toBe(viaStream.contentHash);
      expect(viaBase64.id).toBe(viaStream.id);
    });

    it("파일 파트가 없으면 거절한다", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads/stream`,
        headers: {
          authorization: `Bearer ${stewardToken}`,
          "idempotency-key": idempotencyKey(),
          "content-type": "multipart/form-data; boundary=----x",
        },
        payload: Buffer.from("------x--\r\n"),
      });
      expect(response.statusCode).toBe(400);
    });

    it("권한 없는 계정은 스트리밍으로도 올릴 수 없다", async () => {
      // 경로가 둘이면 한쪽만 권한이 느슨해질 수 있다.
      const response = await streamUpload(operatorToken, "denied");
      expect(response.statusCode).toBe(403);
    });
  });

  it("UUID가 아닌 경로 파라미터는 400이다", async () => {
    // DB에 그대로 넘기면 타입 오류가 500으로 나가고 클라이언트는 서버 장애로
    // 오인해 재시도한다.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/new/uploads",
      headers: { authorization: `Bearer ${stewardToken}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PATH_PARAM_INVALID");
  });

  it("빈 파일을 받지 않는다", async () => {
    const response = await upload(stewardToken, { contentBase64: "" });
    expect(response.statusCode).toBe(400);
  });

  it("source.upload 권한이 없으면 거절한다", async () => {
    // mpc_operator에게는 이 권한이 없다(02 §2.3).
    const response = await upload(operatorToken);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("data_steward");
  });

  it("검사 결과 기록에 If-Match가 필요하다", async () => {
    const created = (await upload(stewardToken)).json();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${created.id}/scan-result`,
      headers: { authorization: `Bearer ${scanToken}`, "idempotency-key": idempotencyKey() },
      payload: { result: "clean" },
    });
    expect(response.statusCode).toBe(428);
  });

  it("올린 사람은 자기 파일의 검사 결과를 만들 수 없다", async () => {
    const created = (await upload(stewardToken)).json();

    // `source.upload`를 재사용했다면 통과했을 것이다. quarantine이 형식만
    // 남지 않게 별도 action으로 분리했다.
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${created.id}/scan-result`,
      headers: {
        authorization: `Bearer ${stewardToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${created.version}"`,
      },
      payload: { result: "clean" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toEqual(["scan_service"]);
  });

  it("다른 tenant의 업로드는 보이지 않는다", async () => {
    await upload(stewardToken);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("감사 로그에 파일명이 남지 않는다", async () => {
    const created = (await upload(stewardToken)).json();

    const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit.events
      WHERE resource_type = 'object_upload' AND resource_id = ${created.id}
      ORDER BY occurred_at LIMIT 1
    `;
    // 감사 로그가 restricted 정보의 통로가 되면 안 된다.
    expect(JSON.stringify(event!.detail)).not.toContain("mining-license");
  });

  /**
   * 저장 등급 게이트 — OD-17·OD-18 (2026-08-14 초안 결정).
   *
   * 초안 저장 경로는 provider 관리 키를 쓰고 tenant별 키 분리도 파기 절차도
   * 없다. 실제 계약서·개인정보는 secured route가 열린 뒤에 올린다.
   */
  describe("저장 등급 게이트", () => {
    it("confidential 업로드를 거절하고 다음 행동을 알려준다", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          contentBase64: Buffer.from("계약서 내용").toString("base64"),
          contentType: "application/pdf",
          originalFilename: "contract.pdf",
          sensitivity: "confidential",
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SECURED_ROUTE_REQUIRED");
      expect(response.json().details.requiredTier).toBe("secured");
    });

    it("restricted는 그대로 받는다", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          contentBase64: Buffer.from("일반 자료").toString("base64"),
          contentType: "application/pdf",
          sensitivity: "restricted",
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it("DB도 같은 것을 막는다", async () => {
      // 라우트를 우회하는 경로가 생겨도 남아야 한다.
      await expect(
        fx.sql`
          UPDATE core.object_uploads SET sensitivity = 'confidential'
          WHERE project_id = ${fx.projectA}
        `,
      ).rejects.toThrow(/object_uploads_draft_tier_only/);
    });
  });
});
