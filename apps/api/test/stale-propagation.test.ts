import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { idempotencyKey, setupFixture, signIn, testEnv, type TestFixture } from "./helpers/db.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Source change propagation — AC-04 · AC-21.
 *
 * The chain:
 *
 *   authority → connection → receipt → claim → attestation
 *
 * Migration 0020 builds the first two links and 0023 the last two. This file checks both
 * **that the chain reaches the end** and **that it leaves closed records untouched**.
 */
describeDb("stale propagation", () => {
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
    // Restore the connection. Each test triggers its own transition.
    await fx.sql`
      UPDATE core.source_connections SET state = 'active' WHERE id = ${fx.connectionA}
    `;
  });

  /** Creates one receipt and one claim backed by it. */
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
        -- A confirmation from a server-initiated lookup — 2026-09-10 audit A1.
        -- Without this flag the DB rejects it (api_confirmation_requires_server_collection).
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
        '{"note":"reviewed"}'::jsonb, 'legal_effect_not_determined', '{}'::jsonb, '1', '1',
        ${`0x${"33".repeat(32)}`}, ${`0x${"44".repeat(65)}`},
        ${fx.reviewerA.address.toLowerCase()}, now(), ${state}
      )
    `;
    return id;
  }

  it("flags the claims of a source when its connection goes down", async () => {
    const { claimId } = await seedClaim();

    await fx.sql`
      UPDATE core.source_connections SET state = 'degraded' WHERE id = ${fx.connectionA}
    `;

    const [claim] = await fx.sql<{ stale_since: Date | null; stale_reason: string | null }[]>`
      SELECT stale_since, stale_reason FROM core.claims WHERE id = ${claimId}
    `;

    expect(claim?.stale_since).not.toBeNull();
    // The reason must be kept alongside so the next person can judge.
    expect(claim?.stale_reason).toContain("degraded");
  });

  it("does not change the review state", async () => {
    const { claimId } = await seedClaim();

    await fx.sql`
      UPDATE core.source_connections SET state = 'disabled' WHERE id = ${fx.connectionA}
    `;

    const [claim] = await fx.sql<{ verification_state: string }[]>`
      SELECT verification_state FROM core.claims WHERE id = ${claimId}
    `;

    // The review did happen. What changed is the evidence it stood on.
    expect(claim?.verification_state).toBe("analyst_checked");
  });

  it("does not overwrite the time it first went stale", async () => {
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

  it("does not propagate a drop to access_confirmed", async () => {
    const { claimId } = await seedClaim();

    // The automated lookup path is gone; the evidence is not.
    await fx.sql`
      UPDATE core.source_connections SET state = 'access_confirmed' WHERE id = ${fx.connectionA}
    `;

    const [claim] = await fx.sql<{ stale_since: Date | null }[]>`
      SELECT stale_since FROM core.claims WHERE id = ${claimId}
    `;
    expect(claim?.stale_since).toBeNull();
  });

  it("marks the attestation covering a stale claim for re-review", async () => {
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

  it("leaves closed attestations untouched", async () => {
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

    // Touching closed records blurs "what was valid when".
    expect(rows.find((r) => r.id === revoked)?.state).toBe("revoked");
    expect(rows.find((r) => r.id === superseded)?.state).toBe("superseded");
  });

  it("does not affect claims from other sources", async () => {
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

  it("cannot mark stale without a reason", async () => {
    const { claimId } = await seedClaim();

    await expect(
      fx.sql`UPDATE core.claims SET stale_since = now() WHERE id = ${claimId}`,
    ).rejects.toThrow(/claims_stale_needs_reason/);
  });

  it("exposes claims without evidence through the view", async () => {
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

    // Not deleted or downgraded automatically. Their existence is the information.
    expect(rows).toHaveLength(1);
  });

  it("cannot use another tenant's receipt as evidence", async () => {
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
   * Last link — attestation → assessment · Registry version.
   *
   * Unlike the earlier links, the target is not modified: both tables are immutable, and a
   * public record must not be taken down automatically.
   */
  describe("evidence signals", () => {
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

    it("leaves a signal on the public version when an attestation goes stale", async () => {
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

    it("does not change the public version itself", async () => {
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

      // One broken connection must not make a public record disappear automatically.
      expect(version?.status).toBe("published");
      expect(version?.revoked_at).toBeNull();
    });

    it("cannot close a signal without a reason", async () => {
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

    it("cannot reopen a closed signal", async () => {
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
        SET resolution = 'dismissed', resolved_at = now(), resolution_note = 'no impact'
        WHERE id = ${signal!.id}
      `;

      // If a decision can be reversed, what was known when and how it was judged is lost.
      await expect(
        fx.sql`
          UPDATE core.evidence_stale_signals SET resolution = 'open' WHERE id = ${signal!.id}
        `,
      ).rejects.toThrow(/이미 닫힌 신호/);
    });

    it("cannot delete a signal", async () => {
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

  describe("signal API", () => {
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

    it("returns open signals with their next actions", async () => {
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
      // The server decides, so the UI does not guess from state strings.
      expect(registrySignal.nextActions.join(" ")).toContain("changes what the world sees");
    });

    it("cannot close without a reason", async () => {
      const signalId = await openSignal();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/stale-signals/${signalId}/resolve`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { resolution: "dismissed", note: "" },
      });

      expect(response.statusCode).toBe(400);
    });

    it("does not change the target when closing", async () => {
      const signalId = await openSignal();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/stale-signals/${signalId}/resolve`,
        headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
        payload: { resolution: "revoked", note: "evidence is gone; decided to take down the public record" },
      });

      expect(response.statusCode).toBe(200);
      // If one request does two things, it is unclear what was executed.
      expect(response.json().targetUnchanged).toBe(true);

      const [signal] = await fx.sql<{ target_id: string }[]>`
        SELECT target_id FROM core.evidence_stale_signals WHERE id = ${signalId}
      `;
      const [version] = await fx.sql<{ status: string }[]>`
        SELECT status::text FROM core.registry_entry_versions WHERE id = ${signal!.target_id}
      `;
      expect(version?.status).toBe("published");
    });

    it("cannot close twice", async () => {
      const signalId = await openSignal();
      const send = () =>
        app.inject({
          method: "POST",
          url: `/api/v1/stale-signals/${signalId}/resolve`,
          headers: { authorization: `Bearer ${operator}`, "idempotency-key": idempotencyKey() },
          payload: { resolution: "dismissed", note: "checked" },
        });

      expect((await send()).statusCode).toBe(200);
      expect((await send()).statusCode).toBe(409);
    });

    it("cannot close without the registry.revoke permission", async () => {
      const signalId = await openSignal();

      const response = await app.inject({
        method: "POST",
        url: `/api/v1/stale-signals/${signalId}/resolve`,
        headers: {
          authorization: `Bearer ${await signIn(app, fx.stewardA)}`,
          "idempotency-key": idempotencyKey(),
        },
        payload: { resolution: "dismissed", note: "checked" },
      });

      // dismissed is also a decision about the fate of a public record.
      expect(response.statusCode).toBe(403);
    });
  });
});