import { DEMO_DOCUMENTS, demoDocumentTitle } from "./dev-demo-documents.js";
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { computeEvidenceLedger, persistEvidenceLedger } from "@mpc/db";
import { parseRuleSet } from "@mpc/policy";

type Tx = postgres.TransactionSql;
export interface DemoCatalog { id: string; claimType: string }

/** Called only by the deployment-owner seed, inside its tenant transaction and seed lock. */
export async function ensureDemoCoverageDefinitions(
  tx: Tx, tenant: string, project: string, scenario: string, limitation: string,
  fixtureId: (name: string) => string,
  completedStages?: number,
): Promise<DemoCatalog> {
  const [source] = await tx`SELECT id FROM core.projects p
    WHERE p.id=${project} AND p.tenant_id=${tenant} AND p.reference_status='synthetic_test_project'
      AND p.project_key=${`DEMO-V1-${scenario}-${tenant}`}
      AND EXISTS(SELECT 1 FROM audit.events e WHERE e.tenant_id=p.tenant_id
        AND e.resource_id=p.id AND e.command='dev_demo.started')`;
  if (!source) throw new Error("Coverage seed requires the original synthetic demo project");
  const proposer = fixtureId("coverage:proposer"), approver = fixtureId("coverage:approver");
  for (const [subject, duty] of [[proposer, "proposer"], [approver, "approver"]]) {
    await tx`INSERT INTO core.subjects(id,tenant_id,kind,display_name)
      VALUES(${subject!},${tenant},'person',${`SYNTHETIC DEMO coverage ${duty} (fixture, no login)`})
      ON CONFLICT(id) DO NOTHING`;
    const [holder] = await tx`SELECT id FROM core.subjects WHERE id=${subject!} AND tenant_id=${tenant}
      AND kind='person' AND email IS NULL AND NOT EXISTS(SELECT 1 FROM core.role_bindings WHERE subject_id=${subject!})`;
    if (!holder) throw new Error("Coverage fixture identity was changed; seed stopped");
  }
  const rich = scenario.startsWith("DOCUMENTS-");
  const catalog = { id: fixtureId("coverage:catalog"), claimType: `synthetic_dev_demo_${scenario.toLowerCase().replaceAll("-", "_")}_licence` };
  const displayName = "Exploration licence";
  const effectiveFrom = new Date("2020-01-01T00:00:00Z");
  const catalogs = [{ ...catalog, gate: "exploration", label: displayName }];
  if (rich) {
    for (const [key, label, gate] of DEMO_DOCUMENTS.slice(1)) {
      catalogs.push({ id: fixtureId(`coverage:catalog:${key}`), claimType: `${catalog.claimType}_${key}`, gate, label: demoDocumentTitle(scenario, key, label) });
    }
  }
  for (const item of catalogs) {
    item.label = await ensureDemoClaimType(tx, tenant, project, proposer, approver, item, effectiveFrom, limitation);
  }
  const gates = ["exploration", "resource_defined", "feasibility", "permitted", "production"];
  for (const [index, gate] of (completedStages === undefined ? gates.slice(0, 1) : gates).entries()) {
    const policyId = fixtureId(`coverage:${gate}`);
    const rule = parseRuleSet({
      ruleSetId: `synthetic-demo-${project}-${gate}`, version: "1.0.0",
      effectiveFrom: "2020-01-01T00:00:00Z", supersededBy: null, jurisdictionProfile: "MNG",
      gateId: `stage.${gate}`, retroactive: false,
      requirements: (rich ? catalogs.filter(item => item.gate === gate) : [{...catalog,label: "Synthetic licence evidence and review"}]).map(item => ({ requirementId: rich ? item.claimType : "synthetic_licence_review", label: item.label,
        appliesWhen: { op: "always" }, requiredClaimTypes: [item.claimType], minimumGrade: completedStages !== undefined && index >= completedStages ? "verified" : "partially_verified",
        freshnessThresholdDays: null, requiredAttestations: ["professional_signoff"], blockingConflictTypes: [],
        notEvaluableWhen: { op: "never" }, watchWhen: null })),
    });
    const [policy] = await tx`SELECT * FROM core.compliance_policy_sets WHERE id=${policyId}`;
    if (policy) {
      if (policy.tenant_id !== tenant || policy.project_id !== project || !isDeepStrictEqual(policy.definition, rule)) {
        throw new Error("Coverage policy identity collision");
      }
      // A human may retire a fixture rule. Never reactivate or replace it on retry.
    } else {
      await tx`INSERT INTO core.compliance_policy_sets(id,tenant_id,project_id,rule_set_id,rule_set_version,
        gate_id,jurisdiction_profile,effective_from,retroactive,definition,state)
        VALUES(${policyId},${tenant},${project},${rule.ruleSetId},${rule.version},${rule.gateId},'MNG',${effectiveFrom},false,${tx.json(rule)},'effective')`;
      await fixtureApproval(tx, tenant, proposer, approver, "policy_set", rule.ruleSetId, policyId,
        { definition: rule, projectId: project }, effectiveFrom, limitation);
    }
  }
  return catalog;
}

