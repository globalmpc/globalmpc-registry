-- tenant 경계를 넘는 참조를 DB가 막는다.
--
-- **발견된 결함:** PostgreSQL의 외래키 검사는 **RLS를 우회한다.** 참조 대상 행이
-- 다른 tenant의 것이어도 존재하기만 하면 FK가 통과한다. 그래서 tenant A의
-- operator가 `owner_organization_id`에 tenant B의 조직 ID를 넣어 프로젝트를 만들 수
-- 있었다. RLS는 "보이는 행"을 제한할 뿐 "참조 가능한 행"을 제한하지 않는다.
--
-- **해결:** 부모 테이블에 `UNIQUE (tenant_id, id)`를 두고, 자식의 FK를
-- `(tenant_id, parent_id)` 복합키로 바꾼다. 그러면 tenant가 다른 행을 참조하는
-- 순간 FK 자체가 실패한다. 애플리케이션 검증에 의존하지 않는다.
--
-- 02 §2.5의 tenant isolation을 RLS + composite FK 두 겹으로 만든다.

-- ---------------------------------------------------------------------------
-- 1. 부모 테이블에 (tenant_id, id) 유니크 제약
-- ---------------------------------------------------------------------------

ALTER TABLE core.organizations          ADD CONSTRAINT organizations_tenant_scope_key          UNIQUE (tenant_id, id);
ALTER TABLE core.subjects               ADD CONSTRAINT subjects_tenant_scope_key               UNIQUE (tenant_id, id);
ALTER TABLE core.credentials            ADD CONSTRAINT credentials_tenant_scope_key            UNIQUE (tenant_id, id);
ALTER TABLE core.projects               ADD CONSTRAINT projects_tenant_scope_key               UNIQUE (tenant_id, id);
ALTER TABLE core.authorities            ADD CONSTRAINT authorities_tenant_scope_key            UNIQUE (tenant_id, id);
ALTER TABLE core.source_connections     ADD CONSTRAINT source_connections_tenant_scope_key     UNIQUE (tenant_id, id);
ALTER TABLE core.source_receipts        ADD CONSTRAINT source_receipts_tenant_scope_key        UNIQUE (tenant_id, id);
ALTER TABLE core.artifacts              ADD CONSTRAINT artifacts_tenant_scope_key              UNIQUE (tenant_id, id);
ALTER TABLE core.claims                 ADD CONSTRAINT claims_tenant_scope_key                 UNIQUE (tenant_id, id);
ALTER TABLE core.attestation_schemas    ADD CONSTRAINT attestation_schemas_tenant_scope_key    UNIQUE (tenant_id, id);
ALTER TABLE core.verification_cases     ADD CONSTRAINT verification_cases_tenant_scope_key     UNIQUE (tenant_id, id);
ALTER TABLE core.assignments            ADD CONSTRAINT assignments_tenant_scope_key            UNIQUE (tenant_id, id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_tenant_scope_key        UNIQUE (tenant_id, id);
ALTER TABLE core.compliance_policy_sets ADD CONSTRAINT policy_sets_tenant_scope_key            UNIQUE (tenant_id, id);
ALTER TABLE core.compliance_assessments ADD CONSTRAINT assessments_tenant_scope_key            UNIQUE (tenant_id, id);
ALTER TABLE core.registry_entries       ADD CONSTRAINT registry_entries_tenant_scope_key       UNIQUE (tenant_id, id);
ALTER TABLE core.registry_entry_versions ADD CONSTRAINT registry_versions_tenant_scope_key     UNIQUE (tenant_id, id);
ALTER TABLE chain.anchor_batches        ADD CONSTRAINT anchor_batches_tenant_scope_key         UNIQUE (tenant_id, id);
-- self-reference(replaced_by_id)도 tenant 경계를 지켜야 하므로 자신도 부모가 된다.
ALTER TABLE chain.transactions          ADD CONSTRAINT transactions_tenant_scope_key           UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- 2. 단일 컬럼 FK를 tenant 포함 복합 FK로 교체
-- ---------------------------------------------------------------------------

-- Identity
ALTER TABLE core.wallet_identities
  DROP CONSTRAINT wallet_identities_subject_id_fkey,
  ADD CONSTRAINT wallet_identities_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id);

ALTER TABLE core.credentials
  DROP CONSTRAINT credentials_subject_id_fkey,
  ADD CONSTRAINT credentials_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  DROP CONSTRAINT credentials_organization_id_fkey,
  ADD CONSTRAINT credentials_org_same_tenant
    FOREIGN KEY (tenant_id, organization_id) REFERENCES core.organizations (tenant_id, id);

