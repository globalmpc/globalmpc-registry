-- Project-bound definitions never become tenant-wide policy or evidence types.
-- Existing rows remain global. No historical assessment, signature or publication changes.
ALTER TABLE core.compliance_policy_sets ADD COLUMN project_id UUID,
  ADD CONSTRAINT policy_project_same_tenant FOREIGN KEY (tenant_id,project_id) REFERENCES core.projects(tenant_id,id);
ALTER TABLE core.claim_types ADD COLUMN project_id UUID,
  ADD CONSTRAINT catalog_project_same_tenant FOREIGN KEY (tenant_id,project_id) REFERENCES core.projects(tenant_id,id);

-- Project-bound fixtures cease to apply if the project is no longer a synthetic demo.
-- No public/worker caller can manufacture a real-project policy through this namespace.
CREATE FUNCTION core.project_definition_applies(p_scope UUID,p_project UUID)
RETURNS boolean LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT p_scope IS NULL OR (p_scope=p_project AND EXISTS(
    SELECT 1 FROM core.projects p WHERE p.id=p_project AND p.reference_status='synthetic_test_project'))
$$;
REVOKE ALL ON FUNCTION core.project_definition_applies(UUID,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.project_definition_applies(UUID,UUID) TO mpc_app,mpc_worker;

CREATE FUNCTION core.guard_demo_definition_project() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND (NOT core.project_definition_applies(NEW.project_id,NEW.project_id)
    OR NOT EXISTS(SELECT 1 FROM audit.events e WHERE e.tenant_id=NEW.tenant_id
      AND e.resource_id=NEW.project_id AND e.command='dev_demo.started')) THEN
    RAISE EXCEPTION 'Project-bound definitions require an original synthetic demo';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_demo_project BEFORE INSERT ON core.claim_types
FOR EACH ROW EXECUTE FUNCTION core.guard_demo_definition_project();
CREATE TRIGGER policy_demo_project BEFORE INSERT ON core.compliance_policy_sets
FOR EACH ROW EXECUTE FUNCTION core.guard_demo_definition_project();

CREATE FUNCTION core.protect_policy_project_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'Policy project scope is immutable; create a new policy version';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_project_scope_immutable BEFORE UPDATE ON core.compliance_policy_sets
FOR EACH ROW EXECUTE FUNCTION core.protect_policy_project_scope();

CREATE FUNCTION core.guard_project_definition_scope() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_TABLE_NAME='claims' THEN
    IF TG_OP='UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
      AND NEW.catalog_entry_id IS NOT DISTINCT FROM OLD.catalog_entry_id THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM core.claim_types c WHERE c.id=NEW.catalog_entry_id AND c.tenant_id=NEW.tenant_id
      AND NOT core.project_definition_applies(c.project_id,NEW.project_id)) THEN
      RAISE EXCEPTION 'Catalog entry belongs to another project';
    END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM core.compliance_policy_sets p WHERE p.id=NEW.policy_set_id AND p.tenant_id=NEW.tenant_id
      AND NOT core.project_definition_applies(p.project_id,NEW.project_id)) THEN
      RAISE EXCEPTION 'Policy belongs to another project';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER claims_project_definition_scope BEFORE INSERT OR UPDATE ON core.claims
FOR EACH ROW EXECUTE FUNCTION core.guard_project_definition_scope();
CREATE TRIGGER assessments_project_definition_scope BEFORE INSERT ON core.compliance_assessments
FOR EACH ROW EXECUTE FUNCTION core.guard_project_definition_scope();


-- Scope is part of the reviewed catalog content, including owner-created fixtures.
CREATE OR REPLACE FUNCTION core.require_claim_type_approval() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.registry_proposals p
    WHERE p.tenant_id = NEW.tenant_id AND p.kind::text = 'claim_type'
      AND p.state = 'approved' AND p.materialized_id = NEW.id
      AND p.item_key = NEW.claim_type AND p.effective_from = NEW.effective_from
      AND p.payload ->> 'projectId' IS NOT DISTINCT FROM NEW.project_id::text
      AND (p.payload - 'projectId') = jsonb_build_object(
        'claimType', NEW.claim_type, 'displayName', NEW.display_name,
        'description', NEW.description, 'definition', NEW.definition)
  ) THEN
    RAISE EXCEPTION 'A claim type row requires an approved proposal matching its content'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NULL;
END
$$;

