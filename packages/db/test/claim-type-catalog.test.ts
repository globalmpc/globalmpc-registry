import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../src/migrate.js";
import { withActor } from "../src/session.js";

const url = process.env["DATABASE_URL"];
const describeDb = url ? describe : describe.skip;

describeDb("reviewed claim type catalog", () => {
  let admin: postgres.Sql;
  let app: postgres.Sql;
  const proposer = randomUUID();
  const decider = randomUUID();
  const effectiveFrom = "2026-01-01T00:00:00Z";
  const definition = { fields: [{ key: "number", label: "Number", type: "string", required: true }] };

  beforeAll(async () => {
    admin = postgres(url!, { onnotice: () => {} });
    await runMigrations(admin);
    await admin.unsafe(`DO $$ BEGIN
      CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login;`);
    const appUrl = new URL(url!);
    appUrl.username = "mpc_app_login";
    appUrl.password = "app";
    app = postgres(appUrl.toString(), { onnotice: () => {} });
    for (const id of [proposer, decider]) {
      await admin`INSERT INTO core.subjects (id, kind, display_name)
        VALUES (${id}, 'person', 'Reviewer')`;
    }
  });

  afterAll(async () => { await app?.end(); await admin?.end(); });

  async function materialize(key: string, options: {
    approve?: boolean; decisionBy?: string; mismatched?: boolean; version?: number; effectiveFrom?: string;
  } = {}) {
    const effective = options.effectiveFrom ?? effectiveFrom;
    const id = randomUUID();
    const proposalId = randomUUID();
    const payload = { claimType: key, displayName: "License", description: null, definition };
    await withActor(app, { subjectId: proposer }, async (tx) => {
      await tx`INSERT INTO core.registry_proposals
        (id, kind, item_key, item_version, payload, rationale, effective_from, proposed_by_subject_id)
        VALUES (${proposalId}, 'claim_type', ${key}, ${options.version ?? 1},
          ${tx.json(payload)}, 'Reviewed field definition', ${effective}, ${proposer})`;
      await tx`INSERT INTO core.claim_types
        (id, claim_type, catalog_version, display_name, description, definition, effective_from)
        VALUES (${id}, ${key}, ${options.version ?? 1},
          ${options.mismatched ? "Different" : "License"}, NULL, ${tx.json(definition)}, ${effective})`;
      if (options.approve !== false) {
        await tx`UPDATE core.registry_proposals SET state = 'approved',
          decided_by_subject_id = ${options.decisionBy ?? decider}, decided_at = now(),
          decision_reason = 'Verified', materialized_id = ${id}, version = version + 1
          WHERE id = ${proposalId}`;
      }
    });
    return id;
  }

  it("accepts reviewed definitions and hides them from an unknown actor", async () => {
    const id = await materialize("reviewed_license");
    const own = await withActor(app, { subjectId: proposer }, (tx) => tx`
      SELECT id, definition FROM core.claim_types WHERE id = ${id}`);
    expect(own).toHaveLength(1);
    expect(own[0]?.["definition"]).toEqual(definition);
    const other = await withActor(app, { subjectId: randomUUID() }, (tx) => tx`
      SELECT id FROM core.claim_types WHERE id = ${id}`);
    expect(other).toHaveLength(0);
  });

  it("rejects pending proposals, self-approval, and mismatched reviewed content", async () => {
    await expect(materialize("pending_license", { approve: false })).rejects.toThrow(/approved proposal/);
    await expect(materialize("self_license", { decisionBy: proposer })).rejects.toThrow(/two_person/);
    await expect(materialize("mismatch_license", { mismatched: true })).rejects.toThrow(/matching its content/);
  });

  it("preserves approved versions and rejects skipped version numbers", async () => {
    const id = await materialize("versioned_license");
    await materialize("versioned_license", { version: 2 });
    await expect(materialize("versioned_license", {
      version: 3, effectiveFrom: "2025-01-01T00:00:00Z",
    })).rejects.toThrow(/before its predecessor/);
    await expect(materialize("versioned_license", { version: 4 })).rejects.toThrow(/consecutive/);
    await expect(withActor(app, { subjectId: proposer }, (tx) => tx`
      UPDATE core.claim_types SET display_name = 'Changed' WHERE id = ${id}`)).rejects.toThrow();
    await expect(withActor(app, { subjectId: proposer }, (tx) => tx`
      DELETE FROM core.claim_types WHERE id = ${id}`)).rejects.toThrow();
    // CASCADE reaches the truncate guard even when claims reference the catalog. Roll back
    // unconditionally so a broken guard cannot destroy shared integration fixtures.
    const beforeTruncate = await admin`SELECT id FROM core.claim_types WHERE id = ${id}`;
    await expect(admin.begin(async (tx) => {
      await tx.unsafe('TRUNCATE core.claim_types CASCADE');
      throw new Error("Catalog truncate guard did not reject the statement");
    })).rejects.toThrow(/TRUNCATE rejected/);
    expect(await admin`SELECT id FROM core.claim_types WHERE id = ${id}`).toEqual(beforeTruncate);
    await expect(admin`DELETE FROM core.claim_types WHERE id = ${id}`).rejects.toThrow(/cannot be modified/);
    await expect(admin`UPDATE core.claim_types SET display_name = 'Changed' WHERE id = ${id}`)
      .rejects.toThrow(/cannot be modified/);
  });

  it("rejects writes without a live actor", async () => {
    await expect(withActor(app, { subjectId: randomUUID() }, (tx) => tx`
      INSERT INTO core.claim_types
        (id, claim_type, catalog_version, display_name, definition, effective_from)
        VALUES (${randomUUID()}, 'unknown_actor', 1, 'License', ${tx.json(definition)}, ${effectiveFrom})`
    )).rejects.toThrow(/row-level security/);
  });

  it("does not give an RLS-bypassing non-superuser role INSERT", async () => {
    const rows = await admin`SELECT rolname FROM pg_roles
      WHERE rolbypassrls AND NOT rolsuper
        AND has_table_privilege(oid, 'core.claim_types', 'INSERT')`;
    expect(rows).toHaveLength(0);
  });
});
