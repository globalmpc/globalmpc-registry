import { randomUUID } from "node:crypto";
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

    // From R1, authentication is SIWE signature → session token. Tests take the same path.
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
       * The default is a **non-confirmed result**.
       *
       * This route is the entry where a person writes in a result; an `authenticated_api`
       * confirmation is created only on the server-called path (`/collect`). Defaulting to
       * confirmed would let other tests walk past that fact.
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
      limitations: ["This lookup confirms mining right registration status only"],
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

  it("returns the 11 non-confirmed results with retryable and nextAction", async () => {
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
   * Negative test: a client cannot supply confirmation evidence.
   *
   * An uploader sending `result: "confirmed_from_source"` was enough to create an API
   * collection confirmation. That record is indistinguishable from the server actually
   * calling the source.
   */
  it("cannot create an API collection confirmation from the request body", async () => {
    const response = await create(
      tokens.stewardA,
      receiptBody({ result: "confirmed_from_source" }),
    );

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CONFIRMATION_REQUIRES_SERVER_COLLECTION");
  });

  it("AC-18: no record and unavailable produce different responses", async () => {
    const noRecord = (
      await create(tokens.stewardA, receiptBody({ result: "source_returned_no_record" }))
    ).json();
    const unavailable = (
      await create(tokens.stewardA, receiptBody({ result: "source_unavailable" }))
    ).json();

    // A source answering "none" is not a retry target.
    expect(noRecord.retryable).toBe(false);
    expect(unavailable.retryable).toBe(true);
    expect(noRecord.nextAction).not.toBe(unavailable.nextAction);
  });

  it("invariant 15: a non-confirmed result is not a canonical acceptance candidate", async () => {
    for (const result of SOURCE_RESULTS.filter((r) => r !== "confirmed_from_source")) {
      const body = (await create(tokens.stewardA, receiptBody({ result }))).json();
      expect(body.permitsCanonicalAcceptance, result).toBe(false);
    }
  });

  it("does not allow a receipt to be modified", async () => {
    const created = (await create(tokens.stewardA, receiptBody())).json();
    await expect(
      fx.sql`
        UPDATE core.source_receipts SET result = 'confirmed_from_source' WHERE id = ${created.id}
      `,
    ).rejects.toThrow(/cannot be modified or deleted/);
  });

  /**
   * REQ-DAPP-049: a missing original is recorded as missing.
   *
   * A lookup that returned nothing has no original to hash. Requiring a hash made callers
   * invent one — the Data Room sent a fixed `0xabab…` — which reads as the hash of a document
   * that does not exist.
   */
  it("records an absent original as absent, not as a hash", async () => {
    const response = await create(tokens.stewardA, receiptBody({ rawHash: undefined }));
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().rawHash).toBeNull();
  });

  it("refuses a zero hash — it stands for no original", async () => {
    const response = await create(tokens.stewardA, receiptBody({ rawHash: `0x${"0".repeat(64)}` }));
    expect(response.statusCode).toBe(400);
  });

  it("refuses a client-sent freshness — the server computes it", async () => {
    const response = await create(tokens.stewardA, receiptBody({ freshnessStatus: "fresh" }));
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("FRESHNESS_IS_SERVER_COMPUTED");

    // With no freshness rule for this source (OD-16 pending), the honest value is unknown.
    const created = await create(tokens.stewardA, receiptBody());
    expect(created.json().freshnessStatus).toBe("unknown");
  });

  it("refuses an authority that is not the connection's", async () => {
    const response = await create(tokens.stewardA, receiptBody({ authorityId: randomUUID() }));
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("CONNECTION_AUTHORITY_MISMATCH");
  });

  it("refuses a connection that does not exist in the tenant", async () => {
    const response = await create(tokens.stewardA, receiptBody({ connectionId: randomUUID() }));
    expect(response.statusCode).toBe(404);
  });

  it("takes terms, reuse, disclosure and versions from the connection when not sent", async () => {
    const response = await create(
      tokens.stewardA,
      receiptBody({
        termsLicense: undefined,
        commercialReuse: undefined,
        disclosurePermission: undefined,
        sourceSchemaVersion: undefined,
        adapterVersion: undefined,
      }),
    );
    expect(response.statusCode, response.body).toBe(200);
    const [connection] = await fx.sql<{ terms_license: string; adapter_version: string }[]>`
      SELECT terms_license, adapter_version FROM core.source_connections WHERE id = ${fx.connectionA}
    `;
    expect(response.json().termsLicense).toBe(connection!.terms_license);
    expect(response.json().adapterVersion).toBe(connection!.adapter_version);
  });

  it("binds the raw hash to a scanned document when one is referenced", async () => {
    const uploadId = randomUUID();
    const contentHash = `0x${randomUUID().replace(/-/g, "").padEnd(64, "7")}`;
    await fx.sql`
      INSERT INTO core.object_uploads (
        id, tenant_id, project_id, object_key, content_hash, byte_size, content_type,
        sensitivity, state
      ) VALUES (
        ${uploadId}, ${fx.tenantA}, ${fx.projectA}, ${`objects/${uploadId}`}, ${contentHash},
        10, 'application/pdf', 'restricted', 'scanned_clean'
      )
    `;

    const bound = await create(
      tokens.stewardA,
      receiptBody({ rawHash: undefined, documentUploadId: uploadId }),
    );
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().rawHash).toBe(contentHash);

    // A hash that disagrees with the referenced document is not silently replaced.
    const disagreeing = await create(
      tokens.stewardA,
      receiptBody({ rawHash: `0x${"cd".repeat(32)}`, documentUploadId: uploadId }),
    );
    expect(disagreeing.statusCode).toBe(422);
    expect(disagreeing.json().code).toBe("RAW_HASH_DOCUMENT_MISMATCH");
  });

  it("rejects a malformed raw hash", async () => {
    const response = await create(tokens.stewardA, receiptBody({ rawHash: "0xdead" }));
    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown result — no aliases can be created", async () => {
    const response = await create(tokens.stewardA, receiptBody({ result: "no_record" }));
    expect(response.statusCode).toBe(400);
  });

  it("rejects an authentication method containing an API secret (05 §5.12)", async () => {
    // Authentication "methods" are a finite set. Allowing free strings would store token values
    // verbatim.
    const response = await create(tokens.stewardA,
      receiptBody({ authenticationMethod: "bearer sk-secret-token" }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("accepts only allowed authentication methods", async () => {
    for (const method of ["mtls", "oauth2", "signed_document", "manual_verification"]) {
      const response = await create(tokens.stewardA, receiptBody({ authenticationMethod: method }));
      expect(response.statusCode, method).toBe(200);
    }
  });

  it("stores no secret value anywhere in the receipt", async () => {
    const created = (await create(tokens.stewardA, receiptBody())).json();
    const [row] = await fx.sql`
      SELECT * FROM core.source_receipts WHERE id = ${created.id}
    `;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toMatch(/sk-[a-z0-9-]+/i);
    expect(serialized).not.toMatch(/bearer /i);
    // Secrets exist only as the connection's reference.
    expect(serialized).not.toContain("vault://");
  });

  it("records audit and outbox entries on registration", async () => {
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

  it("lists only within the tenant", async () => {
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

  it("does not let an unauthorized account register", async () => {
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

  it("REQ-DAPP-004: a new claim starts unreviewed and unverified", async () => {
    const response = await create(tokens.stewardA, claimBody({ evidenceTier: "P1" }));
    expect(response.statusCode).toBe(200);
    expect(response.json().verificationState).toBe("unreviewed");
    expect(response.json().grade).toBe("unverified");
  });

  it("REQ-DAPP-004: the submitter cannot declare a verification state or attestations", async () => {
    for (const declared of [
      { verificationState: "independently_assured" },
      { attestationTypes: ["professional_signoff", "independent_assurance"] },
    ]) {
      const response = await create(tokens.stewardA, claimBody(declared));
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("CLAIM_ASSESSMENT_NOT_SETTABLE");
    }
  });

  it("records who submitted the claim and the first entry of each axis history", async () => {
    const created = (await create(tokens.stewardA, claimBody({ evidenceTier: "P2" }))).json();

    const [row] = await fx.sql<{ submitted_by: string }[]>`
      SELECT submitted_by FROM core.claims WHERE id = ${created.id}
    `;
    expect(row!.submitted_by).toBe(fx.stewardSubjectA);

    const history = await fx.sql<{ axis: string; to_value: string; cause: string }[]>`
      SELECT axis, to_value, cause FROM core.provenance_axis_history
      WHERE subject_id = ${created.id} ORDER BY axis
    `;
    expect(history).toEqual([
      { axis: "evidence_tier", to_value: "P2", cause: "claim_submitted" },
      { axis: "verification_state", to_value: "unreviewed", cause: "claim_submitted" },
    ]);
  });

  it("is unverified without evidence", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ evidenceTier: null, verificationState: "unreviewed" }),
    );
    expect(response.json().grade).toBe("unverified");
  });

  it("recomputes the grade from standing attestations when a conflict appears", async () => {
    const created = (await create(tokens.stewardA, claimBody({ evidenceTier: "P1" }))).json();
    // A claim recorded before assessments were derived: `verified` stored, no attestation behind it.
    await fx.sql`
      UPDATE core.claims SET verification_state = 'independently_assured', grade = 'verified'
      WHERE id = ${created.id}
    `;

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
    // No signed attestation stands behind the stored `verified`, and a conflict is now open.
    expect(conflicted.json().grade).toBe("partially_verified");
  });

  describe("concurrent modification (If-Match)", () => {
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

    it("returns 428 without If-Match and says what is missing", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const response = await recordConflict(created.id, undefined);

      // Not 412. A 412 reads as "wrong version" and hides the missing header.
      expect(response.statusCode).toBe(428);
      expect(response.json().code).toBe("IF_MATCH_REQUIRED");
    });

    it("returns 412 with the current version for a stale version", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();

      const first = await recordConflict(created.id, `"${created.version}"`);
      expect(first.statusCode).toBe(200);

      // Reuse the same version — a request from someone who did not see the first write.
      const second = await recordConflict(created.id, `"${created.version}"`);
      expect(second.statusCode).toBe(412);
      expect(second.json().code).toBe("RESOURCE_VERSION_MISMATCH");
      expect(second.json().details.currentVersion).toBe(String(created.version + 1));
      // Retrying gives the same result. The caller must re-read and decide.
      expect(second.json().retryable).toBe(false);
    });

    it("allows continuing after re-reading the current version", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const first = await recordConflict(created.id, `"${created.version}"`);

      const next = await recordConflict(created.id, `"${first.json().version}"`);
      expect(next.statusCode).toBe(200);
    });

    it("lets only one of two concurrent requests succeed", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();

      // Two people who saw the same version write at once. Without a lock both pass and one
      // decision vanishes without a trace.
      const [a, b] = await Promise.all([
        recordConflict(created.id, `"${created.version}"`),
        recordConflict(created.id, `"${created.version}"`),
      ]);

      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([200, 412]);
    });

    it("accepts the W/ prefix and the unquoted form", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const weak = await recordConflict(created.id, `W/"${created.version}"`);
      expect(weak.statusCode).toBe(200);

      const bare = await recordConflict(created.id, String(weak.json().version));
      expect(bare.statusCode).toBe(200);
    });

    it("returns 400 when the value is not a version", async () => {
      const created = (await create(tokens.stewardA, claimBody({}))).json();
      const response = await recordConflict(created.id, '"abc"');
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("IF_MATCH_INVALID");
    });
  });

  it("rejects a numeric value sent as a number", async () => {
    const response = await create(tokens.stewardA, claimBody({ valueText: 1200 }));
    expect(response.statusCode).toBe(400);
  });

  it("rejects a numeric claim without a unit", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ claimType: "resource_estimate", valueText: "1200", unit: null }),
    );
    expect(response.statusCode).toBe(400);
  });

  it("accepts a numeric claim with a unit", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ claimType: "resource_estimate", valueText: "1200000", unit: "t" }),
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().valueText).toBe("1200000");
    expect(response.json().unit).toBe("t");
  });

  it("keeps precision for large values", async () => {
    const huge = "123456789012345678901234567890";
    const response = await create(tokens.stewardA,
      claimBody({ claimType: "resource_estimate", valueText: huge, unit: "t" }),
    );
    expect(response.json().valueText).toBe(huge);
  });

  it("lists only within the tenant", async () => {
    await create(tokens.stewardA, claimBody());

    const other = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/claims`,
      headers: { authorization: `Bearer ${tokens.operatorB}` },
    });
    expect(other.json().items).toEqual([]);
  });

  it("does not let an unauthorized account register", async () => {
    const response = await create(tokens.readerA, claimBody());
    expect(response.statusCode).toBe(403);
  });
});