CREATE FUNCTION core.require_scoped_policy_approval() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.project_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM core.registry_proposals p WHERE p.tenant_id=NEW.tenant_id AND p.kind='policy_set'
      AND p.state='approved' AND p.materialized_id=NEW.id AND p.payload->>'projectId'=NEW.project_id::text
  ) THEN RAISE EXCEPTION 'Project policy scope requires matching approval'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER policy_project_approval AFTER INSERT ON core.compliance_policy_sets
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION core.require_scoped_policy_approval();

-- The private evaluator and public live warnings must select identical policy identities.
-- Invoker security preserves runtime RLS; the existing public definer calls this as its owner.
CREATE FUNCTION core.effective_stage_policy_sets(p_project UUID,p_at TIMESTAMPTZ)
RETURNS SETOF core.compliance_policy_sets LANGUAGE sql STABLE STRICT SET search_path=pg_catalog AS $$
  SELECT DISTINCT ON (p.gate_id) p.*
  FROM core.projects project JOIN core.compliance_policy_sets p ON p.tenant_id=project.tenant_id
  WHERE project.id=p_project AND core.project_definition_applies(p.project_id,project.id)
    AND p.state='effective' AND p.effective_from<=p_at AND p.superseded_by IS NULL
    AND p.jurisdiction_profile=project.host_country_iso3
    AND p.gate_id=ANY(ARRAY['stage.exploration','stage.resource_defined','stage.feasibility','stage.permitted','stage.production'])
  ORDER BY p.gate_id,(p.project_id IS NOT NULL) DESC,p.effective_from DESC,p.created_at DESC,p.id
