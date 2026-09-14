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
       * The default is a **non-confirmed result** — 2026-09-10 audit A1.
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
      freshnessStatus: "fresh",
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
   * A1 negative test — 2026-09-10 audit.
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
    ).rejects.toThrow(/수정·삭제할 수 없다/);
  });

  it("cannot register without a raw hash", async () => {
    const response = await create(tokens.stewardA, receiptBody({ rawHash: undefined }));
    expect(response.statusCode).toBe(400);
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

  it("computes the grade by domain rules and stores it", async () => {
    const response = await create(tokens.stewardA,
      claimBody({
        evidenceTier: "P1",
        verificationState: "independently_assured",
        attestationTypes: ["professional_signoff", "independent_assurance"],
      }),
    );
    expect(response.json().grade).toBe("verified");
  });

  it("lowers the grade when the evidence tier is low", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ evidenceTier: "P4", verificationState: "machine_checked" }),
    );
    expect(response.json().grade).toBe("self_reported");
  });

  it("is unverified without evidence", async () => {
    const response = await create(tokens.stewardA,
      claimBody({ evidenceTier: null, verificationState: "unreviewed" }),
    );
    expect(response.json().grade).toBe("unverified");
  });

  it("recomputes the grade when an unresolved conflict appears", async () => {
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
    // Attestations are unchanged, but an unresolved conflict breaks verified.
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
