import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Capped lists say they were capped.
 *
 * Every list below used to stop at a fixed row count and say nothing. With ~10,000 documents
 * in a project the Data Room showed the newest 100 and the screen read as "that is all there
 * is". A capped list now either pages with a cursor or states `truncated: true`.
 */
describeDb("capped lists", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;
  let operatorToken: string;
  let proposerToken: string;

  /** Seeded documents. Big enough that every cap in this file is exceeded. */
  const SEEDED_UPLOADS = 10_000;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    stewardToken = await signIn(app, fx.stewardA);
    operatorToken = await signIn(app, fx.operatorA);
    proposerToken = await signIn(app, fx.proposerA);

    // One real upload through the API, then cloned in SQL. Cloning the row keeps every column
    // the constraints expect without restating them here.
    const template = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        contentBase64: Buffer.from("w123 template").toString("base64"),
        contentType: "application/pdf",
        originalFilename: "template.pdf",
      },
    });
    expect(template.statusCode).toBe(200);
    const templateId = template.json().id as string;

    /**
     * Timestamps step by one microsecond and three rows share each one.
     *
     * - shared timestamps: only the id tiebreaker keeps the order total
     * - one-microsecond steps: a cursor that goes through a JS Date loses the microseconds and
     *   skips the rows between the truncated value and the real one
     */
    await fx.sql`
      INSERT INTO core.object_uploads
      SELECT (jsonb_populate_record(NULL::core.object_uploads, to_jsonb(t) || jsonb_build_object(
        'id', gen_random_uuid(),
        'object_key', 'seed/w123/' || g,
        'content_hash', '0x' || encode(sha256(convert_to('w123-' || g, 'UTF8')), 'hex'),
        'original_filename', 'seed-' || g || '.pdf',
        'uploaded_at', timestamptz '2026-01-01T00:00:00Z' + ((g / 3) * interval '1 microsecond')
      ))).*
      FROM core.object_uploads t, generate_series(1, ${SEEDED_UPLOADS - 1}) g
      WHERE t.id = ${templateId}
    `;
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function get(token: string, url: string) {
    return app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
  }

  describe("uploads — keyset cursor", () => {
    it(
      "walks all 10,000 documents with no duplicate and no gap",
      async () => {
        const seen: string[] = [];
        const timings: number[] = [];
        let cursor: string | null = null;
        let pages = 0;

        do {
          const url: string =
            `/api/v1/projects/${fx.projectA}/uploads` +
            (cursor ? `?cursor=${encodeURIComponent(cursor)}` : "");
          const started = performance.now();
          const response = await get(stewardToken, url);
          timings.push(performance.now() - started);
          expect(response.statusCode).toBe(200);

          const body = response.json();
          expect(body.limit).toBe(100);
          expect(body.total).toBe(SEEDED_UPLOADS);
          expect(body.truncated).toBe(body.nextCursor !== null);
          seen.push(...body.items.map((item: { id: string }) => item.id));
          cursor = body.nextCursor;
          pages += 1;
        } while (cursor !== null && pages < 200);

        const expected = await fx.sql<{ id: string }[]>`
          SELECT id FROM core.object_uploads WHERE project_id = ${fx.projectA}
        `;
        const unique = new Set(seen);
        const missing = expected.filter((row) => !unique.has(row.id));

        expect(pages).toBe(SEEDED_UPLOADS / 100);
        expect(seen.length - unique.size, "duplicates").toBe(0);
        expect(missing.length, "missing").toBe(0);
        expect(unique.size).toBe(SEEDED_UPLOADS);

        const sorted = [...timings].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)]!;
        const firstTen = timings.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
        const lastTen = timings.slice(-10).reduce((a, b) => a + b, 0) / 10;
        // Recorded for the PR, not asserted tightly — absolute numbers vary by machine.
        console.log(
          `uploads walk: ${pages} pages, total ${timings
            .reduce((a, b) => a + b, 0)
            .toFixed(0)}ms, median ${median.toFixed(1)}ms, p95 ${sorted[
            Math.floor(sorted.length * 0.95)
          ]!.toFixed(1)}ms, max ${sorted.at(-1)!.toFixed(1)}ms, first10 ${firstTen.toFixed(
            1,
          )}ms, last10 ${lastTen.toFixed(1)}ms`,
        );
        expect(sorted.at(-1)!).toBeLessThan(5_000);
      },
      180_000,
    );

    it("keeps the order newest first with the id as tiebreaker", async () => {
      const first = (await get(stewardToken, `/api/v1/projects/${fx.projectA}/uploads?limit=200`)).json();
      const ids = first.items.map((item: { id: string }) => item.id);
      const rows = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.object_uploads WHERE project_id = ${fx.projectA}
        ORDER BY uploaded_at DESC, id DESC LIMIT 200
      `;
      expect(ids).toEqual(rows.map((row) => row.id));
    });

    it("says the last page is the last one", async () => {
      const response = await get(stewardToken, `/api/v1/projects/${fx.otherProjectA}/uploads`);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ nextCursor: null, truncated: false, total: 0 });
    });

    it("refuses a cursor it did not issue instead of starting over", async () => {
      const response = await get(
        stewardToken,
        `/api/v1/projects/${fx.projectA}/uploads?cursor=${Buffer.from("2026-01-01|x").toString("base64url")}`,
      );
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_CURSOR");
    });

    it("refuses a limit above the cap and unknown parameters", async () => {
      expect(
        (await get(stewardToken, `/api/v1/projects/${fx.projectA}/uploads?limit=201`)).statusCode,
      ).toBe(400);
      expect(
        (await get(stewardToken, `/api/v1/projects/${fx.projectA}/uploads?offset=100`)).statusCode,
      ).toBe(400);
    });
  });

  describe("document graph", () => {
    let recentA: string;
    let recentB: string;
    let old: string;

    beforeAll(async () => {
      const rows = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.object_uploads WHERE project_id = ${fx.projectA}
        ORDER BY uploaded_at DESC, id DESC
      `;
      recentA = rows[0]!.id;
      recentB = rows[1]!.id;
      old = rows.at(-1)!.id;

      for (const [upstream, downstream] of [
        [recentA, recentB],
        [old, recentA],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/v1/projects/${fx.projectA}/document-links`,
          headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
          payload: { upstreamUploadId: upstream, downstreamUploadId: downstream, kind: "depends_on" },
        });
        expect(response.statusCode).toBe(200);
      }
    });

    it("flags the cap and sends no link to a node outside the payload", async () => {
      const response = await get(stewardToken, `/api/v1/projects/${fx.projectA}/document-graph`);
      expect(response.statusCode).toBe(200);
      const body = response.json();

      expect(body.nodes).toHaveLength(500);
      expect(body).toMatchObject({ truncated: true, limit: 500, totalNodes: SEEDED_UPLOADS });

      const ids = new Set(body.nodes.map((node: { uploadId: string }) => node.uploadId));
      for (const link of body.links as { upstreamUploadId: string; downstreamUploadId: string }[]) {
        expect(ids.has(link.upstreamUploadId) && ids.has(link.downstreamUploadId)).toBe(true);
      }
      expect(body.links).toHaveLength(1);
      expect(ids.has(old)).toBe(false);
    });

    it("includes a focused document and its direct neighbours even when they are old", async () => {
      const response = await get(
        stewardToken,
        `/api/v1/projects/${fx.projectA}/document-graph?focus=${old}`,
      );
      expect(response.statusCode).toBe(200);
      const body = response.json();
      const ids = new Set(body.nodes.map((node: { uploadId: string }) => node.uploadId));

      expect(ids.has(old)).toBe(true);
      expect(body.truncated).toBe(true);
      const pairs = body.links.map(
        (link: { upstreamUploadId: string; downstreamUploadId: string }) =>
          `${link.upstreamUploadId}>${link.downstreamUploadId}`,
      );
      expect(pairs).toContain(`${old}>${recentA}`);
      for (const link of body.links as { upstreamUploadId: string; downstreamUploadId: string }[]) {
        expect(ids.has(link.upstreamUploadId) && ids.has(link.downstreamUploadId)).toBe(true);
      }
    });

    it("refuses a focus that is not a document id", async () => {
      const response = await get(
        stewardToken,
        `/api/v1/projects/${fx.projectA}/document-graph?focus=nope`,
      );
      expect(response.statusCode).toBe(400);
    });
  });

  describe("truncation flags", () => {
    it("document impacts: flags more than 500", async () => {
      // One expired-document impact per seeded upload, for 501 of them.
      await fx.sql`
        INSERT INTO core.document_impacts
          (tenant_id, project_id, upload_id, origin_upload_id, cause, depth, origin_valid_until)
        SELECT tenant_id, project_id, id, id, 'expired', 0, date '2026-01-01'
        FROM core.object_uploads
        WHERE project_id = ${fx.projectA}
        ORDER BY uploaded_at LIMIT 501
      `;
      const body = (
        await get(stewardToken, `/api/v1/projects/${fx.projectA}/document-impacts`)
      ).json();
      expect(body.items).toHaveLength(500);
      expect(body).toMatchObject({ truncated: true, limit: 500, total: 501, openCount: 501 });
    });

    it("source receipts: flags more than 100", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/source-receipts`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
        payload: receiptPayload(),
      });
      expect(created.statusCode).toBe(200);

      const before = (await get(stewardToken, `/api/v1/projects/${fx.projectA}/source-receipts`)).json();
      expect(before).toMatchObject({ truncated: false, limit: 100, total: 1 });

      await fx.sql`
        INSERT INTO core.source_receipts
        SELECT (jsonb_populate_record(NULL::core.source_receipts, to_jsonb(t) || jsonb_build_object(
          'id', gen_random_uuid(),
          'as_of', t.as_of - g * interval '1 second'
        ))).*
        FROM core.source_receipts t, generate_series(1, 100) g
        WHERE t.id = ${created.json().id as string}
      `;
      const body = (await get(stewardToken, `/api/v1/projects/${fx.projectA}/source-receipts`)).json();
      expect(body.items).toHaveLength(100);
      expect(body).toMatchObject({ truncated: true, limit: 100, total: 101 });
    });

    it("claims: flags more than 200", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/claims`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          claimType: "mining_right_registration",
          valueText: "MV-000001",
          sourceCoordinate: { document: "license-extract", page: "1" },
          evidenceTier: "P1",
        },
      });
      expect(created.statusCode).toBe(200);

      await fx.sql`
        INSERT INTO core.claims
        SELECT (jsonb_populate_record(NULL::core.claims, to_jsonb(t) || jsonb_build_object(
          'id', gen_random_uuid(),
          'value_text', 'MV-' || g
        ))).*
        FROM core.claims t, generate_series(1, 200) g
        WHERE t.id = ${created.json().id as string}
      `;
      const body = (await get(stewardToken, `/api/v1/projects/${fx.projectA}/claims`)).json();
      expect(body.items).toHaveLength(200);
      expect(body).toMatchObject({ truncated: true, limit: 200, total: 201 });
    });

    it("governance proposals: flags more than 100", async () => {
      const before = (await get(proposerToken, "/api/v1/governance/proposals")).json();
      expect(before).toMatchObject({ truncated: false, limit: 100 });

      await fx.sql`
        INSERT INTO core.governance_proposals
          (id, tenant_id, space, proposal_type, title, rationale, proposer_subject_id,
           quorum_numerator, quorum_denominator, threshold_numerator, threshold_denominator,
           conflict_disclosure, execution_mode, created_at)
        SELECT gen_random_uuid(), ${fx.tenantA}, 'protocol', 'parameter_change',
               'seeded ' || g, 'seeded for the cap', ${fx.operatorSubjectA},
               1, 2, 1, 2, 'No conflict of interest', 'record_only',
               now() - g * interval '1 second'
        FROM generate_series(1, 101) g
      `;
      const body = (await get(proposerToken, "/api/v1/governance/proposals")).json();
      expect(body.items).toHaveLength(100);
      expect(body).toMatchObject({ truncated: true, limit: 100 });
    });

    it("notifications: flags more than 100", async () => {
      await fx.sql`
        INSERT INTO core.notifications (tenant_id, kind, subject_id, summary, link, occurred_at)
        SELECT ${fx.tenantA}, 'readiness_gap', ${fx.operatorSubjectA}, 'seeded ' || g, '/w/work',
               now() - g * interval '1 second'
        FROM generate_series(1, 101) g
      `;
      const body = (await get(operatorToken, "/api/v1/notifications")).json();
      expect(body.items).toHaveLength(100);
      expect(body).toMatchObject({ truncated: true, limit: 100 });
    });

    it("projects: flags more than 50", async () => {
      const before = (await get(operatorToken, "/api/v1/projects")).json();
      expect(before).toMatchObject({ truncated: false, limit: 50 });

      await fx.sql`
        INSERT INTO core.projects
          (id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id,
           updated_at)
        SELECT gen_random_uuid(), ${fx.tenantA}, 'SEED-CAP-' || g, 'Seeded ' || g, 'MNG',
               ARRAY['copper'], ${fx.orgA}, now() - g * interval '1 second'
        FROM generate_series(1, 51) g
      `;
      const body = (await get(operatorToken, "/api/v1/projects")).json();
      expect(body.items).toHaveLength(50);
      expect(body).toMatchObject({ truncated: true, limit: 50 });
    });

    it("my work: flags more than 50 open unassigned signals", async () => {
      const before = (await get(operatorToken, "/api/v1/my-work")).json();
      expect(before).toMatchObject({ unassignedTruncated: false });

      await fx.sql`
        INSERT INTO core.evidence_stale_signals
          (id, tenant_id, project_id, target_type, target_id, reason, detected_at)
        SELECT gen_random_uuid(), ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
               gen_random_uuid(), 'seeded ' || g, now() - g * interval '1 second'
        FROM generate_series(1, 51) g
      `;
      const body = (await get(operatorToken, "/api/v1/my-work")).json();
      const signals = body.unassigned.filter(
        (item: { kind: string }) => item.kind === "stale_signal",
      );
      expect(signals).toHaveLength(50);
      expect(body.unassignedTruncated).toBe(true);
    });

    it("anchor batches: flags more than 100", async () => {
      const before = (await get(operatorToken, "/api/v1/anchor-batches")).json();
      expect(before).toMatchObject({ truncated: false, limit: 100 });

      await fx.sql`
        INSERT INTO chain.anchor_batches
          (id, tenant_id, batch_id, merkle_root, manifest_hash, manifest_object_key,
           schema_version, record_count, created_at)
        SELECT gen_random_uuid(), ${fx.tenantA},
               '0x' || encode(sha256(convert_to('w123-batch-' || ${fx.tenantA} || g, 'UTF8')), 'hex'),
               '0x' || repeat('ab', 32), '0x' || repeat('cd', 32), 'seed/manifest/' || g,
               '1', 1, now() - g * interval '1 second'
        FROM generate_series(1, 101) g
      `;
      const body = (await get(operatorToken, "/api/v1/anchor-batches")).json();
      expect(body.items).toHaveLength(100);
      expect(body).toMatchObject({ truncated: true, limit: 100 });
    });
  });

  function receiptPayload() {
    return {
      connectionId: fx.connectionA,
      authorityId: fx.authorityA,
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
      asOf: new Date().toISOString(),
      limitations: ["seeded"],
    };
  }
});
