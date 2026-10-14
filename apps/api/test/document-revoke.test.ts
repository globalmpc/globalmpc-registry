import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { buildEvidenceSnapshot } from "../src/services/evidence-snapshot.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

interface Upload {
  readonly id: string;
  readonly version: number;
  readonly state?: string;
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
}

/**
 * Revoking a document — the correction and revocation journey of spec 03.
 *
 * What this file holds the feature to:
 *
 * - a revoked document is kept, marked, and never deleted; the mark cannot be undone or edited;
 * - revoking asks what rests on the document for a second look, through the same impacts a
 *   replacement raises, and marks the claims verified against it stale;
 * - a revoked document is no longer something to rest on: no new links, no rules, no profile
 *   edits, no confirmation evidence;
 * - a revoked successor does not bring its predecessor back — the correction is a new version
 *   of the revoked one;
 * - repeat, missing, out-of-scope and concurrent requests each get one defined answer.
 */
describeDb("document revocation", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let steward: string;
  let operator: string;
  let scan: string;
  let reader: string;
  let reviewer: string;
  let scopedSteward: string;
  let otherTenantOperator: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    steward = await signIn(app, fx.stewardA);
    operator = await signIn(app, fx.operatorA);
    scan = await signIn(app, fx.scanServiceA);
    reader = await signIn(app, fx.readerA);
    reviewer = await signIn(app, fx.reviewerA);
    scopedSteward = await signIn(app, fx.scopedStewardA);
    otherTenantOperator = await signIn(app, fx.operatorB);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function headers(token: string, version?: number, key = idempotencyKey()): Record<string, string> {
    return {
      authorization: `Bearer ${token}`,
      "idempotency-key": key,
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

  async function scanResult(document: Upload, result: "clean" | "infected"): Promise<Upload> {
    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${document.id}/scan-result`,
      headers: headers(scan, document.version),
      payload: { result },
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
    return promote(await scanResult(await upload(projectId), "clean"));
  }

  function profile(document: Upload, body: Record<string, unknown>, token = steward) {
    return app.inject({
      method: "PATCH",
      url: `/api/v1/uploads/${document.id}/document-profile`,
      headers: headers(token, document.version),
      payload: body,
    });
  }

  async function newVersionOf(previous: Upload): Promise<Upload> {
    const created = await upload();
    const marked = await profile(created, { supersedesUploadId: previous.id });
    expect(marked.statusCode).toBe(200);
    return promote(await scanResult(marked.json() as Upload, "clean"));
  }

  function link(upstream: Upload, downstream: Upload, kind = "depends_on") {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${fx.projectA}/document-links`,
      headers: headers(steward),
      payload: { upstreamUploadId: upstream.id, downstreamUploadId: downstream.id, kind },
    });
  }

  function revoke(
    document: Upload,
    body: unknown = { reason: "The issuing office confirmed this certificate was forged" },
    options: { token?: string; version?: number | null; key?: string | null } = {},
  ) {
    const token = options.token ?? steward;
    const version = options.version === undefined ? document.version : options.version;
    const requestHeaders: Record<string, string> = { authorization: `Bearer ${token}` };
    if (options.key !== null) requestHeaders["idempotency-key"] = options.key ?? idempotencyKey();
    if (version !== null) requestHeaders["if-match"] = `"${version}"`;
    return app.inject({
      method: "POST",
      url: `/api/v1/uploads/${document.id}/revoke`,
      headers: requestHeaders,
      payload: body as Record<string, unknown>,
    });
  }

  async function current(document: Upload): Promise<Upload> {
    const [row] = await fx.sql<{ version: number; state: string }[]>`
      SELECT version, state::text AS state FROM core.object_uploads WHERE id = ${document.id}
    `;
    return { id: document.id, version: row!.version, state: row!.state };
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

  async function graph() {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/document-graph`,
      headers: { authorization: `Bearer ${steward}` },
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      nodes: {
        uploadId: string;
        supersededByUploadId: string | null;
        revokedAt: string | null;
        revocationReason: string | null;
      }[];
      links: { upstreamUploadId: string; downstreamUploadId: string; origin: string }[];
    };
  }

  function linksTouching(links: { upstreamUploadId: string; downstreamUploadId: string }[], id: string) {
    return links.filter((entry) => entry.upstreamUploadId === id || entry.downstreamUploadId === id);
  }

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
        'none', ${`0x${"22".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
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

  describe("the revocation itself", () => {
    it("marks a promoted document revoked with who and why, and keeps it", async () => {
      const certificate = await promoted();

      const response = await revoke(certificate);
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({
        id: certificate.id,
        // The scan-and-promote lifecycle is untouched; revocation is a separate fact.
        state: "promoted",
        revocationReason: "The issuing office confirmed this certificate was forged",
        version: certificate.version + 1,
        impactsRecorded: 0,
      });
      expect(body.revokedAt).not.toBeNull();
      expect(body.revokedBy).not.toBeNull();
      expect(body.nextActions).toEqual([
        "Download",
        "Upload a corrected version that replaces this one",
      ]);

      // Still in the project's list and graph, marked.
      const node = (await graph()).nodes.find((entry) => entry.uploadId === certificate.id);
      expect(node?.revokedAt).not.toBeNull();
      expect(node?.revocationReason).toBe("The issuing office confirmed this certificate was forged");

      const [audit] = await fx.sql<{ command: string; reason: string | null }[]>`
        SELECT command, reason FROM audit.events
        WHERE resource_id = ${certificate.id} AND command = 'upload.revoked'
      `;
      expect(audit).toMatchObject({
        command: "upload.revoked",
        reason: "The issuing office confirmed this certificate was forged",
      });
    });

    it("cannot be undone or edited, even in the database", async () => {
      const certificate = await promoted();
      expect((await revoke(certificate)).statusCode).toBe(200);

      await expect(fx.sql`
        UPDATE core.object_uploads SET revoked_at = NULL, revoked_by = NULL, revocation_reason = NULL
        WHERE id = ${certificate.id}
      `).rejects.toThrow(/revocation/i);
      await expect(fx.sql`
        UPDATE core.object_uploads SET revocation_reason = 'something milder'
        WHERE id = ${certificate.id}
      `).rejects.toThrow(/revocation/i);
      // Nor is the document as it was revoked.
      await expect(fx.sql`
        UPDATE core.object_uploads SET document_type = 'Something else' WHERE id = ${certificate.id}
      `).rejects.toThrow(/revocation stands/);
      await expect(
        fx.sql`DELETE FROM core.object_uploads WHERE id = ${certificate.id}`,
      ).rejects.toThrow();
    });

    it("is refused by the database without a reason or on an unpromoted upload", async () => {
      const promotedDoc = await promoted();
      await expect(fx.sql`
        UPDATE core.object_uploads
        SET revoked_at = now(), revoked_by = ${fx.operatorSubjectA}, revocation_reason = '  '
        WHERE id = ${promotedDoc.id}
      `).rejects.toThrow(/upload_revocation_complete/);

      const quarantined = await upload();
      await expect(fx.sql`
        UPDATE core.object_uploads
        SET revoked_at = now(), revoked_by = ${fx.operatorSubjectA}, revocation_reason = 'x'
        WHERE id = ${quarantined.id}
      `).rejects.toThrow(/upload_revoked_only_when_promoted/);
    });
    it("no longer counts as active evidence: its artifact is marked and left out of new snapshots", async () => {
      const certificate = await promoted();
      const claimId = await seedClaimOn(certificate);
      const artifactOf = async () => {
        const [row] = await fx.sql<{ id: string; content_hash: string; revoked_at: Date | null }[]>`
          SELECT a.id, a.content_hash, a.revoked_at
          FROM core.artifacts a JOIN core.object_uploads u ON u.promoted_artifact_id = a.id
          WHERE u.id = ${certificate.id}
        `;
        return row!;
      };
      const snapshotArtifacts = () =>
        fx.sql.begin(
          async (tx) => (await buildEvidenceSnapshot(tx, fx.projectA, [claimId])).artifactIds,
        );

      const before = await artifactOf();
      expect(before.revoked_at).toBeNull();
      expect(await snapshotArtifacts()).toContain(before.id);

      expect((await revoke(certificate)).statusCode).toBe(200);

      const after = await artifactOf();
      expect(after.revoked_at).not.toBeNull();
      // The artifact row itself stays, hash and all.
      expect(after.content_hash).toBe(before.content_hash);
      expect(await snapshotArtifacts()).not.toContain(before.id);
    });

    it("keeps an anchored hash as it was and appends a revocation event", async () => {
      const certificate = await promoted();
      const [stored] = await fx.sql<{ content_hash: string }[]>`
        SELECT content_hash FROM core.object_uploads WHERE id = ${certificate.id}
      `;
      const contentHash = stored!.content_hash;

      // A public record already anchored on chain, resting on the evidence this document is in.
      const entryId = randomUUID();
      const versionId = randomUUID();
      const batchId = randomUUID();
      const hex = (seed: string) => `0x${seed.replace(/-/g, "").repeat(2)}`;
      await fx.sql`
        INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
        VALUES (${entryId}, ${fx.tenantA}, 'project', ${fx.projectA}, ${`PRJ-${entryId.slice(0, 8)}`})
      `;
      await fx.sql`
        INSERT INTO core.registry_entry_versions (
          id, tenant_id, entry_id, version, status, public_projection,
          content_hash, source_snapshot_hash, policy_version, schema_version,
          serialization_version, published_at
        ) VALUES (
          ${versionId}, ${fx.tenantA}, ${entryId}, 1, 'published', '{}'::jsonb,
          ${hex(versionId)}, ${hex(entryId)}, '1', '1', '1', now()
        )
      `;
      await fx.sql`
        INSERT INTO chain.anchor_batches (
          id, tenant_id, batch_id, merkle_root, manifest_hash,
          manifest_object_key, schema_version, record_count
        ) VALUES (
          ${batchId}, ${fx.tenantA}, ${hex(batchId)}, ${hex(versionId)},
          ${`0x${"33".repeat(32)}`}, 'manifests/revoke.json', '1', 1
        )
      `;
      await fx.sql`
        INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
        VALUES (${batchId}, ${hex(versionId)}, ${versionId}, 0)
      `;
      const anchored = () => fx.sql`
        SELECT v.status::text AS status, v.content_hash, v.source_snapshot_hash,
               b.merkle_root, l.leaf_hash
        FROM core.registry_entry_versions v
        JOIN chain.anchor_batch_leaves l ON l.entry_version_id = v.id
        JOIN chain.anchor_batches b ON b.id = l.batch_id
        WHERE v.id = ${versionId}
      `;
      const before = await anchored();

      expect((await revoke(certificate)).statusCode).toBe(200);

      expect(await anchored()).toEqual(before);
      const [upload] = await fx.sql<{ content_hash: string }[]>`
        SELECT content_hash FROM core.object_uploads WHERE id = ${certificate.id}
      `;
      expect(upload?.content_hash).toBe(contentHash);

      // The state change is a new event, not an edit of an old one.
      const events = await fx.sql<{ event_type: string; payload: { contentHash: string } }[]>`
        SELECT event_type, payload FROM core.outbox
        WHERE aggregate_id = ${certificate.id} ORDER BY occurred_at
      `;
      expect(events.map((event) => event.event_type)).toEqual(["evidence.version.revoked"]);
      expect(events[0]?.payload.contentHash).toBe(contentHash);
    });
  });

  describe("what rests on it", () => {
    it("flags what rests on the revoked document with cause revoked: depends_on travels, references stops", async () => {
      const license = await promoted();
      const report = await promoted();
      const summary = await promoted();
      const memo = await promoted();
      const memoAnnex = await promoted();
      expect((await link(license, report)).statusCode).toBe(200);
      expect((await link(report, summary)).statusCode).toBe(200);
      expect((await link(license, memo, "references")).statusCode).toBe(200);
      expect((await link(memo, memoAnnex)).statusCode).toBe(200);

      const response = await revoke(license);
      expect(response.statusCode).toBe(200);
      expect(response.json().impactsRecorded).toBe(3);

      const impacts = await impactsOf(license);
      const byUpload = new Map(impacts.map((impact) => [impact.uploadId, impact]));
      expect([...byUpload.keys()].sort()).toEqual([report.id, summary.id, memo.id].sort());
      expect(byUpload.get(report.id)).toMatchObject({ cause: "revoked", depth: 1, resolution: "open" });
      expect(byUpload.get(summary.id)).toMatchObject({ cause: "revoked", depth: 2, viaUploadId: report.id });
      expect(byUpload.get(memo.id)).toMatchObject({ cause: "revoked", viaKind: "references" });
      // The revoked document itself is not asked for a second look; a corrected version is.
      expect(byUpload.has(license.id)).toBe(false);

      // One notification for the revocation, not one per document.
      const [notice] = await fx.sql<{ count: string; summary: string }[]>`
        SELECT count(*) OVER () AS count, summary FROM core.notifications
        WHERE kind = 'document_impact' AND project_id = ${fx.projectA}
          AND summary LIKE '%revoked%'
          AND occurred_at >= (
            SELECT min(detected_at) FROM core.document_impacts WHERE origin_upload_id = ${license.id}
          )
      `;
      expect(Number(notice?.count)).toBe(1);

      // The links stay where they are, so a corrected version can take them over.
      expect(linksTouching((await graph()).links, license.id)).toHaveLength(2);
    });

    it("marks claims verified against the revoked document stale", async () => {
      const certificate = await promoted();
      const claimId = await seedClaimOn(certificate);

      expect((await revoke(certificate)).statusCode).toBe(200);

      const [claim] = await fx.sql<{ stale_since: Date | null; stale_reason: string | null }[]>`
        SELECT stale_since, stale_reason FROM core.claims WHERE id = ${claimId}
      `;
      expect(claim?.stale_since).not.toBeNull();
      expect(claim?.stale_reason).toContain("was revoked");
    });

    it("hands its links and open impacts to the corrected version", async () => {
      const license = await promoted();
      const report = await promoted();
      await link(license, report);
      expect((await revoke(license)).statusCode).toBe(200);

      const corrected = await newVersionOf(await current(license));
      // The correction names the version it corrects; the revoked one keeps why it was revoked.
      expect(corrected).toMatchObject({ supersedesUploadId: license.id });
      const revokedNode = (await graph()).nodes.find((node) => node.uploadId === license.id);
      expect(revokedNode).toMatchObject({
        supersededByUploadId: corrected.id,
        revocationReason: "The issuing office confirmed this certificate was forged",
      });

      const links = (await graph()).links;
      expect(linksTouching(links, license.id)).toEqual([]);
      expect(
        links.filter((entry) => entry.upstreamUploadId === corrected.id).map((entry) => entry.downstreamUploadId),
      ).toEqual([report.id]);
      // The report is asked again: first because the license was revoked, then because the
      // corrected license took effect.
      expect((await impactsOf(license)).map((impact) => impact.cause).sort()).toEqual([
        "revoked",
        "superseded",
      ]);
    });
  });

  describe("no longer something to rest on", () => {
    it("refuses a new link at either end", async () => {
      const revoked = await promoted();
      const other = await promoted();
      expect((await revoke(revoked)).statusCode).toBe(200);

      for (const [upstream, downstream] of [
        [revoked, other],
        [other, revoked],
      ] as const) {
        const response = await link(upstream, downstream);
        expect(response.statusCode).toBe(409);
        expect(response.json().code).toBe("DOCUMENT_REVOKED");
      }
    });

    it("a link waits for a revocation in flight and is then refused", async () => {
      const target = await promoted();
      const other = await promoted();

      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const revocation = fx.sql.begin(async (tx) => {
        await tx`SELECT id FROM core.object_uploads WHERE id = ${target.id} FOR UPDATE`;
        await tx`
          UPDATE core.object_uploads
          SET revoked_at = now(), revoked_by = ${fx.operatorSubjectA}, revocation_reason = 'Withdrawn'
          WHERE id = ${target.id}
        `;
        await held;
      });

      const attempt = link(other, target);
      await new Promise((resolve) => setTimeout(resolve, 300));
      release();
      await revocation;

      const response = await attempt;
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe("DOCUMENT_REVOKED");
    });

    it("refuses profile edits and leaves it out of type rules", async () => {
      const suffix = randomUUID().slice(0, 8);
      const upperType = `Accreditation ${suffix}`;
      const lowerType = `Assay ${suffix}`;

      const revoked = await promoted();
      const typed = await profile(revoked, { documentType: upperType });
      expect(typed.statusCode).toBe(200);
      expect((await revoke(typed.json() as Upload)).statusCode).toBe(200);

      const edit = await profile(await current(revoked), { validUntil: "2030-01-01" });
      expect(edit.statusCode).toBe(409);
      expect(edit.json().code).toBe("DOCUMENT_REVOKED");

      const below = await promoted();
      await profile(below, { documentType: lowerType });

      const rule = await app.inject({
        method: "POST",
        url: "/api/v1/document-link-rules",
        headers: headers(operator),
        payload: { upstreamType: upperType, downstreamType: lowerType, kind: "depends_on" },
      });
      expect(rule.statusCode).toBe(200);
      expect(rule.json().linksCreated).toBe(0);
    });

    it("is not checked for expiry — nobody should rest on it", async () => {
      const permit = await promoted();
      const plan = await promoted();
      await link(permit, plan);
      // A lapsed date nobody has swept yet: only the sweep could notice it.
      await fx.sql`UPDATE core.object_uploads SET valid_until = '2019-12-31' WHERE id = ${permit.id}`;
      expect((await revoke(await current(permit))).statusCode).toBe(200);
      await fx.sql.begin(async (tx) => {
        await tx`SET LOCAL ROLE mpc_worker`;
        await tx`SELECT core.sweep_document_expiry(current_date)`;
      });

      expect((await impactsOf(permit)).map((impact) => impact.cause)).toEqual(["revoked"]);
    });

    it("is skipped when a change further up reaches it, while the change still travels through it", async () => {
      const license = await promoted();
      const revokedReport = await promoted();
      const summary = await promoted();
      await link(license, revokedReport);
      await link(revokedReport, summary);
      expect((await revoke(await current(revokedReport))).statusCode).toBe(200);

      await newVersionOf(license);

      const impacts = await impactsOf(license);
      expect(impacts.map((impact) => impact.uploadId)).toEqual([summary.id]);
      expect(impacts[0]).toMatchObject({ depth: 2, viaUploadId: revokedReport.id });
    });
  });

  describe("versions", () => {
    it("revokes a replaced version: kept, marked, nothing to flag because its links moved on", async () => {
      const original = await promoted();
      const report = await promoted();
      await link(original, report);
      const successor = await newVersionOf(original);
      const claimId = await seedClaimOn(original);
      // Claims verified against the old version were marked when it was replaced; this one is
      // seeded afterwards so the revocation has something of its own to mark.

      const response = await revoke(await current(original));
      expect(response.statusCode).toBe(200);
      expect(response.json().impactsRecorded).toBe(0);

      const nodes = (await graph()).nodes;
      expect(nodes.find((node) => node.uploadId === original.id)).toMatchObject({
        supersededByUploadId: successor.id,
      });
      expect(nodes.find((node) => node.uploadId === successor.id)?.revokedAt).toBeNull();

      const [claim] = await fx.sql<{ stale_reason: string | null }[]>`
        SELECT stale_reason FROM core.claims WHERE id = ${claimId}
      `;
      expect(claim?.stale_reason).toContain("was revoked");
    });

    it("does not bring the predecessor back when the version replacing it is revoked", async () => {
      const original = await promoted();
      const report = await promoted();
      await link(original, report);
      const successor = await newVersionOf(original);

      const response = await revoke(successor);
      expect(response.statusCode).toBe(200);
      // The report followed the successor; it is asked to look again.
      expect(response.json().impactsRecorded).toBe(1);

      const nodes = (await graph()).nodes;
      // The old version stays replaced. Reviving it would quietly make an outdated document
      // current again.
      expect(nodes.find((node) => node.uploadId === original.id)?.supersededByUploadId).toBe(
        successor.id,
      );
      const [successorOf] = await fx.sql<{ id: string | null }[]>`
        SELECT core.document_successor(${original.id}) AS id
      `;
      expect(successorOf?.id).toBe(successor.id);

      // The correction goes on the revoked version, not beside it on the old one.
      const rival = await profile(await upload(), { supersedesUploadId: original.id });
      expect(rival.statusCode).toBe(409);
      expect(rival.json().code).toBe("DOCUMENT_ALREADY_REPLACED");

      const corrected = await profile(await upload(), { supersedesUploadId: successor.id });
      expect(corrected.statusCode).toBe(200);
    });
  });

  describe("what cannot be revoked", () => {
    it("refuses uploads that are not promoted documents", async () => {
      const quarantined = await upload();
      const clean = await scanResult(await upload(), "clean");
      const infected = await scanResult(await upload(), "infected");
      const rejectedUpload = await upload();
      await fx.sql`
        UPDATE core.object_uploads SET state = 'rejected', rejection_reason = 'Wrong file'
        WHERE id = ${rejectedUpload.id}
      `;
      const rejected = await current(rejectedUpload);

      for (const [document, state] of [
        [quarantined, "quarantined"],
        [clean, "scanned_clean"],
        [infected, "scanned_infected"],
        [rejected, "rejected"],
      ] as const) {
        const response = await revoke(document);
        expect(response.statusCode).toBe(409);
        expect(response.json()).toMatchObject({
          code: "DOCUMENT_NOT_REVOCABLE",
          details: { state },
          retryable: false,
        });
        expect(response.json().correlationId).toEqual(expect.any(String));
      }
    });
  });

  describe("repeats and malformed requests", () => {
    it("replays the same request, and refuses a second revocation with a new key", async () => {
      const certificate = await promoted();
      const key = idempotencyKey();

      const first = await revoke(certificate, undefined, { key });
      expect(first.statusCode).toBe(200);

      const replay = await revoke(certificate, undefined, { key });
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual(first.json());

      const reused = await revoke(certificate, { reason: "A different reason" }, { key });
      expect(reused.statusCode).toBe(409);
      expect(reused.json().code).toBe("IDEMPOTENCY_KEY_REUSE");

      // A fresh key with the version the first answer returned — still one revocation.
      const again = await revoke(certificate, undefined, { version: first.json().version });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({
        code: "DOCUMENT_ALREADY_REVOKED",
        details: { revokedAt: first.json().revokedAt },
      });

      const [count] = await fx.sql<{ n: string }[]>`
        SELECT count(*) AS n FROM audit.events
        WHERE resource_id = ${certificate.id} AND command = 'upload.revoked'
      `;
      expect(Number(count?.n)).toBe(1);
    });

    it("requires a reason", async () => {
      const certificate = await promoted();
      for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(1001) }]) {
        const response = await revoke(certificate, body);
        expect(response.statusCode).toBe(400);
        expect(response.json().code).toBe("REQUEST_INVALID");
      }
      const extra = await revoke(certificate, { reason: "Forged", restore: true });
      expect(extra.statusCode).toBe(400);
      expect((await current(certificate)).version).toBe(certificate.version);
    });

    it("requires an Idempotency-Key and If-Match, and refuses a stale version", async () => {
      const certificate = await promoted();

      const noKey = await revoke(certificate, undefined, { key: null });
      expect(noKey.statusCode).toBe(400);
      expect(noKey.json().code).toBe("IDEMPOTENCY_KEY_REQUIRED");

      const noVersion = await revoke(certificate, undefined, { version: null });
      expect(noVersion.statusCode).toBe(428);
      expect(noVersion.json().code).toBe("IF_MATCH_REQUIRED");

      const stale = await revoke(certificate, undefined, { version: certificate.version - 1 });
      expect(stale.statusCode).toBe(412);
      expect(stale.json().code).toBe("RESOURCE_VERSION_MISMATCH");
    });
  });

  describe("who may revoke", () => {
    it("is refused to roles that may read the document but not revoke it", async () => {
      const certificate = await promoted();
      for (const token of [operator, reviewer]) {
        const response = await revoke(certificate, undefined, { token });
        expect(response.statusCode).toBe(403);
        expect(response.json().code).toBe("AUTHORIZATION_DENIED");
      }
      expect((await current(certificate)).version).toBe(certificate.version);
    });

    it("answers 404 where the document is not visible: project out of scope, no role, another tenant, no such id", async () => {
      const elsewhere = await promoted(fx.otherProjectA);

      const outOfScope = await revoke(elsewhere, undefined, { token: scopedSteward });
      expect(outOfScope.statusCode).toBe(404);

      const otherTenant = await revoke(elsewhere, undefined, { token: otherTenantOperator });
      expect(otherTenant.statusCode).toBe(404);

      // No role at all: no project is readable, so nothing is confirmed to exist.
      const noRole = await revoke(elsewhere, undefined, { token: reader });
      expect(noRole.statusCode).toBe(404);

      const missing = await revoke({ id: randomUUID(), version: 1 });
      expect(missing.statusCode).toBe(404);

      // Same body for all three: nothing tells an existing id from a missing one.
      expect(outOfScope.json().message).toBe(missing.json().message);
      expect(otherTenant.json().message).toBe(missing.json().message);

      // The scoped steward still revokes in the project the binding reaches.
      const here = await promoted();
      expect((await revoke(here, undefined, { token: scopedSteward })).statusCode).toBe(200);
    });
  });

  describe("concurrency", () => {
    it("two revocations at once: one succeeds, the other is told it is already revoked", async () => {
      const certificate = await promoted();
      const [a, b] = await Promise.all([
        revoke(certificate, { reason: "Forged — reported by the lab" }),
        revoke(certificate, { reason: "Forged — reported by the regulator" }),
      ]);
      const codes = [a.statusCode, b.statusCode].sort();
      expect(codes).toEqual([200, 409]);
      const loser = a.statusCode === 409 ? a : b;
      expect(loser.json().code).toBe("DOCUMENT_ALREADY_REVOKED");
    });

    it("revocation and replacement at once both land, in either order, with the links on the new version", async () => {
      const license = await promoted();
      const report = await promoted();
      await link(license, report);
      const replacement = await promoted();

      const [revoked, marked] = await Promise.all([
        revoke(license),
        profile(replacement, { supersedesUploadId: license.id }),
      ]);
      expect(revoked.statusCode).toBe(200);
      expect(marked.statusCode).toBe(200);

      const state = await graph();
      expect(state.nodes.find((node) => node.uploadId === license.id)).toMatchObject({
        supersededByUploadId: replacement.id,
      });
      expect(state.nodes.find((node) => node.uploadId === license.id)?.revokedAt).not.toBeNull();
      expect(linksTouching(state.links, license.id)).toEqual([]);
      expect(
        state.links
          .filter((entry) => entry.upstreamUploadId === replacement.id)
          .map((entry) => entry.downstreamUploadId),
      ).toEqual([report.id]);

      // The report is asked to look again whichever landed first.
      const causes = (await impactsOf(license)).filter((impact) => impact.uploadId === report.id);
      expect(causes.map((impact) => impact.cause)).toContain("superseded");
    });
  });
});
