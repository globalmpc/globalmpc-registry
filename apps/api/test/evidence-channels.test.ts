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
 * Do the four channels share one Source Receipt while each blocks what it must block?
 * **A weak channel must not become the easy channel** — otherwise the harder a fact is
 * to confirm, the more likely it enters unverified.
 */
describeDb("Evidence channel", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let steward: string;
  let operator: string;
  let scanService: string;

  /**
   * The authority's signing key pair — 2026-09-10 audit A1.
   *
   * The public key is registered on the integration; the private key is used only when **the
   * test acts as the authority**. The server never sees the private key — that is the point.
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

  /** Uploads a file and passes its scan. An unscanned file is not confirmed evidence. */
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

    // Identical content is not stored twice (content hash UNIQUE). Rescanning an already
    // scanned upload returns 409 — not this helper's concern.
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
        // overrides sets the channel. Confirmation for the default (authenticated_api) is now
        // produced only by the server lookup path (A1).
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
   * Signed document — 2026-09-10 audit A1.
   *
   * Previously `signatureValid: true` in the request body alone confirmed it, without looking
   * at document bytes, the actual signature, or a trusted public key. The server now checks
   * all three.
   */
  describe("signed document", () => {
    async function signedReceipt(
      overrides: Record<string, unknown> = {},
      signer = authorityKeys.privateKey,
      document = Buffer.from("official registry-issued document v1"),
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

    it("cannot confirm without a document and signature", async () => {
      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SIGNATURE_EVIDENCE_MISSING");
    });

    it("cannot confirm by the uploader sending a verification result", async () => {
      // The original A1 path. These fields are no longer in the schema nor used as evidence.
      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
        signatureValid: true,
        signerRecognized: true,
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SIGNATURE_EVIDENCE_MISSING");
    });

    it("does not confirm a signature by someone else", async () => {
      // A valid signature, but not from this authority.
      const response = await signedReceipt({}, otherKeys.privateKey);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SIGNATURE_NOT_VERIFIED");
    });

    it("the signature no longer matches when the document changes", async () => {
      const document = Buffer.from("official registry-issued document v1");
      const tampered = Buffer.from("official registry-issued document v1 (edited)");
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

    it("a file that has not passed scanning cannot be confirmed evidence", async () => {
      const document = Buffer.from("unscanned document");
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

    it("does not confirm without a registered public key", async () => {
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

    it("confirms a server-verified signature and keeps the evidence bound", async () => {
      const document = Buffer.from("official registry-issued document v2");
      const response = await signedReceipt({}, authorityKeys.privateKey, document);

      expect(response.statusCode).toBe(200);

      const [row] = await fx.sql<
        { channel_evidence: Record<string, unknown>; raw_hash: string }[]
      >`
        SELECT channel_evidence, raw_hash FROM core.source_receipts
        WHERE id = ${response.json().id}
      `;
      // Records what was checked and under which rule.
      expect(row?.channel_evidence["verifiedBy"]).toBe("server");
      expect(row?.channel_evidence["verifierVersion"]).toBe("sig-1");
      expect(row?.channel_evidence["signatureValid"]).toBe(true);
      expect(row?.channel_evidence["documentHash"]).toBe(row?.raw_hash);
    });

    it("records a failed result even without signature evidence", async () => {
      // Failures must be kept so the next person does not repeat the same attempt.
      const response = await createReceipt(steward, {
        collectionMethod: "verifiable_signed_document",
        result: "signature_invalid",
      });

      expect(response.statusCode).toBe(200);
    });
  });

  /**
   * bulk export — 2026-09-10 audit A1.
   *
   * The server extracts `observedFields` from the file instead of taking the requester's list.
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

    it("cannot confirm without a file", async () => {
      const response = await bulkReceipt(null);

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("BULK_FILE_MISSING");
    });

    it("cannot confirm with a field list sent by the requester", async () => {
      // The original A1 path: sending only a list, without a file.
      const response = await createReceipt(steward, {
        collectionMethod: "official_bulk_export",
        observedFields: ["licenseId", "holder", "expiresAt"],
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("BULK_FILE_MISSING");
    });

    it("cannot confirm when the schema extracted from the file differs", async () => {
      // expiresAt is gone. If the parser passed it as empty, a nonexistent fact would be recorded.
      const uploadId = await uploadClean(
        Buffer.from("licenseId,holder\nMN-1,Ölgii Mining LLC\n"),
        "text/csv",
      );

      const response = await bulkReceipt(uploadId);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SOURCE_SCHEMA_DRIFT");
      expect(response.json().details.removed).toBe("expiresAt");
    });

    it("confirms when the extracted schema matches and records the comparison", async () => {
      const uploadId = await uploadClean(
        Buffer.from('licenseId,holder,"expiresAt"\nMN-1,Ölgii Mining LLC,2027-01-01\n'),
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

    it("does not confirm a format whose schema cannot be read", async () => {
      const uploadId = await uploadClean(Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");

      const response = await bulkReceipt(uploadId);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("BULK_SCHEMA_UNREADABLE");
    });
  });

  describe("manual confirmation", () => {
    it("cannot confirm without a second review", async () => {
      const response = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
      });

      // A channel whose only evidence is one person's statement must not be the easiest channel.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CHANNEL_REQUIREMENT_UNMET");
    });

    it("confirms after a second review", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });
      expect(created.statusCode).toBe(200);

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "confirmed the same record in the same registry", confirmed: true },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().result).toBe("confirmed_from_source");
    });

    it("the first checker cannot perform the second review", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "I checked it again", confirmed: true },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("SECOND_REVIEW_SAME_PERSON");
    });

    it("does not confirm when the second review saw something different", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "the registry has no such record", confirmed: false },
      });

      expect(response.statusCode).toBe(200);
      // That the second person saw something different is itself a record.
      expect(response.json().result).toBe("conflicting");
    });

    it("cannot review twice", async () => {
      const created = await createReceipt(steward, {
        collectionMethod: "manual_official_registry_confirmation",
        result: "manual_review_required",
      });

      const send = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/source-receipts/${created.json().id}/second-review`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
          payload: { observation: "confirmed", confirmed: true },
        });

      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(409);
    });

    it("the API channel has no second review", async () => {
      const created = await createReceipt(steward, { result: "source_unavailable" });

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/source-receipts/${created.json().id}/second-review`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { observation: "checked", confirmed: true },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SECOND_REVIEW_NOT_APPLICABLE");
    });
  });

  describe("DB constraints", () => {
    it("cannot use the same person as both checkers", async () => {
      // Receipts are append-only. Tested with INSERT, not UPDATE.
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
     * 2026-09-10 audit A1 — are paths that bypass the route also blocked?
     *
     * The route rejects with 422 first, but **there is more than one route, and more will come.**
     * Blocking in one place silently opens the moment a path bypasses it.
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

    it("rejects a signature confirmation without the server-verified marker", async () => {
      // The 0021 constraint only required the **presence of the claim** `signatureValid: true`.
      await expect(
        insertReceipt("verifiable_signed_document", {
          signatureValid: true,
          signerRecognized: true,
        }),
      ).rejects.toThrow(/signed_document_confirmation_is_server_bound/);
    });

    it("rejects a bulk confirmation without the extractor marker", async () => {
      await expect(
        insertReceipt("official_bulk_export", { observedFields: ["a"] }),
      ).rejects.toThrow(/bulk_export_confirmation_is_server_bound/);
    });

    it("rejects an API confirmation without the server-collected marker", async () => {
      // Cannot record "called and checked" without actually calling.
      await expect(insertReceipt("authenticated_api", {})).rejects.toThrow(
        /api_confirmation_requires_server_collection/,
      );
    });

    it("accepts a confirmation carrying server-produced evidence", async () => {
      await expect(
        insertReceipt("authenticated_api", { collector: "server_adapter" }),
      ).resolves.toBeDefined();
    });

    it("rejects a manual confirmation without a second review", async () => {
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
