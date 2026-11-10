import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type postgres from "postgres";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { withTenant } from "@mpc/db";
import { hashProjection } from "@mpc/canonical";
import { publicProjection } from "@mpc/api-contract";
import { evidenceKey, quarantineKey, type ObjectStore } from "@mpc/storage";
import type { AppConfig } from "./config.js";
import { requireDeploymentOwner } from "./deploy-authority.js";
import { buildEvidenceSnapshot } from "./services/evidence-snapshot.js";
import { assignReviewer } from "./services/assignment.js";
import { reassessClaim, recomputeGrade, setProvenanceCause } from "./services/claim-state.js";
import { buildTypedData, hashAttestationPayload, newSignatureNonce, uuidToBytes32 } from "./services/attestation-signing.js";
import { resolvePublicationSubject } from "./services/registry-publication.js";
import { versionsInForce } from "./services/attestation-basis.js";
import { lockProjectRestrictions } from "./restrictions.js";

export const DEMO_LIMITATION = "SYNTHETIC DEV DEMO ONLY: simulated review, no real professional approval, official-source confirmation, legal rights or investment assurance.";
// Fixture issuers/credentials cannot back the application's real mining-right claim type.
const claimType = "synthetic_dev_demo_licence";
const scenarios = ["INPUT", "REVIEW", "PUBLIC"] as const;
type Scenario = typeof scenarios[number];
type Tx = postgres.TransactionSql;
export class DemoSeedError extends Error {}

export function assertDemoEnvironment(environment: string, chainId: string): void {
  if (environment !== "develop" || chainId !== "5611") {
    throw new DemoSeedError("Demo seed requires develop on opBNB testnet 5611");
  }
}

