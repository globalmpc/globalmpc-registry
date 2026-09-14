import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * 출처 변경 전파 — AC-04 · AC-21.
 *
 * 사슬은 이렇다.
 *
 *   authority → connection → receipt → claim → attestation
 *
 * 앞의 두 구간은 0020이, 뒤의 두 구간은 0023이 만든다. 이 파일은 **끝까지
 * 이어지는가**와 **끝난 기록을 건드리지 않는가**를 함께 본다.
 */
describeDb("stale 전파", () => {
  let fx: TestFixture;
  let app: FastifyInstance;
  let operator: string;

  beforeAll(async () => {
    fx = await setupFixture();
    app = await buildServer(loadConfig(testEnv()), fx.appSql);
    operator = await signIn(app, fx.operatorA);
  });

  afterAll(async () => {
    await app.close();
    await fx.close();
  });

  beforeEach(async () => {
    // 연동을 원래대로 돌려 놓는다. 각 테스트가 자기 전이를 일으킨다.
    await fx.sql`
      UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}
    `;
  });

  /** receipt 하나와 그것에 근거한 claim 하나를 만든다. */
  async function seedClaim(): Promise<{ receiptId: string; claimId: string }> {
    const receiptId = randomUUID();
    await fx.sql`
      INSERT INTO core.source_receipts (
        id, tenant_id, project_id, connection_id, authority_id, collection_method,
        result, query_basis, endpoint_or_document_ref, authentication_method,
        raw_hash, source_schema_version, adapter_version, terms_license,
        commercial_reuse, disclosure_permission, received_at, as_of,
        freshness_status, correlation_id, channel_evidence
      ) VALUES (
        ${receiptId}, ${fx.tenantA}, ${fx.projectA}, ${fx.connectionA}, ${fx.authorityA},
        'authenticated_api', 'confirmed_from_source', '{}'::jsonb, 'https://x.test/a',
        'none', ${`0x${"11".repeat(32)}`}, '1', '1', 'x', 'unconfirmed', 'restricted',
        now(), now(), 'fresh', 'test',
        -- 서버가 부른 조회에서 나온 확정이다 — 2026-09-10 실사 A1.
        -- 이 표시가 없으면 DB가 거절한다(api_confirmation_requires_server_collection).
        '{"collector":"server_adapter"}'::jsonb
      )
    `;

    const claimId = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, tenant_id, project_id, claim_type, value_text, source_coordinate,
        evidence_tier, verification_state, grade, source_receipt_id
      ) VALUES (
        ${claimId}, ${fx.tenantA}, ${fx.projectA}, 'mining_right', 'MN-1',
        '{"page":"1"}'::jsonb, 'P1', 'analyst_checked', 'verified', ${receiptId}
      )
    `;

    return { receiptId, claimId };
  }

  async function seedAttestation(claimId: string, state: string): Promise<string> {
    const caseId = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_cases (id, tenant_id, project_id, schema_id, state)
      VALUES (${caseId}, ${fx.tenantA}, ${fx.projectA}, ${fx.schemaA}, 'draft')
    `;

    const assignmentId = randomUUID();
    await fx.sql`
      INSERT INTO core.assignments (id, tenant_id, case_id, subject_id, credential_id)
      VALUES (${assignmentId}, ${fx.tenantA}, ${caseId}, ${fx.reviewerSubjectA},
              ${fx.credentialA})
    `;

    const id = randomUUID();
    await fx.sql`
      INSERT INTO core.verification_attestations (
        id, tenant_id, case_id, assignment_id, credential_id, schema_id,
        attestation_type, claim_scope, evidence_snapshot_hash, findings, limitations,
        credential_status_snapshot, method_version, policy_version,
        payload_hash, signature, signer_wallet_address, signed_at, state
      ) VALUES (
        ${id}, ${fx.tenantA}, ${caseId}, ${assignmentId}, ${fx.credentialA}, ${fx.schemaA},
        'professional_signoff', ARRAY[${claimId}]::UUID[], ${`0x${"22".repeat(32)}`},
        '{"note":"검토했다"}'::jsonb, 'legal_effect_not_determined', '{}'::jsonb, '1', '1',
        ${`0x${"33".repeat(32)}`}, ${`0x${"44".repeat(65)}`},
        ${fx.reviewerA.address.toLowerCase()}, now(), ${state}
      )
    `;
    return id;
  }

  it("연동이 내려가면 그 출처의 claim이 표시된다", async () => {
    const { claimId } = await seedClaim();

    await fx.sql`
      UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
    `;

    const [claim] = await fx.sql<{ stale_since: Date | null; stale_reason: string | null }[]>`
      SELECT stale_since, stale_reason FROM core.claims WHERE id = ${claimId}
    `;

    expect(claim?.stale_since).not.toBeNull();
    // 왜 흔들렸는지가 함께 남아야 다음 사람이 판단한다.
    expect(claim?.stale_reason).toContain("degraded");
  });

  it("검토 상태는 바뀌지 않는다", async () => {
    const { claimId } = await seedClaim();

    await fx.sql`
      UPDATE core.source_connections SET state = 'disabled' WHERE id = ${fx.connectionA}
    `;

    const [claim] = await fx.sql<{ verification_state: string }[]>`
      SELECT verification_state FROM core.claims WHERE id = ${claimId}
    `;

    // 검토는 실제로 있었다. 달라진 것은 그 검토가 딛고 있던 근거다.
    expect(claim?.verification_state).toBe("analyst_checked");
  });

  it("처음 흔들린 시점을 덮어쓰지 않는다", async () => {
    const { claimId } = await seedClaim();

    await fx.sql`UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}`;
    const [first] = await fx.sql<{ stale_since: Date }[]>`
      SELECT stale_since FROM core.claims WHERE id = ${claimId}
    `;

    await fx.sql`UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}`;
    await fx.sql`UPDATE core.source_connections SET state = 'disabled' WHERE id = ${fx.connectionA}`;

    const [second] = await fx.sql<{ stale_since: Date }[]>`
      SELECT stale_since FROM core.claims WHERE id = ${claimId}
    `;

    expect(second?.stale_since.getTime()).toBe(first?.stale_since.getTime());
  });

  it("access_confirmed로 내려가는 것은 전파하지 않는다", async () => {
    const { claimId } = await seedClaim();

    // 자동 호출 경로가 없어진 것이지 근거가 사라진 것이 아니다.
    await fx.sql`
      UPDATE core.source_connections SET state = 'access_confirmed' WHERE id = ${fx.connectionA}
    `;

    const [claim] = await fx.sql<{ stale_since: Date | null }[]>`
      SELECT stale_since FROM core.claims WHERE id = ${claimId}
    `;
    expect(claim?.stale_since).toBeNull();
  });

  it("claim이 흔들리면 그것을 덮은 attestation이 재검토 대상이 된다", async () => {
    const { claimId } = await seedClaim();
    const attestationId = await seedAttestation(claimId, "active");

    await fx.sql`
      UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
    `;

    const [row] = await fx.sql<{ state: string; stale_reason: string | null }[]>`
      SELECT state, stale_reason FROM core.verification_attestations
      WHERE id = ${attestationId}
    `;

    expect(row?.state).toBe("stale_candidate");
    expect(row?.stale_reason).toContain("근거 claim");
  });

  it("이미 끝난 attestation은 건드리지 않는다", async () => {
    const { claimId } = await seedClaim();
    const revoked = await seedAttestation(claimId, "revoked");
    const superseded = await seedAttestation(claimId, "superseded");

    await fx.sql`
      UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
    `;

    const rows = await fx.sql<{ id: string; state: string }[]>`
      SELECT id, state FROM core.verification_attestations
      WHERE id IN (${revoked}, ${superseded})
    `;

    // 끝난 기록을 다시 건드리면 "언제 무엇이 유효했나"가 흐려진다.
    expect(rows.find((r) => r.id === revoked)?.state).toBe("revoked");
    expect(rows.find((r) => r.id === superseded)?.state).toBe("superseded");
  });

  it("다른 출처의 claim은 영향받지 않는다", async () => {
    const other = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, tenant_id, project_id, claim_type, value_text, source_coordinate,
        verification_state, grade
      ) VALUES (
        ${other}, ${fx.tenantA}, ${fx.projectA}, 'other', 'x',
        '{}'::jsonb, 'unreviewed', 'unverified'
      )
    `;
    await seedClaim();

    await fx.sql`
      UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
    `;

    const [row] = await fx.sql<{ stale_since: Date | null }[]>`
      SELECT stale_since FROM core.claims WHERE id = ${other}
    `;
    expect(row?.stale_since).toBeNull();
  });

  it("이유 없이 stale로 표시할 수 없다", async () => {
    const { claimId } = await seedClaim();

    await expect(
      fx.sql`UPDATE core.claims SET stale_since = now() WHERE id = ${claimId}`,
    ).rejects.toThrow(/claims_stale_needs_reason/);
  });

  it("근거 없는 claim을 뷰가 드러낸다", async () => {
    const orphan = randomUUID();
    await fx.sql`
      INSERT INTO core.claims (
        id, tenant_id, project_id, claim_type, value_text, source_coordinate,
        evidence_tier, verification_state, grade
      ) VALUES (
        ${orphan}, ${fx.tenantA}, ${fx.projectA}, 'unbacked', 'x',
        '{}'::jsonb, 'P1', 'independently_assured', 'verified'
      )
    `;

    const rows = await fx.sql<{ id: string }[]>`
      SELECT id FROM core.claims_without_evidence WHERE id = ${orphan}
    `;

    // 자동으로 지우거나 등급을 낮추지 않는다. 존재한다는 사실이 정보다.
    expect(rows).toHaveLength(1);
  });

  it("다른 tenant의 receipt를 근거로 삼을 수 없다", async () => {
    await expect(
      fx.sql`
        INSERT INTO core.claims (
          id, tenant_id, project_id, claim_type, value_text, source_coordinate,
          verification_state, grade, source_receipt_id
        ) VALUES (
          ${randomUUID()}, ${fx.tenantB}, ${fx.projectA}, 'x', 'x',
          '{}'::jsonb, 'unreviewed', 'unverified', ${randomUUID()}
        )
      `,
    ).rejects.toThrow();
  });

  /**
   * 마지막 구간 — attestation → assessment · Registry version.
   *
   * 앞 구간과 달리 대상을 바꾸지 않는다. 두 테이블 모두 불변이기 때문이고,
   * 공개 기록을 자동으로 내리지 않기 위해서이기도 하다.
   */
  describe("근거 신호", () => {
    async function seedPublishedRegistryEntry(): Promise<string> {
      const entryId = randomUUID();
      await fx.sql`
        INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
        VALUES (${entryId}, ${fx.tenantA}, 'project', ${fx.projectA},
                ${`PRJ-${entryId.slice(0, 8)}`})
      `;
      const versionId = randomUUID();
      await fx.sql`
        INSERT INTO core.registry_entry_versions (
          id, tenant_id, entry_id, version, status, public_projection,
          content_hash, source_snapshot_hash, policy_version, schema_version,
          serialization_version, published_at
        ) VALUES (
          ${versionId}, ${fx.tenantA}, ${entryId}, 1, 'published', '{}'::jsonb,
          ${`0x${"55".repeat(32)}`}, ${`0x${"66".repeat(32)}`}, '1', '1', '1', now()
        )
      `;
      return versionId;
    }

    it("attestation이 흔들리면 공개 version에 신호가 남는다", async () => {
      const versionId = await seedPublishedRegistryEntry();
      const { claimId } = await seedClaim();
      await seedAttestation(claimId, "active");

      await fx.sql`
        UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
      `;

      const [signal] = await fx.sql<{ reason: string; resolution: string }[]>`
        SELECT reason, resolution::text FROM core.evidence_stale_signals
        WHERE target_type = 'registry_entry_version' AND target_id = ${versionId}
      `;

      expect(signal?.resolution).toBe("open");
      expect(signal?.reason).toContain("근거");
    });

    it("공개 version 자체는 바뀌지 않는다", async () => {
      const versionId = await seedPublishedRegistryEntry();
      const { claimId } = await seedClaim();
      await seedAttestation(claimId, "active");

      await fx.sql`
        UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
      `;

      const [version] = await fx.sql<{ status: string; revoked_at: Date | null }[]>`
        SELECT status::text, revoked_at FROM core.registry_entry_versions
        WHERE id = ${versionId}
      `;

      // 연동 하나가 끊겼다고 공개 기록이 자동으로 사라지면 안 된다.
      expect(version?.status).toBe("published");
      expect(version?.revoked_at).toBeNull();
    });

    it("이유 없이 신호를 닫을 수 없다", async () => {
      await seedPublishedRegistryEntry();
      const { claimId } = await seedClaim();
      await seedAttestation(claimId, "active");
      await fx.sql`
        UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
      `;

      const [signal] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.evidence_stale_signals WHERE resolution = 'open' LIMIT 1
      `;

      await expect(
        fx.sql`
          UPDATE core.evidence_stale_signals
          SET resolution = 'dismissed', resolved_at = now()
          WHERE id = ${signal!.id}
        `,
      ).rejects.toThrow(/stale_signal_resolution_needs_note/);
    });

    it("닫힌 신호는 다시 열 수 없다", async () => {
      await seedPublishedRegistryEntry();
      const { claimId } = await seedClaim();
      await seedAttestation(claimId, "active");
      await fx.sql`
        UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
      `;

      const [signal] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.evidence_stale_signals WHERE resolution = 'open' LIMIT 1
      `;

      await fx.sql`
        UPDATE core.evidence_stale_signals
        SET resolution = 'dismissed', resolved_at = now(), resolution_note = '영향 없음'
        WHERE id = ${signal!.id}
      `;

      // 판정을 되돌릴 수 있으면 언제 무엇을 알았고 어떻게 판단했나가 사라진다.
      await expect(
        fx.sql`
          UPDATE core.evidence_stale_signals SET resolution = 'open' WHERE id = ${signal!.id}
        `,
      ).rejects.toThrow(/이미 닫힌 신호/);
    });

    it("신호는 삭제할 수 없다", async () => {
      await seedPublishedRegistryEntry();
      const { claimId } = await seedClaim();
      await seedAttestation(claimId, "active");
      await fx.sql`
        UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
      `;

      await expect(
        fx.sql`DELETE FROM core.evidence_stale_signals WHERE resolution = 'open'`,
      ).rejects.toThrow(/삭제할 수 없다/);
    });
  });

  describe("신호 API", () => {
    async function openSignal(): Promise<string> {
      const entryId = randomUUID();
      await fx.sql`
        INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
        VALUES (${entryId}, ${fx.tenantA}, 'project', ${fx.projectA},
                ${`PRJ-${entryId.slice(0, 8)}`})
      `;
      await fx.sql`
        INSERT INTO core.registry_entry_versions (
          id, tenant_id, entry_id, version, status, public_projection,
          content_hash, source_snapshot_hash, policy_version, schema_version,
          serialization_version, published_at
        ) VALUES (
          ${randomUUID()}, ${fx.tenantA}, ${entryId}, 1, 'published', '{}'::jsonb,
          ${`0x${"77".repeat(32)}`}, ${`0x${"88".repeat(32)}`}, '1', '1', '1', now()
        )
      `;
      const { claimId } = await seedClaim();
      await seedAttestation(claimId, "active");
      await fx.sql`
        UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
      `;

      const [signal] = await fx.sql<{ id: string }[]>`
        SELECT id FROM core.evidence_stale_signals
        WHERE resolution = 'open' AND target_type = 'registry_entry_version'
        ORDER BY detected_at DESC LIMIT 1
      `;
      return signal!.id;
    }

    it("열린 신호와 다음 행동을 함께 반환한다", async () => {
      await openSignal();

      const response = await app.inject({
        method: "GET",
        url: `/api/v1/projects/${fx.projectA}/stale-signals`,
        headers: { authorization: `Bearer ${operator}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.openCount).toBeGreaterThan(0);

      const registrySignal = body.items.find(
        (item: { targetType: string }) => item.targetType === "registry_entry_version",
      );
      // 화면이 상태 문자열을 보고 추측하지 않게 서버가 정한다.
      expect(registrySignal.nextActions.join(" ")).toContain("세상이 보는 것이 바뀐다");
    });

    it("이유 없이 닫을 수 없다", async () => {
      const signalId = await openSignal();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/stale-signals/${signalId}/resolve`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { resolution: "dismissed", note: "" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("닫아도 대상은 바뀌지 않는다", async () => {
      const signalId = await openSignal();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/stale-signals/${signalId}/resolve`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { resolution: "revoked", note: "근거가 사라져 공개 기록을 내리기로 했다" },
      });

      expect(response.statusCode).toBe(200);
      // 한 번의 요청으로 두 가지 일이 일어나면 무엇이 실행됐는지 알 수 없다.
      expect(response.json().targetUnchanged).toBe(true);

      const [signal] = await fx.sql<{ target_id: string }[]>`
        SELECT target_id FROM core.evidence_stale_signals WHERE id = ${signalId}
      `;
      const [version] = await fx.sql<{ status: string }[]>`
        SELECT status::text FROM core.registry_entry_versions WHERE id = ${signal!.target_id}
      `;
      expect(version?.status).toBe("published");
    });

    it("두 번 닫을 수 없다", async () => {
      const signalId = await openSignal();
      const send = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/stale-signals/${signalId}/resolve`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
          payload: { resolution: "dismissed", note: "확인했다" },
        });

      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(409);
    });

    it("registry.revoke 권한이 없으면 닫을 수 없다", async () => {
      const signalId = await openSignal();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/stale-signals/${signalId}/resolve`,
        headers: {
          authorization: `Bearer ${await signIn(app, fx.stewardA)}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: { resolution: "dismissed", note: "확인" },
      });

      // dismissed도 공개 기록의 운명을 정하는 판단이다.
      expect(response.statusCode).toBe(403);
    });
  });
});