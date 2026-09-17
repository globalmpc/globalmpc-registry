import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import { connectIsolated } from "./helpers/isolated-db.js";
import { createExpirySweep } from "../src/document-expiry.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

/**
 * Document expiry sweep.
 *
 * A validity date passes with no request to notice it, so the worker asks. Two things are held
 * here: the sweep reaches what rests on an expired document, and it runs once per interval, not
 * once per loop cycle.
 */
describeDb("document expiry sweep", () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = await connectIsolated("document_expiry");
  });

  afterAll(async () => {
    await sql.end();
  });

  /** An expired permit and a plan that rests on it, in a tenant of their own. */
  async function seedExpiredPair(): Promise<{ permit: string; plan: string }> {
    const tenant = randomUUID();
    const org = randomUUID();
    const subject = randomUUID();
    const project = randomUUID();

    await sql`
      INSERT INTO core.tenants (id, slug, display_name)
      VALUES (${tenant}, ${`t-${tenant.slice(0, 8)}`}, 'Expiry tenant')
    `;
    await sql`
      INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
      VALUES (${org}, ${tenant}, 'Expiry org', 'MNG')
    `;
    await sql`
      INSERT INTO core.subjects (id, tenant_id, kind, display_name)
      VALUES (${subject}, ${tenant}, 'person', 'Steward')
    `;
    await sql`
      INSERT INTO core.projects (
        id, tenant_id, project_key, name, host_country_iso3, minerals, owner_organization_id
      ) VALUES (
        ${project}, ${tenant}, ${`EXP-${project.slice(0, 8)}`}, 'Expiry project', 'MNG',
        ARRAY['copper'], ${org}
      )
    `;

    const permit = randomUUID();
    const plan = randomUUID();
    for (const [id, validUntil] of [
      [permit, "2020-01-31"],
      [plan, null],
    ] as const) {
      await sql`
        INSERT INTO core.object_uploads (
          id, tenant_id, project_id, object_key, content_hash, byte_size, content_type,
          sensitivity, state, valid_until
        ) VALUES (
          ${id}, ${tenant}, ${project}, ${`quarantine/${id}`},
          ${`0x${id.replace(/-/g, "").padEnd(64, "0")}`}, 10, 'application/pdf',
          'restricted', 'quarantined', ${validUntil}::date
        )
      `;
    }

    await sql`
      INSERT INTO core.document_links (
        tenant_id, project_id, upstream_upload_id, downstream_upload_id, kind, origin, created_by
      ) VALUES (${tenant}, ${project}, ${permit}, ${plan}, 'depends_on', 'user', ${subject})
    `;

    return { permit, plan };
  }

  it("flags the expired document and what rests on it", async () => {
    const { permit, plan } = await seedExpiredPair();

    const result = await createExpirySweep(sql, 1000, () => 0)();
    expect(result.ran).toBe(true);
    expect(result.flagged).toBeGreaterThanOrEqual(2);

    const rows = await sql<{ upload_id: string; depth: number }[]>`
      SELECT upload_id, depth FROM core.document_impacts
      WHERE origin_upload_id = ${permit}
      ORDER BY depth
    `;
    expect(rows.map((row) => [row.upload_id, row.depth])).toEqual([
      [permit, 0],
      [plan, 1],
    ]);
  });

  it("runs once per interval, not once per loop cycle", async () => {
    let clock = 0;
    const sweep = createExpirySweep(sql, 1000, () => clock);

    expect((await sweep()).ran).toBe(true);
    clock = 500;
    expect((await sweep()).ran).toBe(false);
    clock = 1000;
    expect((await sweep()).ran).toBe(true);
  });
});
