import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

interface Upload {
  readonly id: string;
  readonly version: number;
}

interface Requirement {
  readonly id: string;
  readonly documentType: string;
  readonly tier: string;
}

interface ListItem {
  readonly uploadId: string;
  readonly status: string;
  readonly documentType: string | null;
  readonly tier: string | null;
}

/**
 * Document status — what a project expects, and where its documents stand.
 *
 * What this file holds the feature to:
 *
 * - a declared type is met, expired, pending or missing from the documents that match it,
 *   whatever the case of the type;
 * - replaced, rejected and untyped documents never count toward a requirement;
 * - only people who run the Data Room declare or retire, and a declaration is never deleted;
 * - a project with 10,000 documents is counted whole and paged to the end without a gap.
 */
describeDb("document status", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let steward: string;
  let scan: string;
  let reader: string;
  let scopedSteward: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    steward = await signIn(app, fx.stewardA);
    scan = await signIn(app, fx.scanServiceA);
    reader = await signIn(app, fx.readerA);
    scopedSteward = await signIn(app, fx.scopedStewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function headers(token: string, version?: number): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "idempotency-key": idempotencyKey(),
      ...(version === undefined ? {} : { "if-match": `"${version}"` }),
    };
  }

  async function upload(projectId = fx.projectA): Promise<Upload> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/uploads`,
      headers: headers(steward),
      payload: {
        contentBase64: Buffer.from(`document ${randomUUID()}`).toString("base64"),
        contentType: "application/pdf",
        originalFilename: "document.pdf",
      },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Upload;
  }

  async function scanClean(document: Upload): Promise<Upload> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${document.id}/scan-result`,
      headers: headers(scan, document.version),
      payload: { result: "clean" },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Upload;
  }

  async function promote(document: Upload): Promise<Upload> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${document.id}/promote`,
      headers: headers(steward, document.version),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Upload;
  }

  async function profile(document: Upload, body: Record<string, unknown>): Promise<Upload> {
    const response = await app.inject({
      method: "PATCH",
      url: `/api/v1/uploads/${document.id}/document-profile`,
      headers: headers(steward, document.version),
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as Upload;
  }

  /** A promoted document with the given profile. */
  async function document(body: Record<string, unknown>): Promise<Upload> {
    return profile(await promote(await scanClean(await upload())), body);
  }

  function declare(
    body: Record<string, unknown>,
    token = steward,
    projectId = fx.projectA,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/document-requirements`,
      headers: headers(token),
      payload: body,
    });
  }

  function retire(requirementId: string, body: Record<string, unknown>, token = steward) {
    return app.inject({
      method: "POST",
      url: `/api/v1/document-requirements/${requirementId}/retirement`,
      headers: headers(token),
      payload: body,
    });
  }

  function summary(projectId = fx.projectA, token = steward) {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/document-status`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  function list(query: string, projectId = fx.projectA, token = steward) {
    return app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/documents${query}`,
      headers: { authorization: `Bearer ${token}` },
    });
  }

  describe("requirements", () => {
    it("declares a type once per project, whatever its case", async () => {
      const first = await declare({ documentType: "Mining licence", tier: "required" });
      expect(first.statusCode).toBe(200);
      expect(first.json()).toMatchObject({ documentType: "Mining licence", tier: "required" });

      const again = await declare({ documentType: "mining LICENCE", tier: "presentation" });
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("DOCUMENT_REQUIREMENT_EXISTS");
      expect(again.json().details).toMatchObject({ requirementId: first.json().id, tier: "required" });

      // Another project keeps its own list.
      const other = await declare(
        { documentType: "Mining licence", tier: "management" },
        steward,
        fx.otherProjectA,
      );
      expect(other.statusCode).toBe(200);
    });

    it("moves a type to another tier by retiring and declaring again", async () => {
      const created = (await declare({ documentType: "Site photos", tier: "presentation" })).json() as Requirement;

      const missingReason = await retire(created.id, { reason: "   " });
      expect(missingReason.statusCode).toBe(400);

      const retired = await retire(created.id, { reason: "Investors asked for them" });
      expect(retired.statusCode).toBe(200);
      expect(retired.json().retiredAt).not.toBeNull();

      const twice = await retire(created.id, { reason: "again" });
      expect(twice.statusCode).toBe(409);
      expect(twice.json().code).toBe("DOCUMENT_REQUIREMENT_ALREADY_RETIRED");

      const redeclared = await declare({ documentType: "Site photos", tier: "user_benefit" });
      expect(redeclared.statusCode).toBe(200);

      const active = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/document-requirements`,
        headers: { authorization: `Bearer ${steward}` },
      });
      const items = active.json().items as Requirement[];
      expect(items.filter((item) => item.documentType === "Site photos")).toEqual([
        expect.objectContaining({ tier: "user_benefit" }),
      ]);
    });

    it("lets only people who run the project's Data Room declare or retire", async () => {
      expect((await declare({ documentType: "Assay report", tier: "required" }, reader)).statusCode).toBe(403);
      // Scoped to projectA only.
      expect(
        (await declare({ documentType: "Assay report", tier: "required" }, scopedSteward, fx.otherProjectA))
          .statusCode,
      ).toBe(403);

      const onOther = (
        await declare({ documentType: "Assay report", tier: "required" }, steward, fx.otherProjectA)
      ).json() as Requirement;
      expect((await retire(onOther.id, { reason: "not ours" }, scopedSteward)).statusCode).toBe(403);
    });

    it("answers 404 for an unknown requirement and does not confirm unknown projects", async () => {
      expect((await retire(randomUUID(), { reason: "gone" })).statusCode).toBe(404);
      // Authorization comes first, so an unknown project reads the same as someone else's.
      expect((await declare({ documentType: "X", tier: "required" }, steward, randomUUID())).statusCode).toBe(403);
      expect((await summary(randomUUID())).statusCode).toBe(403);
      // Malformed ids are refused before any route runs.
      const malformed = await retire("not-a-uuid", { reason: "gone" });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json().code).toBe("PATH_PARAM_INVALID");
      expect((await summary("not-a-uuid")).json().code).toBe("PATH_PARAM_INVALID");
    });

    it("rejects unknown tiers and fields", async () => {
      expect((await declare({ documentType: "X", tier: "nice_to_have" })).statusCode).toBe(400);
      expect((await declare({ documentType: "X", tier: "required", owner: "me" })).statusCode).toBe(400);
      expect((await declare({ documentType: "x".repeat(81), tier: "required" })).statusCode).toBe(400);
    });

    it("cannot be deleted or rewritten in the database", async () => {
      const created = (await declare({ documentType: "Drill log", tier: "management" })).json() as Requirement;
      await expect(
        fx.sql`DELETE FROM core.document_requirements WHERE id = ${created.id}`,
      ).rejects.toThrow(/cannot be deleted/);
      await expect(
        fx.sql`UPDATE core.document_requirements SET tier = 'required' WHERE id = ${created.id}`,
      ).rejects.toThrow(/retiring it and declaring a new one/);
    });
  });

  describe("requirement audit and replay", () => {
    it("records the type and project on declare and retire, so a project audit read finds both", async () => {
      const documentType = `Audit type ${Date.now()}`;
      const declared = await declare({ documentType, tier: "required" });
      expect(declared.statusCode).toBe(200);
      const requirementId = declared.json().id as string;
      expect((await retire(requirementId, { reason: "No longer asked for" })).statusCode).toBe(200);

      const rows = await fx.sql<{ command: string; project_id: string | null; detail: { documentType?: string } }[]>`
        SELECT command, project_id, detail FROM audit.events
        WHERE resource_id = ${requirementId} ORDER BY occurred_at
      `;
      expect(rows.map((row) => row.command)).toEqual([
        "document_requirement.declared",
        "document_requirement.retired",
      ]);
      for (const row of rows) {
        expect(row.project_id).toBe(fx.projectA);
        expect(row.detail.documentType).toBe(documentType);
      }
    });

    it("does not replay a stored retirement to someone without the permission", async () => {
      const declared = await declare({ documentType: `replay-${Date.now()}`, tier: "required" });
      const requirementId = declared.json().id as string;
      const key = idempotencyKey();
      const send = (token: string) =>
        app.inject({
          method: "POST",
          url: `/api/v1/document-requirements/${requirementId}/retirement`,
          headers: { authorization: `Bearer ${token}`, "idempotency-key": key },
          payload: { reason: "No longer asked for" },
        });

      expect((await send(steward)).statusCode).toBe(200);
      expect((await send(reader)).statusCode).toBe(403);
    });
  });

  describe("summary and list", () => {
    let current: Upload;
    let expired: Upload;
    let replaced: Upload;
    let successor: Upload;
    let pending: Upload;
    let untyped: Upload;

    beforeAll(async () => {
      // Exploration licence: one current (lower case type), one expired copy.
      current = await document({ documentType: "exploration licence", validUntil: "2999-12-31" });
      await document({ documentType: "Exploration Licence", validUntil: "2020-01-31" });
      // Environmental permit: only an expired one.
      expired = await document({ documentType: "Environmental permit", validUntil: "2021-06-30" });
      // Water permit: only a renewal still in quarantine.
      pending = await profile(await upload(), { documentType: "Water permit" });
      // Feasibility study: replaced by a newer version.
      replaced = await document({ documentType: "Feasibility study" });
      const next = await profile(await upload(), {
        documentType: "Feasibility study",
        supersedesUploadId: replaced.id,
      });
      successor = await promote(await scanClean(next));
      // Something nobody gave a type.
      untyped = await promote(await scanClean(await upload()));
      // Something nobody declared.
      await document({ documentType: "Board minutes" });
      // A rejected file of a declared type does not count.
      const bad = await upload();
      await fx.sql`
        UPDATE core.object_uploads
        SET state = 'rejected', rejection_reason = 'unreadable', document_type = 'Social licence'
        WHERE id = ${bad.id}
      `;

      for (const [documentType, tier] of [
        ["Exploration licence", "required"],
        ["Environmental permit", "required"],
        ["Water permit", "required"],
        ["Social licence", "required"],
        ["Feasibility study", "user_benefit"],
      ] as const) {
        expect((await declare({ documentType, tier })).statusCode).toBe(200);
      }
    });

    it("tells met, expired, pending and missing apart", async () => {
      const response = await summary();
      expect(response.statusCode).toBe(200);
      const body = response.json();

      const status = (type: string) =>
        body.requirements.find(
          (item: { requirement: Requirement }) => item.requirement.documentType === type,
        );
      expect(status("Exploration licence")).toMatchObject({
        status: "met",
        currentCount: 1,
        expiredCount: 1,
        nearestValidUntil: "2999-12-31",
      });
      expect(status("Environmental permit")).toMatchObject({ status: "expired", expiredCount: 1 });
      expect(status("Water permit")).toMatchObject({ status: "pending", pendingCount: 1 });
      expect(status("Social licence")).toMatchObject({ status: "missing", currentCount: 0 });
      expect(status("Feasibility study")).toMatchObject({
        status: "met",
        currentCount: 1,
        supersededCount: 1,
      });

      const required = body.tiers.find((tier: { tier: string }) => tier.tier === "required");
      expect(required).toEqual({
        tier: "required",
        // "Mining licence" was declared required earlier in this file and has no document.
        declared: 5,
        met: 1,
        expired: 1,
        pending: 1,
        missing: 2,
        incomplete: true,
      });
      expect(body.tiers.find((tier: { tier: string }) => tier.tier === "user_benefit").incomplete).toBe(false);
    });

    it("counts every document once, by where it stands", async () => {
      const { totals, today } = (await summary()).json();
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(totals).toMatchObject({
        superseded: 1,
        pending: 1,
        unusable: 1,
        expired: 2,
        untyped: 1,
      });
      expect(totals.all).toBe(
        totals.current + totals.expired + totals.superseded + totals.pending + totals.unusable,
      );
      // Current: licence, study successor, untyped, board minutes, plus earlier-declared tests' none.
      expect(totals.current).toBe(4);
      expect(totals.withoutValidUntil).toBe(3);
    });

    it("lists types nobody declared and the next expiries", async () => {
      const body = (await summary()).json();
      expect(body.undeclaredTypes).toEqual([
        { documentType: "Board minutes", currentCount: 1, expiredCount: 0, supersededCount: 0, pendingCount: 0 },
      ]);
      expect(body.undeclaredTypesTruncated).toBe(false);
      expect(body.nextExpiries).toEqual([
        expect.objectContaining({ uploadId: current.id, validUntil: "2999-12-31" }),
      ]);
    });

    it("filters the list by status, type, tier and nearness of expiry", async () => {
      const ids = async (query: string) =>
        ((await list(query)).json().items as ListItem[]).map((item) => item.uploadId);

      expect(await ids("?status=superseded")).toEqual([replaced.id]);
      expect(await ids("?status=pending")).toEqual([pending.id]);
      expect((await ids("?status=expired")).length).toBe(2);
      expect(await ids("?documentType=FEASIBILITY%20STUDY&status=current")).toEqual([successor.id]);
      expect(await ids("?tier=undeclared&status=current")).toEqual(
        expect.arrayContaining([untyped.id]),
      );
      expect((await ids("?tier=undeclared&status=current")).length).toBe(2);
      expect((await ids("?tier=required&status=expired"))).toEqual(expect.arrayContaining([expired.id]));
      // Nothing current expires within a year; the licence runs to 2999.
      expect(await ids("?expiresWithinDays=365")).toEqual([]);

      const item = ((await list(`?status=current&documentType=exploration%20licence`)).json().items as ListItem[])[0];
      expect(item).toMatchObject({ uploadId: current.id, tier: "required", status: "current" });
    });

    it("rejects filters outside the contract and cursors it did not issue", async () => {
      expect((await list("?status=archived")).statusCode).toBe(400);
      expect((await list("?sort=name")).statusCode).toBe(400);
      expect((await list("?limit=201")).statusCode).toBe(400);
      const forged = Buffer.from("2026-01-01|x").toString("base64url");
      const response = await list(`?cursor=${forged}`);
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("INVALID_CURSOR");
      const invalidTime = Buffer.from(`2026-13-01T00:00:00.000001Z|${fx.projectA}`).toString("base64url");
      const invalidResponse = await list(`?cursor=${invalidTime}`);
      expect(invalidResponse.statusCode).toBe(400);
      expect(invalidResponse.json().code).toBe("INVALID_CURSOR");
    });

    it("is readable only with evidence access to the project", async () => {
      expect((await summary(fx.projectA, reader)).statusCode).toBe(403);
      expect((await list("", fx.projectA, reader)).statusCode).toBe(403);
      expect((await summary(fx.otherProjectA, scopedSteward)).statusCode).toBe(403);
    });
  });

  describe("a project with 10,000 documents", () => {
    const TOTAL = 10_000;

    beforeAll(async () => {
      const seedStarted = performance.now();
      // Seeded in the database: 10,000 uploads through the API would take minutes. Every tenth is
      // expired, every hundredth still pending; timestamps differ by a microsecond so a cursor
      // rounded to the millisecond would lose rows.
      const [subject] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.subjects WHERE tenant_id = ${fx.tenantA} LIMIT 1
      `;
      await fx.sql`
        WITH seed AS (
          SELECT g, gen_random_uuid() AS upload_id, gen_random_uuid() AS artifact_id,
                 '0x' || encode(sha256(convert_to('bulk-' || g || '-' || ${randomUUID()}, 'UTF8')), 'hex') AS hash
          FROM generate_series(1, ${TOTAL}) g
        ),
        artifacts AS (
          INSERT INTO core.artifacts (id, tenant_id, project_id, kind, content_hash, sensitivity)
          SELECT artifact_id, ${fx.tenantA}, ${fx.otherProjectA}, 'raw_source', hash, 'restricted'
          FROM seed WHERE g % 100 <> 0
          RETURNING id
        )
        INSERT INTO core.object_uploads (
          id, tenant_id, project_id, object_key, content_hash, byte_size, content_type,
          original_filename, sensitivity, state, uploaded_by, uploaded_at, promoted_artifact_id,
          document_type, valid_until
        )
        SELECT upload_id, ${fx.tenantA}, ${fx.otherProjectA}, 'bulk/' || upload_id, hash, 1024,
               'application/pdf', 'bulk.pdf', 'restricted',
               (CASE WHEN g % 100 = 0 THEN 'quarantined' ELSE 'promoted' END)::core.upload_state,
               ${subject!.id}, now() - g * interval '1 microsecond',
               CASE WHEN g % 100 = 0 THEN NULL ELSE artifact_id END,
               'Type ' || (g % 137),
               CASE WHEN g % 10 = 0 AND g % 100 <> 0 THEN DATE '2020-01-01' ELSE DATE '2999-01-01' END
        FROM seed
      `;
      console.log(`seeded ${TOTAL} documents in ${(performance.now() - seedStarted).toFixed(0)} ms`);
    }, 120_000);

    it("counts all of them", async () => {
      const started = performance.now();
      const response = await summary(fx.otherProjectA);
      const elapsed = performance.now() - started;
      expect(response.statusCode).toBe(200);
      const { totals, undeclaredTypes } = response.json();
      // Earlier tests put no uploads in this project.
      expect(totals.all).toBe(TOTAL);
      expect(totals.pending).toBe(100);
      expect(totals.expired).toBe(900);
      expect(totals.current).toBe(9_000);
      expect(undeclaredTypes.length).toBe(137);
      console.log(`document-status summary over ${TOTAL} documents: ${elapsed.toFixed(0)} ms`);
    }, 60_000);

    it("pages through every document exactly once", async () => {
      const seen = new Set<string>();
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = `?limit=200${cursor ? `&cursor=${cursor}` : ""}`;
        const response = await list(query, fx.otherProjectA);
        expect(response.statusCode).toBe(200);
        const body = response.json() as { items: ListItem[]; nextCursor: string | null };
        for (const item of body.items) {
          expect(seen.has(item.uploadId)).toBe(false);
          seen.add(item.uploadId);
        }
        cursor = body.nextCursor;
        pages += 1;
      } while (cursor !== null && pages < 100);
      expect(seen.size).toBe(TOTAL);
      expect(pages).toBe(TOTAL / 200);
    }, 60_000);

    it("pages a filtered view to its end", async () => {
      let count = 0;
      let cursor: string | null = null;
      do {
        const query: string = `?status=expired&limit=200${cursor ? `&cursor=${cursor}` : ""}`;
        const body = (await list(query, fx.otherProjectA)).json() as {
          items: ListItem[];
          nextCursor: string | null;
        };
        expect(body.items.every((item) => item.status === "expired")).toBe(true);
        count += body.items.length;
        cursor = body.nextCursor;
      } while (cursor !== null);
      expect(count).toBe(900);
    }, 60_000);
  });
});
