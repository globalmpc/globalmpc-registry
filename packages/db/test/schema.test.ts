import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";
import { withTenant } from "../src/session.js";

/**
 * Schema, RLS, and guard integration tests.
 *
 * Skips entirely without `DATABASE_URL`. CI must always set it —
 * if this file is skipped, tenant isolation and append-only guarantees pass unverified.
 */

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describeDb("schema, RLS, guards", () => {
  let sql: postgres.Sql;
  let appSql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { onnotice: () => {} });
    // Roles are cluster-global, so they are not dropped. DROP fails while another DB in the same
    // cluster references them, and a role is an object that outlives its original DB.
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS core CASCADE;
      DROP SCHEMA IF EXISTS chain CASCADE;
      DROP SCHEMA IF EXISTS audit CASCADE;
    `);
    await runMigrations(sql);

    // Connect with the role the application actually uses. Testing as superuser bypasses
    // RLS (BYPASSRLS), so isolation cannot be verified.
    await sql.unsafe(`
      DO $$
      BEGIN
        CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
      EXCEPTION
        WHEN duplicate_object THEN NULL;
      END
      $$;
      GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login;
    `);

    const url = new URL(DATABASE_URL!);
    url.username = "mpc_app_login";
    url.password = "app";
    appSql = postgres(url.toString(), { onnotice: () => {} });

    const seedTenants: readonly [string, string][] = [
      [TENANT_A, "tenant-a"],
      [TENANT_B, "tenant-b"],
    ];
    for (const [id, slug] of seedTenants) {
      await sql`
        INSERT INTO core.tenants (id, slug, display_name)
        VALUES (${id}, ${slug}, ${slug})
      `;
    }
  });

  afterAll(async () => {
    await appSql?.end();
    await sql?.end();
  });

  describe("migrations", () => {
    it("safe to re-run", async () => {
      const executed = await runMigrations(sql);
      expect(executed).toEqual([]);
    });

    /**
     * Comparing names only would skip an applied file edited later. Schemas would diverge per
     * environment, and that fact would surface nowhere.
     */
    it("rejects when an applied migration's content changed", async () => {
      const [first] = listMigrations();
      await expect(
        runMigrations(sql, [{ name: first!.name, sql: "SELECT 1" }]),
      ).rejects.toThrow(/checksum differs/);
    });

    it("the 12 source result enums exist as is", async () => {
      const rows = await sql<{ enumlabel: string }[]>`
        SELECT enumlabel FROM pg_enum e
        JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'source_result'
        ORDER BY e.enumsortorder
      `;
      expect(rows.map((r) => r.enumlabel)).toEqual([
        "confirmed_from_source",
        "source_returned_no_record",
        "not_applicable",
        "access_not_authorized",
        "source_unavailable",
        "authentication_failed",
        "signature_invalid",
        "schema_changed",
        "stale",
        "conflicting",
        "manual_review_required",
        "legal_interpretation_required",
      ]);
    });
  });

  describe("tenant isolation (RLS)", () => {
    beforeAll(async () => {
      for (const tenant of [TENANT_A, TENANT_B]) {
        await sql`
          INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
          VALUES (gen_random_uuid(), ${tenant}, ${'Org of ' + tenant}, 'MNG')
        `;
      }
    });

    it("no rows are visible without a tenant set", async () => {
      const rows = await appSql`SELECT id FROM core.organizations`;
      expect(rows).toHaveLength(0);
    });

    it("only the own tenant's rows are visible", async () => {
      const rowsA = await withTenant(appSql, { tenantId: TENANT_A }, (tx) =>
        tx`SELECT tenant_id FROM core.organizations`,
      );
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!["tenant_id"]).toBe(TENANT_A);
    });

    it("another tenant's rows stay invisible even when queried explicitly", async () => {
      const rows = await withTenant(appSql, { tenantId: TENANT_A }, (tx) =>
        tx`SELECT id FROM core.organizations WHERE tenant_id = ${TENANT_B}`,
      );
      expect(rows).toHaveLength(0);
    });

    it("cannot INSERT another tenant's rows", async () => {
      await expect(
        withTenant(appSql, { tenantId: TENANT_A }, (tx) =>
          tx`
            INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
            VALUES (gen_random_uuid(), ${TENANT_B}, 'cross tenant', 'MNG')
          `,
        ),
      ).rejects.toThrow();
    });
  });

  describe("audit is append-only (02 §2.7)", () => {
    beforeAll(async () => {
      await sql`
        INSERT INTO audit.events (tenant_id, command, resource_type, correlation_id)
        VALUES (${TENANT_A}, 'project.registered', 'project', 'corr-1')
      `;
    });

    it("INSERT works", async () => {
      const rows = await sql`SELECT id FROM audit.events WHERE correlation_id = 'corr-1'`;
      expect(rows).toHaveLength(1);
    });

    it("UPDATE is rejected", async () => {
      await expect(
        sql`UPDATE audit.events SET command = 'tampered' WHERE correlation_id = 'corr-1'`,
      ).rejects.toThrow(/append-only/);
    });

    it("DELETE is rejected", async () => {
      await expect(
        sql`DELETE FROM audit.events WHERE correlation_id = 'corr-1'`,
      ).rejects.toThrow(/append-only/);
    });

    it("even superuser cannot bypass — the trigger ignores privileges", async () => {
      const [role] = await sql<{ usesuper: boolean }[]>`
        SELECT usesuper FROM pg_user WHERE usename = current_user
      `;
      expect(role!.usesuper).toBe(true);
      await expect(sql`DELETE FROM audit.events`).rejects.toThrow(/append-only/);
    });
  });

  describe("AC-01 — an attestation without limitations cannot be stored", () => {
    it("the DB rejects an empty string", async () => {
      await expect(
        sql.unsafe(`
          INSERT INTO core.verification_attestations (
            id, tenant_id, case_id, assignment_id, credential_id, schema_id,
            attestation_type, claim_scope, evidence_snapshot_hash, limitations,
            credential_status_snapshot, method_version, policy_version, payload_hash,
            signature, signer_wallet_address, signed_at
          ) VALUES (
            gen_random_uuid(), '${TENANT_A}', gen_random_uuid(), gen_random_uuid(),
            gen_random_uuid(), gen_random_uuid(), 'professional_signoff',
            ARRAY[gen_random_uuid()], '0x${"11".repeat(32)}', '',
            '{}'::jsonb, 'm1', 'p1', '0x${"22".repeat(32)}',
            '0xsig', '0x${"ab".repeat(20)}', now()
          )
        `),
      ).rejects.toThrow();
    });

    it("rejects a whitespace-only string too", async () => {
      await expect(
        sql.unsafe(`
          INSERT INTO core.verification_attestations (
            id, tenant_id, case_id, assignment_id, credential_id, schema_id,
            attestation_type, claim_scope, evidence_snapshot_hash, limitations,
            credential_status_snapshot, method_version, policy_version, payload_hash,
            signature, signer_wallet_address, signed_at
          ) VALUES (
            gen_random_uuid(), '${TENANT_A}', gen_random_uuid(), gen_random_uuid(),
            gen_random_uuid(), gen_random_uuid(), 'professional_signoff',
            ARRAY[gen_random_uuid()], '0x${"11".repeat(32)}', '   ',
            '{}'::jsonb, 'm1', 'p1', '0x${"22".repeat(32)}',
            '0xsig', '0x${"ab".repeat(20)}', now()
          )
        `),
      ).rejects.toThrow();
    });
  });

  describe("hash format constraints", () => {
    it("rejects uppercase hex — a different representation means different sorting and comparison", async () => {
      await expect(
        sql`
          INSERT INTO chain.anchor_batches (
            id, tenant_id, batch_id, merkle_root, manifest_hash,
            manifest_object_key, schema_version, record_count
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, ${"0x" + "AB".repeat(32)},
            ${"0x" + "cd".repeat(32)}, ${"0x" + "ef".repeat(32)},
            'manifests/1.json', '1', 3
          )
        `,
      ).rejects.toThrow();
    });

    it("rejects a batch with record_count 0 — empty batches are not anchored", async () => {
      await expect(
        sql`
          INSERT INTO chain.anchor_batches (
            id, tenant_id, batch_id, merkle_root, manifest_hash,
            manifest_object_key, schema_version, record_count
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, ${"0x" + "11".repeat(32)},
            ${"0x" + "22".repeat(32)}, ${"0x" + "33".repeat(32)},
            'manifests/2.json', '1', 0
          )
        `,
      ).rejects.toThrow();
    });
  });

  describe("anchor batches are immutable (08 §8.4)", () => {
    const batchId = "0x" + "44".repeat(32);

    beforeAll(async () => {
      await sql`
        INSERT INTO chain.anchor_batches (
          id, tenant_id, batch_id, merkle_root, manifest_hash,
          manifest_object_key, schema_version, record_count
        ) VALUES (
          gen_random_uuid(), ${TENANT_A}, ${batchId},
          ${"0x" + "55".repeat(32)}, ${"0x" + "66".repeat(32)},
          'manifests/3.json', '1', 5
        )
      `;
    });

    it("cannot modify the root", async () => {
      await expect(
        sql`
          UPDATE chain.anchor_batches SET merkle_root = ${"0x" + "77".repeat(32)}
          WHERE batch_id = ${batchId}
        `,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });

    it("cannot delete", async () => {
      await expect(
        sql`DELETE FROM chain.anchor_batches WHERE batch_id = ${batchId}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });

    it("cannot reuse the same batch_id", async () => {
      await expect(
        sql`
          INSERT INTO chain.anchor_batches (
            id, tenant_id, batch_id, merkle_root, manifest_hash,
            manifest_object_key, schema_version, record_count
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, ${batchId},
            ${"0x" + "88".repeat(32)}, ${"0x" + "99".repeat(32)},
            'manifests/4.json', '1', 5
          )
        `,
      ).rejects.toThrow();
    });
  });

  describe("REQ-DAPP-017 — no readiness override", () => {
    let assessmentId: string;
    let projectId: string;
    let policySetId: string;

    beforeAll(async () => {
      const [org] = await sql<{ id: string }[]>`
        SELECT id FROM core.organizations WHERE tenant_id = ${TENANT_A} LIMIT 1
      `;
      const [project] = await sql<{ id: string }[]>`
        INSERT INTO core.projects (id, tenant_id, project_key, name, host_country_iso3, owner_organization_id)
        VALUES (gen_random_uuid(), ${TENANT_A}, 'SYNTH-PROJECT-001', 'Synthetic', 'MNG', ${org!.id})
        RETURNING id
      `;
      projectId = project!.id;

      const [policy] = await sql<{ id: string }[]>`
        INSERT INTO core.compliance_policy_sets (
          id, tenant_id, rule_set_id, rule_set_version, gate_id,
          jurisdiction_profile, effective_from, definition
        ) VALUES (
          gen_random_uuid(), ${TENANT_A}, 'registry-publication-gate', '1.0.0',
          'registry_publication', 'MNG', now(), '{}'::jsonb
        ) RETURNING id
      `;
      policySetId = policy!.id;

      const [assessment] = await sql<{ id: string }[]>`
        INSERT INTO core.compliance_assessments (
          id, tenant_id, project_id, gate_id, policy_set_id,
          input_snapshot_hash, evaluated_as_of, status, requirement_results, canonical_result_hash
        ) VALUES (
          gen_random_uuid(), ${TENANT_A}, ${projectId}, 'registry_publication', ${policySetId},
          ${"0x" + "aa".repeat(32)}, now(), 'gap', '[]'::jsonb, ${"0x" + "bb".repeat(32)}
        ) RETURNING id
      `;
      assessmentId = assessment!.id;
    });

    it("cannot change status from gap to ok", async () => {
      await expect(
        sql`UPDATE core.compliance_assessments SET status = 'ok' WHERE id = ${assessmentId}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });

    it("cannot delete", async () => {
      await expect(
        sql`DELETE FROM core.compliance_assessments WHERE id = ${assessmentId}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });

    it("gate decisions cannot be modified either", async () => {
      const [subject] = await sql<{ id: string }[]>`
        INSERT INTO core.subjects (id, tenant_id, kind, display_name)
        VALUES (gen_random_uuid(), ${TENANT_A}, 'person', 'Approver')
        RETURNING id
      `;
      const [decision] = await sql<{ id: string }[]>`
        INSERT INTO core.gate_decisions (
          id, tenant_id, project_id, gate_id, decision, input_assessment_id,
          evidence_snapshot_hash, decision_authority, decision_maker_subject_id,
          rationale, signature, signed_at
        ) VALUES (
          gen_random_uuid(), ${TENANT_A}, ${projectId}, 'registry_publication', 'hold',
          ${assessmentId}, ${"0x" + "cc".repeat(32)}, 'MPC Gate Approver', ${subject!.id},
          'Held for insufficient evidence', '0xsig', now()
        ) RETURNING id
      `;
      await expect(
        sql`UPDATE core.gate_decisions SET decision = 'go' WHERE id = ${decision!.id}`,
      ).rejects.toThrow(/cannot be modified or deleted/);
    });

    it("cannot record a decision with an empty rationale", async () => {
      const [subject] = await sql<{ id: string }[]>`
        SELECT id FROM core.subjects WHERE tenant_id = ${TENANT_A} LIMIT 1
      `;
      await expect(
        sql`
          INSERT INTO core.gate_decisions (
            id, tenant_id, project_id, gate_id, decision, input_assessment_id,
            evidence_snapshot_hash, decision_authority, decision_maker_subject_id,
            rationale, signature, signed_at
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, ${projectId}, 'registry_publication', 'go',
            ${assessmentId}, ${"0x" + "cc".repeat(32)}, 'MPC Gate Approver', ${subject!.id},
            '  ', '0xsig', now()
          )
        `,
      ).rejects.toThrow();
    });
  });

  describe("lifecycle constraints", () => {
    it("cannot have prior_lifecycle_state unless suspended", async () => {
      const [org] = await sql<{ id: string }[]>`
        SELECT id FROM core.organizations WHERE tenant_id = ${TENANT_A} LIMIT 1
      `;
      await expect(
        sql`
          INSERT INTO core.projects (
            id, tenant_id, project_key, name, host_country_iso3,
            owner_organization_id, lifecycle_state, prior_lifecycle_state
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, 'BAD-STATE-001', 'Bad', 'MNG',
            ${org!.id}, 'active', 'registered'
          )
        `,
      ).rejects.toThrow();
    });

    it("prior_lifecycle_state is required when suspended", async () => {
      const [org] = await sql<{ id: string }[]>`
        SELECT id FROM core.organizations WHERE tenant_id = ${TENANT_A} LIMIT 1
      `;
      await expect(
        sql`
          INSERT INTO core.projects (
            id, tenant_id, project_key, name, host_country_iso3,
            owner_organization_id, lifecycle_state
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, 'BAD-STATE-002', 'Bad', 'MNG',
            ${org!.id}, 'suspended'
          )
        `,
      ).rejects.toThrow();
    });
  });

  describe("authorities must state limitations (05 §5.11)", () => {
    it("rejects an empty does_not_prove", async () => {
      await expect(
        sql`
          INSERT INTO core.authorities (
            id, tenant_id, name, jurisdiction, proves, does_not_prove,
            recognized_scope, verification_method, public_disclosure_level, valid_from
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, 'Mineral Registry', 'MNG',
            ARRAY['license_registration'], ARRAY[]::text[],
            ARRAY['mining_license'], 'authenticated_api', 'public', '2020-01-01'
          )
        `,
      ).rejects.toThrow();
    });

    it("passes when limitations are stated", async () => {
      const rows = await sql`
        INSERT INTO core.authorities (
          id, tenant_id, name, jurisdiction, proves, does_not_prove,
          recognized_scope, verification_method, public_disclosure_level, valid_from
        ) VALUES (
          gen_random_uuid(), ${TENANT_A}, 'Mineral Registry', 'MNG',
          ARRAY['license_registration'],
          ARRAY['economic_viability','rights_completeness','investment_suitability'],
          ARRAY['mining_license'], 'authenticated_api', 'public', '2020-01-01'
        ) RETURNING id
      `;
      expect(rows).toHaveLength(1);
    });
  });

  describe("a published registry version cannot be overwritten", () => {
    let versionId: string;

    beforeAll(async () => {
      const [entry] = await sql<{ id: string }[]>`
        INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
        VALUES (gen_random_uuid(), ${TENANT_A}, 'project', gen_random_uuid(), 'SYNTH-PROJECT-001')
        RETURNING id
      `;
      const [version] = await sql<{ id: string }[]>`
        INSERT INTO core.registry_entry_versions (
          id, tenant_id, entry_id, version, status, public_projection,
          content_hash, source_snapshot_hash, policy_version, schema_version, published_at
        ) VALUES (
          gen_random_uuid(), ${TENANT_A}, ${entry!.id}, 1, 'published',
          '{"projectKey":"SYNTH-PROJECT-001"}'::jsonb,
          ${"0x" + "dd".repeat(32)}, ${"0x" + "ee".repeat(32)}, 'p1', 's1', now()
        ) RETURNING id
      `;
      versionId = version!.id;
    });

    it("cannot modify the projection", async () => {
      await expect(
        sql`
          UPDATE core.registry_entry_versions
          SET public_projection = '{"projectKey":"CHANGED"}'::jsonb
          WHERE id = ${versionId}
        `,
      ).rejects.toThrow(/cannot be overwritten/);
    });

    it("state transition (revoke) is allowed", async () => {
      const result = await sql`
        UPDATE core.registry_entry_versions
        SET status = 'revoked', revoked_at = now()
        WHERE id = ${versionId}
        RETURNING id
      `;
      expect(result).toHaveLength(1);
    });

    it("cannot store published without a projection", async () => {
      const [entry] = await sql<{ id: string }[]>`
        SELECT id FROM core.registry_entries WHERE tenant_id = ${TENANT_A} LIMIT 1
      `;
      await expect(
        sql`
          INSERT INTO core.registry_entry_versions (
            id, tenant_id, entry_id, version, status,
            source_snapshot_hash, policy_version, schema_version
          ) VALUES (
            gen_random_uuid(), ${TENANT_A}, ${entry!.id}, 2, 'published',
            ${"0x" + "ee".repeat(32)}, 'p1', 's1'
          )
        `,
      ).rejects.toThrow();
    });
  });

  describe("lineage recursive CTE (ADR-T03)", () => {
    it("can query the impact propagation path", async () => {
      const ids = Array.from({ length: 4 }, (_, i) =>
        `3333333${i}-3333-3333-3333-333333333333`,
      );
      for (let i = 0; i < ids.length - 1; i += 1) {
        await sql`
          INSERT INTO core.lineage_edges (id, tenant_id, from_id, to_id, relation_type)
          VALUES (gen_random_uuid(), ${TENANT_A}, ${ids[i]!}, ${ids[i + 1]!}, 'derived_from')
        `;
      }

      const rows = await sql<{ to_id: string; depth: number }[]>`
        WITH RECURSIVE downstream AS (
          SELECT to_id, 1 AS depth
          FROM core.lineage_edges
          WHERE from_id = ${ids[0]!}
          UNION ALL
          SELECT e.to_id, d.depth + 1
          FROM core.lineage_edges e
          JOIN downstream d ON e.from_id = d.to_id
          WHERE d.depth < 10
        )
        SELECT to_id, depth FROM downstream ORDER BY depth
      `;

      expect(rows.map((r) => r.to_id)).toEqual([ids[1], ids[2], ids[3]]);
    });
  });
});
