import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { createCredentialExpirySweep } from "../src/credential-expiry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Credential expiry sweep — migration 0051.
 *
 * An expiry date passes without a row update, so no trigger sees it. Held here: the sweep moves
 * the attestations signed with an expired credential to re-review, leaves the credential row and
 * finished attestations alone, raises nothing new on a second run, and runs once per interval.
 */
describeDb("credential expiry sweep", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await connectIsolated("credential_expiry");
  });

  afterAll(async () => {
    await sql.end();
  });

  /** A credential that expired yesterday, with one active and one revoked attestation. */
  async function seedExpired(): Promise<{ credential: string; active: string; revoked: string }> {
    const tenant = randomUUID();
    const org = randomUUID();
    const subject = randomUUID();
    const project = randomUUID();
    const credential = randomUUID();
    const schema = randomUUID();

    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenant}, ${`t-${tenant.slice(0, 8)}`}, 'Credential tenant')
    `;
    await sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${org}, ${tenant}, 'Credential org', 'MNG')
    `;
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${tenant}, 'person', 'Reviewer')
    `;
    await sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${project}, ${tenant}, ${`CRD-${project.slice(0, 8)}`}, 'Credential project', 'MNG',
        ARRAY['copper'], ${org}
      )
    `;
    // Inserted already past its date: an INSERT fires no update trigger, as when a date lapses.
    await sql`
      INSERT INTO core.credentials (
        id, tenant_id, subject_id, organization_id, issuer_reference, credential_type,
        issued_at, expires_at, current_status
      ) VALUES (
        ${credential}, ${tenant}, ${subject}, ${org}, 'AusIMM', 'competent_person',
        now() - interval '2 years', now() - interval '1 day', 'valid'
      )
    `;
    await sql`
      INSERT INTO core.attestation_schemas (
        id, tenant_id, schema_key, schema_version, attestation_type, jurisdiction_profile, state
      ) VALUES (${schema}, ${tenant}, 'review', '1', 'professional_signoff', 'MNG', 'active')
    `;

    const ids: string[] = [];
    for (const state of ["active", "revoked"]) {
      const caseId = randomUUID();
      const assignment = randomUUID();
      const id = randomUUID();
      await sql`
        INSERT INTO core.verification_cases (id, tenant_id, project_id, schema_id, state)
        VALUES (${caseId}, ${tenant}, ${project}, ${schema}, 'draft')
      `;
      await sql`
        INSERT INTO core.assignments (id, tenant_id, case_id, subject_id, credential_id)
        VALUES (${assignment}, ${tenant}, ${caseId}, ${subject}, ${credential})
      `;
      await sql`
        INSERT INTO core.verification_attestations (
          id, tenant_id, case_id, assignment_id, credential_id, schema_id,
          attestation_type, claim_scope, evidence_snapshot_hash, limitations,
          credential_status_snapshot, method_version, policy_version,
          payload_hash, signature, signer_wallet_address, signed_at, state
        ) VALUES (
          ${id}, ${tenant}, ${caseId}, ${assignment}, ${credential}, ${schema},
          'professional_signoff', ARRAY[${randomUUID()}]::UUID[], ${`0x${"22".repeat(32)}`},
          'legal_effect_not_determined', '{"currentStatus":"valid"}'::jsonb, '1', '1',
          ${`0x${"33".repeat(32)}`}, ${`0x${"44".repeat(65)}`},
          ${`0x${"ab".repeat(20)}`}, now() - interval '1 year', ${state}
        )
      `;
      ids.push(id);
    }

    return { credential, active: ids[0]!, revoked: ids[1]! };
  }

  it("moves attestations signed with an expired credential to re-review, once", async () => {
    const { credential, active, revoked } = await seedExpired();

    const first = await createCredentialExpirySweep(sql, 1000, () => 0)();
    expect(first.ran).toBe(true);
    expect(first.flagged).toBeGreaterThanOrEqual(1);

    const rows = await sql<{ id: string; state: string; stale_reason: string | null }[]>`
      SELECT id, state, stale_reason FROM core.verification_attestations
      WHERE id IN (${active}, ${revoked})
    `;
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(active)?.state).toBe("stale_candidate");
    expect(byId.get(active)?.stale_reason).toContain("passed its expiry");
    // Finished records are not touched again.
    expect(byId.get(revoked)?.state).toBe("revoked");

    // The credential's status is not the sweep's to write.
    const [cred] = await sql<{ current_status: string }[]>`
      SELECT current_status FROM core.credentials WHERE id = ${credential}
    `;
    expect(cred?.current_status).toBe("valid");

    const second = await createCredentialExpirySweep(sql, 1000, () => 0)();
    expect(second.flagged).toBe(0);
  });

  it("runs once per interval, not once per loop cycle", async () => {
    let clock = 0;
    const sweep = createCredentialExpirySweep(sql, 1000, () => clock);

    expect((await sweep()).ran).toBe(true);
    clock = 500;
    expect((await sweep()).ran).toBe(false);
    clock = 1000;
    expect((await sweep()).ran).toBe(true);
  });
});
