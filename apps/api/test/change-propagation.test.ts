import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { evidenceStaleSignal } from "@mpc/api-contract";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Change propagation beyond sources — spec 04 invariant 18, 05 §5.5, AC-04 · AC-12 · AC-17 · AC-21.
 *
 * `stale-propagation.test.ts` holds the source chain. This file holds the other three origins
 * AC-21 names (credential, Attestation Schema, Policy version) and the last two steps of 05 §5.5
 * (a suspension proposal, and a notification to the Issuer).
 *
 * Every test builds its own project, credential, and schema: propagation reaches across a whole
 * tenant, and a shared fixture row would let one test's change show up in another's assertion.
 */
describeDb("change propagation", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;
  let auditor: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
    auditor = await signIn(app, fx.auditorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  async function newProject(lifecycle = "registered"): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id,
        lifecycle_state
      ) VALUES (
        ${id}, ${fx.tenantA}, ${`CP-${id.slice(0, 8)}`}, 'Propagation project', 'MNG',
        ARRAY['copper'], ${fx.orgA}, ${lifecycle}::core.at_lifecycle_state
      )
    `;
    return id;
  }

  async function newCredential(): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.credentials (
        id, tenant_id, subject_id, organization_id, issuer_reference,
        credential_type, issued_at, expires_at, current_status
      ) VALUES (
        ${id}, ${fx.tenantA}, ${fx.reviewerSubjectA}, ${fx.orgA}, 'AusIMM',
        'competent_person', now() - interval '1 year', now() + interval '1 year', 'valid'
      )
    `;
    return id;
  }

  async function newSchema(key: string, version: string, state = "active"): Promise<string> {
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.attestation_schemas (
        id, tenant_id, schema_key, schema_version, attestation_type, jurisdiction_profile, state
      ) VALUES (
        ${id}, ${fx.tenantA}, ${key}, ${version}, 'professional_signoff', 'MNG', ${state}
      )
    `;
    return id;
  }

  async function seedAttestation(opts: {
    project: string;
    credential?: string;
    schema?: string;
    state?: string;
    claims?: string[];
  }): Promise<string> {
    const credential = opts.credential ?? (await newCredential());
    const schema = opts.schema ?? (await newSchema(`k-${randomUUID().slice(0, 8)}`, "1"));
    const caseId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_cases (id, tenant_id, project_id, schema_id, state)
      VALUES (${caseId}, ${fx.tenantA}, ${opts.project}, ${schema}, 'draft')
    `;
    const assignmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.assignments (id, tenant_id, case_id, subject_id, credential_id)
      VALUES (${assignmentId}, ${fx.tenantA}, ${caseId}, ${fx.reviewerSubjectA}, ${credential})
    `;
    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_attestations (
        id, tenant_id, case_id, assignment_id, credential_id, schema_id,
        attestation_type, claim_scope, evidence_snapshot_hash, findings, limitations,
        credential_status_snapshot, method_version, policy_version,
        payload_hash, signature, signer_wallet_address, signed_at, state
      ) VALUES (
        ${id}, ${fx.tenantA}, ${caseId}, ${assignmentId}, ${credential}, ${schema},
        'professional_signoff', ${opts.claims ?? [randomUUID()]}::UUID[],
        ${`0x${"22".repeat(32)}`}, '{"note":"reviewed"}'::jsonb, 'legal_effect_not_determined',
        '{"currentStatus":"valid","validAtAttestationTime":true}'::jsonb, '1', '1',
        ${`0x${"33".repeat(32)}`}, ${`0x${"44".repeat(65)}`},
        ${fx.reviewerA.address.toLowerCase()}, now(), ${opts.state ?? "active"}
      )
    `;
    return id;
  }

  async function attestation(id: string) {
    const [row] = await fx.sql<
      { state: string; stale_reason: string | null; credential_status_snapshot: unknown }[]
    >`
      SELECT state, stale_reason, credential_status_snapshot
      FROM core.verification_attestations WHERE id = ${id}
    `;
    return row!;
  }

  async function signalsFor(project: string) {
    return fx.sql<
      {
        target_type: string;
        target_id: string;
        origin_attestation_id: string | null;
        origin_policy_set_id: string | null;
        reason: string;
        resolution: string;
      }[]
    >`
      SELECT target_type::text, target_id, origin_attestation_id, origin_policy_set_id, reason,
             resolution::text
      FROM core.evidence_stale_signals
      WHERE project_id = ${project}
      ORDER BY detected_at
    `;
  }

  describe("credential → attestation (AC-12 · AC-17)", () => {
    it("moves an active attestation to re-review when its credential is revoked", async () => {
      const project = await newProject();
      const credential = await newCredential();
      const id = await seedAttestation({ project, credential });

      await fx.sql`
        UPDATE core.credentials SET current_status = 'revoked', revoked_at = now()
        WHERE id = ${credential}
      `;

      const row = await attestation(id);
      expect(row.state).toBe("stale_candidate");
      expect(row.stale_reason).toContain("Signing credential is now revoked");
    });

    it("keeps the status at signing unchanged", async () => {
      const project = await newProject();
      const credential = await newCredential();
      const id = await seedAttestation({ project, credential });
      const before = (await attestation(id)).credential_status_snapshot;

      await fx.sql`UPDATE core.credentials SET current_status = 'expired' WHERE id = ${credential}`;

      // The signature happened while the credential was valid. That stays true.
      expect((await attestation(id)).credential_status_snapshot).toEqual(before);
    });

    it("treats suspension like expiry", async () => {
      const project = await newProject();
      const credential = await newCredential();
      const id = await seedAttestation({ project, credential });

      await fx.sql`UPDATE core.credentials SET current_status = 'suspended' WHERE id = ${credential}`;

      expect((await attestation(id)).state).toBe("stale_candidate");
    });

    it("leaves finished attestations untouched", async () => {
      const project = await newProject();
      const credential = await newCredential();
      const revoked = await seedAttestation({ project, credential, state: "revoked" });
      const superseded = await seedAttestation({ project, credential, state: "superseded" });

      await fx.sql`UPDATE core.credentials SET current_status = 'revoked' WHERE id = ${credential}`;

      expect((await attestation(revoked)).state).toBe("revoked");
      expect((await attestation(superseded)).state).toBe("superseded");
    });

    it("reaches the public version through the existing signal chain", async () => {
      const project = await newProject();
      const credential = await newCredential();
      const id = await seedAttestation({ project, credential });
      const entry = randomUUID();
      await fx.sql`
        INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
        VALUES (${entry}, ${fx.tenantA}, 'project', ${project}, ${`PRJ-${entry.slice(0, 8)}`})
      `;
      const version = randomUUID();
      await fx.sql`
        INSERT INTO core.registry_entry_versions (
          id, tenant_id, entry_id, version, status, public_projection,
          content_hash, source_snapshot_hash, policy_version, schema_version,
          serialization_version, published_at
        ) VALUES (
          ${version}, ${fx.tenantA}, ${entry}, 1, 'published', '{}'::jsonb,
          ${`0x${"55".repeat(32)}`}, ${`0x${"66".repeat(32)}`}, '1', '1', '1', now()
        )
      `;

      await fx.sql`UPDATE core.credentials SET current_status = 'revoked' WHERE id = ${credential}`;

      const signals = await signalsFor(project);
      const registry = signals.find((s) => s.target_type === "registry_entry_version");
      expect(registry?.target_id).toBe(version);
      expect(registry?.origin_attestation_id).toBe(id);

      // Nothing public is taken down automatically.
      const [row] = await fx.sql<{ status: string }[]>`
        SELECT status::text FROM core.registry_entry_versions WHERE id = ${version}
      `;
      expect(row?.status).toBe("published");
    });

    // The time-based sweep crosses tenants, so it is exercised in the worker's isolated
    // database (apps/worker/test/credential-expiry.test.ts), not in this shared one.
    it("the API role cannot run the cross-tenant sweep", async () => {
      await expect(
        fx.appSql`SELECT core.sweep_credential_expiry(now())`,
      ).rejects.toThrow(/permission denied/);
    });
  });

  describe("Attestation Schema → attestation (AC-21)", () => {
    it("moves attestations to re-review when their schema version is retired", async () => {
      const project = await newProject();
      const schema = await newSchema(`retire-${randomUUID().slice(0, 8)}`, "1");
      const id = await seedAttestation({ project, schema });

      await fx.sql`UPDATE core.attestation_schemas SET state = 'retired' WHERE id = ${schema}`;

      const row = await attestation(id);
      expect(row.state).toBe("stale_candidate");
      expect(row.stale_reason).toContain("was retired");
    });

    it("moves attestations under the old version when a new version becomes active", async () => {
      const project = await newProject();
      const key = `bump-${randomUUID().slice(0, 8)}`;
      const v1 = await newSchema(key, "1");
      const onV1 = await seedAttestation({ project, schema: v1 });
      const v2 = await newSchema(key, "2", "approved");
      const onV2 = await seedAttestation({ project, schema: v2 });

      await fx.sql`UPDATE core.attestation_schemas SET state = 'active' WHERE id = ${v2}`;

      expect((await attestation(onV1)).stale_reason).toContain("new active version 2");
      // The new version's own attestations are current.
      expect((await attestation(onV2)).state).toBe("active");
    });

    it("does not touch attestations of another schema", async () => {
      const project = await newProject();
      const other = await seedAttestation({ project });
      const schema = await newSchema(`solo-${randomUUID().slice(0, 8)}`, "1");

      await fx.sql`UPDATE core.attestation_schemas SET state = 'superseded' WHERE id = ${schema}`;

      expect((await attestation(other)).state).toBe("active");
    });
  });

  describe("Policy version → assessment signal (AC-21)", () => {
    async function newPolicy(ruleSet: string, version: string, state: string): Promise<string> {
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.compliance_policy_sets (
          id, tenant_id, rule_set_id, rule_set_version, gate_id,
          jurisdiction_profile, effective_from, definition, state
        ) VALUES (
          ${id}, ${fx.tenantA}, ${ruleSet}, ${version}, 'registry_publication', 'MNG', now(),
          '{}'::jsonb, ${state}
        )
      `;
      return id;
    }

    async function newAssessment(project: string, policy: string, ageMinutes: number) {
      const id = randomUUID();
      await fx.sql`
        INSERT INTO core.compliance_assessments (
          id, tenant_id, project_id, gate_id, policy_set_id, input_snapshot_hash,
          evaluated_as_of, status, requirement_results, canonical_result_hash, generated_at
        ) VALUES (
          ${id}, ${fx.tenantA}, ${project}, 'registry_publication', ${policy},
          ${`0x${"aa".repeat(32)}`}, now(), 'ok', '[]'::jsonb, ${`0x${"bb".repeat(32)}`},
          now() - make_interval(mins => ${ageMinutes})
        )
      `;
      return id;
    }

    it("signals the latest assessment evaluated under a replaced policy, once", async () => {
      const project = await newProject();
      const ruleSet = `rules-${randomUUID().slice(0, 8)}`;
      const v1 = await newPolicy(ruleSet, "1.0.0", "effective");
      const older = await newAssessment(project, v1, 30);
      const latest = await newAssessment(project, v1, 5);

      // Both ways a version is replaced — the new one takes effect, then the old one is marked.
      const v2 = await newPolicy(ruleSet, "2.0.0", "effective");
      await fx.sql`
        UPDATE core.compliance_policy_sets SET state = 'superseded', superseded_by = ${v2}
        WHERE id = ${v1}
      `;

      const signals = (await signalsFor(project)).filter(
        (s) => s.target_type === "compliance_assessment",
      );
      // Only the latest: the older one is a judgment of its time. One signal, not one per change.
      expect(signals.map((s) => s.target_id)).toEqual([latest]);
      expect(signals[0]?.origin_policy_set_id).toBe(v1);
      expect(signals[0]?.reason).toContain("version 2.0.0 is now effective");
      expect(signals.some((s) => s.target_id === older)).toBe(false);
    });

    it("does not change the assessment", async () => {
      const project = await newProject();
      const ruleSet = `rules-${randomUUID().slice(0, 8)}`;
      const v1 = await newPolicy(ruleSet, "1.0.0", "effective");
      const assessment = await newAssessment(project, v1, 1);

      await fx.sql`UPDATE core.compliance_policy_sets SET state = 'retired' WHERE id = ${v1}`;

      const [row] = await fx.sql<{ status: string; policy_set_id: string }[]>`
        SELECT status::text, policy_set_id FROM core.compliance_assessments WHERE id = ${assessment}
      `;
      expect(row).toEqual({ status: "ok", policy_set_id: v1 });
      expect((await signalsFor(project)).map((s) => s.reason)).toEqual([
        "Assessed under policy " + ruleSet + " version 1.0.0, which was retired",
      ]);
    });

    it("leaves assessments under another rule set alone", async () => {
      const project = await newProject();
      const mine = await newPolicy(`rules-${randomUUID().slice(0, 8)}`, "1.0.0", "effective");
      await newAssessment(project, mine, 1);

      const other = await newPolicy(`rules-${randomUUID().slice(0, 8)}`, "1.0.0", "effective");
      await fx.sql`UPDATE core.compliance_policy_sets SET state = 'superseded' WHERE id = ${other}`;

      expect(await signalsFor(project)).toEqual([]);
    });

    it("keeps the policy origin of a signal fixed", async () => {
      const project = await newProject();
      const ruleSet = `rules-${randomUUID().slice(0, 8)}`;
      const v1 = await newPolicy(ruleSet, "1.0.0", "effective");
      await newAssessment(project, v1, 1);
      await fx.sql`UPDATE core.compliance_policy_sets SET state = 'retired' WHERE id = ${v1}`;
      const other = await newPolicy(ruleSet, "9.0.0", "draft");

      await expect(
        fx.sql`
          UPDATE core.evidence_stale_signals SET origin_policy_set_id = ${other}
          WHERE project_id = ${project}
        `,
      ).rejects.toThrow(/cannot be changed/);
    });
  });

  describe("suspension proposal (05 §5.5 steps 5-6)", () => {
    it("proposes suspension of a registered project and tells the Issuer", async () => {
      const project = await newProject("registered");
      const credential = await newCredential();
      const id = await seedAttestation({ project, credential });

      await fx.sql`UPDATE core.credentials SET current_status = 'revoked' WHERE id = ${credential}`;

      const proposal = (await signalsFor(project)).find((s) => s.target_type === "project_lifecycle");
      expect(proposal?.target_id).toBe(project);
      expect(proposal?.origin_attestation_id).toBe(id);
      expect(proposal?.reason).toContain("Nothing is suspended automatically");

      const notes = await fx.sql<{ audience_role: string; summary: string }[]>`
        SELECT audience_role, summary FROM core.notifications
        WHERE project_id = ${project} AND audience_role = 'issuer_officer'
      `;
      expect(notes).toHaveLength(1);
      expect(notes[0]?.summary).toMatch(/^Suspension to consider/);
    });

    it("never moves the lifecycle", async () => {
      // `registered`, not `active`: the offering guard refuses a project inserted as `active`
      // without its preconditions, and any non-draft state takes a proposal.
      const project = await newProject("registered");
      const credential = await newCredential();
      await seedAttestation({ project, credential });

      await fx.sql`UPDATE core.credentials SET current_status = 'revoked' WHERE id = ${credential}`;

      const [row] = await fx.sql<{ lifecycle_state: string }[]>`
        SELECT lifecycle_state::text FROM core.projects WHERE id = ${project}
      `;
      expect(row?.lifecycle_state).toBe("registered");
    });

    it("keeps one open proposal per project", async () => {
      const project = await newProject();
      const credential = await newCredential();
      await seedAttestation({ project, credential });
      await seedAttestation({ project, credential });

      await fx.sql`UPDATE core.credentials SET current_status = 'revoked' WHERE id = ${credential}`;

      const proposals = (await signalsFor(project)).filter(
        (s) => s.target_type === "project_lifecycle",
      );
      expect(proposals).toHaveLength(1);
    });

    it("proposes nothing for a draft project — there is nothing to suspend", async () => {
      const project = await newProject("draft");
      const credential = await newCredential();
      await seedAttestation({ project, credential });

      await fx.sql`UPDATE core.credentials SET current_status = 'revoked' WHERE id = ${credential}`;

      expect(
        (await signalsFor(project)).filter((s) => s.target_type === "project_lifecycle"),
      ).toEqual([]);
    });
  });

  /**
   * AC-04 end to end, through the API where the API has a path.
   *
   * Revoke a source authority → connection down → claim stale → attestation stale → signals on the
   * assessment and the public version → suspension proposal. The readiness recomputation is the
   * readiness read side's job; here the signal it reads is asserted.
   */
  it("AC-04: revoking evidence reaches a suspension proposal, and a person decides", async () => {
    const project = await newProject("registered");

    const authority = randomUUID();
    await fx.sql`
      INSERT INTO core.authorities (
        id, tenant_id, name, jurisdiction, proves, does_not_prove,
        recognized_scope, verification_method, public_disclosure_level, valid_from, state
      ) VALUES (
        ${authority}, ${fx.tenantA}, ${`Registry ${authority.slice(0, 8)}`}, 'MNG',
        ARRAY['mining_right_registration'], ARRAY['economic_viability'],
        ARRAY['mining_license'], 'authenticated_api', 'public', '2015-01-01', 'accepted'
      )
    `;
    const connection = randomUUID();
    await fx.sql`
      INSERT INTO core.source_connections (
        id, tenant_id, authority_id, connection_key, collection_method,
        access_basis, secret_reference, state,
        endpoint, authentication_method, adapter_version, source_schema_version,
        schema_fingerprint, response_record_absent_field, response_record_absent_value,
        response_business_error_field
      ) VALUES (
        ${connection}, ${fx.tenantA}, ${authority}, ${`conn-${connection.slice(0, 8)}`},
        'authenticated_api', 'agreement', 'vault://mn/x', 'active',
        'https://registry.example.test/x', 'none', 'test', 'test',
        ARRAY['licenseId'], 'found', 'false', 'error'
      )
    `;
    const receipt = randomUUID();
    await fx.sql`
      INSERT INTO core.source_receipts (
        id, tenant_id, project_id, connection_id, authority_id, collection_method,
        result, query_basis, endpoint_or_document_ref, authentication_method,
        raw_hash, source_schema_version, adapter_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        freshness_status, correlation_id, channel_evidence
      ) VALUES (
        ${receipt}, ${fx.tenantA}, ${project}, ${connection}, ${authority},
        'authenticated_api', 'confirmed_from_source', '{}'::jsonb, 'https://x.test/a',
        'none', ${`0x${"11".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
        now(), now(), 'fresh', 'test', '{"collector":"server_adapter"}'::jsonb
      )
    `;
    const claim = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, tenant_id, project_id, claim_type, value_text, source_coordinate,
        evidence_tier, verification_state, grade, source_receipt_id
      ) VALUES (
        ${claim}, ${fx.tenantA}, ${project}, 'mining_right', 'MN-1', '{"page":"1"}'::jsonb,
        'P1', 'analyst_checked', 'verified', ${receipt}
      )
    `;
    const attestationId = await seedAttestation({ project, claims: [claim] });

    // 1. A person revokes the authority through the API.
    const [authorityRow] = await fx.sql<{ version: number }[]>`
      SELECT version FROM core.authorities WHERE id = ${authority}
    `;
    const revoked = await app.inject({
      method: "POST",
      url: `/api/v1/authorities/${authority}/state`,
      headers: {
        authorization: `Bearer ${auditor}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${authorityRow!.version}"`,
      },
      payload: { state: "revoked", reason: "registry withdrew recognition" },
    });
    expect(revoked.statusCode).toBe(200);

    // 2. Claim stale, attestation to re-review.
    const [claimRow] = await fx.sql<{ stale_since: Date | null }[]>`
      SELECT stale_since FROM core.claims WHERE id = ${claim}
    `;
    expect(claimRow?.stale_since).not.toBeNull();
    expect((await attestation(attestationId)).state).toBe("stale_candidate");

    // 3. The signals, including the suspension proposal, are listed for the project.
    const listed = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project}/stale-signals`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(listed.statusCode).toBe(200);
    const proposal = listed
      .json()
      .items.find((item: { targetType: string }) => item.targetType === "project_lifecycle");
    expect(proposal.nextActions.join(" ")).toContain("nothing is suspended automatically");
    // The contract describes what the route returns, this target type included.
    expect(evidenceStaleSignal.safeParse(proposal).success).toBe(true);

    // 4. The lifecycle has not moved.
    const lifecycle = await app.inject({
      method: "GET",
      url: `/api/v1/projects/${project}/lifecycle`,
      headers: { authorization: `Bearer ${operator}` },
    });
    expect(lifecycle.json().lifecycleState).toBe("registered");

    // 5. A person suspends, then closes the proposal with a note. It cannot be closed as a
    //    revocation: no record was revoked.
    const suspended = await app.inject({
      method: "POST",
      url: `/api/v1/projects/${project}/lifecycle-transitions`,
      headers: {
        authorization: `Bearer ${operator}`,
        "idempotency-key": idempotencyKey(),
        "if-match": `"${lifecycle.json().version}"`,
      },
      payload: { toState: "suspended", reason: "source authority revoked; evidence under review" },
    });
    expect(suspended.statusCode).toBe(200);

    const wrongClose = await app.inject({
      method: "POST",
      url: `/api/v1/stale-signals/${proposal.id}/resolve`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
      payload: { resolution: "revoked", note: "suspended" },
    });
    expect(wrongClose.statusCode).toBe(422);

    const closed = await app.inject({
      method: "POST",
      url: `/api/v1/stale-signals/${proposal.id}/resolve`,
      headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
      payload: { resolution: "dismissed", note: "project suspended pending re-review" },
    });
    expect(closed.statusCode).toBe(200);
  });
});
