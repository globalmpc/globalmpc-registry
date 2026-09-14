import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, testEnv, type TestFixture, signIn } from "./helpers/db.js";
import rulesFixture from "../../../packages/policy/test/fixtures/registry-gate.rules.json" with { type: "json" };

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * AC-25 Jurisdiction portability.
 *
 * So far, the only check was "Core does not hard-code Mongolian authority names".
 * That is **proof of absence**; no amount of it shows that a second jurisdiction
 * actually runs.
 *
 * So this stands up a whole synthetic jurisdiction and runs the same path end to end.
 * `ZZZ` is in the ISO 3166-1 user-assigned range, not a real country — using a real
 * jurisdiction as test data leaves that country's authority names in fixtures.
 */
describeDb("second-jurisdiction portability (AC-25)", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operatorToken: string;
  let stewardToken: string;
  let approverToken: string;

  /** Synthetic jurisdiction. Not a real country. */
  const JURISDICTION = "ZZZ";
  let authorityId: string;
  let connectionId: string;
  let policySetId: string;
  let projectId: string;

  /**
   * Response of the synthetic source. The test plays that jurisdiction's authority.
   *
   * No real call goes out, not for speed but because **a synthetic jurisdiction has
   * nothing to call**. That is the premise of this test — if standing up a jurisdiction
   * needs a real authority, portability does not hold.
   */
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ licenseId: "SYNTH-1", status: "valid" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql, {
      fetchImpl,
      resolveHost: async () => ["203.0.113.10"],
    });
    operatorToken = await signIn(app, fx.operatorA);
    stewardToken = await signIn(app, fx.stewardA);
    approverToken = await signIn(app, fx.approverA);

    authorityId = randomUUID();
    connectionId = randomUUID();
    policySetId = randomUUID();

    // Stands up a whole jurisdiction. AC-25 requires it to be done with **data** only,
    // not Core changes.
    await fx.sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        ${authorityId}, ${fx.tenantA}, 'Synthetic Cadastre', ${JURISDICTION},
        ARRAY['Existence of a registered mining right'], ARRAY['Ore body grade', 'Legal validity of issuance'],
        ARRAY['mining_right'], 'authenticated_api', 'public', '2020-01-01', 'accepted'
      )
    `;
    await fx.sql`
      INSERT INTO core.source_connections (
        id, tenant_id, authority_id, connection_key, collection_method,
        access_basis, state, endpoint, authentication_method,
        adapter_version, source_schema_version
      ) VALUES (
        ${connectionId}, ${fx.tenantA}, ${authorityId}, ${`synthetic-${randomUUID().slice(0, 8)}`},
        'authenticated_api', 'For synthetic-jurisdiction tests', 'active',
        -- .test is a reserved TLD and never resolves. Keeps the synthetic address from
        -- being mistaken for a real authority's address.
        'https://cadastre.example.test/mining/licenses', 'none', 'test', 'test'
      )
    `;
    await fx.sql`
      INSERT INTO core.compliance_policy_sets (
        id, tenant_id, rule_set_id, rule_set_version, gate_id,
        jurisdiction_profile, effective_from, definition, state
      ) VALUES (
        ${policySetId}, ${fx.tenantA}, 'registry-publication-gate', '1.0.0',
        'registry_publication', ${JURISDICTION}, now(),
        ${fx.sql.json(rulesFixture as never)}, 'effective'
      )
    `;
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  function post(token: string, url: string, payload: unknown) {
    return app.inject({
      method: "POST",
      url,
      headers: { authorization: `Bearer ${token}`, "idempotency-key": idempotencyKey() },
      payload: payload as never,
    });
  }

  it("creates a project in the synthetic jurisdiction", async () => {
    const response = await post(operatorToken, "/api/v1/projects", {
      projectKey: `ZZZ-${randomUUID().slice(0, 8)}`,
      name: "Synthetic jurisdiction mine",
      hostCountryIso3: JURISDICTION,
      minerals: ["copper"],
      ownerOrganizationId: fx.orgA,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().hostCountryIso3).toBe(JURISDICTION);
    projectId = response.json().id;
  });

  it("returns the synthetic jurisdiction's authority profile as is", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/v1/jurisdictions/${JURISDICTION.toLowerCase()}/profile`,
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.jurisdiction).toBe(JURISDICTION);
    expect(body.authorities.map((item: { name: string }) => item.name)).toContain(
      "Synthetic Cadastre",
    );
    // If Mongolian profile values leak in, it is a copy, not a port.
    expect(JSON.stringify(body)).not.toContain("MNG");
  });

  it("a source lookup in the synthetic jurisdiction creates a receipt", async () => {
    const response = await post(
      stewardToken,
      `/api/v1/source-connections/${connectionId}/collect`,
      { projectId, queryBasis: { licenseId: "SYNTH-LICENSE-1" } },
    );

    expect(response.statusCode).toBe(200);
    // Whatever the result, **a receipt must remain**. A failure is a fact too (05 §5.12).
    expect(response.json().receiptId).toBeTruthy();
    expect(response.json().authorityId).toBe(authorityId);
  });

  it("evaluates readiness with the synthetic jurisdiction's policy set", async () => {
    const response = await post(
      operatorToken,
      `/api/v1/projects/${projectId}/readiness-assessments`,
      { policySetId },
    );

    expect(response.statusCode).toBe(200);
    // Checks that **evaluation works**, not whether it passes. Whether the synthetic
    // project lacks evidence is out of scope here.
    expect(["ok", "gap", "blocked"]).toContain(response.json().status);
    expect(response.json().policySetId).toBe(policySetId);
  });

  it("publishes a synthetic-jurisdiction record to the Registry and reads it publicly", async () => {
    const publicKey = `ZZZ-PUB-${randomUUID().slice(0, 8)}`;
    const published = await post(operatorToken, "/api/v1/registry-entries", {
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
        hostCountry: JURISDICTION,
        limitations: ["Legal title verification is outside this review's scope"],
        legalEffect: "none",
        disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"],
      },
      // The policy version string must not embed the jurisdiction either.
      sourceSnapshotHash: `0x${"33".repeat(32)}`,
      policyVersion: "zzz-core-1.0.0",
      schemaVersion: "project-registry-1",
    });
    expect(published.statusCode).toBe(200);

    const read = await app.inject({
      method: "GET",
      url: `/api/v1/public/registries/project/${publicKey}`,
    });
    expect(read.statusCode).toBe(200);
    expect(read.json().hostCountry).toBe(JURISDICTION);
  });

  it("the synthetic jurisdiction leaves the Mongolian profile untouched", async () => {
    // For portability, the two jurisdictions must not see each other.
    const mongolia = await app.inject({
      method: "GET",
      url: "/api/v1/jurisdictions/mng/profile",
      headers: { authorization: `Bearer ${operatorToken}` },
    });

    expect(mongolia.statusCode).toBe(200);
    expect(
      mongolia.json().authorities.map((item: { name: string }) => item.name),
    ).not.toContain("Synthetic Cadastre");
  });

  it("an approver can decide a gate in the synthetic jurisdiction", async () => {
    const assessment = await post(
      operatorToken,
      `/api/v1/projects/${projectId}/readiness-assessments`,
      { policySetId },
    );
    const response = await post(approverToken, `/api/v1/projects/${projectId}/gate-decisions`, {
      gateId: "registry_publication",
      inputAssessmentId: assessment.json().id,
      // A gap blocks go (AC-03). This checks that deciding works, so it picks
      // a value that fits the result.
      decision: assessment.json().status === "ok" ? "go" : "hold",
      rationale: "synthetic-jurisdiction portability test",
    });

    // Jurisdiction does not change decision rights. Roles do.
    expect(response.statusCode).toBe(200);
  });
});
