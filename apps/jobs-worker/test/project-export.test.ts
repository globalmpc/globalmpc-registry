import { createHash, randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { buildMerkleTree, canonicalize, verifyMerkleProof, type Hex } from "@mpc/canonical";
import { connectIsolated } from "./helpers/isolated-db.js";
import {
  assembleExportPackage,
  buildProjectExport,
  projectExportHandler,
  type ExportJob,
  type ExportRecords,
} from "../src/project-export.js";
import { createDispatcher, publishBatch } from "../src/outbox-publisher.js";

const describeDb = process.env["DATABASE_URL"] ? describe : describe.skip;

const hex32 = (byte: string) => `0x${byte.repeat(32)}` as Hex;
const randomHex32 = () => `0x${randomBytes(32).toString("hex")}` as Hex;

function job(clearance: string[]): ExportJob {
  return {
    id: randomUUID(),
    tenant_id: randomUUID(),
    project_id: randomUUID(),
    requested_by_subject_id: randomUUID(),
    requested_by_wallet: `0x${"ab".repeat(20)}`,
    sensitivity_clearance: clearance,
    state: "queued",
    requested_at: new Date("2026-09-01T00:00:00Z"),
  };
}

const records: ExportRecords = {
  project: { id: "p-1", projectKey: "MN-01" },
  registryVersions: [],
  attestations: [
    {
      id: "a-1",
      case_id: "c-1",
      attestation_type: "resource_estimate",
      state: "signed",
      payload_hash: hex32("11"),
      limitations: "Drill spacing is wide.",
      signer_wallet_address: `0x${"cd".repeat(20)}`,
      findings: [{ secret: "reviewer notes" }],
      signed_at: new Date("2026-08-01T00:00:00Z"),
    },
  ],
  sourceReceipts: [
    { id: "r-public", disclosure_permission: "public", raw_hash: hex32("22"), result: "confirmed_from_source", query_basis: { owner: "x" }, raw_object_key: "raw/1" },
    { id: "r-restricted", disclosure_permission: "restricted", raw_hash: hex32("33") },
  ],
  gateDecisions: [],
  anchorLeaves: [],
  batchLeaves: new Map(),
};

describe("export package assembly", () => {
  it("never copies findings, query bases or object keys", () => {
    const { pkg } = assembleExportPackage(job(["public", "restricted"]), records, new Date());
    const text = JSON.stringify(pkg);

    expect(text).not.toContain("reviewer notes");
    expect(text).not.toContain("raw/1");
    expect(text).not.toContain("query_basis");
    expect(text).not.toContain('"owner"');
  });

  it("reduces what the requester's clearance does not cover", () => {
    const { pkg } = assembleExportPackage(job(["public"]), records, new Date());

    expect(pkg.sections["sourceReceipts"]).toEqual([
      expect.objectContaining({ id: "r-public", redacted: false, rawHash: hex32("22") }),
      { id: "r-restricted", disclosurePermission: "restricted", redacted: true },
    ]);
    expect(pkg.sections["attestations"]?.[0]).toMatchObject({
      payloadHash: hex32("11"),
      limitations: null,
      signerWalletAddress: null,
    });
    const receipts = (pkg.manifest["sections"] as { name: string; redacted: string }[]).find(
      (section) => section.name === "sourceReceipts",
    );
    expect(receipts?.redacted).toBe("1");
  });

  it("keeps restricted fields for a restricted clearance", () => {
    const { pkg } = assembleExportPackage(job(["public", "restricted"]), records, new Date());

    expect(pkg.sections["attestations"]?.[0]).toMatchObject({
      limitations: "Drill spacing is wide.",
    });
    expect(pkg.sections["sourceReceipts"]?.[1]).toMatchObject({ redacted: false });
  });

  it("the manifest hashes each section and itself over the canonical form", () => {
    const { pkg, manifestHash } = assembleExportPackage(job(["public"]), records, new Date());
    const sha = (value: unknown) =>
      createHash("sha256").update(canonicalize(value as never), "utf8").digest("hex");

    const sections = pkg.manifest["sections"] as { name: string; sha256: string }[];
    for (const section of sections) {
      expect(section.sha256).toBe(sha(pkg.sections[section.name]));
    }
    expect(manifestHash).toBe(sha(pkg.manifest));
  });
});

describeDb("export build", () => {
  let sql: postgres.Sql;
  const tenant = randomUUID();
  const project = randomUUID();
  const subject = randomUUID();
  const versionId = randomUUID();
  const leaf = hex32("aa");
  const sibling = hex32("bb");

  beforeAll(async () => {
    sql = await connectIsolated("project_export");
    const org = randomUUID();
    await sql`INSERT INTO core.tenants (id, slug, display_name)
              VALUES (${tenant}, ${`e-${tenant.slice(0, 8)}`}, 'export test')`;
    await sql`INSERT INTO core.organizations (id, tenant_id, legal_name, jurisdiction)
              VALUES (${org}, ${tenant}, 'Org', 'MNG')`;
    await sql`INSERT INTO core.subjects (id, tenant_id, kind, display_name)
              VALUES (${subject}, ${tenant}, 'person', 'Requester')`;
    await sql`INSERT INTO core.projects (id, tenant_id, project_key, name, host_country_iso3, owner_organization_id)
              VALUES (${project}, ${tenant}, ${`K-${project.slice(0, 6)}`}, 'Export', 'MNG', ${org})`;

    const entry = randomUUID();
    await sql`INSERT INTO core.registry_entries (id, tenant_id, registry_type, subject_id, public_key)
              VALUES (${entry}, ${tenant}, 'project', ${project}, ${`pk-${entry}`})`;
    await sql`
      INSERT INTO core.registry_entry_versions (
        id, tenant_id, entry_id, version, status, public_projection, content_hash,
        source_snapshot_hash, policy_version, schema_version, published_at
      ) VALUES (
        ${versionId}, ${tenant}, ${entry}, 1, 'published', '{"name":"Export","holes":3}'::jsonb,
        ${hex32("cc")}, ${hex32("dd")}, 'p1', 's1', now()
      )
    `;

    const batch = randomUUID();
    const root = buildMerkleTree([leaf, sibling]).root;
    await sql`
      INSERT INTO chain.anchor_batches (
        id, tenant_id, batch_id, merkle_root, manifest_hash, manifest_object_key,
        schema_version, record_count
      ) VALUES (${batch}, ${tenant}, ${randomHex32()}, ${root}, ${hex32("ff")}, 'm.json', '1', 2)
    `;
    // The sibling belongs to another version; only the leaf set matters for the proof.
    const other = randomUUID();
    await sql`
      INSERT INTO core.registry_entry_versions (
        id, tenant_id, entry_id, version, status, source_snapshot_hash, policy_version, schema_version
      ) VALUES (${other}, ${tenant}, ${entry}, 2, 'draft', ${hex32("dd")}, 'p1', 's1')
    `;
    await sql`INSERT INTO chain.anchor_batch_leaves (batch_id, leaf_hash, entry_version_id, leaf_index)
              VALUES (${batch}, ${leaf}, ${versionId}, 0), (${batch}, ${sibling}, ${other}, 1)`;
    await sql`INSERT INTO chain.transactions (id, tenant_id, batch_id, intent_key, chain_id, state, tx_hash, block_number, block_hash)
              VALUES (${randomUUID()}, ${tenant}, ${batch}, ${`anchor:${batch}`}, 31337, 'confirmed', ${randomHex32()}, 42, ${randomHex32()})`;
  });

  afterAll(async () => {
    await sql.end();
  });

  async function newJob(): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO core.project_exports (
        id, tenant_id, project_id, requested_by_subject_id, requested_by_wallet,
        sensitivity_clearance
      ) VALUES (${id}, ${tenant}, ${project}, ${subject}, ${`0x${"ab".repeat(20)}`}, '{public}')
    `;
    return id;
  }

  it("builds a package whose anchor proof verifies against the batch root", async () => {
    const id = await newJob();

    // Built as the worker role: the grants in 0067 are what production has.
    const role = await sql.reserve();
    try {
      await role`SET ROLE mpc_worker`;
      expect(await buildProjectExport(role as unknown as postgres.Sql, id)).toBe("built");
    } finally {
      await role`RESET ROLE`;
      role.release();
    }

    const [stored] = await sql<{ state: string; package: Record<string, any>; manifest_hash: string }[]>`
      SELECT state, package, manifest_hash FROM core.project_exports WHERE id = ${id}
    `;
    expect(stored!.state).toBe("succeeded");
    expect(stored!.manifest_hash).toMatch(/^[0-9a-f]{64}$/);

    const proof = stored!.package["sections"]["anchorProofs"].find(
      (item: { entryVersionId: string }) => item.entryVersionId === versionId,
    );
    expect(proof).toMatchObject({
      entryVersionId: versionId,
      leafHash: leaf,
      transactionState: "confirmed",
      blockNumber: "42",
    });
    expect(verifyMerkleProof(leaf, proof.proof, proof.merkleRoot)).toBe(true);

    const versions = stored!.package["sections"]["registryVersions"] as Record<string, unknown>[];
    // Numbers inside projections become strings — the canonical profile has none.
    expect(versions.find((item) => item["status"] === "published")?.["publicProjection"]).toEqual({
      name: "Export",
      holes: "3",
    });
    // A draft's projection is not public yet.
    expect(versions.find((item) => item["status"] === "draft")?.["publicProjection"]).toBeNull();
  });

  it("a second delivery of the same request keeps the first package", async () => {
    const id = await newJob();
    await buildProjectExport(sql, id);
    const [first] = await sql<{ manifest_hash: string }[]>`
      SELECT manifest_hash FROM core.project_exports WHERE id = ${id}`;

    expect(await buildProjectExport(sql, id, () => new Date("2030-01-01T00:00:00Z"))).toBe(
      "already_built",
    );
    const [second] = await sql<{ manifest_hash: string }[]>`
      SELECT manifest_hash FROM core.project_exports WHERE id = ${id}`;
    expect(second!.manifest_hash).toBe(first!.manifest_hash);
  });

  it("marks the job failed when its event is dead-lettered", async () => {
    await sql`TRUNCATE core.outbox, core.inbox`;
    const id = randomUUID();
    await sql`
      INSERT INTO core.project_exports (
        id, tenant_id, project_id, requested_by_subject_id, requested_by_wallet, sensitivity_clearance
      ) VALUES (${id}, ${tenant}, ${project}, ${subject}, ${`0x${"ab".repeat(20)}`}, '{public}')
    `;
    await sql`
      INSERT INTO core.outbox (id, tenant_id, event_type, aggregate_id, aggregate_version, payload, correlation_id)
      VALUES (${randomUUID()}, ${tenant}, 'project.export.requested', ${id}, 1,
              ${sql.json({ exportId: id, projectId: project })}, 'dead-export')
    `;
    const handler = projectExportHandler(sql);
    const broken = { ...handler, handle: async () => { throw new Error("storage down"); } };
    const dispatcher = createDispatcher(sql, [broken]);

    await publishBatch(sql, dispatcher.publish, {
      maxAttempts: 1,
      onDeadLetter: dispatcher.onDeadLetter,
    });

    const [failed] = await sql<{ state: string; failure_reason: string; completed_at: Date | null }[]>`
      SELECT state, failure_reason, completed_at FROM core.project_exports WHERE id = ${id}`;
    expect(failed).toMatchObject({ state: "failed", failure_reason: "EXPORT_BUILD_FAILED" });
    expect(failed!.completed_at).toBeInstanceOf(Date);
  });
});
