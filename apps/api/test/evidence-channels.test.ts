import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Evidence channel parity — AC-29.
 *
 * 네 채널이 같은 Source Receipt를 통과하되 각자가 막아야 하는 것을 막는가.
 * **약한 채널이 쉬운 채널이 되면 안 된다** — 그러면 확인이 어려운 사실일수록
 * 검증 없이 들어온다.
 */
describeDb("Evidence channel", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let steward: string;
  let operator: string;
  let scanService: string;

  /**
   * 기관의 서명 키쌍 — 2026-09-10 실사 A1.
   *
   * 공개키는 연동에 등록되고 개인키는 **테스트가 기관 역할**을 할 때만 쓴다.
   * 서버는 개인키를 보지 못한다 — 그것이 이 채널의 요점이다.
   */
  const authorityKeys = generateKeyPairSync("ed25519");
  const authorityPublicKeyPem = authorityKeys.publicKey
    .export({ type: "spki", format: "pem" })
    .toString();
  const otherKeys = generateKeyPairSync("ed25519");

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    steward = await signIn(app, fx.stewardA);
    operator = await signIn(app, fx.operatorA);
    scanService = await signIn(app, fx.scanServiceA);

    await fx.sql`
      UPDATE core.source_connections
      SET signing_key_reference = ${`plain:${authorityPublicKeyPem}`}
      WHERE id = ${fx.connectionA}
    `;
  });

  /** 파일을 올리고 검사를 통과시킨다. 검사 전 파일은 확정 근거가 아니다. */
  async function uploadClean(content: Buffer, contentType: string): Promise<string> {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
      payload: {
        contentBase64: content.toString("base64"),
        contentType,
        originalFilename: null,
        sensitivity: "restricted",
      },
    });
    expect(created.statusCode).toBe(200);
    const uploadId = created.json().id as string;

    // 같은 내용은 두 번 저장되지 않는다(content hash UNIQUE). 이미 검사를 지난
    // 업로드를 다시 검사하면 409다 — 그것은 이 헬퍼가 볼 일이 아니다.
    if (created.json().state !== "quarantined") return uploadId;

    const scanned = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadId}/scan-result`,
      headers: {
        authorization: `Bearer ${scanService}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${created.json().version}"`,
      },
      payload: { result: "clean" },
    });
    expect(scanned.statusCode).toBe(200);
    return uploadId;
  }

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function createReceipt(token: string, overrides: Record<string, unknown> = {}) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/source-receipts`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        connectionId: fx.connectionA,
        authorityId: fx.authorityA,
        result: "confirmed_from_source",
        // 채널은 overrides가 정한다. 기본값(authenticated_api)의 확정은 이제
        // 서버 조회 경로에서만 만들어진다(A1).
        collectionMethod: "authenticated_api",
        queryBasis: { licenseNumber: "MN-1" },
        endpointOrDocumentRef: "https://registry.example.test/x",
        authenticationMethod: "mtls",
        rawHash: `0x${"ab".repeat(32)}`,
        sourceSchemaVersion: "1",
        adapterVersion: "1",
        termsLicense: "data sharing agreement",
        commercialReuse: "unconfirmed",
        disclosurePermission: "restricted",
        asOf: new Date().toISOString(),
        freshnessStatus: "fresh",
        limitations: ["economic_viability"],
        ...overrides,
      },
    });
  }

  /**
   * 서명 문서 — 2026-09-10 실사 A1.
   *
   * 이전에는 요청 본문의 `signatureValid: true` 하나로 확정됐다. 문서 바이트도
   * 실제 서명도 신뢰된 공개키도 보지 않았다. 지금은 셋을 서버가 본다.
   */
  describe("signed document", () => {
    async function signedReceipt(
      overrides: Record<string, unknown> = {},
      signer = authorityKeys.privateKey,
      document = Buffer.from("공식 등록부 발급 문서 v1"),
    ) {
      const uploadId = await uploadClean(document, "application/pdf");
      const signature = cryptoSign(null, document, signer);

      return createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
        documentUploadId: uploadId,
        signatureBase64: signature.toString("base64"),
        ...overrides,
      });
    }

    it("문서와 서명 없이 확정될 수 없다", async () => {
      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SIGNATURE_EVIDENCE_MISSING");
    });

    it("업로더가 검증 결과를 보내는 것으로 확정할 수 없다", async () => {
      // A1의 원래 경로. 이제 이 필드들은 스키마에 없고 근거로도 쓰이지 않는다.
      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
        signatureValid: true,
        signerRecognized: true,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SIGNATURE_EVIDENCE_MISSING");
    });

    it("다른 사람의 서명은 확정되지 않는다", async () => {
      // 유효한 서명이지만 이 기관의 것이 아니다.
      const response = await signedReceipt({}, otherKeys.privateKey);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SIGNATURE_NOT_VERIFIED");
    });

    it("문서가 바뀌면 서명이 맞지 않는다", async () => {
      const document = Buffer.from("공식 등록부 발급 문서 v1");
      const tampered = Buffer.from("공식 등록부 발급 문서 v1 (수정)");
      const uploadId = await uploadClean(tampered, "application/pdf");
      const signature = cryptoSign(null, document, authorityKeys.privateKey);

      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
        documentUploadId: uploadId,
        signatureBase64: signature.toString("base64"),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SIGNATURE_NOT_VERIFIED");
    });

    it("검사를 통과하지 않은 파일은 확정 근거가 될 수 없다", async () => {
      const document = Buffer.from("검사 전 문서");
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads`,
        headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
        payload: {
          contentBase64: document.toString("base64"),
          contentType: "application/pdf",
          originalFilename: null,
          sensitivity: "restricted",
        },
      });

      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
        documentUploadId: created.json().id,
        signatureBase64: cryptoSign(null, document, authorityKeys.privateKey).toString("base64"),
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("UPLOAD_NOT_VERIFIABLE");
    });

    it("등록된 공개키가 없으면 확정되지 않는다", async () => {
      await fx.sql`
        UPDATE core.source_connections SET signing_key_reference = NULL
        WHERE id = ${fx.connectionA}
      `;
      try {
        const response = await signedReceipt();
        expect(response.statusCode).toBe(422);
        expect(response.json().code).toBe("SIGNER_KEY_NOT_REGISTERED");
      } finally {
        await fx.sql`
          UPDATE core.source_connections
          SET signing_key_reference = ${`plain:${authorityPublicKeyPem}`}
          WHERE id = ${fx.connectionA}
        `;
      }
    });

    it("서버가 검증한 서명이면 확정되고 근거가 결속돼 남는다", async () => {
      const document = Buffer.from("공식 등록부 발급 문서 v2");
      const response = await signedReceipt({}, authorityKeys.privateKey, document);

      expect(response.statusCode).toBe(200);

      const [row] = await fx.sql<
        { channel_evidence: Record<string, unknown>; raw_hash: string }[]
      >`
        SELECT channel_evidence, raw_hash FROM core.source_receipts
        WHERE id = ${response.json().id}
      `;
      // 무엇을 무슨 규칙으로 확인했는지가 함께 남는다.
      expect(row?.channel_evidence["verifiedBy"]).toBe("server");
      expect(row?.channel_evidence["verifierVersion"]).toBe("sig-1");
      expect(row?.channel_evidence["signatureValid"]).toBe(true);
      expect(row?.channel_evidence["documentHash"]).toBe(row?.raw_hash);
    });

    it("실패 결과는 서명 증거 없이도 기록된다", async () => {
      // 실패는 실패대로 남아야 다음 사람이 같은 시도를 반복하지 않는다.
      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
        result: "signature_invalid",
      });

      expect(response.statusCode).toBe(200);
    });
  });

  /**
   * bulk export — 2026-09-10 실사 A1.
   *
   * `observedFields`를 요청자가 적어 보내던 것을 서버가 파일에서 뽑는다.
   */
  describe("bulk export", () => {
    beforeAll(async () => {
      await fx.sql`
        UPDATE core.source_connections
        SET schema_fingerprint = ARRAY['licenseId', 'holder', 'expiresAt']
        WHERE id = ${fx.connectionA}
      `;
    });

    function bulkReceipt(uploadId: string | null, overrides: Record<string, unknown> = {}) {
      return createReceipt(steward, {
        collectionMethod: "official_bulk_export",
        documentUploadId: uploadId,
        ...overrides,
      });
    }

    it("파일 없이 확정될 수 없다", async () => {
      const response = await bulkReceipt(null);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("BULK_FILE_MISSING");
    });

    it("요청자가 적어 보낸 필드 목록으로 확정할 수 없다", async () => {
      // A1의 원래 경로. 파일 없이 목록만 보내던 것이다.
      const response = await createReceipt(steward, {
        collectionMethod: "official_bulk_export",
        observedFields: ["licenseId", "holder", "expiresAt"],
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("BULK_FILE_MISSING");
    });

    it("파일에서 뽑은 스키마가 다르면 확정될 수 없다", async () => {
      // expiresAt이 사라졌다. 파서가 빈 값으로 넘기면 없는 사실이 기록된다.
      const uploadId = await uploadClean(
        Buffer.from("licenseId,holder\nMN-1,광업사\n"),
        "text/csv",
      );

      const response = await bulkReceipt(uploadId);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SOURCE_SCHEMA_DRIFT");
      expect(response.json().details.removed).toBe("expiresAt");
    });

    it("파일에서 뽑은 스키마가 같으면 확정되고 대조 결과가 남는다", async () => {
      const uploadId = await uploadClean(
        Buffer.from('licenseId,holder,"expiresAt"\nMN-1,광업사,2027-01-01\n'),
        "text/csv",
      );

      const response = await bulkReceipt(uploadId);
      expect(response.statusCode).toBe(200);

      const [row] = await fx.sql<
        { channel_evidence: Record<string, unknown>; raw_hash: string }[]
      >`
        SELECT channel_evidence, raw_hash FROM core.source_receipts WHERE id = ${response.json().id}
      `;
      expect(row?.channel_evidence["observedFields"]).toEqual([
        "licenseId",
        "holder",
        "expiresAt",
      ]);
      expect(row?.channel_evidence["verifiedBy"]).toBe("server");
      expect(row?.channel_evidence["documentHash"]).toBe(row?.raw_hash);
    });

    it("스키마를 읽을 수 없는 형식은 확정되지 않는다", async () => {
      const uploadId = await uploadClean(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");

      const response = await bulkReceipt(uploadId);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("BULK_SCHEMA_UNREADABLE");
    });
  });

  describe("manual confirmation", () => {
    it("두 번째 검토 없이 확정될 수 없다", async () => {
      const response = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
      });

      // 한 사람의 진술이 유일한 근거인 채널이 가장 쉬운 채널이 되면 안 된다.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CHANNEL_REQUIREMENT_UNMET");
    });

    it("두 번째 검토를 거쳐 확정된다", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });
      expect(created.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "같은 등록부에서 동일한 기록을 확인했다", confirmed: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result).toBe("confirmed_from_source");
    });

    it("처음 확인한 사람은 두 번째 검토를 할 수 없다", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "내가 다시 봤다", confirmed: true },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("SECOND_REVIEW_SAME_PERSON");
    });

    it("두 번째 검토가 다른 것을 봤으면 확정되지 않는다", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "등록부에 해당 기록이 없다", confirmed: false },
      });

      expect(response.statusCode).toBe(200);
      // 두 번째 사람이 다른 것을 봤다는 사실 자체가 기록이다.
      expect(response.json().result).toBe("conflicting");
    });

    it("두 번 검토할 수 없다", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });

      const send = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/source-receipts/${created.json().id}/second-review`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
          payload: { observation: "확인했다", confirmed: true },
        });

      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(409);
    });

    it("API 채널에는 두 번째 검토가 없다", async () => {
      const created = await createReceipt(steward, { result: "source_unavailable" });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "확인", confirmed: true },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SECOND_REVIEW_NOT_APPLICABLE");
    });
  });

  describe("DB 제약", () => {
    it("같은 사람을 두 확인자로 넣을 수 없다", async () => {
      // receipt는 append-only다. UPDATE가 아니라 INSERT로 시험한다.
      await expect(
        fx.sql`
          INSERT INTO core.source_receipts (
            id, tenant_id, project_id, connection_id, authority_id, collection_method,
            result, query_basis, endpoint_or_document_ref, authentication_method,
            raw_hash, source_schema_version, adapter_version, terms_license,
            commercial_reuse, disclosure_permission, received_at, as_of,
            freshness_status, correlation_id, first_confirmed_by, second_confirmed_by
          ) VALUES (
            gen_random_uuid(), ${fx.tenantA}, ${fx.projectA}, ${fx.connectionA},
            ${fx.authorityA}, 'manual_official_registry_confirmation',
            'confirmed_from_source', '{}'::jsonb, 'doc', 'none',
            ${`0x${"cd".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
            now(), now(), 'fresh', 'test',
            ${fx.reviewerSubjectA}, ${fx.reviewerSubjectA}
          )
        `,
      ).rejects.toThrow(/second_reviewer_differs/);
    });

    /**
     * 2026-09-10 실사 A1 — 라우트를 우회한 경로도 막는가.
     *
     * 라우트가 먼저 422로 막지만 **라우트는 하나가 아니고 앞으로 더 생긴다.**
     * 한 곳만 막으면 그곳을 지나지 않는 경로가 생기는 순간 조용히 열린다.
     */
    function insertReceipt(
      method: string,
      channelEvidence: Record<string, unknown>,
      extraColumns = "",
      extraValues = "",
    ) {
      return fx.sql`
        INSERT INTO core.source_receipts (
          id, tenant_id, project_id, connection_id, authority_id, collection_method,
          result, query_basis, endpoint_or_document_ref, authentication_method,
          raw_hash, source_schema_version, adapter_version, terms_license,
          commercial_reuse, disclosure_permission, received_at, as_of,
          freshness_status, correlation_id, channel_evidence
        ) VALUES (
          gen_random_uuid(), ${fx.tenantA}, ${fx.projectA}, ${fx.connectionA},
          ${fx.authorityA}, ${fx.sql.unsafe(`'${method}'`)},
          'confirmed_from_source', '{}'::jsonb, 'doc', 'none',
          ${`0x${"1a".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
          now(), now(), 'fresh', 'test', ${fx.sql.json(channelEvidence as never)}
        )
      `;
    }

    it("서명 확정에 서버 검증 표시가 없으면 거절한다", async () => {
      // 0021의 제약은 `signatureValid: true`라는 **주장의 존재**만 요구했다.
      await expect(
        insertReceipt("verifiable_signed_document", {
          signatureValid: true,
          signerRecognized: true,
        }),
      ).rejects.toThrow(/signed_document_confirmation_is_server_bound/);
    });

    it("bulk 확정에 추출기 표시가 없으면 거절한다", async () => {
      await expect(
        insertReceipt("official_bulk_export", { observedFields: ["a"] }),
      ).rejects.toThrow(/bulk_export_confirmation_is_server_bound/);
    });

    it("API 확정에 서버 수집 표시가 없으면 거절한다", async () => {
      // 부르지 않고 "불러서 확인했다"를 기록할 수 없다.
      await expect(insertReceipt("authenticated_api", {})).rejects.toThrow(
        /api_confirmation_requires_server_collection/,
      );
    });

    it("서버가 만든 근거를 갖춘 확정은 들어간다", async () => {
      await expect(
        insertReceipt("authenticated_api", { collector: "server_adapter" }),
      ).resolves.toBeDefined();
    });

    it("두 번째 검토 없는 수동 확정을 거절한다", async () => {
      await expect(
        fx.sql`
          INSERT INTO core.source_receipts (
            id, tenant_id, project_id, connection_id, authority_id, collection_method,
            result, query_basis, endpoint_or_document_ref, authentication_method,
            raw_hash, source_schema_version, adapter_version, terms_license,
            commercial_reuse, disclosure_permission, received_at, as_of,
            freshness_status, correlation_id
          ) VALUES (
            gen_random_uuid(), ${fx.tenantA}, ${fx.projectA}, ${fx.connectionA},
            ${fx.authorityA}, 'manual_official_registry_confirmation',
            'confirmed_from_source', '{}'::jsonb, 'doc', 'none',
            ${`0x${"ef".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
            now(), now(), 'fresh', 'test'
          )
        `,
      ).rejects.toThrow(/manual_confirmation_needs_second_review/);
    });
  });
});
