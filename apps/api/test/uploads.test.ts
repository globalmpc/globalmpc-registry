import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * File uploads — 05 §5.2, 06 §6.7.
 *
 * The core of what this file checks: **there is no path by which an infected file becomes
 * evidence.** The rest are the conditions that guarantee rests on.
 */
describeDb("uploads", () => {
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
        // Each case uses different content. The content hash is UNIQUE within a project,
        // so reusing content returns the existing row from the second call on.
        contentBase64: Buffer.from(`license extract ${counter}`).toString("base64"),
        contentType: "application/pdf",
        originalFilename: "mining-license.pdf",
        ...body,
      },
    });
  }

  describe("content type restrictions", () => {
    it("rejects executable document types", async () => {
      /**
       * The storage origin does not pass through our permission checks. Stored as `text/html`,
       * the file runs on that origin just by opening the download link.
       */
      const response = await upload(stewardToken, { contentType: "text/html" });
      expect(response.statusCode).toBe(400);
      expect(response.json().code).toBe("REQUEST_INVALID");
    });

    it("rejects svg too — it can carry scripts", async () => {
      const response = await upload(stewardToken, { contentType: "image/svg+xml" });
      expect(response.statusCode).toBe(400);
    });

    it("judges a type with parameters by its media type", async () => {
      const response = await upload(stewardToken, { contentType: "text/csv; charset=utf-8" });
      expect(response.statusCode).toBe(200);
      // Stores the normalized value. Storing parameters would split one type into several.
      expect(response.json().contentType).toBe("text/csv");
    });
  });

  function scan(uploadId: string, version: number, result: "clean" | "infected") {
    return app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadId}/scan-result`,
      headers: {
        // Only the scan service can produce results. The steward is the uploader.
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

  it("places uploads in quarantine", async () => {
    const response = await upload(stewardToken);

    expect(response.statusCode).toBe(200);
    // Not evidence. Promotion requires passing the scan.
    expect(response.json().state).toBe("quarantined");
    expect(response.json().promotedArtifactId).toBeNull();
  });

  it("keeps the filename out of the storage key", async () => {
    const created = (await upload(stewardToken)).json();

    const [row] = await fx.sql<{ object_key: string }[]>`
      SELECT object_key FROM core.object_uploads WHERE id = ${created.id}
    `;
    // Keys flow through logs, URLs, and error messages. Document titles must not leak.
    expect(row!.object_key).not.toContain("mining-license");
    expect(row!.object_key).toContain("quarantine/");
  });

  it("returns the available next actions", async () => {
    const created = (await upload(stewardToken)).json();
    expect(created.nextActions).toContain("Record scan result");
  });

  it("promotes to evidence and creates an artifact after a clean scan", async () => {
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

  it("does not promote a file judged infected", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "infected");
    expect(scanned.json().state).toBe("scanned_infected");

    // The state machine has no `scanned_infected → promoted` path.
    const promoted = await promote(created.id, scanned.json().version);
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json().code).toBe("INVALID_STATE_TRANSITION");
  });

  it("does not reverse an infected verdict", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "infected");

    // A rescan cannot make it clean. To try again, upload anew.
    const recheck = await scan(created.id, scanned.json().version, "clean");
    expect(recheck.statusCode).toBe(409);
    expect(scanned.json().nextActions).not.toContain("Promote to evidence");
  });

  it("does not issue download links for infected files", async () => {
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

  function downloadLink(uploadId: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/uploads/${uploadId}/download-link`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
      payload: {},
    });
  }

  it("does not issue download links for files not yet scanned (Q-033)", async () => {
    // Quarantine means "not known to be safe". A link would deliver an unscanned file to the
    // project's users before the scanner has seen it.
    const created = (await upload(stewardToken)).json();
    expect(created.state).toBe("quarantined");

    const link = await downloadLink(created.id);
    expect(link.statusCode).toBe(409);
    expect(link.json().code).toBe("UPLOAD_NOT_SCANNED");
    expect(link.body).not.toContain("url\"");
  });

  it("issues download links for promoted files", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "clean");
    const promoted = await promote(created.id, scanned.json().version);
    expect(promoted.json().state).toBe("promoted");

    const link = await downloadLink(created.id);
    expect(link.statusCode).toBe(200);
  });

  it("issues short-lived download links and states what they bypass", async () => {
    const created = (await upload(stewardToken)).json();
    const scanned = await scan(created.id, created.version, "clean");
    expect(scanned.json().state).toBe("scanned_clean");

    const link = await downloadLink(created.id);

    expect(link.statusCode).toBe(200);
    // Never creates permanent URLs (06 §6.7).
    expect(link.json().expiresInSeconds).toBeLessThanOrEqual(900);
    // Whoever receives the link does not go through permission checks again.
    expect(link.json().warning).toContain("without signing in");
  });

  it("returns the existing upload for duplicate content", async () => {
    const body = {
      contentBase64: Buffer.from("identical content").toString("base64"),
      contentType: "application/pdf",
      originalFilename: "same.pdf",
    };

    const first = await upload(stewardToken, body);
    const second = await upload(stewardToken, body);

    // Storing twice splits the evidence, leaving it unclear which copy is under review.
    expect(second.json().id).toBe(first.json().id);
  });

  describe("multipart streaming", () => {
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

    it("places streamed uploads in quarantine too", async () => {
      const response = await streamUpload(stewardToken, `stream content ${Date.now()}`);

      expect(response.statusCode).toBe(200);
      expect(response.json().state).toBe("quarantined");
    });

    it("produces the same content hash as the base64 path", async () => {
      const content = `same bytes ${Date.now()}`;
      const viaStream = (await streamUpload(stewardToken, content)).json();
      const viaBase64 = (
        await upload(stewardToken, {
          contentBase64: Buffer.from(content).toString("base64"),
        })
      ).json();

      // If the paths hashed differently, one file would become two pieces of evidence.
      expect(viaBase64.contentHash).toBe(viaStream.contentHash);
      expect(viaBase64.id).toBe(viaStream.id);
    });

    it("rejects a request without a file part", async () => {
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

    it("rejects streamed uploads from an unauthorized account", async () => {
      // With two paths, permissions can loosen on just one of them.
      const response = await streamUpload(operatorToken, "denied");
      expect(response.statusCode).toBe(403);
    });
  });

  it("returns 400 for a non-UUID path parameter", async () => {
    // Passed straight to the DB, the type error surfaces as 500 and the client retries,
    // mistaking it for a server outage.
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/projects/new/uploads",
      headers: { authorization: `Bearer ${stewardToken}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe("PATH_PARAM_INVALID");
  });

  it("rejects empty files", async () => {
    const response = await upload(stewardToken, { contentBase64: "" });
    expect(response.statusCode).toBe(400);
  });

  it("rejects without the source.upload permission", async () => {
    // mpc_operator lacks this permission (02 §2.3).
    const response = await upload(operatorToken);
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("data_steward");
  });

  it("requires If-Match to record a scan result", async () => {
    const created = (await upload(stewardToken)).json();

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/uploads/${created.id}/scan-result`,
      headers: { authorization: `Bearer ${scanToken}`, "idempotency-key": idempotencyKey() },
      payload: { result: "clean" },
    });
    expect(response.statusCode).toBe(428);
  });

  it("does not let the uploader record the scan result for their own file", async () => {
    const created = (await upload(stewardToken)).json();

    // Reusing `source.upload` would have let this pass. The check is a separate action so
    // quarantine does not become a formality.
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

  it("hides uploads from other tenants", async () => {
    await upload(stewardToken);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${fx.projectA}/uploads`,
      headers: { authorization: `Bearer ${await signIn(app, fx.operatorB)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().items).toEqual([]);
  });

  it("keeps filenames out of the audit log", async () => {
    const created = (await upload(stewardToken)).json();

    const [event] = await fx.sql<{ detail: Record<string, unknown> }[]>`
      SELECT detail FROM audit.events
      WHERE resource_type = 'object_upload' AND resource_id = ${created.id}
      ORDER BY occurred_at LIMIT 1
    `;
    // The audit log must not become a channel for restricted information.
    expect(JSON.stringify(event!.detail)).not.toContain("mining-license");
  });

  /**
   * Storage tier gate — OD-17·OD-18 (2026-08-14 draft decision).
   *
   * The draft storage path uses provider-managed keys, with neither per-tenant key separation
   * nor a destruction procedure. Real contracts and personal data wait for the secured route.
   */
  describe("storage tier gate", () => {
    it("rejects confidential uploads and returns the next action", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          contentBase64: Buffer.from("contract body").toString("base64"),
          contentType: "application/pdf",
          originalFilename: "contract.pdf",
          sensitivity: "confidential",
        },
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("SECURED_ROUTE_REQUIRED");
      expect(response.json().details.requiredTier).toBe("secured");
    });

    it("accepts restricted uploads as is", async () => {
      const response = await app.inject({
        method: "POST",
        url: `/api/v1/projects/${fx.projectA}/uploads`,
        headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
        payload: {
          contentBase64: Buffer.from("general material").toString("base64"),
          contentType: "application/pdf",
          sensitivity: "restricted",
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it("blocks the same at the DB level", async () => {
      // Must hold even if a path that bypasses the route appears.
      await expect(
        fx.sql`
          UPDATE core.object_uploads SET sensitivity = 'confidential'
          WHERE project_id = ${fx.projectA}
        `,
      ).rejects.toThrow(/object_uploads_draft_tier_only/);
    });
  });
});
