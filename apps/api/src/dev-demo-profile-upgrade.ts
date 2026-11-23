import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { hashProjection } from "@mpc/canonical";
import { publicProjection } from "@mpc/api-contract";
import { lockProjectRestrictions } from "./restrictions.js";
import { demoProfiles, publicReviewLimit, type DemoScenario } from "./dev-demo-profiles.js";

/** A metadata correction to an original fixture. Its evidence and assessment date stay frozen. */
export async function upgradeDemoProfile(tx: postgres.TransactionSql, ns: string, owner: string, scenario: DemoScenario,
  project: string, originalVersionId: string, legacyLimit: string): Promise<boolean> {
  const key = `DEMO-V1-${scenario}-${ns}`;
  const originalName = `SYNTHETIC DEMO — ${scenario.toLowerCase()}`;
  const profile = demoProfiles[scenario];
  const published = scenario !== "INPUT" && scenario !== "REVIEW";
  const [original] = await tx`SELECT id FROM core.projects
    WHERE id=${project} AND project_key=${key} AND name=${originalName}
      AND owner_organization_id=${owner} AND reference_status='synthetic_test_project'
      AND host_country_iso3='MNG' AND minerals=ARRAY['copper'] AND version=${published ? 2 : 1}
      AND lifecycle_state=${published ? "registered" : "draft"} FOR UPDATE`;
  if (!original) return false;
  await lockProjectRestrictions(tx, project);
  const [activity] = await tx`SELECT
    EXISTS(SELECT 1 FROM core.disclosure_restrictions WHERE project_id=${project}) OR
    EXISTS(SELECT 1 FROM core.registry_publication_drafts WHERE subject_id=${project}) AS present`;
  if (activity?.present) return false;
  if (published) {
    const [version] = await tx`SELECT v.* FROM core.registry_entry_versions v
      JOIN core.registry_entries e ON e.id=v.entry_id
      WHERE v.id=${originalVersionId} AND e.subject_id=${project}
        AND e.public_key=${key} AND e.registry_type='project' AND v.version=1 AND v.status='published'
        AND v.revoked_at IS NULL AND v.superseded_by_id IS NULL AND v.serialization_version='1'
        AND v.policy_version='synthetic-demo-v1' AND v.schema_version='project-registry-1'
        AND NOT EXISTS(SELECT 1 FROM core.registry_entry_versions later WHERE later.entry_id=e.id AND later.version>1)
        AND EXISTS(SELECT 1 FROM audit.events WHERE resource_id=${project} AND command='dev_demo.synthetic_publication')
      FOR UPDATE OF v,e`;
    if (!version) return false;
    const old = publicProjection.parse(version.public_projection);
    if (hashProjection(old as never) !== version.content_hash || old.projectName !== originalName || old.projectKey !== key || old.stableId !== project ||
        old.limitations.length !== 1 || old.limitations[0] !== legacyLimit) return false;
    // Only copy already-public evidence. Reading live claims could publish a later private edit.
    const next = { ...old, version: "2", projectName: profile.name, mineral: [profile.mineral], limitations: [publicReviewLimit] };
    const [added] = await tx`INSERT INTO core.registry_entry_versions
      (id,entry_id,version,status,previous_version_id,public_projection,content_hash,source_snapshot_hash,policy_version,schema_version,serialization_version,published_at)
      VALUES(${randomUUID()},${version.entry_id},2,'published',${originalVersionId},${tx.json(next as never)},${hashProjection(next as never)},
        ${version.source_snapshot_hash},${version.policy_version},${version.schema_version},${version.serialization_version},now()) RETURNING id`;
    await tx`UPDATE core.registry_entry_versions SET status='superseded',superseded_by_id=${added!.id} WHERE id=${originalVersionId}`;
  }
  await tx`UPDATE core.projects SET name=${profile.name},minerals=${[profile.mineral]}::text[],version=version+1,updated_at=now()
    WHERE id=${project}`;
  return true;
}
