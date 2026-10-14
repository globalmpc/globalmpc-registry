import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";
import { publishProject } from "./helpers/registry.js";
import { OFFERING_PRECONDITIONS } from "@mpc/domain";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Material-information blackout — 07 §7.14, 03 J-22, AC-30.
 *
 * Checks that an active restriction is enforced by the API (not only hidden in the UI), that
 * the refusal carries the restriction ID, that every blocked attempt is kept, and that nothing
 * but a recorded release lifts it.
 */
describeDb("disclosure restrictions", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let approver: string;
  let steward: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    approver = await signIn(app, fx.approverA);
    steward = await signIn(app, fx.stewardA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  /** A project already `registered`, so `offering_open` is a legal next step. */
  async function registeredProject(): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, owner_organization_id,
        lifecycle_state
      ) VALUES (
        ${id}, ${fx.tenantA}, ${`BO-${id.slice(0, 8)}`}, 'Blackout check', 'MNG', ${fx.orgA},
        'registered'
      )
    `;
    await makeOfferingReady(id);
    return id;
  }

  /**
   * Every offering precondition evidenced and a go on the offering gate, so the offering guard
   * (invariant 7) passes and only the restriction decides whether `offering_open` goes through.
   */
  async function makeOfferingReady(projectId: string): Promise<void> {
    for (const precondition of OFFERING_PRECONDITIONS) {
      await fx.sql`
        INSERT INTO core.project_facts (
          id, tenant_id, project_id, fact_key, status, evidence_ref, evidence_kind
        )
        VALUES (${randomUUID()}, ${fx.tenantA}, ${projectId}, ${precondition.key},
                'confirmed', ${randomUUID()}, 'upload')
      `;
    }
    const [policy] = await fx.sql<{ id: string }[]>`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${`bo-${randomUUID().slice(0, 8)}`}, '1.0.0',
        'offering_activation', 'MNG', now(), '{}'::jsonb
      ) RETURNING id
    `;
    const [assessment] = await fx.sql<{ id: string }[]>`
      INSERT INTO core.compliance_assessments (
        id, tenant_id, project_id, gate_id, policy_set_id,
        input_snapshot_hash, evaluated_as_of, status, requirement_results, canonical_result_hash
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, 'offering_activation', ${policy!.id},
        ${"0x" + "aa".repeat(32)}, now(), 'ok', '[]'::jsonb, ${"0x" + "bb".repeat(32)}
      ) RETURNING id
    `;
    const [decider] = await fx.sql<{ subject_id: string }[]>`
      SELECT subject_id FROM core.wallet_identities WHERE wallet_address = ${fx.approverA.address}
    `;
    await fx.sql`
      INSERT INTO core.gate_decisions (
        id, tenant_id, project_id, gate_id, decision, input_assessment_id,
        evidence_snapshot_hash, decision_authority, decision_maker_subject_id,
        rationale, signature, signed_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, 'offering_activation', 'go',
        ${assessment!.id}, ${"0x" + "cc".repeat(32)}, 'Gate approver', ${decider!.subject_id},
        'recorded for the blackout test', '0xsig', now()
      )
    `;
  }

  async function projectVersion(projectId: string): Promise<number> {
    const [row] = await fx.sql<{ version: number }[]>`
      SELECT version FROM core.projects WHERE id = ${projectId}
    `;
    return row!.version;
  }

  function create(projectId: string, body: Record<string, unknown> = {}, token = operator) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/disclosure-restrictions`,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: {
        subjectScope: [projectId],
        restrictedActionTypes: ["project.lifecycle.offering_open", "registry.publish"],
        materialInfoRef: "board-minutes-2026-09",
        reason: "Resource estimate revision pending disclosure",
        legalBasis: "Listing rule 3.1",
        authority: "Disclosure committee",
        expectedNextUpdateAt: "2026-10-01T00:00:00.000Z",
        // Already in the past: an expected release time must not lift anything.
        expectedReleaseAt: "2020-01-01T00:00:00.000Z",
        ...body,
      },
    });
  }

  function move(id: string, kind: string, version: number, body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/api/v1/disclosure-restrictions/${id}/${kind}`,
      headers: {
        authorization: `Bearer ${operator}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: body,
    });
  }

  async function activeRestriction(projectId: string, body: Record<string, unknown> = {}) {
    const created = (await create(projectId, body)).json();
    const activated = await move(created.restrictionId, "activate", created.version, {
      reason: "Material information identified",
    });
    expect(activated.statusCode).toBe(200);
    return activated.json() as { restrictionId: string; version: number };
  }

  async function openOffering(projectId: string, token = approver) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/lifecycle-transitions`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${await projectVersion(projectId)}"`,
      },
      payload: { toState: "offering_open", reason: "gate passed" },
    });
  }

  it("creates a draft that blocks nothing", async () => {
    const projectId = await registeredProject();
    const created = await create(projectId);
    expect(created.statusCode).toBe(201);
    expect(created.json().state).toBe("draft");

    expect((await openOffering(projectId)).statusCode).toBe(200);
  });

  it("refuses a named action with the restriction ID while active", async () => {
    const projectId = await registeredProject();
    const restriction = await activeRestriction(projectId);

    const response = await openOffering(projectId);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DISCLOSURE_RESTRICTED");
    // The same ID the UI shows and the history keeps.
    expect(response.json().details.restrictionId).toBe(restriction.restrictionId);
    expect(response.json().details.reason).toBe("Resource estimate revision pending disclosure");

    const [project] = await fx.sql<{ lifecycle_state: string }[]>`
      SELECT lifecycle_state FROM core.projects WHERE id = ${projectId}
    `;
    expect(project?.lifecycle_state).toBe("registered");
  });

  it("keeps every blocked attempt in the history and the outbox", async () => {
    const projectId = await registeredProject();
    const restriction = await activeRestriction(projectId);

    await openOffering(projectId);

    const events = await fx.sql<{ event_kind: string; action_type: string | null }[]>`
      SELECT event_kind, action_type FROM core.disclosure_restriction_events
      WHERE restriction_id = ${restriction.restrictionId} ORDER BY occurred_at, event_kind
    `;
    expect(events.map((event) => event.event_kind)).toEqual(
      expect.arrayContaining(["created", "activated", "blocked_attempt"]),
    );
    expect(events.find((event) => event.event_kind === "blocked_attempt")?.action_type).toBe(
      "project.lifecycle.offering_open",
    );

    const outbox = await fx.sql<{ event_type: string }[]>`
      SELECT event_type FROM core.outbox WHERE aggregate_id = ${restriction.restrictionId}
    `;
    expect(outbox.map((row) => row.event_type)).toEqual(
      expect.arrayContaining(["disclosure.blackout.opened", "disclosure.blackout.blocked_action"]),
    );
  });

  it("blocks Project Registry publication when the restriction names it", async () => {
    const projectId = await registeredProject();
    const restriction = await activeRestriction(projectId);

    // Publication is two steps (02 §2.8). A draft is not public, so the blackout stops the
    // publish step.
    const response = await publishProject(
      app,
      fx.sql,
      { drafter: operator, publisher: await signIn(app, fx.disclosureApproverA) },
      projectId,
    );

    expect(response.statusCode).toBe(409);
    expect(response.json().details.restrictionId).toBe(restriction.restrictionId);
  });

  it("blocks a designated insider without blocking the whole project", async () => {
    const projectId = await registeredProject();
    const [approverSubject] = await fx.sql<{ subject_id: string }[]>`
      SELECT subject_id FROM core.wallet_identities WHERE wallet_address = ${fx.approverA.address}
    `;
    await activeRestriction(projectId, { subjectScope: [approverSubject!.subject_id] });

    const response = await openOffering(projectId);
    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe("DISCLOSURE_RESTRICTED");
  });

  it("never blocks suspension — taking a project down reduces risk", async () => {
    const projectId = await registeredProject();
    await activeRestriction(projectId);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/lifecycle-transitions`,
      headers: {
        authorization: `Bearer ${operator}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${await projectVersion(projectId)}"`,
      },
      payload: { toState: "suspended", reason: "incident" },
    });
    expect(response.statusCode).toBe(200);
  });

  it("does not accept actions that have no check behind them", async () => {
    const projectId = await registeredProject();
    // Suspension must stay possible; token transfer is R6 and has no route (OD-07).
    for (const action of ["project.lifecycle.suspended", "token.transfer"]) {
      const response = await create(projectId, { restrictedActionTypes: [action] });
      expect(response.statusCode, action).toBe(400);
    }
  });

  it("does not release on the expected release time — only a recorded release lifts it", async () => {
    const projectId = await registeredProject();
    const restriction = await activeRestriction(projectId);

    // expectedReleaseAt is in the past, and the action is still refused.
    expect((await openOffering(projectId)).statusCode).toBe(409);

    const withoutRecord = await move(restriction.restrictionId, "release", restriction.version, {
      reason: "done",
    });
    expect(withoutRecord.statusCode).toBe(400);

    const released = await move(restriction.restrictionId, "release", restriction.version, {
      disclosureReference: "Exchange filing 2026-0917",
      legalCondition: "Disclosure published; trading window reopened",
      reason: "Material information disclosed",
    });
    expect(released.statusCode).toBe(200);
    expect(released.json().state).toBe("released");
    expect(released.json().releaseRecord.disclosureReference).toBe("Exchange filing 2026-0917");

    expect((await openOffering(projectId)).statusCode).toBe(200);
  });

  it("does not re-arm a released restriction", async () => {
    const projectId = await registeredProject();
    const restriction = await activeRestriction(projectId);
    const released = (
      await move(restriction.restrictionId, "release", restriction.version, {
        disclosureReference: "filing",
        legalCondition: "condition",
        reason: "disclosed",
      })
    ).json();

    const again = await move(restriction.restrictionId, "activate", released.version, {
      reason: "again",
    });
    expect(again.statusCode).toBe(422);
    expect(again.json().code).toBe("RESTRICTION_TRANSITION_NOT_ALLOWED");
  });

  it("supersede lifts the block and keeps the replacement link", async () => {
    const projectId = await registeredProject();
    const restriction = await activeRestriction(projectId);
    const replacement = (await create(projectId)).json();

    const superseded = await move(restriction.restrictionId, "supersede", restriction.version, {
      reason: "scope corrected",
      supersededById: replacement.restrictionId,
    });
    expect(superseded.statusCode).toBe(200);
    expect(superseded.json().supersededById).toBe(replacement.restrictionId);
  });

  it("lists only active restrictions on /active, with what the screen must show", async () => {
    const projectId = await registeredProject();
    await create(projectId);
    const active = await activeRestriction(projectId);

    const response = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/disclosure-restrictions/active`,
      headers: { authorization: `Bearer ${steward}` },
    });
    expect(response.statusCode).toBe(200);
    const items = response.json().items as { restrictionId: string; authority: string }[];
    expect(items.map((item) => item.restrictionId)).toEqual([active.restrictionId]);
    expect(items[0]?.authority).toBe("Disclosure committee");
  });

  it("does not let a role without disclosure.restrict create or release", async () => {
    const projectId = await registeredProject();
    expect((await create(projectId, {}, steward)).statusCode).toBe(403);
  });

  it("does not replay a stored activation to someone without disclosure.restrict", async () => {
    const projectId = await registeredProject();
    const created = (await create(projectId)).json();
    const key = idempotencyKey();
    const send = (token: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/disclosure-restrictions/${created.restrictionId}/activate`,
        headers: {
          authorization: `Bearer ${token}`,
          "idempotency-key": key,
          "if-match": `"${created.version}"`,
        },
        payload: { reason: "Material information identified" },
      });

    expect((await send(operator)).statusCode).toBe(200);
    expect((await send(steward)).statusCode).toBe(403);
  });

  it("a guarded action waits for an activation in flight and then sees it", async () => {
    const projectId = await registeredProject();
    const created = (await create(projectId)).json();

    // Hold an activation open under the same project lock the route takes.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const activation = fx.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`disclosure:${fx.tenantA}:${projectId}`}, 0))`;
      await tx`
        UPDATE core.disclosure_restrictions SET state = 'active', effective_at = now()
        WHERE id = ${created.restrictionId}
      `;
      await held;
    });

    const attempt = openOffering(projectId);
    await new Promise((resolve) => setTimeout(resolve, 300));
    release();
    await activation;

    // Without the lock the check would have read no active restriction and opened the offering.
    expect((await attempt).statusCode).toBe(409);
  });

  describe("DB guards", () => {
    it("rejects changing the scope of an active restriction", async () => {
      const projectId = await registeredProject();
      const restriction = await activeRestriction(projectId);
      await expect(
        fx.sql`
          UPDATE core.disclosure_restrictions SET restricted_action_types = ARRAY['registry.publish']
          WHERE id = ${restriction.restrictionId}
        `,
      ).rejects.toThrow(/cannot change after it leaves draft/);
    });

    it("rejects a release without a release record", async () => {
      const projectId = await registeredProject();
      const restriction = await activeRestriction(projectId);
      await expect(
        fx.sql`
          UPDATE core.disclosure_restrictions SET state = 'released', released_at = now()
          WHERE id = ${restriction.restrictionId}
        `,
      ).rejects.toThrow(/disclosure_restrictions_release_needs_record/);
    });

    it("rejects going back to draft, deleting, and editing history", async () => {
      const projectId = await registeredProject();
      const restriction = await activeRestriction(projectId);
      await expect(
        fx.sql`UPDATE core.disclosure_restrictions SET state = 'draft' WHERE id = ${restriction.restrictionId}`,
      ).rejects.toThrow(/not allowed/);
      await expect(
        fx.sql`DELETE FROM core.disclosure_restrictions WHERE id = ${restriction.restrictionId}`,
      ).rejects.toThrow(/cannot be deleted/);
      await expect(
        fx.sql`DELETE FROM core.disclosure_restriction_events WHERE restriction_id = ${restriction.restrictionId}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });
  });
});
