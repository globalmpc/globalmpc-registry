import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import {
  bearer,
  idempotencyKey,
  setupFixture,
  signIn,
  testEnv,
  type TestFixture,
} from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Audit export, project export packages and audit coverage — 07 §7.9, 12 §12.4, 02 §2.7.
 */
describeDb("exports and audit coverage", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let auditorToken: string;
  let operatorToken: string;
  let stewardToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    auditorToken = await signIn(app, fx.auditorA);
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function auditRows(command: string, wallet: string) {
    return fx.sql<{ effective_role: string; resource_id: string | null; project_id: string | null }[]>`
      SELECT effective_role, resource_id, project_id FROM audit.events
      WHERE tenant_id = ${fx.tenantA} AND command = ${command} AND actor_wallet = ${wallet}
      ORDER BY id
    `;
  }

  describe("audit export", () => {
    function exportAudit(token: string, query = "") {
      return app.inject({
        method: "GET",
        url: `/api/v1/audit-events/export${query}`,
        headers: bearer(token),
      });
    }

    it("returns JSON Lines whose sha256 the manifest states", async () => {
      const response = await exportAudit(auditorToken);
      expect(response.statusCode).toBe(200);
      const { manifest, jsonl } = response.json() as {
        manifest: Record<string, unknown>;
        jsonl: string;
      };

      const lines = jsonl.split("\n").filter((line) => line.length > 0);
      expect(manifest["format"]).toBe("mpc.audit-export");
      expect(manifest["lineCount"]).toBe(lines.length);
      expect(manifest["sha256"]).toBe(createHash("sha256").update(jsonl, "utf8").digest("hex"));
      // detail and request IP stay out, as on the read route.
      for (const line of lines) {
        const record = JSON.parse(line) as Record<string, unknown>;
        expect(record).not.toHaveProperty("detail");
        expect(record).not.toHaveProperty("requestIp");
      }
    });

    it("pages by id and narrows by project and time", async () => {
      const first = (await exportAudit(auditorToken, "?limit=1")).json();
      expect(first.manifest.lineCount).toBe(1);
      expect(first.manifest.nextAfterId).toBe(first.manifest.lastId);

      const next = (
        await exportAudit(auditorToken, `?limit=1&afterId=${first.manifest.nextAfterId}`)
      ).json();
      expect(BigInt(next.manifest.firstId)).toBeGreaterThan(BigInt(first.manifest.lastId));

      const future = (await exportAudit(auditorToken, "?from=2999-01-01T00:00:00.000Z")).json();
      expect(future.manifest.lineCount).toBe(0);

      const scoped = (await exportAudit(auditorToken, `?projectId=${fx.projectA}`)).json();
      for (const line of (scoped.jsonl as string).split("\n").filter(Boolean)) {
        expect(JSON.parse(line).projectId).toBe(fx.projectA);
      }
    });

    it("records the export itself, with the hash of what left", async () => {
      const response = (await exportAudit(auditorToken, "?limit=5")).json();
      const [row] = await fx.sql<{ detail: { sha256: string; lineCount: number } }[]>`
        SELECT detail FROM audit.events
        WHERE tenant_id = ${fx.tenantA} AND command = 'audit.exported'
        ORDER BY id DESC LIMIT 1
      `;
      expect(row!.detail.sha256).toBe(response.manifest.sha256);
      expect(row!.detail.lineCount).toBe(response.manifest.lineCount);
    });

    it("is limited to auditors and security operators", async () => {
      // mpc_operator may read the trail but not take a copy out.
      const operator = await exportAudit(operatorToken);
      expect(operator.statusCode).toBe(403);
      expect(operator.json().details.requiredRoles).toEqual(["auditor", "security_operator"]);
      expect((await exportAudit(stewardToken)).statusCode).toBe(403);
    });
  });

  describe("project export package", () => {
    function requestExport(token: string, projectId = fx.projectA, key = idempotencyKey()) {
      return app.inject({
        method: "POST",
        url: `/api/v1/projects/${projectId}/exports`,
        headers: { ...bearer(token), "idempotency-key": key },
      });
    }

    it("refuses another person's key instead of answering with their job", async () => {
      const key = idempotencyKey();
      expect((await requestExport(stewardToken, fx.projectA, key)).statusCode).toBe(202);

      const other = await requestExport(operatorToken, fx.projectA, key);
      expect(other.statusCode).toBe(409);
      expect(other.json().code).toBe("IDEMPOTENCY_KEY_REUSE");
    });

    it("accepts the request as a queued job and emits the event in the same transaction", async () => {
      const response = await requestExport(stewardToken);
      expect(response.statusCode).toBe(202);
      const job = response.json();
      expect(job).toMatchObject({
        projectId: fx.projectA,
        state: "queued",
        package: null,
        // The steward session is identity_bound: its clearance is frozen on the job.
        sensitivityClearance: ["public", "restricted"],
      });

      const [event] = await fx.sql<{ event_type: string; payload: Record<string, string> }[]>`
        SELECT event_type, payload FROM core.outbox WHERE aggregate_id = ${job.id}
      `;
      expect(event).toEqual({
        event_type: "project.export.requested",
        payload: { exportId: job.id, projectId: fx.projectA },
      });

      const audited = await auditRows("project.export.requested", fx.stewardA.address);
      expect(audited.at(-1)).toMatchObject({ resource_id: job.id, project_id: fx.projectA });
    });

    it("a retried request with the same key creates one job", async () => {
      const key = idempotencyKey();
      const first = (await requestExport(stewardToken, fx.projectA, key)).json();
      const second = (await requestExport(stewardToken, fx.projectA, key)).json();
      expect(second.id).toBe(first.id);
    });

    it("only the requester can read the job and its package", async () => {
      const job = (await requestExport(stewardToken)).json();
      const read = (token: string) =>
        app.inject({
          method: "GET",
          url: `/api/v1/projects/${fx.projectA}/exports/${job.id}`,
          headers: bearer(token),
        });

      const mine = await read(stewardToken);
      expect(mine.statusCode).toBe(200);
      expect(mine.json().state).toBe("queued");

      // The operator could read the project, but the package was redacted for someone else.
      expect((await read(operatorToken)).statusCode).toBe(404);
    });

    it("follows project scope", async () => {
      const scopedToken = await signIn(app, fx.scopedStewardA);
      expect((await requestExport(scopedToken, fx.otherProjectA)).statusCode).toBe(403);
      // A tenant-wide role passes scope, so a missing project answers as missing.
      expect((await requestExport(operatorToken, randomUUID())).statusCode).toBe(404);
    });
  });

  describe("audit coverage", () => {
    it("sign-in and sign-out are recorded with a self-bound role", async () => {
      const before = (await auditRows("auth.session.created", fx.readerA.address)).length;
      const token = await signIn(app, fx.readerA);
      const created = await auditRows("auth.session.created", fx.readerA.address);
      expect(created.length).toBe(before + 1);
      expect(created.at(-1)!.effective_role).toBe("self_bound");

      const logout = await app.inject({
        method: "POST",
        url: "/api/v1/auth/logout",
        headers: bearer(token),
      });
      expect(logout.json().revoked).toBe(true);
      const revoked = await auditRows("auth.session.revoked", fx.readerA.address);
      expect(revoked.at(-1)!.effective_role).toBe("self_bound");

      // A logout with a token already revoked changed nothing and records nothing.
      await app.inject({ method: "POST", url: "/api/v1/auth/logout", headers: bearer(token) });
      expect((await auditRows("auth.session.revoked", fx.readerA.address)).length).toBe(
        revoked.length,
      );
    });

    it("marking a notification read is recorded once", async () => {
      const reason = `audit-${randomUUID().slice(0, 8)}`;
      await fx.sql`
        INSERT INTO core.evidence_stale_signals (
          id, tenant_id, project_id, target_type, target_id, reason
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
          ${randomUUID()}, ${reason}
        )
      `;
      const listed = await app.inject({
        method: "GET",
        url: "/api/v1/notifications",
        headers: bearer(stewardToken),
      });
      const notification = (listed.json().items as { id: string; summary: string }[]).find(
        (item) => item.summary.includes(reason),
      )!;

      for (let i = 0; i < 2; i += 1) {
        const marked = await app.inject({
          method: "POST",
          url: `/api/v1/notifications/${notification.id}/read`,
          headers: { ...bearer(stewardToken), "idempotency-key": idempotencyKey() },
        });
        expect(marked.statusCode).toBe(200);
      }

      const rows = (await auditRows("notification.read", fx.stewardA.address)).filter(
        (row) => row.resource_id === notification.id,
      );
      expect(rows).toEqual([
        { effective_role: "data_steward", resource_id: notification.id, project_id: fx.projectA },
      ]);
    });
  });

  it("the backlog counts dead-lettered events apart, with the last error", async () => {
    await fx.sql`
      INSERT INTO core.outbox (
        id, tenant_id, event_type, aggregate_id, aggregate_version, payload, correlation_id,
        attempts, last_error, dead_lettered_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, 'test.dead_letter', ${randomUUID()}, 1, '{}'::jsonb,
        'dead-letter-test', 5, 'project_export: Error: down', now()
      )
    `;

    const body = (
      await app.inject({
        method: "GET",
        url: "/api/v1/outbox-backlog",
        headers: bearer(operatorToken),
      })
    ).json();

    expect(body.deadLettered).toBeGreaterThanOrEqual(1);
    expect(body.deadLetteredByEventType).toContainEqual({
      eventType: "test.dead_letter",
      deadLettered: 1,
      lastError: "project_export: Error: down",
    });
    expect(body.byEventType.map((row: { eventType: string }) => row.eventType)).not.toContain(
      "test.dead_letter",
    );
  });
});
