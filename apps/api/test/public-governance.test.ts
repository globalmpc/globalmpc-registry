import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { PUBLIC_FIELD_ALLOWLIST } from "@mpc/domain";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Unauthenticated public governance and public history.
 *
 * What is verified is not "a list comes back" but **only what was chosen for disclosure goes
 * out**. If project space, `draft`, or the voter list leaks, these two endpoints have no
 * public boundary.
 */
describeDb("public governance and public history", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let proposerToken: string;
  let voterToken: string;
  let operatorToken: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    proposerToken = await signIn(app, fx.proposerA);
    voterToken = await signIn(app, fx.voterA);
    operatorToken = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function propose(body: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${proposerToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        space: "protocol",
        proposalType: "attestation_schema_approval",
        title: "Schema change",
        rationale: "The current schema cannot express limitations",
        eligibleWeight: "100",
        ...body,
      },
    });
  }

  function transition(id: string, version: number, toState: string) {
    return app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${id}/transitions`,
      headers: {
        authorization: `Bearer ${proposerToken}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${version}"`,
      },
      payload: { toState, reason: "next stage" },
    });
  }

  async function openVoting(body: Record<string, unknown> = {}) {
    const created = (await propose(body)).json();
    let version = created.version;
    for (const state of ["review", "announced", "voting"]) {
      version = (await transition(created.id, version, state)).json().version;
    }
    return { id: created.id as string, version: version as number };
  }

  function publicProposals() {
    return app.inject({ method: "GET", url: "/api/v1/public/governance/proposals?limit=100" });
  }

  it("does not disclose draft proposals", async () => {
    const draft = (await propose({ title: `DRAFT-${randomUUID().slice(0, 8)}` })).json();

    const listed = (await publicProposals()).json();
    expect(listed.items.map((item: { id: string }) => item.id)).not.toContain(draft.id);
  });

  it("shows non-draft protocol proposals without login", async () => {
    const opened = await openVoting({ title: `OPEN-${randomUUID().slice(0, 8)}` });

    const response = await publicProposals();
    expect(response.statusCode).toBe(200);
    expect(response.json().items.map((item: { id: string }) => item.id)).toContain(opened.id);
  });

  it("does not disclose project space proposals", async () => {
    // Counterpart to protocol governance not deciding a specific project's disposition —
    // internal project decisions stay off the public list.
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/governance/proposals",
      headers: { authorization: `Bearer ${proposerToken}`, "idempotency-key": idempotencyKey() },
      payload: {
        space: "project",
        projectId: fx.projectA,
        proposalType: "project_data_room_publication",
        title: `PROJECT-${randomUUID().slice(0, 8)}`,
        rationale: "Internal project decision",
        eligibleWeight: "100",
      },
    });

    // Created or rejected, the public list must contain no project space proposal.
    const listed = (await publicProposals()).json();
    if (created.statusCode === 200 || created.statusCode === 201) {
      expect(listed.items.map((item: { id: string }) => item.id)).not.toContain(
        created.json().id,
      );
    }
    for (const item of listed.items) {
      expect(item).not.toHaveProperty("projectId");
      expect(item).not.toHaveProperty("space");
    }
  });

  it("returns tallies but not voters", async () => {
    const opened = await openVoting({ title: `TALLY-${randomUUID().slice(0, 8)}` });
    await app.inject({
      method: "POST",
      url: `/api/v1/governance/proposals/${opened.id}/votes`,
      headers: { authorization: `Bearer ${voterToken}`, "idempotency-key": idempotencyKey() },
      payload: { choice: "for", weight: "30" },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/public/governance/proposals/${opened.id}`,
    });

    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.tally.for).toBe("30");
    expect(body.tally.voterCount).toBe(1);
    // Individual voters are subjects and link to natural-person identifiers (AC-32).
    expect(JSON.stringify(body)).not.toContain(fx.voterA.address);
    expect(body).not.toHaveProperty("votes");
    expect(body).not.toHaveProperty("proposerSubjectId");
  });

  it("does not return weight as a JSON number", async () => {
    // NUMERIC(78,0) does not fit in a number; it would be silently rounded (ADR-T07).
    const listed = (await publicProposals()).json();
    for (const item of listed.items) {
      expect(typeof item.tally.for).toBe("string");
      expect(typeof item.tally.against).toBe("string");
    }
  });

  it("does not expose the tenant", async () => {
    const listed = await publicProposals();

    expect(listed.body).not.toContain(fx.tenantA);
  });

  it("returns 404 for a missing proposal", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/governance/proposals/00000000-0000-4000-8000-000000000000",
    });

    expect(response.statusCode).toBe(404);
  });

  it("states the event kinds public history does not cover", async () => {
    // Without separating an empty list from "that kind never comes here", users read it as
    // "it never happened".
    //
    // After the 2026-09-09 decision only credential revocation remains — its "record" is a
    // person, so it cannot be expressed as "happened + when + which record".
    const response = await app.inject({ method: "GET", url: "/api/v1/public/disclosures" });

    expect(response.statusCode).toBe(200);
    const kinds = response.json().notCovered.map((entry: { kind: string }) => entry.kind);
    expect(kinds).toEqual(["credential_revocation"]);
    for (const entry of response.json().notCovered) {
      expect(entry.reason.length).toBeGreaterThan(0);
    }
  });

  it("now covers suspension, pause, and dispute", async () => {
    // Three of four left `notCovered`. The cases below check that they actually appear —
    // this one only checks that **the scope declaration has not diverged**.
    const response = await app.inject({ method: "GET", url: "/api/v1/public/disclosures" });
    const kinds = response.json().notCovered.map((entry: { kind: string }) => entry.kind);

    for (const covered of ["suspension", "pause", "dispute"]) {
      expect(kinds).not.toContain(covered);
    }
  });

  it("lists a revoked public version in history and honors the allowlist", async () => {
    const publicKey = `DISC-${randomUUID().slice(0, 8)}`;
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
          limitations: ["Legal rights verification is outside this review's scope"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(published.statusCode).toBe(200);

    // Revocation has no in-repo route yet. This checks not whether the event is created but
    // **whether it respects the public boundary once created**.
    await fx.sql`
      UPDATE core.registry_entry_versions
      SET status = 'revoked', revoked_at = now()
      WHERE id = ${published.json().id}
    `;

    const events = (await app.inject({ method: "GET", url: "/api/v1/public/disclosures?limit=100" })).json();
    const mine = events.items.find(
      (event: { publicKey: string }) => event.publicKey === publicKey,
    );

    expect(mine).toBeDefined();
    expect(mine.eventKind).toBe("revocation");
    const leaked = Object.keys(mine.registryVersion.projection).filter(
      (field) => !(PUBLIC_FIELD_ALLOWLIST as readonly string[]).includes(field),
    );
    expect(leaked).toEqual([]);

    // Only events from a registry version carry this bundle.
    expect(mine.lifecycle).toBeNull();
    expect(mine.resolvedAt).toBeNull();
  });

  // --- Decision: "happened + when + which record" ---------------------

  /**
   * Creates a project and attaches a public registry entry.
   *
   * **Created fresh every time.** With `fx.projectA`, one case making it public breaks another
   * case's "undisclosed project" premise — a test whose result depends on execution order
   * guarantees nothing even when it passes.
   */
  async function newProject(): Promise<string> {
    const projectId = randomUUID();
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${projectId}, ${fx.tenantA}, ${`Q17-${projectId.slice(0, 8)}`}, 'disclosure fixture',
        'MNG', ARRAY['copper'], ${fx.orgA}
      )
    `;
    return projectId;
  }

  async function publishPublic(projectId: string): Promise<string> {
    const publicKey = `Q17-${randomUUID().slice(0, 8)}`;
    const response = await app.inject({
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
          limitations: ["Legal rights verification is outside this review's scope"],
          legalEffect: "none",
          disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
        },
        sourceSnapshotHash: `0x${"11".repeat(32)}`,
        policyVersion: "mn-core-1.0.0",
        schemaVersion: "project-registry-1",
      },
    });
    expect(response.statusCode).toBe(200);
    return publicKey;
  }

  /** Shape of one response item. `publicDisclosureEvent` owns the contract; only read fields here. */
  interface DisclosureEvent {
    readonly eventId: string;
    readonly eventKind: string;
    readonly publicKey: string;
    readonly registryVersion: { readonly projection: Record<string, unknown> } | null;
    readonly lifecycle: { readonly fromState: string; readonly toState: string } | null;
    readonly resolvedAt: string | null;
  }

  async function disclosures(): Promise<{ items: DisclosureEvent[] }> {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/public/disclosures?limit=100",
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  }

  const SECRET_REASON = "suspension reason is not disclosed SUSPEND_SECRET";

  it("returns a suspension without its reason or actor", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    await fx.sql`
      INSERT INTO core.project_lifecycle_transitions (
        tenant_id, project_id, from_state, to_state, reason, actor_subject_id
      ) VALUES (
        ${fx.tenantA}, ${projectId}, 'registered', 'suspended', ${SECRET_REASON},
        ${fx.reviewerSubjectA}
      )
    `;

    const body = await disclosures();
    const mine = body.items.find(
      (event) => event.publicKey === publicKey && event.eventKind === "suspension",
    );

    expect(mine).toBeDefined();
    expect(mine?.lifecycle).toEqual({ fromState: "registered", toState: "suspended" });
    expect(mine?.registryVersion).toBeNull();

    // The **entire** response must lack the reason and actor id. Checking one field misses
    // leaks elsewhere.
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SECRET_REASON);
    expect(serialized).not.toContain(fx.reviewerSubjectA);
  });

  it("does not return suspensions of undisclosed projects", async () => {
    // Otherwise **the very existence of an undisclosed project** is revealed.
    const projectId = await newProject();

    await fx.sql`
      INSERT INTO core.project_lifecycle_transitions (
        tenant_id, project_id, from_state, to_state, reason
      ) VALUES (${fx.tenantA}, ${projectId}, 'registered', 'suspended', 'undisclosed')
    `;

    const body = await disclosures();
    expect(JSON.stringify(body)).not.toContain(projectId);
  });

  it("returns a pause without its legal basis or requesting authority", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    await fx.sql`
      INSERT INTO core.disclosure_restrictions (
        id, tenant_id, project_id, subject_scope, restricted_action_types,
        legal_basis, authority, state, effective_at
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, ARRAY[]::UUID[], ARRAY['publish'],
        'LEGAL_BASIS_SECRET', 'AUTHORITY_SECRET', 'active', now()
      )
    `;

    const body = await disclosures();
    const mine = body.items.find(
      (event) => event.publicKey === publicKey && event.eventKind === "pause",
    );

    expect(mine).toBeDefined();
    // Not yet lifted.
    expect(mine?.resolvedAt).toBeNull();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("LEGAL_BASIS_SECRET");
    expect(serialized).not.toContain("AUTHORITY_SECRET");
  });

  it("does not return a pause before it takes effect (draft)", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    await fx.sql`
      INSERT INTO core.disclosure_restrictions (
        id, tenant_id, project_id, subject_scope, restricted_action_types,
        legal_basis, authority, state
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${projectId}, ARRAY[]::UUID[], ARRAY['publish'],
        'draft basis', 'draft authority', 'draft'
      )
    `;

    const body = await disclosures();
    const paused = body.items.filter(
      (event) => event.publicKey === publicKey && event.eventKind === "pause",
    );
    expect(paused).toEqual([]);
  });

  it("returns a dispute without its reason or raiser", async () => {
    const projectId = await newProject();
    const publicKey = await publishPublic(projectId);

    const caseId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_cases (id, tenant_id, project_id, schema_id, state)
      VALUES (${caseId}, ${fx.tenantA}, ${projectId}, ${fx.schemaA}, 'draft')
    `;

    const assignmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.assignments (id, tenant_id, case_id, subject_id, credential_id)
      VALUES (${assignmentId}, ${fx.tenantA}, ${caseId}, ${fx.reviewerSubjectA}, ${fx.credentialA})
    `;

    const attestationId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_attestations (
        id, tenant_id, case_id, assignment_id, credential_id, schema_id,
        attestation_type, claim_scope, evidence_snapshot_hash, findings, limitations,
        credential_status_snapshot, method_version, policy_version,
        payload_hash, signature, signer_wallet_address, signed_at, state
      ) VALUES (
        ${attestationId}, ${fx.tenantA}, ${caseId}, ${assignmentId}, ${fx.credentialA},
        ${fx.schemaA}, 'professional_signoff', ARRAY[]::UUID[], ${`0x${"22".repeat(32)}`},
        '{}'::jsonb, 'legal_effect_not_determined', '{}'::jsonb, '1', '1',
        ${`0x${"33".repeat(32)}`}, ${`0x${"44".repeat(65)}`},
        ${fx.reviewerA.address.toLowerCase()}, now(), 'signed'
      )
    `;

    await fx.sql`
      INSERT INTO core.attestation_disputes (
        id, tenant_id, attestation_id, reason_code, detail, raised_by_subject_id
      ) VALUES (
        ${randomUUID()}, ${fx.tenantA}, ${attestationId}, 'REASON_CODE_SECRET',
        'DETAIL_SECRET', ${fx.reviewerSubjectA}
      )
    `;

    const body = await disclosures();
    const mine = body.items.find(
      (event) => event.publicKey === publicKey && event.eventKind === "dispute",
    );

    expect(mine).toBeDefined();

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("REASON_CODE_SECRET");
    expect(serialized).not.toContain("DETAIL_SECRET");
    // The attestation id is not returned either — "which record" is the public project entry.
    expect(serialized).not.toContain(attestationId);
  });
});
