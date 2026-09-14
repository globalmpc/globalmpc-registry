import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { listMigrations, runMigrations } from "../src/migrate.js";
import { withTenant } from "../src/session.js";

/**
 * 스키마·RLS·guard 통합 테스트.
 *
 * `DATABASE_URL`이 없으면 전체를 skip한다. CI에서는 반드시 설정한다 —
 * 이 파일이 skip되면 tenant 격리와 append-only 보장이 검증되지 않은 채 통과한다.
 */

const DATABASE_URL = process.env["DATABASE_URL"];
const describeDb = DATABASE_URL ? describe : describe.skip;

const TENANT_A = "11111111-1111-1111-1111-111111111111";
const TENANT_B = "22222222-2222-2222-2222-222222222222";

describeDb("스키마·RLS·guard", () => {
  let sql: postgres.Sql;
  let appSql: postgres.Sql;

  beforeAll(async () => {
    sql = postgres(DATABASE_URL!, { onnotice: () => {} });
    // role은 클러스터 전역이라 DROP하지 않는다. 같은 클러스터의 다른 DB가
    // 참조 중이면 DROP이 실패하고, role은 원래 DB보다 오래 사는 객체다.
    await sql.unsafe(`
      DROP SCHEMA IF EXISTS core CASCADE;
      DROP SCHEMA IF EXISTS chain CASCADE;
      DROP SCHEMA IF EXISTS audit CASCADE;
    `);
    await runMigrations(sql);

    // 애플리케이션이 실제로 쓰는 role로 접속한다. superuser로 테스트하면
    // RLS가 우회되어(BYPASSRLS) 격리를 검증할 수 없다.
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

  describe("마이그레이션", () => {
    it("재실행해도 안전하다", async () => {
      const executed = await runMigrations(sql);
      expect(executed).toEqual([]);
    });

    /**
     * 이름만 비교하면 적용된 파일을 나중에 고쳐도 건너뛴다. 환경마다 스키마가
     * 갈리고 그 사실이 어디에도 드러나지 않는다.
     */
    it("적용된 마이그레이션의 내용이 바뀌면 거절한다", async () => {
      const [first] = listMigrations();
      await expect(
        runMigrations(sql, [{ name: first!.name, sql: "SELECT 1" }]),
      ).rejects.toThrow(/체크섬/);
    });

    it("12개 source result enum이 그대로 존재한다", async () => {
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

  describe("tenant 격리 (RLS)", () => {
    beforeAll(async () => {
      for (const tenant of [TENANT_A, TENANT_B]) {
        await sql`
          INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
          VALUES (gen_random_uuid(), ${tenant}, ${'Org of ' + tenant}, 'MNG')
        `;
      }
    });

    it("tenant를 설정하지 않으면 아무 행도 보이지 않는다", async () => {
      const rows = await appSql`SELECT id FROM core.organizations`;
      expect(rows).toHaveLength(0);
    });

    it("자기 tenant의 행만 보인다", async () => {
      const rowsA = await withTenant(appSql, { tenantId: TENANT_A }, (tx) =>
        tx`SELECT tenant_id FROM core.organizations`,
      );
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]!["tenant_id"]).toBe(TENANT_A);
    });

    it("다른 tenant의 행을 명시적으로 조회해도 보이지 않는다", async () => {
      const rows = await withTenant(appSql, { tenantId: TENANT_A }, (tx) =>
        tx`SELECT id FROM core.organizations WHERE tenant_id = ${TENANT_B}`,
      );
      expect(rows).toHaveLength(0);
    });

    it("다른 tenant의 행을 INSERT할 수 없다", async () => {
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

  describe("audit는 append-only다 (02 §2.7)", () => {
    beforeAll(async () => {
      await sql`
        INSERT INTO audit.events (tenant_id, command, resource_type, correlation_id)
        VALUES (${TENANT_A}, 'project.registered', 'project', 'corr-1')
      `;
    });

    it("INSERT는 된다", async () => {
      const rows = await sql`SELECT id FROM audit.events WHERE correlation_id = 'corr-1'`;
      expect(rows).toHaveLength(1);
    });

    it("UPDATE가 거절된다", async () => {
      await expect(
        sql`UPDATE audit.events SET command = 'tampered' WHERE correlation_id = 'corr-1'`,
      ).rejects.toThrow(/append-only/);
    });

    it("DELETE가 거절된다", async () => {
      await expect(
        sql`DELETE FROM audit.events WHERE correlation_id = 'corr-1'`,
      ).rejects.toThrow(/append-only/);
    });

    it("superuser도 우회할 수 없다 — 트리거는 권한과 무관하다", async () => {
      const [role] = await sql<{ usesuper: boolean }[]>`
        SELECT usesuper FROM pg_user WHERE usename = current_user
      `;
      expect(role!.usesuper).toBe(true);
      await expect(sql`DELETE FROM audit.events`).rejects.toThrow(/append-only/);
    });
  });

  describe("AC-01 — limitations 없는 attestation은 저장할 수 없다", () => {
    it("빈 문자열을 DB가 거절한다", async () => {
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

    it("공백만 있는 문자열도 거절한다", async () => {
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

  describe("hash 형식 제약", () => {
    it("대문자 hex를 거절한다 — 표현이 갈리면 정렬과 비교가 갈린다", async () => {
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

    it("record_count가 0인 batch를 거절한다 — 빈 batch는 anchor하지 않는다", async () => {
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

  describe("anchor batch는 immutable이다 (08 §8.4)", () => {
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

    it("root를 수정할 수 없다", async () => {
      await expect(
        sql`
          UPDATE chain.anchor_batches SET merkle_root = ${"0x" + "77".repeat(32)}
          WHERE batch_id = ${batchId}
        `,
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });

    it("삭제할 수 없다", async () => {
      await expect(
        sql`DELETE FROM chain.anchor_batches WHERE batch_id = ${batchId}`,
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });

    it("같은 batch_id를 재사용할 수 없다", async () => {
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

  describe("REQ-DAPP-017 — readiness override 불가", () => {
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

    it("status를 gap에서 ok로 바꿀 수 없다", async () => {
      await expect(
        sql`UPDATE core.compliance_assessments SET status = 'ok' WHERE id = ${assessmentId}`,
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });

    it("삭제할 수 없다", async () => {
      await expect(
        sql`DELETE FROM core.compliance_assessments WHERE id = ${assessmentId}`,
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });

    it("gate decision도 수정할 수 없다", async () => {
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
          '근거 부족으로 보류', '0xsig', now()
        ) RETURNING id
      `;
      await expect(
        sql`UPDATE core.gate_decisions SET decision = 'go' WHERE id = ${decision!.id}`,
      ).rejects.toThrow(/수정·삭제할 수 없다/);
    });

    it("빈 rationale로 결정을 기록할 수 없다", async () => {
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

  describe("lifecycle 제약", () => {
    it("suspended가 아니면 prior_lifecycle_state를 가질 수 없다", async () => {
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

    it("suspended면 prior_lifecycle_state가 필수다", async () => {
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

  describe("authority는 한계를 명시해야 한다 (05 §5.11)", () => {
    it("does_not_prove가 비면 거절한다", async () => {
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

    it("한계를 명시하면 통과한다", async () => {
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

  describe("published registry version은 덮어쓸 수 없다", () => {
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

    it("projection을 수정할 수 없다", async () => {
      await expect(
        sql`
          UPDATE core.registry_entry_versions
          SET public_projection = '{"projectKey":"CHANGED"}'::jsonb
          WHERE id = ${versionId}
        `,
      ).rejects.toThrow(/덮어쓸 수 없다/);
    });

    it("상태 전이(revoke)는 허용된다", async () => {
      const result = await sql`
        UPDATE core.registry_entry_versions
        SET status = 'revoked', revoked_at = now()
        WHERE id = ${versionId}
        RETURNING id
      `;
      expect(result).toHaveLength(1);
    });

    it("published인데 projection이 없으면 저장할 수 없다", async () => {
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
    it("영향 전파 경로를 조회할 수 있다", async () => {
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
