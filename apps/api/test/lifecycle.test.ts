import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { OFFERING_PRECONDITIONS } from "@mpc/domain";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Project lifecycle transitions.
 *
 * `lifecycle_state` never moved from `draft`. The state machine and its unit tests
 * existed, but **no route called it.**
 *
 * This file guards three things.
 *
 * 1. Transitions outside the state machine are rejected.
 * 2. Leaving suspension goes **only to the prior state or to closure** — exiting to an
 *    arbitrary state would make suspension a way to launder state.
 * 3. **Whoever suspended cannot resume.**
 * 4. **A reason is not enough** — each move meets its §4.3 guard. An offering cannot open
 *    without every precondition evidenced and a human go (invariant 7, AC-03), and a guard
 *    whose input this system does not record refuses the move.
 */
describeDb("project lifecycle", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let approverToken: string;
  let issuerToken: string;
  let issuerSubjectId: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
    approverToken = await signIn(app, fx.approverA);

    // issuer_officer is not in the fixture. It is the role that advances the lifecycle, so
    // it is created here — possible now that the operator screens exist.
    const subject = (
      await app.inject({
        method: "POST",
        url: "/api/v1/admin/subjects",
        headers: {
          authorization: `Bearer ${operatorToken}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: { displayName: "Issuer Officer" },
      })
    ).json();
    issuerSubjectId = subject.id;

    const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
    const account = privateKeyToAccount(generatePrivateKey());
    await fx.sql`
      INSERT INTO core.wallet_identities (
        id, tenant_id, subject_id, wallet_address, chain_id, assurance_level, bound_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${subject.id},
        ${account.address.toLowerCase()}, 31337, 'high_assurance', now()
      )
    `;
    await fx.sql`
      INSERT INTO core.role_bindings (id, tenant_id, subject_id, organization_id, role)
      VALUES (${randomUUID()}, ${fx.tenantA}, ${subject.id}, ${fx.orgA}, 'issuer_officer')
    `;
    issuerToken = await signIn(app, {
      address: account.address.toLowerCase() as `0x${string}`,
      account,
    });
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function newProject(): Promise<{ id: string; version: number }> {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectKey: `LC-${randomUUID().slice(0, 8)}`,
        name: "Lifecycle check",
        hostCountryIso3: "MNG",
        minerals: [],
        ownerOrganizationId: fx.orgA,
      },
    });
    return { id: created.json().id, version: created.json().version };
  }

  function transition(token: string, projectId: string, version: number, body: unknown) {
    return app.inject({
      method: "POST",
      url: `/api/v1/projects/${projectId}/lifecycle-transitions`,
      headers: {
        authorization: `Bearer ${token}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: body as never,
    });
  }

  /** Registry publication performs draft → registered. This uses the same path. */
  async function register(projectId: string): Promise<number> {
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: projectId,
        publicKey: `LC-${randomUUID().slice(0, 8)}`,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["legal rights verification is outside the scope of this review"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${projectId}/lifecycle`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });
    expect(lifecycle.json().lifecycleState).toBe("registered");
    return lifecycle.json().version;
  }

  /** A readiness assessment recorded now — "new review" after a suspension (§4.3). */
  async function recordAssessment(projectId: string, gateId = "registry_publication") {
    const [policy] = await fx.sql<{ id: string }[]>`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${`lc-${randomUUID().slice(0, 8)}`}, '1.0.0', ${gateId},
        'MNG', now(), '{}'::jsonb
      ) RETURNING id
    `;
    const [assessment] = await fx.sql<{ id: string }[]>`
      INSERT INTO core.compliance_assessments (
        id, tenant_id, project_id, gate_id, policy_set_id,
        input_snapshot_hash, evaluated_as_of, status, requirement_results, canonical_result_hash
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, ${gateId}, ${policy!.id},
        ${"0x" + "aa".repeat(32)}, now(), 'ok', '[]'::jsonb, ${"0x" + "bb".repeat(32)}
      ) RETURNING id
    `;
    return assessment!.id;
  }

  /** Every offering precondition confirmed with evidence — the data R6 would need. */
  async function confirmOfferingPreconditions(projectId: string, except?: string) {
    for (const precondition of OFFERING_PRECONDITIONS.filter((p) => p.key !== except)) {
      await fx.sql`
        INSERT INTO core.project_facts (id, tenant_id, project_id, fact_key, status, evidence_ref)
        VALUES (${randomUUID()}, ${fx.tenantA}, ${projectId}, ${precondition.key},
                'confirmed', ${randomUUID()})
      `;
    }
  }

  async function decideOfferingGate(projectId: string, decision: "go" | "hold") {
    const assessmentId = await recordAssessment(projectId, "offering_activation");
    await fx.sql`
      INSERT INTO core.gate_decisions (
        id, tenant_id, project_id, gate_id, decision, input_assessment_id,
        evidence_snapshot_hash, decision_authority, decision_maker_subject_id,
        rationale, signature, signed_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, 'offering_activation', ${decision},
        ${assessmentId}, ${"0x" + "cc".repeat(32)}, 'Gate approver', ${issuerSubjectId},
        'recorded for the lifecycle guard test', '0xsig', now()
      )
    `;
  }

  function conditionKeys(body: { details: { conditions: { key: string }[] } }): string[] {
    return body.details.conditions.map((condition) => condition.key);
  }

  it("moves draft to registered on publication and records history", async () => {
    const project = await newProject();
    await register(project.id);

    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project.id}/lifecycle`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    // Apart from the audit log, **where this project has been** must be recorded.
    expect(lifecycle.json().transitions).toHaveLength(1);
    expect(lifecycle.json().transitions[0].fromState).toBe("draft");
    expect(lifecycle.json().transitions[0].toState).toBe("registered");
    expect(lifecycle.json().transitions[0].reason).toBeTruthy();
  });

  it("rejects transitions outside the state machine", async () => {
    const project = await newProject();
    const version = await register(project.id);

    // From registered, only offering_open and suspended are reachable.
    const response = await transition(issuerToken, project.id, version, {
      toState: "retired",
      reason: "skip ahead",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("LIFECYCLE_TRANSITION_NOT_ALLOWED");
    expect(response.json().details.allowed).toContain("offering_open");
  });

  it("does not let an operator open an offering alone", async () => {
    const project = await newProject();
    const version = await register(project.id);

    const response = await transition(operatorToken, project.id, version, {
      toState: "offering_open",
      reason: "operator acting directly",
    });

    // Issuance decisions belong to whoever makes issuance decisions.
    expect(response.statusCode).toBe(403);
    expect(response.json().details.requiredRoles).toContain("issuer_officer");
  });

  it("rejects a transition without a reason", async () => {
    const project = await newProject();
    const version = await register(project.id);

    const response = await transition(issuerToken, project.id, version, {
      toState: "offering_open",
      reason: "",
    });

    expect(response.statusCode).toBe(400);
  });

  describe("suspension", () => {
    it("lets an operator suspend alone", async () => {
      const project = await newProject();
      const version = await register(project.id);

      // It is urgent. Requiring two people lets a problem project keep running meanwhile.
      const response = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lifecycleState).toBe("suspended");
      // Remembers the state to resume to (§4.3).
      expect(response.json().priorLifecycleState).toBe("registered");
    });

    it("does not let whoever suspended resume", async () => {
      const project = await newProject();
      const version = await register(project.id);
      // issuer_officer holds both the suspend and the advance permission, so only the
      // separation rule stands between it and resuming its own suspension.
      const suspended = await transition(issuerToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });
      await recordAssessment(project.id);

      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "registered",
        reason: "I suspended it and I resume it",
      });

      // If one person both suspends and resumes, suspension becomes discretion, not control.
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("LIFECYCLE_RESUME_SELF");
    });

    it("refuses a resume by an operator on the permission, before the separation rule", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

      const response = await transition(operatorToken, project.id, suspended.json().version, {
        toState: "registered",
        reason: "I suspended it and I resume it",
      });

      // An operator may suspend but never advance; the role check answers first.
      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe("AUTHORIZATION_DENIED");
    });

    it("lets another person resume to the prior state", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

      // §4.3 suspended→prior: something new must have been reviewed since the suspension.
      await recordAssessment(project.id);

      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "registered",
        reason: "no problem found on re-review",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lifecycleState).toBe("registered");
      // Clears the resume target on exit.
      expect(response.json().priorLifecycleState).toBeNull();
      expect(response.json().transitions).toHaveLength(3);
    });

    it("refuses reinstatement when nothing new was recorded since the suspension", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "registered",
        reason: "looks fine now",
      });

      // Reinstating on the same record that led to suspension undoes the control.
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("LIFECYCLE_GUARD_UNMET");
      expect(conditionKeys(response.json())).toEqual(["review_since_suspension"]);
    });

    it("rejects exiting to anything but the prior state", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

      // Suspended from registered, exiting to active would let suspension launder state.
      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "active",
        reason: "just move forward",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("LIFECYCLE_RESUME_TARGET_INVALID");
    });

    it("always allows exiting to closure", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

      // Closing a suspended project is not laundering (§4.3).
      const response = await transition(issuerToken, project.id, suspended.json().version, {
        toState: "closure",
        reason: "winding down the business",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lifecycleState).toBe("closure");
    });
  });

  it("rejects a transition without If-Match", async () => {
    const project = await newProject();
    await register(project.id);

    const response = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project.id}/lifecycle-transitions`,
      headers: { authorization: `Bearer ${issuerToken}`, "idempotency-key": idempotencyKey() },
      payload: { toState: "offering_open", reason: "without a version" },
    });

    expect(response.statusCode).toBe(428);
  });

  describe("offering guard — invariant 7, AC-03", () => {
    it("refuses to open an offering on a reason alone and lists what is missing", async () => {
      const project = await newProject();
      const version = await register(project.id);

      const response = await transition(approverToken, project.id, version, {
        toState: "offering_open",
        reason: "proceeding per gate verdict",
      });

      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe("LIFECYCLE_GUARD_UNMET");
      const keys = conditionKeys(response.json());
      expect(keys).toContain("legal_issuance_decision");
      expect(keys).toContain("issuer_identified");
      expect(keys).toContain("host_country_spv");
      expect(keys).toContain("ersp_engaged");
      expect(keys).toContain("offering_gate_go_decision");
      // Each condition says why and whose it is — a bare refusal tells nobody what to do.
      for (const condition of response.json().details.conditions) {
        expect(condition.why).toBeTruthy();
      }

      const lifecycle = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/lifecycle`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(lifecycle.json().lifecycleState).toBe("registered");
    });

    it("AC-03: every precondition confirmed is still not go", async () => {
      const project = await newProject();
      const version = await register(project.id);
      await confirmOfferingPreconditions(project.id);

      const response = await transition(issuerToken, project.id, version, {
        toState: "offering_open",
        reason: "all conditions look met",
      });

      expect(response.statusCode).toBe(422);
      expect(conditionKeys(response.json())).toEqual(["offering_gate_go_decision"]);
    });

    it("a hold recorded after a go withdraws it", async () => {
      const project = await newProject();
      const version = await register(project.id);
      await confirmOfferingPreconditions(project.id);
      await decideOfferingGate(project.id, "go");
      await decideOfferingGate(project.id, "hold");

      const response = await transition(issuerToken, project.id, version, {
        toState: "offering_open",
        reason: "we had a go once",
      });

      expect(response.statusCode).toBe(422);
      expect(conditionKeys(response.json())).toEqual(["offering_gate_go_decision"]);
    });

    it("opens only with every precondition evidenced and a human go", async () => {
      // Proves the guard reads data rather than refusing unconditionally — and that the DB
      // trigger's precondition list matches the domain list, or this UPDATE would fail.
      const project = await newProject();
      const version = await register(project.id);
      await confirmOfferingPreconditions(project.id);
      await decideOfferingGate(project.id, "go");

      const response = await transition(issuerToken, project.id, version, {
        toState: "offering_open",
        reason: "legal issuance confirmed and gate decided go",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().lifecycleState).toBe("offering_open");

      // The next row's inputs (Issuer offering status, deadline/cap) are not recorded here.
      const next = await transition(issuerToken, project.id, response.json().version, {
        toState: "offering_closed",
        reason: "closing",
      });
      expect(next.statusCode).toBe(422);
      expect(next.json().code).toBe("LIFECYCLE_GUARD_UNMET");
      expect(
        next.json().details.conditions.every(
          (condition: { status: string }) => condition.status === "not_evaluable",
        ),
      ).toBe(true);
    });

    // The trigger keeps its own copy of the precondition keys. Leaving out any one key the
    // domain lists must still be refused, or the two lists have drifted apart.
    it.each(OFFERING_PRECONDITIONS.map((p) => p.key))(
      "the database refuses an offering state while %s is unconfirmed",
      async (missingKey) => {
        const project = await newProject();
        await register(project.id);
        await confirmOfferingPreconditions(project.id, missingKey);
        await decideOfferingGate(project.id, "go");

        await expect(
          fx.sql`UPDATE core.projects SET lifecycle_state = 'offering_open' WHERE id = ${project.id}`,
        ).rejects.toThrow(/offering precondition/);
      },
    );

    it("the database refuses an offering state written around the route", async () => {
      const project = await newProject();
      await register(project.id);

      // A migration script or ops console does not go through the route (0003 rationale).
      await expect(
        fx.sql`UPDATE core.projects SET lifecycle_state = 'offering_open' WHERE id = ${project.id}`,
      ).rejects.toThrow(/offering precondition/);
      await expect(
        fx.sql`UPDATE core.projects SET lifecycle_state = 'active' WHERE id = ${project.id}`,
      ).rejects.toThrow(/offering precondition/);

      // Preconditions alone are not enough at the DB either.
      await confirmOfferingPreconditions(project.id);
      await expect(
        fx.sql`UPDATE core.projects SET lifecycle_state = 'offering_open' WHERE id = ${project.id}`,
      ).rejects.toThrow(/go decision/);
    });

    it("AC-08: a reference project with pending rights, Issuer, and SPV keeps its Registry workflow", async () => {
      const project = await newProject();
      for (const key of ["issuer_identified", "host_country_spv", "legal_issuance_decision"]) {
        await fx.sql`
          INSERT INTO core.project_facts (id, tenant_id, project_id, fact_key, status)
          VALUES (${randomUUID()}, ${fx.tenantA}, ${project.id}, ${key}, 'pending')
        `;
      }
      // Registry publication works with the offering conditions pending.
      const version = await register(project.id);

      const refused = await transition(issuerToken, project.id, version, {
        toState: "offering_open",
        reason: "reference project",
      });
      expect(refused.statusCode).toBe(422);
      // Pending is not confirmed (invariant 10: reference status confirms nothing).
      expect(conditionKeys(refused.json())).toEqual(
        expect.arrayContaining(["issuer_identified", "host_country_spv", "legal_issuance_decision"]),
      );

      // The refusal leaves the Registry side untouched: the offering gate still answers, and the
      // project can still be suspended and wound down through the normal controls.
      const gate = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${project.id}/offering-gate`,
        headers: { authorization: `Bearer ${operatorToken}` },
      });
      expect(gate.statusCode).toBe(200);
      expect(gate.json().activatable).toBe(false);

      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "source record under review",
      });
      expect(suspended.statusCode).toBe(200);
    });
  });

  it("does not register a draft through the lifecycle route", async () => {
    const project = await newProject();

    const response = await transition(issuerToken, project.id, project.version, {
      toState: "registered",
      reason: "skip the Registry",
    });

    // Publication checks the minimum fields and the responsible party; a reason checks neither.
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe("LIFECYCLE_REGISTER_VIA_PUBLICATION");
  });
});

describeDb("lifecycle in the public projection", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  it("carries the post-publication state, not the pre-publication state", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectKey: `W39-${randomUUID().slice(0, 8)}`,
        name: "Projection status",
        hostCountryIso3: "MNG",
        minerals: [],
        ownerOrganizationId: fx.orgA,
      },
    });
    const projectId = created.json().id;
    const publicKey = `W39-${randomUUID().slice(0, 8)}`;

    // The screen sends the state **just before** publication. That is `draft`.
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: projectId,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "draft",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["legal rights verification is outside the scope of this review"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    // In 11 §11.4, `registered` means "a Registry record exists", and this very request
    // creates that record. The moment it is stored, it is no longer draft.
    const read = await app.inject({
      method: "GET",
      url: `/api/v1/public/registries/project/${publicKey}`,
    });
    expect(read.statusCode).toBe(200);
    // The top-level `status` in the response is the version's publication state; the one
    // inside the projection is the lifecycle.
    const [stored] = await fx.sql<{ public_projection: { status: string } }[]>`
      SELECT public_projection FROM core.registry_entry_versions
      WHERE id = ${published.json().id}
    `;
    expect(stored!.public_projection.status).toBe("registered");
  });

  it("does not advance a non-draft state on publication", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        projectKey: `W39B-${randomUUID().slice(0, 8)}`,
        name: "Already suspended",
        hostCountryIso3: "MNG",
        minerals: [],
        ownerOrganizationId: fx.orgA,
      },
    });
    const projectId = created.json().id;
    await fx.sql`
      UPDATE core.projects
      SET lifecycle_state = 'suspended', prior_lifecycle_state = 'registered'
      WHERE id = ${projectId}
    `;

    const publicKey = `W39B-${randomUUID().slice(0, 8)}`;
    const published = await app.inject({
      method: "POST",
      url: "/api/v1/registry-entries",
      headers: { authorization: `Bearer ${operatorToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        registryType: "project",
        subjectId: projectId,
        publicKey,
        projection: {
          stableId: randomUUID(),
          status: "registered",
          version: "1",
          asOf: "2026-08-01T00:00:00.000Z",
          sourceAge: "12",
          staleStatus: "fresh",
          limitations: ["legal rights verification is outside the scope of this review"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    // Reverting suspended via publication would resume without incident closure.
    const [stored] = await fx.sql<{ public_projection: { status: string } }[]>`
      SELECT public_projection FROM core.registry_entry_versions
      WHERE id = ${published.json().id}
    `;
    expect(stored!.public_projection.status).toBe("suspended");
  });
});