ALTER TABLE core.role_bindings
  DROP CONSTRAINT role_bindings_subject_id_fkey,
  ADD CONSTRAINT role_bindings_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  DROP CONSTRAINT role_bindings_organization_id_fkey,
  ADD CONSTRAINT role_bindings_org_same_tenant
    FOREIGN KEY (tenant_id, organization_id) REFERENCES core.organizations (tenant_id, id);

-- Project — 이 결함이 처음 발견된 지점이다.
ALTER TABLE core.projects
  DROP CONSTRAINT projects_owner_organization_id_fkey,
  ADD CONSTRAINT projects_owner_org_same_tenant
    FOREIGN KEY (tenant_id, owner_organization_id) REFERENCES core.organizations (tenant_id, id);

ALTER TABLE core.project_facts
  DROP CONSTRAINT project_facts_project_id_fkey,
  ADD CONSTRAINT project_facts_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id);

-- Source integration
ALTER TABLE core.source_connections
  DROP CONSTRAINT source_connections_authority_id_fkey,
  ADD CONSTRAINT source_connections_authority_same_tenant
    FOREIGN KEY (tenant_id, authority_id) REFERENCES core.authorities (tenant_id, id);

ALTER TABLE core.source_receipts
  DROP CONSTRAINT source_receipts_project_id_fkey,
  ADD CONSTRAINT source_receipts_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  DROP CONSTRAINT source_receipts_connection_id_fkey,
  ADD CONSTRAINT source_receipts_connection_same_tenant
    FOREIGN KEY (tenant_id, connection_id) REFERENCES core.source_connections (tenant_id, id),
  DROP CONSTRAINT source_receipts_authority_id_fkey,
  ADD CONSTRAINT source_receipts_authority_same_tenant
    FOREIGN KEY (tenant_id, authority_id) REFERENCES core.authorities (tenant_id, id);

-- Evidence
ALTER TABLE core.artifacts
  DROP CONSTRAINT artifacts_project_id_fkey,
  ADD CONSTRAINT artifacts_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  DROP CONSTRAINT artifacts_source_receipt_id_fkey,
  ADD CONSTRAINT artifacts_receipt_same_tenant
    FOREIGN KEY (tenant_id, source_receipt_id) REFERENCES core.source_receipts (tenant_id, id),
  DROP CONSTRAINT artifacts_superseded_by_fkey,
  ADD CONSTRAINT artifacts_superseded_same_tenant
    FOREIGN KEY (tenant_id, superseded_by) REFERENCES core.artifacts (tenant_id, id);

ALTER TABLE core.claims
  DROP CONSTRAINT claims_project_id_fkey,
  ADD CONSTRAINT claims_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id);

ALTER TABLE core.claim_conflicts
  DROP CONSTRAINT claim_conflicts_claim_id_fkey,
  ADD CONSTRAINT claim_conflicts_claim_same_tenant
    FOREIGN KEY (tenant_id, claim_id) REFERENCES core.claims (tenant_id, id);

-- Verification
ALTER TABLE core.verification_cases
  DROP CONSTRAINT verification_cases_project_id_fkey,
  ADD CONSTRAINT verification_cases_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  DROP CONSTRAINT verification_cases_schema_id_fkey,
  ADD CONSTRAINT verification_cases_schema_same_tenant
    FOREIGN KEY (tenant_id, schema_id) REFERENCES core.attestation_schemas (tenant_id, id);

ALTER TABLE core.assignments
  DROP CONSTRAINT assignments_case_id_fkey,
  ADD CONSTRAINT assignments_case_same_tenant
    FOREIGN KEY (tenant_id, case_id) REFERENCES core.verification_cases (tenant_id, id),
  DROP CONSTRAINT assignments_subject_id_fkey,
  ADD CONSTRAINT assignments_subject_same_tenant
    FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  DROP CONSTRAINT assignments_credential_id_fkey,
  ADD CONSTRAINT assignments_credential_same_tenant
    FOREIGN KEY (tenant_id, credential_id) REFERENCES core.credentials (tenant_id, id);