$$;
REVOKE ALL ON FUNCTION core.effective_stage_policy_sets(UUID,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.effective_stage_policy_sets(UUID,TIMESTAMPTZ) TO mpc_app,mpc_worker;

CREATE OR REPLACE FUNCTION core.public_evidence_ledger_current(p_version UUID, p_evaluated_at TIMESTAMPTZ)
-- JSON array cardinality estimates otherwise trigger JIT compilation for a tiny public
-- lookup; compilation dominates the actual scoped lookup and delays every Explorer view.
RETURNS JSONB LANGUAGE sql STABLE STRICT SECURITY DEFINER SET search_path = pg_catalog SET jit = off AS $$
  WITH published AS (
    SELECT e.tenant_id,e.subject_id,v.public_projection
    FROM core.registry_entry_versions v JOIN core.registry_entries e ON e.id=v.entry_id AND e.tenant_id=v.tenant_id
    WHERE v.id=p_version AND e.registry_type='project'
      AND v.status IN ('published','revoked','superseded') AND v.published_at IS NOT NULL
  ), frozen AS (
    SELECT p.tenant_id,p.subject_id,s.snapshot
    FROM published p JOIN core.evidence_ledger_snapshots s
      ON s.id::text=p.public_projection #>> '{evidenceLedger,snapshotId}'
      AND s.tenant_id=p.tenant_id AND s.project_id=p.subject_id
  ), warnings AS (
    SELECT item ->> 'claimType' AS claim_type,item ->> 'catalogVersion' AS catalog_version,
      CASE WHEN EXISTS (
        SELECT 1 FROM core.claim_conflicts cc WHERE cc.claim_id::text IN (
          SELECT jsonb_array_elements_text(item -> 'claimIds')) AND cc.resolved_at IS NULL
      ) OR EXISTS (SELECT 1 FROM core.verification_attestations disputed
        WHERE disputed.id::text IN (SELECT jsonb_array_elements_text(item -> 'attestationIds'))
          AND disputed.state='disputed') THEN 'conflicting'
      -- Actual invalidation outranks rejection; missing positive obligations do not.
      WHEN EXISTS (
        SELECT 1 FROM core.ledger_claim_health(f.subject_id,p_evaluated_at) h
        WHERE h.id::text IN (SELECT jsonb_array_elements_text(item -> 'claimIds')) AND h.stale
      ) OR EXISTS (
        SELECT 1 FROM core.claims c WHERE c.id::text IN (SELECT jsonb_array_elements_text(item -> 'claimIds'))
          AND c.superseded_by_claim_id IS NOT NULL
      ) OR EXISTS (
        SELECT 1 FROM core.evidence_stale_signals signal
        WHERE signal.tenant_id=f.tenant_id AND signal.target_type='registry_entry_version'
          AND signal.target_id=p_version AND signal.resolution='open'
          -- Every version signal starts from a review that became stale. That review's own
          -- items already warn through its state; another item's review is outside this
          -- item's input scope. A signal without a recorded origin still warns conservatively.
          AND (signal.origin_attestation_id IS NULL OR signal.origin_attestation_id::text IN (
            SELECT jsonb_array_elements_text(item -> 'attestationIds')))
      ) OR EXISTS (
        SELECT 1 FROM core.verification_attestations a
        JOIN core.credentials cr ON cr.id=a.credential_id AND cr.tenant_id=a.tenant_id
        JOIN core.attestation_schemas sch ON sch.id=a.schema_id AND sch.tenant_id=a.tenant_id
        WHERE a.id::text IN (SELECT jsonb_array_elements_text(item -> 'attestationIds'))
          AND (a.state NOT IN ('signed','active') OR (a.valid_until IS NOT NULL AND a.valid_until <= p_evaluated_at)
            OR cr.current_status <> 'valid' OR cr.revoked_at IS NOT NULL OR cr.expires_at <= p_evaluated_at
            OR sch.state NOT IN ('active','approved') OR a.signature='' OR a.signed_at > p_evaluated_at)
      ) THEN 'needs_re_review'
      WHEN EXISTS (
        SELECT 1 FROM core.claims c WHERE c.id::text IN (SELECT jsonb_array_elements_text(item -> 'claimIds'))
          AND (c.grade='rejected' OR c.excluded_by_rule)
      ) THEN 'rejected'
      WHEN EXISTS (
        SELECT 1 FROM core.ledger_claim_health(f.subject_id,p_evaluated_at) h
        WHERE h.id::text IN (SELECT jsonb_array_elements_text(item -> 'claimIds')) AND NOT h.has_evidence AND NOT exclusion.current
      ) OR EXISTS (
        SELECT 1 FROM core.ledger_claim_health(f.subject_id,p_evaluated_at) h
        WHERE h.claim_type=item ->> 'claimType' AND h.catalog_version::text=item ->> 'catalogVersion'
          AND NOT exclusion.current
          AND NOT EXISTS (
            SELECT 1 FROM core.verification_attestations a
            JOIN core.verification_cases vc ON vc.id=a.case_id AND vc.tenant_id=a.tenant_id
            JOIN core.credentials cr ON cr.id=a.credential_id AND cr.tenant_id=a.tenant_id
            JOIN core.attestation_schemas sch ON sch.id=a.schema_id AND sch.tenant_id=a.tenant_id
            WHERE a.tenant_id=f.tenant_id AND vc.project_id=f.subject_id AND h.id=ANY(a.claim_scope)
              AND a.state IN ('signed','active') AND a.signature <> '' AND a.signed_at <= p_evaluated_at
              AND (a.valid_until IS NULL OR a.valid_until > p_evaluated_at)
              AND cr.current_status='valid' AND cr.revoked_at IS NULL
              AND (cr.expires_at IS NULL OR cr.expires_at > p_evaluated_at)
              AND sch.state IN ('active','approved')
          )
          AND h.id::text NOT IN (SELECT jsonb_array_elements_text(frozen_item -> 'claimIds'))
      ) OR (
        -- Match the private evaluator's latest effective policy per stage, including a newly
        -- approved version whose predecessor was deliberately left effective. Compare only
        -- identities internally; public warnings never disclose policy IDs or definitions.
        ARRAY(
          SELECT selected.id::text FROM (
            SELECT policy.id,policy.gate_id
            FROM core.effective_stage_policy_sets(f.subject_id,p_evaluated_at) policy
          ) selected ORDER BY selected.id::text
        ) IS DISTINCT FROM ARRAY(
          SELECT policy ->> 'id' FROM jsonb_array_elements(f.snapshot #> '{inputBasis,policies}') policy
          ORDER BY policy ->> 'id'
        )
      ) OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(f.snapshot -> 'stages') frozen_stage
        JOIN core.compliance_policy_sets policy ON policy.id::text=frozen_stage ->> 'policySetId'
          AND policy.tenant_id=f.tenant_id
        CROSS JOIN LATERAL jsonb_array_elements(policy.definition -> 'requirements') requirement
        JOIN core.claims dated ON dated.id::text IN (SELECT jsonb_array_elements_text(item -> 'claimIds'))
          AND dated.tenant_id=f.tenant_id AND dated.project_id=f.subject_id
        WHERE requirement -> 'requiredClaimTypes' ? (item ->> 'claimType')
          -- A recorded exclusion removes this positive-evidence obligation, including its
          -- age limit. Actual stale/revoked evidence is still checked independently above.
          AND NOT exclusion.current
          AND ((p_evaluated_at AT TIME ZONE 'UTC')::date - dated.as_of) >
            CASE WHEN requirement ->> 'freshnessThresholdDays' ~ '^[0-9]+$'
              THEN (requirement ->> 'freshnessThresholdDays')::numeric ELSE NULL END
      ) OR EXISTS (
        -- Signed review and evidence currency do not upgrade a claim's grade. Match the
        -- private evaluator's weakest relevant grade for requirements that established
        -- an approved stage. Applicability comes from that evaluator, not a second SQL
        -- implementation of its predicate language. Older snapshots without this private
        -- metadata conservatively require re-review on a below-minimum grade.
        SELECT 1 FROM jsonb_array_elements(f.snapshot -> 'stages') frozen_stage
        JOIN LATERAL jsonb_array_elements(f.snapshot #> '{inputBasis,policies}') policy
          ON policy ->> 'id'=frozen_stage ->> 'policySetId'
        CROSS JOIN LATERAL jsonb_array_elements(policy #> '{definition,requirements}') requirement
        JOIN core.claims graded ON graded.tenant_id=f.tenant_id AND graded.project_id=f.subject_id
          AND graded.claim_type=item ->> 'claimType'
          AND graded.catalog_version::text=item ->> 'catalogVersion'
          AND graded.catalog_entry_id IS NOT NULL AND graded.superseded_by_claim_id IS NULL
        WHERE frozen_stage ->> 'status'='ok'
          AND requirement -> 'requiredClaimTypes' ? (item ->> 'claimType')
          AND (f.snapshot #> '{inputBasis,applicableStageRequirements}' IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(f.snapshot #> '{inputBasis,applicableStageRequirements}') applicable
            WHERE applicable ->> 'policySetId'=policy ->> 'id'
              AND applicable ->> 'requirementId'=requirement ->> 'requirementId'
          ))
          -- The enum order is the domain weakestGrade order: rejected, unverified,
          -- self_reported, partially_verified, verified. A single weak claim is enough.
          AND graded.grade < (requirement ->> 'minimumGrade')::core.grade
          AND NOT exclusion.current
      ) OR EXISTS (
        -- A new manual exclusion removes positive evidence from an approved stage.
        -- Frozen applicability excludes unrelated items. As with grade changes, older
        -- snapshots without applicability metadata conservatively require re-review.
        SELECT 1 FROM jsonb_array_elements(f.snapshot -> 'stages') frozen_stage
        JOIN LATERAL jsonb_array_elements(f.snapshot #> '{inputBasis,policies}') policy
          ON policy ->> 'id'=frozen_stage ->> 'policySetId'
        CROSS JOIN LATERAL jsonb_array_elements(policy #> '{definition,requirements}') requirement
        WHERE frozen_stage ->> 'status'='ok'
          AND frozen_item ->> 'status' <> 'not_applicable'
          AND requirement -> 'requiredClaimTypes' ? (item ->> 'claimType')
          AND (f.snapshot #> '{inputBasis,applicableStageRequirements}' IS NULL OR EXISTS (
            SELECT 1 FROM jsonb_array_elements(f.snapshot #> '{inputBasis,applicableStageRequirements}') applicable
            WHERE applicable ->> 'policySetId'=policy ->> 'id'
              AND applicable ->> 'requirementId'=requirement ->> 'requirementId'
          ))
          AND manual_applicability.status='not_applicable'
          AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(f.snapshot #> '{inputBasis,manual}') approved_manual
            WHERE approved_manual ->> 'fact_key'=item ->> 'claimType'
              AND approved_manual ->> 'status'='not_applicable'
          )
      ) OR (
        -- Withdrawing an approved exclusion restores an evidence obligation even if
        -- no claims exist and no stage previously passed. Do not mistake a missing
        -- manual row for a withdrawal; only a later explicit decision changes it.
        frozen_item ->> 'status'='not_applicable'
          AND manual_applicability.status <> 'not_applicable'
      ) THEN 'needs_re_review'
      ELSE NULL END AS status
    FROM frozen f CROSS JOIN LATERAL jsonb_array_elements(f.snapshot -> 'items') frozen_item
    CROSS JOIN LATERAL (
      -- Reserved names belong exclusively to the fixed confirmation matrix. Historical
      -- catalog rows can share their spelling, but never that decision's namespace.
      SELECT (SELECT manual.status FROM core.project_fact_versions manual
        WHERE manual.tenant_id=f.tenant_id AND manual.project_id=f.subject_id
          AND manual.fact_key=frozen_item ->> 'claimType'
          AND NOT core.is_reserved_catalog_key(frozen_item ->> 'claimType')
        ORDER BY manual.version DESC LIMIT 1) AS status
    ) manual_applicability
    CROSS JOIN LATERAL (
      -- Reserved-key applicability was already approved in the historical snapshot.
      -- Preserve that decision, but never reinterpret a later legacy matrix update as
      -- catalog applicability. Normal catalog keys still follow current scoped decisions.
      SELECT CASE WHEN core.is_reserved_catalog_key(frozen_item ->> 'claimType')
        THEN frozen_item ->> 'status'='not_applicable'
        ELSE COALESCE(manual_applicability.status='not_applicable',false) END AS current
    ) exclusion
    -- Expand only the already approved public identity, never today's unrelated catalog entries.
    -- Frozen IDs retain supersession warnings; active additions must also remain reviewed.
    CROSS JOIN LATERAL (
      SELECT frozen_item || jsonb_build_object(
        'claimIds', COALESCE((SELECT jsonb_agg(DISTINCT claim_id) FROM (
          SELECT jsonb_array_elements_text(frozen_item -> 'claimIds') AS claim_id
          UNION SELECT c.id::text FROM core.claims c
          WHERE c.tenant_id=f.tenant_id AND c.project_id=f.subject_id
            AND c.claim_type=frozen_item ->> 'claimType'
            AND c.catalog_version::text=frozen_item ->> 'catalogVersion'
            AND c.catalog_entry_id IS NOT NULL AND c.superseded_by_claim_id IS NULL
        ) scoped_claims),'[]'::jsonb)
      ) AS claim_item
    ) scoped_claim_item
    CROSS JOIN LATERAL (
      SELECT scoped_claim_item.claim_item || jsonb_build_object(
        'attestationIds', COALESCE((SELECT jsonb_agg(DISTINCT attestation_id) FROM (
          SELECT jsonb_array_elements_text(frozen_item -> 'attestationIds') AS attestation_id
          UNION SELECT a.id::text FROM core.verification_attestations a
          JOIN core.verification_cases vc ON vc.id=a.case_id AND vc.tenant_id=a.tenant_id
          WHERE a.tenant_id=f.tenant_id AND vc.project_id=f.subject_id
            AND a.state NOT IN ('draft','superseded') AND EXISTS (
              SELECT 1 FROM jsonb_array_elements_text(scoped_claim_item.claim_item -> 'claimIds') claim_id
              WHERE claim_id::uuid=ANY(a.claim_scope)
            )
        ) scoped_attestations),'[]'::jsonb)
      ) AS item
    ) scoped_item
    -- The frozen allowlisted projection is the upper bound, not today's private catalog.
    WHERE EXISTS (SELECT 1 FROM published p, jsonb_array_elements(p.public_projection #> '{evidenceLedger,items}') approved
      WHERE approved ->> 'claimType' = item ->> 'claimType'
        AND approved ->> 'catalogVersion' = item ->> 'catalogVersion')
  ) SELECT CASE WHEN EXISTS(SELECT 1 FROM frozen) THEN jsonb_build_object(
    'evaluatedAt', to_char(p_evaluated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'warnings',COALESCE((SELECT jsonb_agg(jsonb_build_object('claimType',claim_type,'catalogVersion',catalog_version,'status',status,
      'reasons',jsonb_build_array(CASE status WHEN 'conflicting' THEN 'UNRESOLVED_CONFLICT'
        WHEN 'rejected' THEN 'REJECTED_OR_EXCLUDED_EVIDENCE' ELSE 'EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT' END)) ORDER BY claim_type)
      FROM warnings WHERE status IS NOT NULL),'[]'::jsonb)) ELSE NULL END
$$;
REVOKE ALL ON FUNCTION core.public_evidence_ledger_current(UUID,TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_evidence_ledger_current(UUID,TIMESTAMPTZ) TO mpc_app;
