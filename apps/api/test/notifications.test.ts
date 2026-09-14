import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Notifications.
 *
 * When a review request, gap, stale or revoke happened, the only way people found out was
 * reopening the screen. Two things are enforced here.
 *
 * 1. A notification is created **whatever path the event takes** — hence a trigger.
 * 2. A role notification read by one person **stays unread for others.**
 */
describeDb("notifications", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let stewardToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    stewardToken = await signIn(app, fx.stewardA);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function list(token: string) {
    return app.inject({
      method: "GET",
      url: "/api/v1/notifications",
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it("notifies the role when a stale signal appears", async () => {
    const reason = `stale-${randomUUID().slice(0, 8)}`;
    // Signals are also created by triggers; here we check that a notification appears
    // **whatever path they come in by**.
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${reason}
      )
    `;

    const items = (await list(stewardToken)).json().items as {
      summary: string;
      audience: string;
      audienceRole: string | null;
      read: boolean;
      link: string;
    }[];
    const found = items.find((item) => item.summary.includes(reason));

    expect(found).toBeDefined();
    // The event is assigned to nobody. Sending it to one person means nobody knows
    // while that person is away.
    expect(found!.audience).toBe("role");
    expect(found!.audienceRole).toBe("data_steward");
    // A notification with no link forces a search.
    expect(found!.link).toBeTruthy();
    expect(found!.read).toBe(false);
  });

  it("a role notification read by one person stays for others", async () => {
    const reason = `shared-${randomUUID().slice(0, 8)}`;
    await fx.sql`
      INSERT INTO core.evidence_stale_signals (
        id, tenant_id, project_id, target_type, target_id, reason
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${fx.projectA}, 'registry_entry_version',
        ${randomUUID()}, ${reason}
      )
    `;
    // Creates a second person with the same role as steward.
    const secondSubject = randomUUID();
    await fx.sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${secondSubject}, ${fx.tenantA}, 'person', 'Second steward')
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${secondSubject}, ${fx.orgA}, 'data_steward')
    `;

    const mine = ((await list(stewardToken)).json().items as { id: string; summary: string }[]).find(
      (item) => item.summary.includes(reason),
    );
    expect(mine).toBeDefined();

    const marked = await app.inject({
      method: "POST",
      url: `/api/v1/notifications/${mine!.id}/read`,
      headers: { authorization: `Bearer ${stewardToken}`, "idempotency-key": idempotencyKey() },
    });
    expect(marked.statusCode).toBe(200);
    expect(marked.json().read).toBe(true);

    // The same notification must still be unread for the other person. Storing read state
    // on the notification row hides it from everyone once one person reads it.
    const [otherRead] = await fx.sql<{ count: string }[]>`
      SELECT count(*) FROM core.notification_reads
      WHERE notification_id = ${mine!.id} AND subject_id = ${secondSubject}
    `;
    expect(Number(otherRead!.count)).toBe(0);
  });

  it("notifies operators when a public record is revoked", async () => {
    const publicKey = `NOTIF-${randomUUID().slice(0, 8)}`;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: fx.projectA,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["Legal title verification is outside this review's scope"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    await fx.sql`
      UPDATE core.registry_entry_versions
      SET status = 'revoked', revoked_at = now()
      WHERE id = ${published.json().id}
    `;

    const items = (await list(operatorToken)).json().items as { summary: string }[];
    // A revoke takes down something public; a late notice lets citations continue meanwhile.
    expect(items.some((item) => item.summary.includes(publicKey))).toBe(true);
  });

  it("another tenant's notifications are not visible", async () => {
    const operatorB = await signIn(app, fx.operatorB);
    const mine = (await list(operatorToken)).json().items as { id: string }[];
    const theirs = (await list(operatorB)).json().items as { id: string }[];

    const mineIds = new Set(mine.map((item) => item.id));
    for (const item of theirs) {
      expect(mineIds.has(item.id)).toBe(false);
    }
  });

  it("does not mark a nonexistent notification as read", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/notifications/00000000-0000-4000-8000-000000000000/read",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
    });

    expect(response.statusCode).toBe(404);
  });
});