/** Stable, tenant-scoped fixture identities; never a source of signing keys. */
function id(tenant: string, name: string): string {
  const hex = createHash("sha256").update(`registry-dev-demo-v1:${tenant}:${name}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function audit(tx: Tx, tenant: string, project: string, command: string): Promise<void> {
  await tx`INSERT INTO audit.events
    (tenant_id,project_id,effective_role,command,resource_type,resource_id,reason,correlation_id,detail)
    VALUES (${tenant},${project},'deploy_bound',${command},'project',${project},${DEMO_LIMITATION},${randomUUID()},
      '{"synthetic":true,"seedVersion":"1","humanApproval":false}')`;
}

async function assertPristinePartial(tx: Tx, tenant: string, project: string, owner: string, scenario: Scenario): Promise<void> {
  // Lock the parent before inspecting children; normal child inserts take its FK key-share
  // lock. Restriction writers also share this advisory lock, as in the publication route.
  const [row] = await tx`SELECT * FROM core.projects WHERE tenant_id=${tenant} AND id=${project} FOR UPDATE`;
  if (!row || row.version !== 1 || row.lifecycle_state !== 'draft' || row.owner_organization_id !== owner ||
      row.reference_status !== 'synthetic_test_project' || row.name !== `SYNTHETIC DEMO — ${scenario.toLowerCase()}`) {
    throw new DemoSeedError("Incomplete demo was edited; seed stopped without replacing it");
  }
  await lockProjectRestrictions(tx, tenant, project);
  const [activity] = await tx<{ changed: boolean }[]>`SELECT
    EXISTS(SELECT 1 FROM core.claims WHERE tenant_id=${tenant} AND project_id=${project}) OR
    EXISTS(SELECT 1 FROM core.artifacts WHERE tenant_id=${tenant} AND project_id=${project}) OR
    EXISTS(SELECT 1 FROM core.source_receipts WHERE tenant_id=${tenant} AND project_id=${project}) OR
    EXISTS(SELECT 1 FROM core.project_fact_versions WHERE tenant_id=${tenant} AND project_id=${project}) OR
    EXISTS(SELECT 1 FROM core.disclosure_restrictions WHERE tenant_id=${tenant} AND project_id=${project}) OR
    EXISTS(SELECT 1 FROM core.object_uploads WHERE tenant_id=${tenant} AND project_id=${project} AND id<>${id(tenant, `${scenario}:upload`)})
    AS changed`;
  if (activity?.changed) throw new DemoSeedError("Incomplete demo has user activity or restrictions; seed stopped without replacing it");
}

export interface DemoOptions {
  environment: string;
  chainId: string;
  tenantSlug: string;
  ownerOrganizationName?: string;
  scanTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Add only absent scenarios. No login credentials, roles, sessions or authenticators are provisioned. */
export async function seedDevDemo(sql: postgres.Sql, store: ObjectStore, options: DemoOptions): Promise<{ created: string[]; skipped: string[] }> {
  assertDemoEnvironment(options.environment, options.chainId);
  await requireDeploymentOwner(sql);
  const [tenant] = await sql<{ id: string }[]>`SELECT id FROM core.tenants WHERE slug=${options.tenantSlug}`;
  if (!tenant) throw new DemoSeedError("Demo tenant must already exist");
  const tenantId = tenant.id;
  const connection = await sql.reserve();
  const lock = `dev-demo-v1:${tenantId}`;
  try {
    // A session lock keeps concurrent deploys apart without hiding quarantined rows from workers.
    await connection`SELECT pg_advisory_lock(hashtextextended(${lock},0))`;
    const owners = await withTenant(sql, { tenantId }, async tx => options.ownerOrganizationName
      ? tx<{ id: string }[]>`SELECT id FROM core.organizations WHERE tenant_id=${tenantId} AND legal_name=${options.ownerOrganizationName}`
      : tx<{ id: string }[]>`SELECT DISTINCT o.id FROM core.organizations o
          JOIN core.role_bindings r ON r.organization_id=o.id AND r.tenant_id=o.tenant_id
          WHERE o.tenant_id=${tenantId} AND r.role='mpc_operator' AND r.revoked_at IS NULL`);
    if (owners.length !== 1) throw new DemoSeedError("Demo owner is missing or ambiguous; configure DEMO_OWNER_ORGANIZATION_NAME");
    const result = { created: [] as string[], skipped: [] as string[] };
    for (const scenario of scenarios) {
      const projectId = id(tenantId, scenario);
      const projectKey = `DEMO-V1-${scenario}-${tenantId}`;
      const state = await withTenant(sql, { tenantId }, async tx => {
        const [done] = await tx`SELECT 1 FROM audit.events WHERE tenant_id=${tenantId}
          AND resource_id=${projectId} AND command='dev_demo.completed'`;
        if (done) return "done";
        const existing = await tx`SELECT id,reference_status,owner_organization_id FROM core.projects
          WHERE tenant_id=${tenantId} AND (id=${projectId} OR project_key=${projectKey})`;
        const [started] = await tx`SELECT 1 FROM audit.events WHERE tenant_id=${tenantId}
          AND resource_id=${projectId} AND command='dev_demo.started'`;
        if (existing.length) {
          if (!started || existing.length !== 1 || existing[0]!.id !== projectId ||
              existing[0]!.reference_status !== "synthetic_test_project" || existing[0]!.owner_organization_id !== owners[0]!.id) {
            throw new DemoSeedError(`Demo identity collision or edited incomplete scenario: ${projectKey}`);
          }
          await assertPristinePartial(tx, tenantId, projectId, owners[0]!.id, scenario);
          return "resume";
        }
        return "new";
      });
      if (state === "done") { result.skipped.push(projectKey); continue; }
      const uploadId = id(tenantId, `${scenario}:upload`);
      if (state === "new") {
        const object = scenario === "INPUT" ? null : await store.put(quarantineKey(tenantId, uploadId),
          Buffer.from(`${DEMO_LIMITATION}\n${projectKey}\nSynthetic licence DEMO-0001\n`), "text/plain");
        await withTenant(sql, { tenantId }, async tx => {
          await tx`INSERT INTO core.projects (id,tenant_id,project_key,name,host_country_iso3,minerals,reference_status,owner_organization_id)
            VALUES (${projectId},${tenantId},${projectKey},${`SYNTHETIC DEMO — ${scenario.toLowerCase()}`},'MNG',ARRAY['copper'],'synthetic_test_project',${owners[0]!.id})`;
          await audit(tx, tenantId, projectId, "dev_demo.started");
          if (object) await tx`INSERT INTO core.object_uploads
            (id,tenant_id,project_id,object_key,content_hash,byte_size,content_type,original_filename,sensitivity,state)
            VALUES (${uploadId},${tenantId},${projectId},${object.key},${object.contentHash},${object.byteSize},'text/plain',${`${projectKey}-SYNTHETIC.txt`},'public','quarantined')`;
        });
      }
      if (scenario !== "INPUT") {
        const deadline = Date.now() + (options.scanTimeoutMs ?? 180_000);
        for (;;) {
          const upload = await withTenant(sql, { tenantId }, async tx => {
            const [row] = await tx<{ state: string }[]>`SELECT state FROM core.object_uploads
              WHERE tenant_id=${tenantId} AND id=${uploadId}`;
            return row;
          });
          if (!upload) throw new DemoSeedError(`Demo upload missing: ${projectKey}`);
          if (upload.state === "scanned_clean") break;
          if (upload.state !== "quarantined") throw new DemoSeedError(`Demo upload did not pass scanning: ${projectKey}`);
          if (Date.now() >= deadline) throw new DemoSeedError(`Demo scan timeout: ${projectKey}; rerun to resume`);
          await delay(options.pollIntervalMs ?? 2000);
        }
      }
      await withTenant(sql, { tenantId }, async tx => {
        await assertPristinePartial(tx, tenantId, projectId, owners[0]!.id, scenario);
        // The scan is a live worker result. Check it again under a row lock before promotion.
        if (scenario !== "INPUT") await finishEvidence(tx, store, tenantId, projectId, uploadId, scenario);
        await audit(tx, tenantId, projectId, "dev_demo.completed");
      });
      result.created.push(projectKey);
    }
    return result;
  } finally {
    try { await connection`SELECT pg_advisory_unlock(hashtextextended(${lock},0))`; }
    finally { connection.release(); }
  }
}

async function finishEvidence(tx: Tx, store: ObjectStore, tenant: string, project: string, uploadId: string, scenario: Scenario): Promise<void> {
  const [clock] = await tx<{ at: Date }[]>`SELECT now() AS at`;
  const credentialIssuedAt = new Date(clock!.at.getTime()-86400_000);
  const [upload] = await tx<{ state: string; object_key: string; content_hash: string }[]>`
    SELECT state,object_key,content_hash FROM core.object_uploads WHERE tenant_id=${tenant} AND id=${uploadId} FOR UPDATE`;
  if (upload?.state !== "scanned_clean") throw new DemoSeedError("Demo evidence requires an actual clean scan");
  const artifact = id(tenant, `${scenario}:artifact`);
  await store.copy(upload.object_key, evidenceKey(tenant, artifact));
  await tx`INSERT INTO core.artifacts(id,tenant_id,project_id,kind,content_hash,object_key,sensitivity)
    VALUES (${artifact},${tenant},${project},'raw_source',${upload.content_hash},${evidenceKey(tenant, artifact)},'public')`;
  await tx`UPDATE core.object_uploads SET state='promoted',promoted_artifact_id=${artifact},version=version+1 WHERE id=${uploadId}`;
  const reviewer = id(tenant, `${scenario}:reviewer`);
  const proposer = id(tenant, `${scenario}:proposer`);
  const approver = id(tenant, `${scenario}:approver`);
  const organization = id(tenant, `${scenario}:review-organization`);
  const issuer = id(tenant, `${scenario}:issuer`);
  const credential = id(tenant, `${scenario}:credential`);
  const schema = id(tenant, `${scenario}:schema`);
  await tx`INSERT INTO core.organizations(id,tenant_id,legal_name,jurisdiction)
    VALUES (${organization},${tenant},${`SYNTHETIC DEMO ${scenario} reviewer`},'MNG')`;
  for (const [subject, name] of [[reviewer, "reviewer"], [proposer, "proposer"], [approver, "approver"]] as const) {
    await tx`INSERT INTO core.subjects(id,tenant_id,kind,display_name)
      VALUES (${subject},${tenant},'person',${`SYNTHETIC DEMO ${scenario} ${name} (fixture, no login)`})`;
  }
  const claim = id(tenant, `${scenario}:claim`);
  await tx`INSERT INTO core.claims(id,tenant_id,project_id,claim_type,value_text,source_coordinate,evidence_tier,as_of,submitted_by)
    VALUES (${claim},${tenant},${project},${claimType},'SYNTHETIC DEMO-0001',
      '{"reference":"Synthetic generated document; not an official licence"}','P1',current_date,${proposer})`;
  await tx`INSERT INTO core.lineage_edges(id,tenant_id,from_id,to_id,relation_type)
    VALUES (${randomUUID()},${tenant},${artifact},${claim},'supports')`;
  await setProvenanceCause(tx, "dev_demo.synthetic_fixture", null);
  await recomputeGrade(tx, claim);
  await tx`INSERT INTO core.authorities(id,tenant_id,name,jurisdiction,proves,does_not_prove,recognized_scope,verification_method,public_disclosure_level,valid_from,state)
    VALUES (${issuer},${tenant},${`SYNTHETIC DEMO ${scenario} issuer`},'MNG',ARRAY['synthetic_review'],ARRAY['real_professional_accreditation','official_mining_rights'],
      ${[claimType]}::text[],'synthetic_fixture_only','public',current_date-1,'accepted')`;
  await tx`INSERT INTO core.credentials(id,tenant_id,subject_id,organization_id,issuer_reference,issuer_authority_id,credential_type,credential_scope,jurisdiction,issued_at,current_status)
    VALUES (${credential},${tenant},${reviewer},${organization},${`SYNTHETIC-DEMO-${scenario}`},${issuer},'competent_person',${[claimType]}::text[],ARRAY['MNG'],${credentialIssuedAt},'valid')`;
  await tx`INSERT INTO core.attestation_schemas(id,tenant_id,schema_key,schema_version,attestation_type,required_evidence,accepted_authority_types,mandatory_limitations,jurisdiction_profile,state)
    VALUES (${schema},${tenant},${`dev-demo-v1-${scenario.toLowerCase()}`},'1','professional_signoff',${[claimType]}::text[],ARRAY['synthetic_fixture_only'],${[DEMO_LIMITATION]}::text[],'MNG','active')`;
  // Retain explicit fixture proposal histories even for a table owner without BYPASSRLS.
  for (const [kind, materialized, key, payload] of [
    ["credential", credential, `${reviewer}/SYNTHETIC-DEMO-${scenario}`, {
      subjectId: reviewer, issuerReference: `SYNTHETIC-DEMO-${scenario}`, issuerAuthorityId: issuer,
      credentialType: "competent_person", credentialScope: [claimType], jurisdiction: ["MNG"],
      organizationId: organization, issuedAt: credentialIssuedAt.toISOString(), expiresAt: null,
    }],
    ["attestation_schema", schema, `dev-demo-v1-${scenario.toLowerCase()}`, {
      schemaKey: `dev-demo-v1-${scenario.toLowerCase()}`, schemaVersion: "1", attestationType: "professional_signoff",
      requiredEvidence: [claimType], acceptedAuthorityTypes: ["synthetic_fixture_only"],
      mandatoryLimitations: [DEMO_LIMITATION], jurisdictionProfile: "MNG", effectiveFrom: clock!.at.toISOString(),
    }],
  ] as const) {
    const proposal = randomUUID();
    await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
      VALUES (${proposal},${tenant},${kind},${key},1,${tx.json(payload as never)},${DEMO_LIMITATION},${kind === 'credential' ? credentialIssuedAt : clock!.at},${proposer})`;
    await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${approver},decided_at=now(),
      decision_reason=${DEMO_LIMITATION},materialized_id=${materialized},version=2 WHERE id=${proposal}`;
  }
  const snapshot = await buildEvidenceSnapshot(tx, project, [claim]);
  const caseId = id(tenant, `${scenario}:case`);
  await tx`INSERT INTO core.verification_cases(id,tenant_id,project_id,schema_id,state,evidence_snapshot_hash)
    VALUES (${caseId},${tenant},${project},${schema},'assigned',${snapshot.hash})`;
  await tx`INSERT INTO core.verification_case_claims(tenant_id,case_id,claim_id) VALUES (${tenant},${caseId},${claim})`;
  const assignment = await assignReviewer(tx, { tenantId: tenant, caseId, projectId: project,
    claimIds: [claim], reviewerSubjectId: reviewer, credentialId: credential, conflictStatus: "none", assignerSubjectId: proposer });
  const attestation = id(tenant, `${scenario}:attestation`);
  const payload = { findings: [{ result: "Synthetic workflow simulation only" }], citations: [{ document: uploadId }], limitations: DEMO_LIMITATION, claimScope: [claim] };
  const payloadHash = hashAttestationPayload(payload);
  const account = privateKeyToAccount(generatePrivateKey());
  await tx`INSERT INTO core.wallet_identities(id,tenant_id,subject_id,wallet_address,chain_id,assurance_level,bound_at)
    VALUES (${randomUUID()},${tenant},${reviewer},${account.address.toLowerCase()},5611,'wallet_only',now())`;
  const issuedAt = BigInt(Math.floor(clock!.at.getTime() / 1000));
  const nonce = newSignatureNonce();
  const message = { attestationId: uuidToBytes32(attestation), schemaId: uuidToBytes32(schema), schemaVersion: 1,
    evidenceSnapshotHash: snapshot.hash, assignmentId: uuidToBytes32(assignment.id), credentialId: uuidToBytes32(credential),
    payloadHash, issuedAt, expiresAt: issuedAt + 600n, nonce };
  const signature = await account.signTypedData(buildTypedData({ chainId: 5611 } as AppConfig, message));
  const versions = await versionsInForce(tx, schema);
  await tx`INSERT INTO core.verification_attestations(id,tenant_id,case_id,assignment_id,credential_id,schema_id,attestation_type,claim_scope,evidence_snapshot_hash,
    findings,citations,limitations,credential_status_snapshot,method_version,policy_version,payload_hash,signature,signer_wallet_address,signed_at,state)
    VALUES (${attestation},${tenant},${caseId},${assignment.id},${credential},${schema},'professional_signoff',${[claim]}::uuid[],${snapshot.hash},
      ${tx.json(payload.findings)},${tx.json(payload.citations)},${DEMO_LIMITATION},'{"synthetic":true,"statusAtSigning":"valid","validAtAttestationTime":true}',
      ${versions.methodVersion},${versions.policyVersion},${payloadHash},${signature},${account.address.toLowerCase()},now(),'signed')`;
  await tx`INSERT INTO core.attestation_signature_requests(id,tenant_id,attestation_id,nonce,evidence_snapshot_hash,payload_hash,issued_at,expires_at,consumed_at)
    VALUES (${randomUUID()},${tenant},${attestation},${nonce},${snapshot.hash},${payloadHash},${new Date(Number(issuedAt)*1000)},${new Date(Number(issuedAt+600n)*1000)},now())`;
  await tx`UPDATE core.verification_cases SET state='signed' WHERE id=${caseId}`;
  await reassessClaim(tx, claim);
  if (scenario === "PUBLIC") {
    const subject = await resolvePublicationSubject(tx, tenant, "project", project);
    const projection = publicProjection.parse({ ...subject.identity, status: subject.publishedStatus, version: "1", asOf: new Date().toISOString(),
      sourceAge: null, staleStatus: "unknown", limitations: [DEMO_LIMITATION], legalEffect: "none", disclaimerCodes: ["VERIFICATION_IS_NOT_GUARANTEE"] });
    const entry = id(tenant, "PUBLIC:registry");
    await tx`INSERT INTO core.registry_entries(id,tenant_id,registry_type,subject_id,public_key)
      VALUES (${entry},${tenant},'project',${project},${subject.publicKey})`;
    await tx`INSERT INTO core.registry_entry_versions(id,tenant_id,entry_id,version,status,public_projection,content_hash,source_snapshot_hash,policy_version,schema_version,published_at)
      VALUES (${id(tenant, "PUBLIC:version")},${tenant},${entry},1,'published',${tx.json(projection as never)},${hashProjection(projection as never)},
        ${subject.sourceSnapshotHash},'synthetic-demo-v1','project-registry-1',now())`;
    const moved = await tx`UPDATE core.projects SET lifecycle_state='registered',version=version+1,updated_at=now()
      WHERE id=${project} AND tenant_id=${tenant} AND lifecycle_state='draft' RETURNING id`;
    if (moved.length) await tx`INSERT INTO core.project_lifecycle_transitions(tenant_id,project_id,from_state,to_state,reason)
      VALUES (${tenant},${project},'draft','registered',${DEMO_LIMITATION})`;
    // This is explicitly a fixture publication, never an attributed human approval.
    await audit(tx, tenant, project, "dev_demo.synthetic_publication");
  }
}