async function ensureDemoClaimType(
  tx: Tx, tenant: string, project: string, proposer: string, approver: string,
  item: DemoCatalog & { label: string }, effectiveFrom: Date, limitation: string,
) {
  const definition = { fields: [{ key: "reference", label: "Synthetic reference", type: "string", required: true }] };
  const [existing] = await tx`SELECT * FROM core.claim_types WHERE id=${item.id}`;
  if (existing) {
    if (existing.project_id !== project || existing.tenant_id !== tenant || existing.claim_type !== item.claimType ||
      !isDeepStrictEqual(existing.definition, definition)) throw new Error("Coverage catalog identity collision");
    // Historical policies use the label stored with their immutable catalog version.
    return String(existing.display_name);
  }
  await tx`INSERT INTO core.claim_types(id,tenant_id,project_id,claim_type,catalog_version,display_name,description,definition,effective_from)
    VALUES(${item.id},${tenant},${project},${item.claimType},1,${item.label},${limitation},${tx.json(definition)},${effectiveFrom})`;
  await fixtureApproval(tx, tenant, proposer, approver, "claim_type", item.claimType, item.id,
    { claimType: item.claimType, displayName: item.label, description: limitation, definition, projectId: project }, effectiveFrom, limitation);
  return item.label;
}

async function fixtureApproval(
  tx: Tx, tenant: string, proposer: string, approver: string, kind: "claim_type" | "policy_set",
  key: string, materialized: string, payload: object, effectiveFrom: Date, limitation: string,
) {
  const proposal = randomUUID();
  await tx`INSERT INTO core.registry_proposals(id,tenant_id,kind,item_key,item_version,payload,rationale,effective_from,proposed_by_subject_id)
    VALUES(${proposal},${tenant},${kind},${key},1,${tx.json(payload as never)},${limitation},${effectiveFrom},${proposer})`;
  await tx`UPDATE core.registry_proposals SET state='approved',decided_by_subject_id=${approver},decided_at=now(),
    decision_reason=${limitation},materialized_id=${materialized},version=2 WHERE id=${proposal}`;
}

/** Adds one new assessment; never rewrites legacy claims, signatures or public projections. */
export async function seedDemoCoverageSnapshot(tx: Tx, tenant: string, project: string, limitation: string) {
  const [done] = await tx`SELECT 1 FROM audit.events WHERE tenant_id=${tenant} AND resource_id=${project}
    AND command='dev_demo.coverage_v1.completed'`;
  if (done) return null;
  const snapshot = await computeEvidenceLedger(tx, tenant, project, new Date());
  if (!snapshot) throw new Error("Coverage project disappeared");
  const stored = await persistEvidenceLedger(tx, tenant, snapshot);
  await tx`INSERT INTO audit.events(tenant_id,project_id,effective_role,command,resource_type,resource_id,reason,correlation_id,detail)
    VALUES(${tenant},${project},'deploy_bound','dev_demo.coverage_v1.completed','project',${project},${limitation},${randomUUID()},
      '{"synthetic":true,"humanApproval":false,"coverageSeedVersion":"1"}')`;
  return stored;
}
