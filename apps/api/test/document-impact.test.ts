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

interface Impact {
  readonly id: string;
  readonly uploadId: string;
  readonly originUploadId: string;
  readonly cause: string;
  readonly depth: number;
  readonly viaUploadId: string | null;
  readonly viaKind: string | null;
  readonly resolution: string;
  readonly resolvedBy: string | null;
  readonly revisedByUploadId: string | null;
}

/**
 * Document relations — declared links, and the impacts a replacement or an expiry sends along
 * them.
 *
 * What this file holds the feature to:
 *
 * - a change travels along `depends_on` and stops after `references`;
 * - a new version takes over the links and answers the old version's open impacts;
 * - an expiry is raised once, however often the sweep runs;
 * - nothing is deleted, and a closed judgment stays closed;
 * - links stay inside one project, and only the people who work the Data Room make them.
 */
describeDb("document relations", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let steward: string;
  let operator: string;
  let scan: string;
  let reader: string;
  let scopedSteward: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    steward = await signIn(app, fx.stewardA);
    operator = await signIn(app, fx.operatorA);
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
        // The content hash is unique per project; every document here is distinct.
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

  async function promoted(projectId = fx.projectA): Promise<Upload> {
    return promote(await scanClean(await upload(projectId)));
  }

  function profile(document: Upload, body: Record<string, unknown>, token = steward) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/uploads/${document.id}/document-profile`,
      headers: headers(token, document.version),
      payload: body,
    });
  }

  /** A new version of `previous`, uploaded, marked, scanned, and promoted. */
  async function newVersionOf(previous: Upload): Promise<Upload> {
    const created = await upload();
    const marked = await profile(created, { supersedesUploadId: previous.id });
    expect(marked.statusCode).toBe(200);
    return promote(await scanClean(marked.json() as Upload));
  }

  function link(
    upstream: Upload,
    downstream: Upload,
    kind: "depends_on" | "references" = "depends_on",
    token = steward,
    projectId = fx.projectA,
  ) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/document-links`,
      headers: headers(token),
      payload: { upstreamUploadId: upstream.id, downstreamUploadId: downstream.id, kind },
    });
  }

  async function impactsOf(origin: Upload): Promise<Impact[]> {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/document-impacts`,
      headers: { authorization: `Bearer ${steward}` },
    });
    expect(response.statusCode).toBe(200);
    return (response.json().items as Impact[]).filter(
      (impact) => impact.originUploadId === origin.id,
    );
  }

  async function graphLinks() {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/document-graph`,
      headers: { authorization: `Bearer ${steward}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json().links as {
      id: string;
      upstreamUploadId: string;
      downstreamUploadId: string;
      origin: string;
    }[];
  }

  async function notificationsFor(origin: Upload): Promise<number> {
    const [row] = await fx.sql<{ count: string }[]>`
      SELECT count(*) FROM core.notifications
      WHERE kind = 'document_impact' AND project_id = ${fx.projectA}
        AND occurred_at >= (
          SELECT min(detected_at) FROM core.document_impacts WHERE origin_upload_id = ${origin.id}
        )
    `;
    return Number(row!.count);
  }

  /**
   * A claim whose receipt was verified against `document` — the link the database follows from
   * a replaced or expired document to the claims resting on it.
   */
  async function seedClaimOn(document: Upload): Promise<string> {
    const receiptId = randomUUID();
    await fx.sql`
      INSERT INTO core.source_receipts (
        id, tenant_id, project_id, connection_id, authority_id, collection_method,
        result, query_basis, endpoint_or_document_ref, authentication_method,
        raw_hash, source_schema_version, adapter_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        freshness_status, correlation_id, channel_evidence
      ) VALUES (
        ${receiptId}, ${fx.tenantA}, ${fx.projectA}, ${fx.connectionA}, ${fx.authorityA},
        'authenticated_api', 'manual_review_required', '{}'::jsonb, 'document',
        'none', ${`0x${"11".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
        now(), now(), 'fresh', 'test',
        ${fx.sql.json({ documentUploadId: document.id })}
      )
    `;
    const claimId = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, tenant_id, project_id, claim_type, value_text, source_coordinate,
        evidence_tier, verification_state, grade, source_receipt_id
      ) VALUES (
        ${claimId}, ${fx.tenantA}, ${fx.projectA}, 'lab_accreditation', 'ISO 17025',
        '{"page":"1"}'::jsonb, 'P1', 'analyst_checked', 'verified', ${receiptId}
      )
    `;
    return claimId;
  }

  describe("links", () => {
    it("links two documents and lists the link with both documents", async () => {
      const license = await promoted();
      const report = await promoted();

      const created = await link(license, report);
      expect(created.statusCode).toBe(200);
      expect(created.json()).toMatchObject({
        upstreamUploadId: license.id,
        downstreamUploadId: report.id,
        kind: "depends_on",
        origin: "user",
      });

      const links = await graphLinks();
      expect(links.map((entry) => entry.id)).toContain(created.json().id);
    });

    it("refuses a depends_on link that would close a loop, but allows a citation back", async () => {
      const a = await promoted();
      const b = await promoted();
      const c = await promoted();
      expect((await link(a, b)).statusCode).toBe(200);
      expect((await link(b, c)).statusCode).toBe(200);

      const loop = await link(c, a);
      expect(loop.statusCode).toBe(409);
      expect(loop.json().code).toBe("DOCUMENT_LINK_CYCLE");

      // A citation does not carry a change onward, so it cannot loop.
      expect((await link(c, a, "references")).statusCode).toBe(200);
    });

    it("refuses the same pair twice", async () => {
      const a = await promoted();
      const b = await promoted();
      expect((await link(a, b)).statusCode).toBe(200);

      const again = await link(a, b, "references");
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe("DOCUMENT_LINK_EXISTS");
    });

    it("does not reach into another project", async () => {
      const here = await promoted();
      const elsewhere = await promoted(fx.otherProjectA);

      const response = await link(here, elsewhere);
      expect(response.statusCode).toBe(404);

      // The database refuses it too — FK checks bypass RLS, so the keys carry the scope.
      await expect(fx.sql`
        INSERT INTO core.document_links (
          tenant_id, project_id, upstream_upload_id, downstream_upload_id, kind, origin, created_by
        ) VALUES (
          ${fx.tenantA}, ${fx.projectA}, ${here.id}, ${elsewhere.id}, 'depends_on', 'user',
          ${fx.operatorSubjectA}
        )
      `).rejects.toThrow();
    });

    it("leaves linking to the people who work the Data Room", async () => {
      const a = await promoted();
      const b = await promoted();

      const byReader = await link(a, b, "depends_on", reader);
      expect(byReader.statusCode).toBe(403);

      // Scoped to projectA only: nothing in the other project.
      const c = await promoted(fx.otherProjectA);
      const d = await promoted(fx.otherProjectA);
      const outOfScope = await link(c, d, "depends_on", scopedSteward, fx.otherProjectA);
      expect(outOfScope.statusCode).toBe(403);
    });

    it("removes a link once, with a reason, and never deletes it", async () => {
      const a = await promoted();
      const b = await promoted();
      const created = (await link(a, b)).json();

      await expect(fx.sql`DELETE FROM core.document_links WHERE id = ${created.id}`).rejects.toThrow();
      await expect(
        fx.sql`UPDATE core.document_links SET kind = 'references' WHERE id = ${created.id}`,
      ).rejects.toThrow();

      const remove = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/document-links/${created.id}/removal`,
          headers: headers(steward),
          payload: { reason: "Linked by mistake" },
        });

      const first = await remove();
      expect(first.statusCode).toBe(200);
      expect(first.json().removalReason).toBe("Linked by mistake");

      const second = await remove();
      expect(second.statusCode).toBe(409);
      expect(second.json().code).toBe("DOCUMENT_LINK_ALREADY_REMOVED");
    });
  });

  describe("a new version", () => {
    it("flags what rests on the old version: depends_on travels, references stops", async () => {
      const license = await promoted();
      const report = await promoted();
      const summary = await promoted();
      const memo = await promoted();
      const memoAnnex = await promoted();

      await link(license, report); // report rests on the license
      await link(report, summary); // summary rests on the report
      await link(license, memo, "references"); // memo cites the license
      await link(memo, memoAnnex); // annex rests on the memo — the citation stops before it

      const preview = await app.inject({
        method: "GET",
        url: `/api/v1/uploads/${license.id}/impact-preview`,
        headers: { authorization: `Bearer ${steward}` },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().items.map((item: { uploadId: string }) => item.uploadId).sort()).toEqual(
        [report.id, summary.id, memo.id].sort(),
      );
      // A preview records nothing.
      expect(await impactsOf(license)).toEqual([]);

      const renewed = await newVersionOf(license);
      const impacts = await impactsOf(license);

      const byUpload = new Map(impacts.map((impact) => [impact.uploadId, impact]));
      expect([...byUpload.keys()].sort()).toEqual([report.id, summary.id, memo.id].sort());
      expect(byUpload.get(report.id)).toMatchObject({ cause: "superseded", depth: 1 });
      expect(byUpload.get(summary.id)).toMatchObject({ depth: 2, viaUploadId: report.id });
      expect(byUpload.get(memo.id)).toMatchObject({ depth: 1, viaKind: "references" });
      expect(byUpload.has(memoAnnex.id)).toBe(false);

      // One notification for the change, not one per document.
      expect(await notificationsFor(license)).toBe(1);

      // The links moved to the new version; none still point at the old one.
      const links = await graphLinks();
      expect(
        links.filter(
          (entry) => entry.upstreamUploadId === license.id || entry.downstreamUploadId === license.id,
        ),
      ).toEqual([]);
      expect(
        links.filter((entry) => entry.upstreamUploadId === renewed.id).map((entry) => entry.origin),
      ).toEqual(["carried_over", "carried_over"]);
    });

    it("answers the old version's open impacts and passes the change on", async () => {
      const license = await promoted();
      const report = await promoted();
      const summary = await promoted();
      await link(license, report);
      await link(report, summary);

      await newVersionOf(license);
      const [reportImpact] = (await impactsOf(license)).filter(
        (impact) => impact.uploadId === report.id,
      );
      expect(reportImpact?.resolution).toBe("open");

      const revisedReport = await newVersionOf(report);

      const [closed] = (await impactsOf(license)).filter((impact) => impact.uploadId === report.id);
      expect(closed).toMatchObject({
        resolution: "revised",
        revisedByUploadId: revisedReport.id,
        resolvedBy: null,
      });

      // The revised report is itself a change to what rests on it.
      const fromReport = await impactsOf(report);
      expect(fromReport.map((impact) => impact.uploadId)).toEqual([summary.id]);
    });

    it("marks claims verified against the replaced document as stale", async () => {
      const certificate = await promoted();
      const claimId = await seedClaimOn(certificate);

      await newVersionOf(certificate);

      const [claim] = await fx.sql<{ stale_since: Date | null; stale_reason: string | null }[]>`
        SELECT stale_since, stale_reason FROM core.claims WHERE id = ${claimId}
      `;
      expect(claim?.stale_since).not.toBeNull();
      expect(claim?.stale_reason).toContain("replaced by a new version");
    });

    it("takes one predecessor, once, and one live successor per document", async () => {
      const original = await promoted();
      const first = await upload();
      const second = await upload();

      const withoutIfMatch = await app.inject({
        method: "PATCH",
        url: `/api/v1/uploads/${first.id}/document-profile`,
        headers: { authorization: `Bearer ${steward}`, "idempotency-key": idempotencyKey() },
        payload: { supersedesUploadId: original.id },
      });
      expect(withoutIfMatch.statusCode).toBe(428);

      const marked = await profile(first, { supersedesUploadId: original.id });
      expect(marked.statusCode).toBe(200);

      const changed = await profile(marked.json() as Upload, { supersedesUploadId: second.id });
      expect(changed.statusCode).toBe(409);
      expect(changed.json().code).toBe("SUPERSEDES_ALREADY_SET");

      const rival = await profile(second, { supersedesUploadId: original.id });
      expect(rival.statusCode).toBe(409);
      expect(rival.json().code).toBe("DOCUMENT_ALREADY_REPLACED");
    });

    it("refuses a version chain that loops, in the database too", async () => {
      const earlier = await promoted();
      const later = await upload();
      expect((await profile(later, { supersedesUploadId: earlier.id })).statusCode).toBe(200);

      const back = await profile(earlier, { supersedesUploadId: later.id });
      expect(back.statusCode).toBe(409);
      expect(back.json().code).toBe("VERSION_LOOP");

      // No route is the only guard: a direct write is refused as well.
      await expect(fx.sql`
        UPDATE core.object_uploads SET supersedes_upload_id = ${later.id} WHERE id = ${earlier.id}
      `).rejects.toThrow(/later version/);
    });
  });

  describe("expiry", () => {
    it("flags the expired document and what rests on it, once however often the sweep runs", async () => {
      const permit = await promoted();
      const plan = await promoted();
      await link(permit, plan);

      const expired = await profile(permit, { documentType: "Water permit", validUntil: "2020-01-31" });
      expect(expired.statusCode).toBe(200);
      expect(expired.json()).toMatchObject({ documentType: "Water permit", validUntil: "2020-01-31" });

      // Setting a past date shows the impact at once, without waiting for the sweep.
      const impacts = await impactsOf(permit);
      expect(impacts.map((impact) => [impact.uploadId, impact.depth]).sort()).toEqual(
        [
          [permit.id, 0],
          [plan.id, 1],
        ].sort(),
      );

      await fx.sql`SELECT core.sweep_document_expiry(current_date)`;
      await fx.sql`SELECT core.sweep_document_expiry(current_date)`;
      expect(await impactsOf(permit)).toHaveLength(2);
      expect(await notificationsFor(permit)).toBe(1);
    });

    it("flags a document again when a date corrected in place passes too", async () => {
      const permit = await promoted();
      const plan = await promoted();
      await link(permit, plan);

      const first = await profile(permit, { validUntil: "2020-01-31" });
      expect(first.statusCode).toBe(200);
      expect(await impactsOf(permit)).toHaveLength(2);

      // The steward extends the date in place instead of uploading a new version; it lapses again.
      const second = await profile(
        { ...permit, version: first.json().version },
        { validUntil: "2021-01-31" },
      );
      expect(second.statusCode).toBe(200);

      await fx.sql`SELECT core.sweep_document_expiry(current_date)`;
      const impacts = await impactsOf(permit);
      expect(impacts.map((impact) => [impact.uploadId, impact.depth]).sort()).toEqual(
        [
          [permit.id, 0],
          [permit.id, 0],
          [plan.id, 1],
          [plan.id, 1],
        ].sort(),
      );
      expect(await notificationsFor(permit)).toBe(2);
    });

    it("flags a document linked later to an expired one", async () => {
      const permit = await promoted();
      await profile(permit, { validUntil: "2021-06-30" });
      const lateComer = await promoted();

      expect((await link(permit, lateComer)).statusCode).toBe(200);
      expect((await impactsOf(permit)).map((impact) => impact.uploadId)).toContain(lateComer.id);
    });

    it("lets the worker run the sweep and keeps it away from the API role", async () => {
      await expect(fx.appSql`SELECT core.sweep_document_expiry(current_date)`).rejects.toThrow(
        /permission denied/,
      );

      const [result] = await fx.sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE mpc_worker`;
        return tx<{ swept: number }[]>`SELECT core.sweep_document_expiry(current_date) AS swept`;
      });
      expect(typeof result?.swept).toBe("number");
    });

    it("flags a document linked several steps below an expired one at once", async () => {
      const permit = await promoted();
      const plan = await promoted();
      await link(permit, plan);
      await profile(permit, { validUntil: "2022-03-31" });

      const annex = await promoted();
      expect((await link(plan, annex)).statusCode).toBe(200);

      const onAnnex = (await impactsOf(permit)).find((impact) => impact.uploadId === annex.id);
      expect(onAnnex).toMatchObject({ cause: "expired", depth: 2, viaUploadId: plan.id });
    });

    it("reaches claims from the worker's sweep too", async () => {
      /**
       * The sweep runs as its definer with a fixed search path, and from there the change goes on
       * through the claim, attestation, and signal triggers. Setting the date in SQL leaves the
       * sweep as the only thing that can notice it.
       */
      const certificate = await promoted();
      const claimId = await seedClaimOn(certificate);
      await fx.sql`
        UPDATE core.object_uploads SET valid_until = '2019-12-31' WHERE id = ${certificate.id}
      `;

      await fx.sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE mpc_worker`;
        await tx`SELECT core.sweep_document_expiry(current_date)`;
      });

      const [claim] = await fx.sql<{ stale_reason: string | null }[]>`
        SELECT stale_reason FROM core.claims WHERE id = ${claimId}
      `;
      expect(claim?.stale_reason).toContain("passed its validity date");
    });

    it("rejects a day that does not exist", async () => {
      const document = await promoted();
      const response = await profile(document, { validUntil: "2026-02-30" });
      expect(response.statusCode).toBe(400);
    });
  });

  describe("judgments", () => {
    async function openImpacts(): Promise<{ origin: Upload; impacts: Impact[] }> {
      const origin = await promoted();
      const a = await promoted();
      const b = await promoted();
      await link(origin, a);
      await link(origin, b);
      await newVersionOf(origin);
      return { origin, impacts: await impactsOf(origin) };
    }

    function resolve(impactIds: string[], resolution = "no_change_needed") {
      return app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/document-impacts/resolutions`,
        headers: headers(steward),
        payload: { impactIds, resolution, note: "Checked against the renewed license" },
      });
    }

    it("closes several impacts at once, with the person and the reason", async () => {
      const { impacts } = await openImpacts();

      const response = await resolve(impacts.map((impact) => impact.id));
      expect(response.statusCode).toBe(200);
      for (const item of response.json().items as Impact[]) {
        expect(item.resolution).toBe("no_change_needed");
        expect(item.resolvedBy).not.toBeNull();
      }
    });

    it("changes nothing when one of them is already closed", async () => {
      const { origin, impacts } = await openImpacts();
      const [first, second] = impacts;
      expect((await resolve([first!.id])).statusCode).toBe(200);

      const response = await resolve([first!.id, second!.id]);
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("DOCUMENT_IMPACT_ALREADY_RESOLVED");

      const after = (await impactsOf(origin)).find((impact) => impact.id === second!.id);
      expect(after?.resolution).toBe("open");
    });

    it("does not reopen a closed impact, even in the database", async () => {
      const { impacts } = await openImpacts();
      await resolve([impacts[0]!.id]);

      await expect(
        fx.sql`UPDATE core.document_impacts SET resolution = 'open' WHERE id = ${impacts[0]!.id}`,
      ).rejects.toThrow(/closed document impact/);
      await expect(
        fx.sql`DELETE FROM core.document_impacts WHERE id = ${impacts[0]!.id}`,
      ).rejects.toThrow();
    });
  });

  describe("type rules", () => {
    it("links current documents now and documents typed later", async () => {
      const suffix = randomUUID().slice(0, 8);
      const licenseType = `Exploration license ${suffix}`;
      const reportType = `Drilling report ${suffix}`;

      const license = await promoted();
      const typedLicense = (await profile(license, { documentType: licenseType })).json() as Upload;
      const report = await promoted();
      await profile(report, { documentType: reportType.toUpperCase() });

      const bySteward = await app.inject({
        method: "POST",
        url: "/api/v1/document-link-rules",
        headers: headers(steward),
        payload: { upstreamType: licenseType, downstreamType: reportType, kind: "depends_on" },
      });
      // A rule writes into every project of the tenant; an organization-scoped role cannot.
      expect(bySteward.statusCode).toBe(403);

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/document-link-rules",
        headers: headers(operator),
        payload: { upstreamType: licenseType, downstreamType: reportType, kind: "depends_on" },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().linksCreated).toBe(1);

      const later = await promoted();
      await profile(later, { documentType: reportType });

      const ruleLinks = (await graphLinks()).filter(
        (entry) => entry.upstreamUploadId === typedLicense.id && entry.origin === "rule",
      );
      expect(ruleLinks.map((entry) => entry.downstreamUploadId).sort()).toEqual(
        [report.id, later.id].sort(),
      );

      const retired = await app.inject({
        method: "POST",
        url: `/api/v1/document-link-rules/${created.json().id}/retirement`,
        headers: headers(operator),
        payload: { note: "Replaced by a narrower rule" },
      });
      expect(retired.statusCode).toBe(200);
      // Retiring keeps what the rule already made.
      expect(
        (await graphLinks()).filter((entry) => entry.upstreamUploadId === typedLicense.id),
      ).toHaveLength(2);
    });

    it("flags a document a rule links below an already expired ancestor at once", async () => {
      /**
       * The rule's new link lands under Y, which is not expired itself; Z above Y is. The check
       * must walk above Y, or X waits for the hourly sweep.
       */
      const suffix = randomUUID().slice(0, 8);
      const upperType = `Lab accreditation ${suffix}`;
      const lowerType = `Assay certificate ${suffix}`;

      const expired = await promoted();
      const middle = await promoted();
      await link(expired, middle);
      await profile(expired, { validUntil: "2021-06-30" });
      await profile(middle, { documentType: upperType });
      const below = await promoted();
      await profile(below, { documentType: lowerType });

      const created = await app.inject({
        method: "POST",
        url: "/api/v1/document-link-rules",
        headers: headers(operator),
        payload: { upstreamType: upperType, downstreamType: lowerType, kind: "depends_on" },
      });
      expect(created.statusCode).toBe(200);
      expect(created.json().linksCreated).toBe(1);

      const onBelow = (await impactsOf(expired)).find((impact) => impact.uploadId === below.id);
      expect(onBelow).toMatchObject({ cause: "expired", depth: 2, viaUploadId: middle.id });
    });
  });
});
