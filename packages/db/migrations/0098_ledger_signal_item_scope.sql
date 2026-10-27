-- A published version's stale signal records the review that became stale. Scope it to the
-- items whose review set includes that review, instead of warning every approved item. This is
-- consistent with the private evaluator, which never reads these signals and instead judges an
-- item by the relevance and validity of reviews overlapping its claims. The approved
-- projection, its hash and every other 0097 warning rule are unchanged. The record-level CRE
-- status still treats any open version signal as stale.
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
            SELECT DISTINCT ON (policy.gate_id) policy.id,policy.gate_id
            FROM core.compliance_policy_sets policy
            JOIN core.projects project ON project.id=f.subject_id AND project.tenant_id=f.tenant_id
            WHERE policy.tenant_id=f.tenant_id AND policy.state='effective'
              AND policy.effective_from <= p_evaluated_at AND policy.superseded_by IS NULL
              AND policy.gate_id = ANY(ARRAY['stage.exploration','stage.resource_defined','stage.feasibility','stage.permitted','stage.production'])
              AND policy.jurisdiction_profile=project.host_country_iso3
            ORDER BY policy.gate_id,policy.effective_from DESC,policy.created_at DESC,policy.id
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