ALTER TABLE core.verification_attestations
  DROP CONSTRAINT verification_attestations_case_id_fkey,
  ADD CONSTRAINT attestations_case_same_tenant
    FOREIGN KEY (tenant_id, case_id) REFERENCES core.verification_cases (tenant_id, id),
  DROP CONSTRAINT verification_attestations_assignment_id_fkey,
  ADD CONSTRAINT attestations_assignment_same_tenant
    FOREIGN KEY (tenant_id, assignment_id) REFERENCES core.assignments (tenant_id, id),
  DROP CONSTRAINT verification_attestations_credential_id_fkey,
  ADD CONSTRAINT attestations_credential_same_tenant
    FOREIGN KEY (tenant_id, credential_id) REFERENCES core.credentials (tenant_id, id),
  DROP CONSTRAINT verification_attestations_schema_id_fkey,
  ADD CONSTRAINT attestations_schema_same_tenant
    FOREIGN KEY (tenant_id, schema_id) REFERENCES core.attestation_schemas (tenant_id, id),
  DROP CONSTRAINT verification_attestations_supersedes_id_fkey,
  ADD CONSTRAINT attestations_supersedes_same_tenant
    FOREIGN KEY (tenant_id, supersedes_id) REFERENCES core.verification_attestations (tenant_id, id),
  DROP CONSTRAINT verification_attestations_revokes_id_fkey,
  ADD CONSTRAINT attestations_revokes_same_tenant
    FOREIGN KEY (tenant_id, revokes_id) REFERENCES core.verification_attestations (tenant_id, id);

-- Readiness
ALTER TABLE core.compliance_policy_sets
  DROP CONSTRAINT compliance_policy_sets_superseded_by_fkey,
  ADD CONSTRAINT policy_sets_superseded_same_tenant
    FOREIGN KEY (tenant_id, superseded_by) REFERENCES core.compliance_policy_sets (tenant_id, id);

ALTER TABLE core.compliance_assessments
  DROP CONSTRAINT compliance_assessments_project_id_fkey,
  ADD CONSTRAINT assessments_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  DROP CONSTRAINT compliance_assessments_policy_set_id_fkey,
  ADD CONSTRAINT assessments_policy_same_tenant
    FOREIGN KEY (tenant_id, policy_set_id) REFERENCES core.compliance_policy_sets (tenant_id, id);

ALTER TABLE core.gate_decisions
  DROP CONSTRAINT gate_decisions_project_id_fkey,
  ADD CONSTRAINT gate_decisions_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id),
  DROP CONSTRAINT gate_decisions_input_assessment_id_fkey,
  ADD CONSTRAINT gate_decisions_assessment_same_tenant
    FOREIGN KEY (tenant_id, input_assessment_id) REFERENCES core.compliance_assessments (tenant_id, id),
  DROP CONSTRAINT gate_decisions_decision_maker_subject_id_fkey,
  ADD CONSTRAINT gate_decisions_decider_same_tenant
    FOREIGN KEY (tenant_id, decision_maker_subject_id) REFERENCES core.subjects (tenant_id, id);

-- Registry
ALTER TABLE core.registry_entry_versions
  DROP CONSTRAINT registry_entry_versions_entry_id_fkey,
  ADD CONSTRAINT registry_versions_entry_same_tenant
    FOREIGN KEY (tenant_id, entry_id) REFERENCES core.registry_entries (tenant_id, id),
  DROP CONSTRAINT registry_entry_versions_previous_version_id_fkey,
  ADD CONSTRAINT registry_versions_previous_same_tenant
    FOREIGN KEY (tenant_id, previous_version_id) REFERENCES core.registry_entry_versions (tenant_id, id),
  DROP CONSTRAINT registry_entry_versions_superseded_by_id_fkey,
  ADD CONSTRAINT registry_versions_superseded_same_tenant
    FOREIGN KEY (tenant_id, superseded_by_id) REFERENCES core.registry_entry_versions (tenant_id, id);

ALTER TABLE core.disclosure_restrictions
  DROP CONSTRAINT disclosure_restrictions_project_id_fkey,
  ADD CONSTRAINT disclosure_restrictions_project_same_tenant
    FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects (tenant_id, id);

-- Chain
ALTER TABLE chain.transactions
  DROP CONSTRAINT transactions_batch_id_fkey,
  ADD CONSTRAINT transactions_batch_same_tenant
    FOREIGN KEY (tenant_id, batch_id) REFERENCES chain.anchor_batches (tenant_id, id),
  DROP CONSTRAINT transactions_replaced_by_id_fkey,
  ADD CONSTRAINT transactions_replacement_same_tenant
    FOREIGN KEY (tenant_id, replaced_by_id) REFERENCES chain.transactions (tenant_id, id);

-- chain.anchor_batch_leaves는 tenant_id 컬럼이 없다. 상위 batch를 통해서만
-- 접근되므로 batch의 tenant 경계를 상속한다. R1에서 leaf 조회 경로가 생기면
-- tenant_id를 추가하고 같은 규칙을 적용한다.
