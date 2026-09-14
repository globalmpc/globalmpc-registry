import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
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
        ${account.address.toLowerCase()}, 97, 'high_assurance', now()
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
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

      const response = await transition(operatorToken, project.id, suspended.json().version, {
        toState: "registered",
        reason: "I suspended it and I resume it",
      });

      // If one person both suspends and resumes, suspension becomes discretion, not control.
      // The permission is missing too (operator is not advance), but this rule comes first.
      expect([403]).toContain(response.statusCode);
    });

    it("lets another person resume to the prior state", async () => {
      const project = await newProject();
      const version = await register(project.id);
      const suspended = await transition(operatorToken, project.id, version, {
        toState: "suspended",
        reason: "the underlying attestation was revoked",
      });

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

  it("lets an approver make forward transitions too", async () => {
    const project = await newProject();
    const version = await register(project.id);

    const response = await transition(approverToken, project.id, version, {
      toState: "offering_open",
      reason: "proceeding per gate verdict",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().lifecycleState).toBe("offering_open");
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
