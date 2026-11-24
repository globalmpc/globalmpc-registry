-- Remove the tenant from the Registry.
--
-- The Registry is one shared instance in which organizations own projects and role bindings
-- decide reach. The tenant was a second, coarser boundary around everything; production holds
-- exactly one, so removing it changes no record's owner and no person's reach within it.
--
-- What changes:
--   * Every `tenant_id` column, the `core.tenants` table, `core.current_tenant()` and the
--     `app.current_tenant` setting are gone. Old API and worker tasks that still set the tenant
--     stop working; the operator accepted that no old task runs during this deploy.
--   * Row-level security is actor-based throughout (0168): project-owned records by the actor's
--     project reach, their child records through the parent, records without a project and
--     Registry reference/account records by a live actor.
--   * Keys and foreign keys that paired a column with the tenant now name the column alone. The
--     single tenant made each pair unique already, so no existing row can collide.
--   * Functions keep their behaviour with the tenant comparisons, columns and arguments removed.
--     Functions whose arguments or results named the tenant are recreated with their grants.
--   * The `tenant` role scope is renamed `registry`. Its meaning (every project, the operator's
--     roles) is unchanged, so no audit reinterpretation is recorded.
--   * `audit.events` loses its tenant column with the rest. Signed payloads, anchored leaves and
--     stored objects never contained the tenant; they keep their bytes.
--
-- Generated from the catalog at 0168 and reviewed by hand. The final block fails the migration
-- if any tenant reference or policy-less RLS table remains.

-- Merging tenants would silently move one organization's records under another's keys and
-- reach. Production holds one; refuse anything else instead of guessing.
DO $$
BEGIN
  IF (SELECT count(*) FROM core.tenants) > 1 THEN
    RAISE EXCEPTION 'TENANT_REMOVAL_REQUIRES_ONE_TENANT: found % tenants', (SELECT count(*) FROM core.tenants);
  END IF;
END
$$;

-- The migration owner must not be subject to row-level security, as the definer functions it
-- owns already require (0131; docs/operations/deployment.md): the actor helpers below read role
-- bindings and subjects with row_security off, and this migration rewrites rows of forced-RLS
-- tables. An owner that RLS still filters would fail part-way or, worse, rewrite only the rows it
-- sees. Refuse first.
--
-- Checked by behaviour, not by role attribute. Superuser and BYPASSRLS are the documented ways,
-- but a managed database can exempt its master role otherwise: the Aurora develop deployment's
-- `postgres` has neither attribute, yet its definers (sign-in, session resolution) have worked
-- since 0131 under `row_security = off`, which PostgreSQL refuses for any query RLS would affect.
-- So each RLS table is read here with `row_security = off`: that read succeeds only when RLS does
-- not apply to this role on that table, which is the condition the definers and the rewrites
-- below need. Any failure lists the tables and the role's attributes, so the refusal can be
-- diagnosed from the migration log alone.
DO $$
DECLARE
  previous TEXT := current_setting('row_security');
  t RECORD;
  refused TEXT[] := '{}';
  attrs TEXT;
BEGIN
  PERFORM set_config('row_security', 'off', true);
  FOR t IN
    SELECT c.oid::regclass AS rel, c.relforcerowsecurity AS forced, pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname IN ('core', 'chain', 'audit') AND c.relkind IN ('r', 'p') AND c.relrowsecurity
    ORDER BY 1
  LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM %s LIMIT 1', t.rel);
    EXCEPTION WHEN insufficient_privilege THEN
      refused := refused || format('%s (owner %s, force %s)', t.rel, t.owner, t.forced);
    END;
  END LOOP;
  PERFORM set_config('row_security', previous, true);
  IF cardinality(refused) > 0 THEN
    SELECT format('superuser %s, bypassrls %s, member of %s', r.rolsuper, r.rolbypassrls,
        COALESCE((SELECT string_agg(b.rolname, ', ' ORDER BY b.rolname) FROM pg_auth_members m
          JOIN pg_roles b ON b.oid = m.roleid WHERE m.member = r.oid), 'nothing'))
      INTO attrs FROM pg_roles r WHERE r.rolname = current_user;
    RAISE EXCEPTION 'TENANT_REMOVAL_REQUIRES_BYPASSRLS: row-level security still applies to % (%) on % table(s): %',
        current_user, attrs, cardinality(refused), array_to_string(refused[1:10], '; ')
      USING HINT = 'Run migrations as the owner that owns the SECURITY DEFINER functions and is not subject to RLS (superuser or BYPASSRLS)';
  END IF;
END
$$;

-- A live actor: the request names a subject that exists and is not suspended.
CREATE FUNCTION core.actor_live() RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, core, pg_temp SET row_security = off AS $$
  SELECT EXISTS (
    SELECT FROM core.subjects AS s WHERE s.id = core.current_actor() AND s.suspended_at IS NULL
  )
$$;
REVOKE EXECUTE ON FUNCTION core.actor_live() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.actor_live() TO mpc_app;


-- 1. Tenant policies. Actor policies replace them in step 9.
DROP POLICY tenant_isolation ON audit.events;
DROP POLICY tenant_isolation ON chain.anchor_batches;
DROP POLICY tenant_isolation ON chain.anchor_proposals;
DROP POLICY tenant_isolation ON chain.anchor_sends;
DROP POLICY tenant_isolation ON chain.gas_spend;
DROP POLICY tenant_isolation ON chain.reorg_events;
DROP POLICY tenant_isolation ON chain.safe_execution_history;
DROP POLICY tenant_isolation ON chain.transactions;
DROP POLICY tenant_isolation ON core.artifacts;
DROP POLICY tenant_isolation ON core.assignments;
DROP POLICY tenant_isolation ON core.attestation_disputes;
DROP POLICY tenant_isolation ON core.attestation_schemas;
DROP POLICY tenant_isolation ON core.attestation_signature_requests;
DROP POLICY tenant_isolation ON core.authorities;
DROP POLICY tenant_isolation ON core.authority_versions;
DROP POLICY break_glass_elevations_tenant ON core.break_glass_elevations;
DROP POLICY tenant_isolation ON core.claim_conflicts;
DROP POLICY claim_derivations_tenant ON core.claim_derivations;
DROP POLICY claim_types_tenant ON core.claim_types;
DROP POLICY tenant_isolation ON core.claims;
DROP POLICY tenant_isolation ON core.compliance_assessments;
DROP POLICY tenant_isolation ON core.compliance_policy_sets;
DROP POLICY connection_security_reviews_tenant ON core.connection_security_reviews;
DROP POLICY tenant_isolation ON core.cre_reports;
DROP POLICY tenant_isolation ON core.credential_status_events;
DROP POLICY tenant_isolation ON core.credentials;
DROP POLICY disclosure_restriction_events_tenant ON core.disclosure_restriction_events;
DROP POLICY tenant_isolation ON core.disclosure_restrictions;
DROP POLICY tenant_isolation ON core.document_impacts;
DROP POLICY tenant_isolation ON core.document_link_rules;
DROP POLICY tenant_isolation ON core.document_links;
DROP POLICY tenant_isolation ON core.document_requirements;
DROP POLICY tenant_isolation ON core.email_challenges;
DROP POLICY tenant_isolation ON core.email_change_requests;
DROP POLICY evidence_ledger_tenant ON core.evidence_ledger_snapshots;
DROP POLICY tenant_isolation ON core.evidence_stale_signals;
DROP POLICY tenant_isolation ON core.external_identities;
DROP POLICY tenant_isolation ON core.gate_decision_signature_requests;
DROP POLICY tenant_isolation ON core.gate_decisions;
DROP POLICY tenant_isolation ON core.governance_execution_records;
DROP POLICY tenant_isolation ON core.governance_proposals;
DROP POLICY tenant_isolation ON core.governance_transitions;
DROP POLICY tenant_isolation ON core.governance_vote_weights;
DROP POLICY tenant_isolation ON core.governance_votes;
DROP POLICY tenant_isolation ON core.idempotency_keys;
DROP POLICY tenant_isolation ON core.invitations;
DROP POLICY jurisdiction_profiles_tenant ON core.jurisdiction_profiles;
DROP POLICY tenant_isolation ON core.lineage_edges;
DROP POLICY tenant_isolation ON core.mfa_reset_requests;
DROP POLICY notification_deliveries_tenant ON core.notification_deliveries;
DROP POLICY notification_reads_tenant ON core.notification_reads;
DROP POLICY notification_sinks_tenant ON core.notification_sinks;
DROP POLICY notifications_tenant ON core.notifications;
DROP POLICY tenant_isolation ON core.object_uploads;
DROP POLICY tenant_isolation ON core.oidc_login_transactions;
DROP POLICY tenant_isolation ON core.organizations;
DROP POLICY tenant_isolation ON core.outbox;
DROP POLICY project_fact_versions_tenant ON core.project_fact_versions;
DROP POLICY tenant_isolation ON core.project_facts;
DROP POLICY project_lifecycle_transitions_tenant ON core.project_lifecycle_transitions;
DROP POLICY project_parties_tenant ON core.project_parties;
DROP POLICY project_party_versions_tenant ON core.project_party_versions;
DROP POLICY project_registration_requests_tenant ON core.project_registration_requests;
DROP POLICY project_stakeholder_events_tenant ON core.project_stakeholder_events;
DROP POLICY tenant_isolation ON core.projects;
DROP POLICY tenant_isolation ON core.provenance_axis_history;
DROP POLICY tenant_isolation ON core.recovery_codes;
DROP POLICY tenant_isolation ON core.registry_entries;
DROP POLICY tenant_isolation ON core.registry_entry_versions;
DROP POLICY registry_proposals_tenant ON core.registry_proposals;
DROP POLICY registry_publication_drafts_tenant ON core.registry_publication_drafts;
DROP POLICY tenant_isolation ON core.registry_review_bundles;
DROP POLICY tenant_isolation ON core.role_bindings;
DROP POLICY role_grant_requests_tenant ON core.role_grant_requests;
DROP POLICY role_revocation_requests_tenant ON core.role_revocation_requests;
DROP POLICY schema_activation_clock_tenant ON core.schema_activation_clocks;
DROP POLICY tenant_isolation ON core.service_tokens;
DROP POLICY tenant_isolation ON core.session_factor_proofs;
DROP POLICY tenant_isolation ON core.sessions;
DROP POLICY source_connection_transitions_tenant ON core.source_connection_transitions;
DROP POLICY tenant_isolation ON core.source_connections;
DROP POLICY tenant_isolation ON core.source_observations;
DROP POLICY tenant_isolation ON core.source_receipts;
DROP POLICY source_reconciliation_tasks_tenant ON core.source_reconciliation_tasks;
DROP POLICY tenant_isolation ON core.subject_suspensions;
DROP POLICY tenant_isolation ON core.subjects;
DROP POLICY tenant_isolation ON core.totp_authenticators;
DROP POLICY tenant_isolation ON core.verification_attestations;
DROP POLICY tenant_isolation ON core.verification_case_claims;
DROP POLICY tenant_isolation ON core.verification_case_transitions;
DROP POLICY tenant_isolation ON core.verification_cases;
DROP POLICY tenant_isolation ON core.wallet_binding_challenges;
DROP POLICY wallet_disable_events_tenant ON core.wallet_disable_events;
DROP POLICY tenant_isolation ON core.wallet_identities;
DROP POLICY tenant_isolation ON core.wallet_recoveries;
DROP POLICY tenant_isolation ON core.webauthn_challenges;
DROP POLICY tenant_isolation ON core.webauthn_credentials;

-- 2. Objects that exist only to carry the tenant: the 0167 rolling-deploy view and its
--    trigger, and views that expose the column (recreated in step 8).
DROP VIEW core.project_exports;
DROP FUNCTION core.insert_legacy_project_export();
DROP VIEW core.claims_without_evidence;
DROP VIEW core.document_status;

-- 3. Constraints that name the tenant. Foreign keys first, then the keys they reference.
ALTER TABLE chain.anchor_batches DROP CONSTRAINT anchor_batch_project_scope;
ALTER TABLE chain.anchor_batches DROP CONSTRAINT anchor_batches_tenant_id_fkey;
ALTER TABLE chain.anchor_proposals DROP CONSTRAINT anchor_proposals_tenant_id_fkey;
ALTER TABLE chain.anchor_sends DROP CONSTRAINT anchor_sends_tenant_id_fkey;
ALTER TABLE chain.gas_spend DROP CONSTRAINT gas_spend_tenant_id_fkey;
ALTER TABLE chain.reorg_events DROP CONSTRAINT reorg_events_tenant_id_fkey;
ALTER TABLE chain.safe_execution_history DROP CONSTRAINT safe_execution_history_proposal_id_transaction_id_tenant_i_fkey;
ALTER TABLE chain.safe_execution_history DROP CONSTRAINT safe_execution_history_tenant_id_fkey;
ALTER TABLE chain.safe_execution_history DROP CONSTRAINT safe_execution_history_transaction_id_tenant_id_fkey;
ALTER TABLE chain.transactions DROP CONSTRAINT transactions_batch_same_tenant;
ALTER TABLE chain.transactions DROP CONSTRAINT transactions_replacement_same_tenant;
ALTER TABLE chain.transactions DROP CONSTRAINT transactions_tenant_id_fkey;
ALTER TABLE core.artifacts DROP CONSTRAINT artifacts_project_same_tenant;
ALTER TABLE core.artifacts DROP CONSTRAINT artifacts_receipt_same_tenant;
ALTER TABLE core.artifacts DROP CONSTRAINT artifacts_superseded_same_tenant;
ALTER TABLE core.artifacts DROP CONSTRAINT artifacts_tenant_id_fkey;
ALTER TABLE core.assignments DROP CONSTRAINT assignments_assigned_by_same_tenant;
ALTER TABLE core.assignments DROP CONSTRAINT assignments_case_same_tenant;
ALTER TABLE core.assignments DROP CONSTRAINT assignments_credential_same_tenant;
ALTER TABLE core.assignments DROP CONSTRAINT assignments_revoked_by_same_tenant;
ALTER TABLE core.assignments DROP CONSTRAINT assignments_subject_same_tenant;
ALTER TABLE core.assignments DROP CONSTRAINT assignments_tenant_id_fkey;
ALTER TABLE core.attestation_disputes DROP CONSTRAINT attestation_disputes_tenant_id_attestation_id_fkey;
ALTER TABLE core.attestation_disputes DROP CONSTRAINT attestation_disputes_tenant_id_fkey;
ALTER TABLE core.attestation_schemas DROP CONSTRAINT attestation_schemas_tenant_id_fkey;
ALTER TABLE core.attestation_signature_requests DROP CONSTRAINT attestation_signature_requests_tenant_id_fkey;
ALTER TABLE core.attestation_signature_requests DROP CONSTRAINT signature_request_attestation_same_tenant;
ALTER TABLE core.authorities DROP CONSTRAINT authorities_tenant_id_fkey;
ALTER TABLE core.authority_versions DROP CONSTRAINT authority_versions_tenant_id_authority_id_fkey;
ALTER TABLE core.authority_versions DROP CONSTRAINT authority_versions_tenant_id_fkey;
ALTER TABLE core.break_glass_elevations DROP CONSTRAINT break_glass_decider_same_tenant;
ALTER TABLE core.break_glass_elevations DROP CONSTRAINT break_glass_elevations_tenant_id_fkey;
ALTER TABLE core.break_glass_elevations DROP CONSTRAINT break_glass_incident_recorder_same_tenant;
ALTER TABLE core.break_glass_elevations DROP CONSTRAINT break_glass_releaser_same_tenant;
ALTER TABLE core.break_glass_elevations DROP CONSTRAINT break_glass_subject_same_tenant;
ALTER TABLE core.claim_conflicts DROP CONSTRAINT claim_conflicts_claim_same_tenant;
ALTER TABLE core.claim_conflicts DROP CONSTRAINT claim_conflicts_tenant_id_fkey;
ALTER TABLE core.claim_derivations DROP CONSTRAINT claim_derivations_tenant_id_author_subject_id_fkey;
ALTER TABLE core.claim_derivations DROP CONSTRAINT claim_derivations_tenant_id_claim_id_fkey;
ALTER TABLE core.claim_derivations DROP CONSTRAINT claim_derivations_tenant_id_fkey;
ALTER TABLE core.claim_types DROP CONSTRAINT catalog_project_same_tenant;
ALTER TABLE core.claim_types DROP CONSTRAINT claim_types_tenant_id_fkey;
ALTER TABLE core.claims DROP CONSTRAINT claims_catalog_same_tenant;
ALTER TABLE core.claims DROP CONSTRAINT claims_project_same_tenant;
ALTER TABLE core.claims DROP CONSTRAINT claims_source_receipt_fk;
ALTER TABLE core.claims DROP CONSTRAINT claims_submitted_by_same_tenant;
ALTER TABLE core.claims DROP CONSTRAINT claims_superseded_by_same_tenant;
ALTER TABLE core.claims DROP CONSTRAINT claims_supersedes_same_tenant;
ALTER TABLE core.claims DROP CONSTRAINT claims_tenant_id_fkey;
ALTER TABLE core.compliance_assessments DROP CONSTRAINT assessments_policy_same_tenant;
ALTER TABLE core.compliance_assessments DROP CONSTRAINT assessments_project_same_tenant;
ALTER TABLE core.compliance_assessments DROP CONSTRAINT compliance_assessments_tenant_id_fkey;
ALTER TABLE core.compliance_policy_sets DROP CONSTRAINT compliance_policy_sets_tenant_id_fkey;
ALTER TABLE core.compliance_policy_sets DROP CONSTRAINT policy_project_same_tenant;
ALTER TABLE core.compliance_policy_sets DROP CONSTRAINT policy_sets_superseded_same_tenant;
ALTER TABLE core.connection_security_reviews DROP CONSTRAINT connection_review_same_tenant;
ALTER TABLE core.connection_security_reviews DROP CONSTRAINT connection_reviewer_same_tenant;
ALTER TABLE core.connection_security_reviews DROP CONSTRAINT connection_security_reviews_tenant_id_fkey;
ALTER TABLE core.cre_reports DROP CONSTRAINT cre_reports_tenant_id_fkey;
ALTER TABLE core.cre_reports DROP CONSTRAINT cre_reports_tenant_id_project_id_fkey;
ALTER TABLE core.cre_reports DROP CONSTRAINT cre_reports_tenant_id_registry_version_id_fkey;
ALTER TABLE core.credential_status_events DROP CONSTRAINT credential_status_events_tenant_id_credential_id_fkey;
ALTER TABLE core.credential_status_events DROP CONSTRAINT credential_status_events_tenant_id_fkey;
ALTER TABLE core.credentials DROP CONSTRAINT credentials_issuer_authority_same_tenant;
ALTER TABLE core.credentials DROP CONSTRAINT credentials_org_same_tenant;
ALTER TABLE core.credentials DROP CONSTRAINT credentials_subject_same_tenant;
ALTER TABLE core.credentials DROP CONSTRAINT credentials_tenant_id_fkey;
ALTER TABLE core.disclosure_restriction_events DROP CONSTRAINT disclosure_restriction_events_tenant_id_fkey;
ALTER TABLE core.disclosure_restriction_events DROP CONSTRAINT disclosure_restriction_events_tenant_id_project_id_fkey;
ALTER TABLE core.disclosure_restriction_events DROP CONSTRAINT disclosure_restriction_events_tenant_id_restriction_id_fkey;
ALTER TABLE core.disclosure_restrictions DROP CONSTRAINT disclosure_restrictions_project_same_tenant;
ALTER TABLE core.disclosure_restrictions DROP CONSTRAINT disclosure_restrictions_superseded_by_same_tenant;
ALTER TABLE core.disclosure_restrictions DROP CONSTRAINT disclosure_restrictions_tenant_id_fkey;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impact_origin_same_project;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impact_revision_same_project;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impact_successor_same_project;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impact_upload_same_project;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impact_via_same_project;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impacts_tenant_id_fkey;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impacts_tenant_id_resolved_by_fkey;
ALTER TABLE core.document_link_rules DROP CONSTRAINT document_link_rules_tenant_id_created_by_fkey;
ALTER TABLE core.document_link_rules DROP CONSTRAINT document_link_rules_tenant_id_fkey;
ALTER TABLE core.document_link_rules DROP CONSTRAINT document_link_rules_tenant_id_retired_by_fkey;
ALTER TABLE core.document_links DROP CONSTRAINT document_link_downstream_same_project;
ALTER TABLE core.document_links DROP CONSTRAINT document_link_upstream_same_project;
ALTER TABLE core.document_links DROP CONSTRAINT document_links_tenant_id_carried_from_link_id_fkey;
ALTER TABLE core.document_links DROP CONSTRAINT document_links_tenant_id_created_by_fkey;
ALTER TABLE core.document_links DROP CONSTRAINT document_links_tenant_id_fkey;
ALTER TABLE core.document_links DROP CONSTRAINT document_links_tenant_id_removed_by_fkey;
ALTER TABLE core.document_links DROP CONSTRAINT document_links_tenant_id_rule_id_fkey;
ALTER TABLE core.document_requirements DROP CONSTRAINT document_requirements_tenant_id_created_by_fkey;
ALTER TABLE core.document_requirements DROP CONSTRAINT document_requirements_tenant_id_fkey;
ALTER TABLE core.document_requirements DROP CONSTRAINT document_requirements_tenant_id_project_id_fkey;
ALTER TABLE core.document_requirements DROP CONSTRAINT document_requirements_tenant_id_retired_by_fkey;
ALTER TABLE core.email_challenges DROP CONSTRAINT email_challenges_tenant_id_fkey;
ALTER TABLE core.email_challenges DROP CONSTRAINT email_challenges_tenant_id_subject_id_fkey;
ALTER TABLE core.email_change_requests DROP CONSTRAINT email_change_requests_tenant_id_decided_by_subject_id_fkey;
ALTER TABLE core.email_change_requests DROP CONSTRAINT email_change_requests_tenant_id_fkey;
ALTER TABLE core.email_change_requests DROP CONSTRAINT email_change_requests_tenant_id_requested_by_subject_id_fkey;
ALTER TABLE core.email_change_requests DROP CONSTRAINT email_change_requests_tenant_id_subject_id_fkey;
ALTER TABLE core.evidence_ledger_snapshots DROP CONSTRAINT evidence_ledger_snapshots_tenant_id_fkey;
ALTER TABLE core.evidence_ledger_snapshots DROP CONSTRAINT evidence_ledger_snapshots_tenant_id_project_id_fkey;
ALTER TABLE core.evidence_stale_signals DROP CONSTRAINT evidence_stale_signals_tenant_id_fkey;
ALTER TABLE core.evidence_stale_signals DROP CONSTRAINT stale_signal_policy_same_tenant;
ALTER TABLE core.external_identities DROP CONSTRAINT external_identities_tenant_id_fkey;
ALTER TABLE core.external_identities DROP CONSTRAINT external_identities_tenant_id_subject_id_fkey;
ALTER TABLE core.gate_decision_signature_requests DROP CONSTRAINT gate_decision_signature_requests_tenant_id_fkey;
ALTER TABLE core.gate_decision_signature_requests DROP CONSTRAINT gate_signature_request_assessment_same_tenant;
ALTER TABLE core.gate_decision_signature_requests DROP CONSTRAINT gate_signature_request_project_same_tenant;
ALTER TABLE core.gate_decision_signature_requests DROP CONSTRAINT gate_signature_request_subject_same_tenant;
ALTER TABLE core.gate_decisions DROP CONSTRAINT gate_decision_signature_request_same_tenant;
ALTER TABLE core.gate_decisions DROP CONSTRAINT gate_decisions_assessment_same_tenant;
ALTER TABLE core.gate_decisions DROP CONSTRAINT gate_decisions_decider_same_tenant;
ALTER TABLE core.gate_decisions DROP CONSTRAINT gate_decisions_project_same_tenant;
ALTER TABLE core.gate_decisions DROP CONSTRAINT gate_decisions_tenant_id_fkey;
ALTER TABLE core.governance_execution_records DROP CONSTRAINT governance_execution_records_tenant_id_fkey;
ALTER TABLE core.governance_execution_records DROP CONSTRAINT governance_execution_records_tenant_id_proposal_id_fkey;
ALTER TABLE core.governance_proposals DROP CONSTRAINT governance_proposals_tenant_id_fkey;
ALTER TABLE core.governance_proposals DROP CONSTRAINT governance_proposals_tenant_id_project_id_fkey;
ALTER TABLE core.governance_transitions DROP CONSTRAINT governance_transitions_tenant_id_fkey;
ALTER TABLE core.governance_transitions DROP CONSTRAINT governance_transitions_tenant_id_proposal_id_fkey;
ALTER TABLE core.governance_vote_weights DROP CONSTRAINT governance_vote_weights_tenant_id_fkey;
ALTER TABLE core.governance_vote_weights DROP CONSTRAINT governance_vote_weights_tenant_id_proposal_id_fkey;
ALTER TABLE core.governance_votes DROP CONSTRAINT governance_votes_tenant_id_fkey;
ALTER TABLE core.governance_votes DROP CONSTRAINT governance_votes_tenant_id_proposal_id_fkey;
ALTER TABLE core.idempotency_keys DROP CONSTRAINT idempotency_keys_tenant_id_fkey;
ALTER TABLE core.invitations DROP CONSTRAINT invitations_tenant_id_accepted_subject_id_fkey;
ALTER TABLE core.invitations DROP CONSTRAINT invitations_tenant_id_fkey;
ALTER TABLE core.invitations DROP CONSTRAINT invitations_tenant_id_invited_by_subject_id_fkey;
ALTER TABLE core.invitations DROP CONSTRAINT invitations_tenant_id_invited_project_id_fkey;
ALTER TABLE core.invitations DROP CONSTRAINT invitations_tenant_id_organization_id_fkey;
ALTER TABLE core.invitations DROP CONSTRAINT invitations_tenant_id_revoked_by_subject_id_fkey;
ALTER TABLE core.jurisdiction_profiles DROP CONSTRAINT jurisdiction_profiles_tenant_id_fkey;
ALTER TABLE core.lineage_edges DROP CONSTRAINT lineage_edges_tenant_id_fkey;
ALTER TABLE core.mfa_reset_requests DROP CONSTRAINT mfa_reset_decider_same_tenant;
ALTER TABLE core.mfa_reset_requests DROP CONSTRAINT mfa_reset_requester_same_tenant;
ALTER TABLE core.mfa_reset_requests DROP CONSTRAINT mfa_reset_requests_tenant_id_fkey;
ALTER TABLE core.mfa_reset_requests DROP CONSTRAINT mfa_reset_subject_same_tenant;
ALTER TABLE core.notification_deliveries DROP CONSTRAINT notification_deliveries_tenant_id_fkey;
ALTER TABLE core.notification_reads DROP CONSTRAINT notification_reads_tenant_id_fkey;
ALTER TABLE core.notification_sinks DROP CONSTRAINT notification_sinks_tenant_id_fkey;
ALTER TABLE core.notifications DROP CONSTRAINT notifications_tenant_id_fkey;
ALTER TABLE core.notifications DROP CONSTRAINT notifications_tenant_id_project_id_fkey;
ALTER TABLE core.object_uploads DROP CONSTRAINT object_uploads_artifact_same_tenant;
ALTER TABLE core.object_uploads DROP CONSTRAINT object_uploads_project_same_tenant;
ALTER TABLE core.object_uploads DROP CONSTRAINT object_uploads_tenant_id_fkey;
ALTER TABLE core.object_uploads DROP CONSTRAINT object_uploads_uploader_same_tenant;
ALTER TABLE core.object_uploads DROP CONSTRAINT upload_revoker_same_tenant;
ALTER TABLE core.object_uploads DROP CONSTRAINT upload_supersedes_same_project;
ALTER TABLE core.oidc_login_transactions DROP CONSTRAINT oidc_login_transactions_tenant_id_fkey;
ALTER TABLE core.oidc_login_transactions DROP CONSTRAINT oidc_login_transactions_tenant_id_subject_id_fkey;
ALTER TABLE core.organizations DROP CONSTRAINT organizations_tenant_id_fkey;
ALTER TABLE core.outbox DROP CONSTRAINT outbox_tenant_id_fkey;
ALTER TABLE core.project_fact_versions DROP CONSTRAINT project_fact_versions_tenant_id_fkey;
ALTER TABLE core.project_fact_versions DROP CONSTRAINT project_fact_versions_tenant_id_project_id_fkey;
ALTER TABLE core.project_fact_versions DROP CONSTRAINT project_fact_versions_tenant_id_recorded_by_subject_id_fkey;
ALTER TABLE core.project_facts DROP CONSTRAINT project_facts_project_same_tenant;
ALTER TABLE core.project_facts DROP CONSTRAINT project_facts_recorder_same_tenant;
ALTER TABLE core.project_facts DROP CONSTRAINT project_facts_tenant_id_fkey;
ALTER TABLE core.project_lifecycle_transitions DROP CONSTRAINT project_lifecycle_transitions_tenant_id_fkey;
ALTER TABLE core.project_lifecycle_transitions DROP CONSTRAINT project_lifecycle_transitions_tenant_id_project_id_fkey;
ALTER TABLE core.project_parties DROP CONSTRAINT project_parties_tenant_id_fkey;
ALTER TABLE core.project_parties DROP CONSTRAINT project_parties_tenant_id_organization_id_fkey;
ALTER TABLE core.project_parties DROP CONSTRAINT project_parties_tenant_id_project_id_fkey;
ALTER TABLE core.project_parties DROP CONSTRAINT project_parties_tenant_id_submitted_by_subject_id_fkey;
ALTER TABLE core.project_party_versions DROP CONSTRAINT project_party_versions_tenant_id_fkey;
ALTER TABLE core.project_party_versions DROP CONSTRAINT project_party_versions_tenant_id_party_id_fkey;
ALTER TABLE core.project_party_versions DROP CONSTRAINT project_party_versions_tenant_id_recorded_by_subject_id_fkey;
ALTER TABLE core.project_registration_requests DROP CONSTRAINT project_registration_requests_tenant_id_fkey;
ALTER TABLE core.project_registration_requests DROP CONSTRAINT project_registration_requests_tenant_id_project_id_fkey;
ALTER TABLE core.project_registration_requests DROP CONSTRAINT project_registration_requests_tenant_id_requested_by_subje_fkey;
ALTER TABLE core.project_stakeholder_events DROP CONSTRAINT project_stakeholder_events_tenant_id_fkey;
ALTER TABLE core.project_stakeholder_events DROP CONSTRAINT project_stakeholder_events_tenant_id_project_id_fkey;
ALTER TABLE core.project_stakeholder_events DROP CONSTRAINT project_stakeholder_events_tenant_id_recorded_by_subject_i_fkey;
ALTER TABLE core.project_stakeholder_events DROP CONSTRAINT project_stakeholder_events_tenant_id_supersedes_id_fkey;
ALTER TABLE core.projects DROP CONSTRAINT projects_owner_org_same_tenant;
ALTER TABLE core.projects DROP CONSTRAINT projects_tenant_id_fkey;
ALTER TABLE core.provenance_axis_history DROP CONSTRAINT provenance_axis_history_tenant_id_fkey;
ALTER TABLE core.recovery_codes DROP CONSTRAINT recovery_codes_subject_same_tenant;
ALTER TABLE core.recovery_codes DROP CONSTRAINT recovery_codes_tenant_id_fkey;
ALTER TABLE core.registry_entries DROP CONSTRAINT registry_entries_tenant_id_fkey;
ALTER TABLE core.registry_entry_versions DROP CONSTRAINT registry_entry_versions_tenant_id_fkey;
ALTER TABLE core.registry_entry_versions DROP CONSTRAINT registry_versions_entry_same_tenant;
ALTER TABLE core.registry_entry_versions DROP CONSTRAINT registry_versions_previous_same_tenant;
ALTER TABLE core.registry_entry_versions DROP CONSTRAINT registry_versions_superseded_same_tenant;
ALTER TABLE core.registry_proposals DROP CONSTRAINT registry_proposals_decider_same_tenant;
ALTER TABLE core.registry_proposals DROP CONSTRAINT registry_proposals_proposer_same_tenant;
ALTER TABLE core.registry_proposals DROP CONSTRAINT registry_proposals_tenant_id_fkey;
ALTER TABLE core.registry_publication_drafts DROP CONSTRAINT registry_drafts_decider_same_tenant;
ALTER TABLE core.registry_publication_drafts DROP CONSTRAINT registry_drafts_entry_version_same_tenant;
ALTER TABLE core.registry_publication_drafts DROP CONSTRAINT registry_drafts_proposer_same_tenant;
ALTER TABLE core.registry_publication_drafts DROP CONSTRAINT registry_publication_drafts_tenant_id_fkey;
ALTER TABLE core.registry_review_bundles DROP CONSTRAINT registry_review_bundles_tenant_id_entry_version_id_fkey;
ALTER TABLE core.registry_review_bundles DROP CONSTRAINT registry_review_bundles_tenant_id_fkey;
ALTER TABLE core.registry_review_bundles DROP CONSTRAINT review_bundle_project_tenant;
ALTER TABLE core.role_bindings DROP CONSTRAINT role_bindings_org_same_tenant;
ALTER TABLE core.role_bindings DROP CONSTRAINT role_bindings_subject_same_tenant;
ALTER TABLE core.role_bindings DROP CONSTRAINT role_bindings_tenant_id_fkey;
ALTER TABLE core.role_grant_requests DROP CONSTRAINT role_grant_requests_tenant_id_fkey;
ALTER TABLE core.role_grant_requests DROP CONSTRAINT role_grant_requests_tenant_id_project_id_fkey;
ALTER TABLE core.role_revocation_requests DROP CONSTRAINT role_revocation_binding_same_tenant;
ALTER TABLE core.role_revocation_requests DROP CONSTRAINT role_revocation_decider_same_tenant;
ALTER TABLE core.role_revocation_requests DROP CONSTRAINT role_revocation_requester_same_tenant;
ALTER TABLE core.role_revocation_requests DROP CONSTRAINT role_revocation_requests_tenant_id_fkey;
ALTER TABLE core.schema_activation_clocks DROP CONSTRAINT schema_activation_clocks_tenant_id_fkey;
ALTER TABLE core.service_tokens DROP CONSTRAINT service_tokens_tenant_id_fkey;
ALTER TABLE core.service_tokens DROP CONSTRAINT service_tokens_tenant_id_subject_id_fkey;
ALTER TABLE core.session_factor_proofs DROP CONSTRAINT session_factor_proofs_subject_same_tenant;
ALTER TABLE core.session_factor_proofs DROP CONSTRAINT session_factor_proofs_tenant_id_fkey;
ALTER TABLE core.sessions DROP CONSTRAINT sessions_subject_same_tenant;
ALTER TABLE core.sessions DROP CONSTRAINT sessions_tenant_id_fkey;
ALTER TABLE core.source_connection_transitions DROP CONSTRAINT source_connection_transitions_tenant_id_connection_id_fkey;
ALTER TABLE core.source_connection_transitions DROP CONSTRAINT source_connection_transitions_tenant_id_fkey;
ALTER TABLE core.source_connections DROP CONSTRAINT source_connections_authority_same_tenant;
ALTER TABLE core.source_connections DROP CONSTRAINT source_connections_tenant_id_fkey;
ALTER TABLE core.source_observations DROP CONSTRAINT source_observations_tenant_id_connection_id_fkey;
ALTER TABLE core.source_observations DROP CONSTRAINT source_observations_tenant_id_fkey;
ALTER TABLE core.source_observations DROP CONSTRAINT source_observations_tenant_id_previous_receipt_id_fkey;
ALTER TABLE core.source_observations DROP CONSTRAINT source_observations_tenant_id_project_id_fkey;
ALTER TABLE core.source_observations DROP CONSTRAINT source_observations_tenant_id_receipt_id_fkey;
ALTER TABLE core.source_receipts DROP CONSTRAINT source_receipts_authority_same_tenant;
ALTER TABLE core.source_receipts DROP CONSTRAINT source_receipts_connection_same_tenant;
ALTER TABLE core.source_receipts DROP CONSTRAINT source_receipts_project_same_tenant;
ALTER TABLE core.source_receipts DROP CONSTRAINT source_receipts_tenant_id_fkey;
ALTER TABLE core.source_reconciliation_tasks DROP CONSTRAINT source_reconciliation_tasks_tenant_id_connection_id_fkey;
ALTER TABLE core.source_reconciliation_tasks DROP CONSTRAINT source_reconciliation_tasks_tenant_id_fkey;
ALTER TABLE core.source_reconciliation_tasks DROP CONSTRAINT source_reconciliation_tasks_tenant_id_receipt_id_fkey;
ALTER TABLE core.subject_suspensions DROP CONSTRAINT subject_suspensions_decider_same_tenant;
ALTER TABLE core.subject_suspensions DROP CONSTRAINT subject_suspensions_requester_same_tenant;
ALTER TABLE core.subject_suspensions DROP CONSTRAINT subject_suspensions_subject_same_tenant;
ALTER TABLE core.subject_suspensions DROP CONSTRAINT subject_suspensions_tenant_id_fkey;
ALTER TABLE core.subjects DROP CONSTRAINT subjects_organization_same_tenant;
ALTER TABLE core.subjects DROP CONSTRAINT subjects_tenant_id_fkey;
ALTER TABLE core.totp_authenticators DROP CONSTRAINT totp_authenticators_subject_same_tenant;
ALTER TABLE core.totp_authenticators DROP CONSTRAINT totp_authenticators_tenant_id_fkey;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_assignment_same_tenant;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_case_same_tenant;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_credential_same_tenant;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_revoked_by_same_tenant;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_revokes_same_tenant;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_schema_same_tenant;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_supersedes_same_tenant;
ALTER TABLE core.verification_attestations DROP CONSTRAINT verification_attestations_tenant_id_fkey;
ALTER TABLE core.verification_case_claims DROP CONSTRAINT verification_case_claims_tenant_id_case_id_fkey;
ALTER TABLE core.verification_case_claims DROP CONSTRAINT verification_case_claims_tenant_id_claim_id_fkey;
ALTER TABLE core.verification_case_claims DROP CONSTRAINT verification_case_claims_tenant_id_fkey;
ALTER TABLE core.verification_case_transitions DROP CONSTRAINT verification_case_transitions_tenant_id_case_id_fkey;
ALTER TABLE core.verification_case_transitions DROP CONSTRAINT verification_case_transitions_tenant_id_fkey;
ALTER TABLE core.verification_cases DROP CONSTRAINT verification_cases_project_same_tenant;
ALTER TABLE core.verification_cases DROP CONSTRAINT verification_cases_schema_same_tenant;
ALTER TABLE core.verification_cases DROP CONSTRAINT verification_cases_tenant_id_fkey;
ALTER TABLE core.wallet_binding_challenges DROP CONSTRAINT wallet_binding_challenges_subject_same_tenant;
ALTER TABLE core.wallet_binding_challenges DROP CONSTRAINT wallet_binding_challenges_tenant_id_fkey;
ALTER TABLE core.wallet_disable_events DROP CONSTRAINT wallet_disable_events_tenant_id_fkey;
ALTER TABLE core.wallet_identities DROP CONSTRAINT wallet_identities_subject_same_tenant;
ALTER TABLE core.wallet_identities DROP CONSTRAINT wallet_identities_tenant_id_fkey;
ALTER TABLE core.wallet_recoveries DROP CONSTRAINT wallet_recoveries_tenant_id_fkey;
ALTER TABLE core.webauthn_challenges DROP CONSTRAINT webauthn_challenges_subject_same_tenant;
ALTER TABLE core.webauthn_challenges DROP CONSTRAINT webauthn_challenges_tenant_id_fkey;
ALTER TABLE core.webauthn_credentials DROP CONSTRAINT webauthn_credentials_subject_same_tenant;
ALTER TABLE core.webauthn_credentials DROP CONSTRAINT webauthn_credentials_tenant_id_fkey;
ALTER TABLE chain.anchor_batches DROP CONSTRAINT anchor_batches_tenant_scope_key;
ALTER TABLE chain.anchor_proposals DROP CONSTRAINT anchor_proposals_execution_identity;
ALTER TABLE chain.transactions DROP CONSTRAINT transactions_safe_execution_identity;
ALTER TABLE chain.transactions DROP CONSTRAINT transactions_tenant_scope_key;
ALTER TABLE core.artifacts DROP CONSTRAINT artifacts_tenant_scope_key;
ALTER TABLE core.assignments DROP CONSTRAINT assignments_tenant_scope_key;
ALTER TABLE core.attestation_schemas DROP CONSTRAINT attestation_schemas_tenant_id_schema_key_schema_version_key;
ALTER TABLE core.attestation_schemas DROP CONSTRAINT attestation_schemas_tenant_scope_key;
ALTER TABLE core.attestation_signature_requests DROP CONSTRAINT signature_request_tenant_scope_key;
ALTER TABLE core.authorities DROP CONSTRAINT authorities_tenant_scope_key;
ALTER TABLE core.break_glass_elevations DROP CONSTRAINT break_glass_elevations_tenant_id_id_key;
ALTER TABLE core.claim_types DROP CONSTRAINT claim_types_tenant_id_claim_type_catalog_version_key;
ALTER TABLE core.claim_types DROP CONSTRAINT claim_types_tenant_id_id_unique;
ALTER TABLE core.claims DROP CONSTRAINT claims_tenant_scope_key;
ALTER TABLE core.compliance_assessments DROP CONSTRAINT assessments_tenant_scope_key;
ALTER TABLE core.compliance_policy_sets DROP CONSTRAINT compliance_policy_sets_tenant_id_rule_set_id_rule_set_versi_key;
ALTER TABLE core.compliance_policy_sets DROP CONSTRAINT policy_sets_tenant_scope_key;
ALTER TABLE core.credentials DROP CONSTRAINT credentials_tenant_scope_key;
ALTER TABLE core.disclosure_restrictions DROP CONSTRAINT disclosure_restrictions_tenant_scope_key;
ALTER TABLE core.document_impacts DROP CONSTRAINT document_impact_tenant_scope_key;
ALTER TABLE core.document_link_rules DROP CONSTRAINT document_link_rule_tenant_scope_key;
ALTER TABLE core.document_links DROP CONSTRAINT document_link_tenant_scope_key;
ALTER TABLE core.document_requirements DROP CONSTRAINT document_requirement_tenant_scope_key;
ALTER TABLE core.gate_decision_signature_requests DROP CONSTRAINT gate_signature_request_tenant_scope_key;
ALTER TABLE core.governance_proposals DROP CONSTRAINT governance_proposals_tenant_scope_key;
ALTER TABLE core.idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE core.jurisdiction_profiles DROP CONSTRAINT jurisdiction_profiles_tenant_id_jurisdiction_profile_versio_key;
ALTER TABLE core.notification_sinks DROP CONSTRAINT notification_sinks_tenant_id_url_key;
ALTER TABLE core.object_uploads DROP CONSTRAINT object_uploads_tenant_id_object_key_key;
ALTER TABLE core.object_uploads DROP CONSTRAINT object_uploads_tenant_id_project_id_content_hash_key;
ALTER TABLE core.object_uploads DROP CONSTRAINT upload_project_scope_key;
ALTER TABLE core.object_uploads DROP CONSTRAINT upload_tenant_scope_key;
ALTER TABLE core.organizations DROP CONSTRAINT organizations_tenant_scope_key;
ALTER TABLE core.project_parties DROP CONSTRAINT project_parties_tenant_scope_key;
ALTER TABLE core.project_stakeholder_events DROP CONSTRAINT project_stakeholder_events_tenant_scope_key;
ALTER TABLE core.projects DROP CONSTRAINT projects_tenant_id_project_key_key;
ALTER TABLE core.projects DROP CONSTRAINT projects_tenant_scope_key;
ALTER TABLE core.registry_entries DROP CONSTRAINT registry_entries_tenant_scope_key;
ALTER TABLE core.registry_entry_versions DROP CONSTRAINT registry_versions_tenant_scope_key;
ALTER TABLE core.registry_proposals DROP CONSTRAINT registry_proposals_item_version_key;
ALTER TABLE core.registry_proposals DROP CONSTRAINT registry_proposals_tenant_scope_key;
ALTER TABLE core.registry_publication_drafts DROP CONSTRAINT registry_drafts_tenant_scope_key;
ALTER TABLE core.role_bindings DROP CONSTRAINT role_bindings_tenant_scope_key;
ALTER TABLE core.schema_activation_clocks DROP CONSTRAINT schema_activation_clocks_pkey;
ALTER TABLE core.source_connections DROP CONSTRAINT source_connections_tenant_id_connection_key_key;
ALTER TABLE core.source_connections DROP CONSTRAINT source_connections_tenant_scope_key;
ALTER TABLE core.source_receipts DROP CONSTRAINT source_receipts_tenant_scope_key;
ALTER TABLE core.subjects DROP CONSTRAINT subjects_tenant_scope_key;
ALTER TABLE core.verification_attestations DROP CONSTRAINT attestations_tenant_scope_key;
ALTER TABLE core.verification_cases DROP CONSTRAINT verification_cases_tenant_scope_key;
-- Checks that paired a subject with its tenant; the subject alone carries the meaning now.
ALTER TABLE core.sessions DROP CONSTRAINT sessions_subject_and_tenant_together;
ALTER TABLE core.email_challenges DROP CONSTRAINT email_challenges_tenant_with_subject;
ALTER TABLE core.oidc_login_transactions DROP CONSTRAINT oidc_tx_link_bound;
ALTER TABLE core.oidc_login_transactions DROP CONSTRAINT oidc_tx_session_outcome;
ALTER TABLE core.role_bindings DROP CONSTRAINT role_bindings_scope_kind_check;
ALTER TABLE core.role_grant_requests DROP CONSTRAINT role_grant_requests_scope_kind_check;
-- Triggers that fire on a tenant change; recreated in step 8 without the column.
DROP TRIGGER sessions_email_challenge_consumed ON core.sessions;
DROP TRIGGER sessions_oidc_transaction_completed ON core.sessions;
DROP TRIGGER external_identities_person_only ON core.external_identities;

-- 4. Columns, the tenant table and the tenant helpers.
ALTER TABLE core.registry_review_bundles DROP COLUMN tenant_id;
ALTER TABLE core.organizations DROP COLUMN tenant_id;
ALTER TABLE core.subjects DROP COLUMN tenant_id;
ALTER TABLE core.wallet_identities DROP COLUMN tenant_id;
ALTER TABLE core.credentials DROP COLUMN tenant_id;
ALTER TABLE core.role_bindings DROP COLUMN tenant_id;
ALTER TABLE core.projects DROP COLUMN tenant_id;
ALTER TABLE core.authorities DROP COLUMN tenant_id;
ALTER TABLE core.project_facts DROP COLUMN tenant_id;
ALTER TABLE core.source_connections DROP COLUMN tenant_id;
ALTER TABLE core.source_receipts DROP COLUMN tenant_id;
ALTER TABLE core.artifacts DROP COLUMN tenant_id;
ALTER TABLE core.lineage_edges DROP COLUMN tenant_id;
ALTER TABLE core.claims DROP COLUMN tenant_id;
ALTER TABLE core.claim_conflicts DROP COLUMN tenant_id;
ALTER TABLE core.attestation_schemas DROP COLUMN tenant_id;
ALTER TABLE core.verification_cases DROP COLUMN tenant_id;
ALTER TABLE core.assignments DROP COLUMN tenant_id;
ALTER TABLE core.verification_attestations DROP COLUMN tenant_id;
ALTER TABLE core.compliance_policy_sets DROP COLUMN tenant_id;
ALTER TABLE core.compliance_assessments DROP COLUMN tenant_id;
ALTER TABLE core.gate_decisions DROP COLUMN tenant_id;
ALTER TABLE core.registry_entries DROP COLUMN tenant_id;
ALTER TABLE core.registry_entry_versions DROP COLUMN tenant_id;
ALTER TABLE chain.anchor_batches DROP COLUMN tenant_id;
ALTER TABLE core.disclosure_restrictions DROP COLUMN tenant_id;
ALTER TABLE chain.transactions DROP COLUMN tenant_id;
ALTER TABLE core.outbox DROP COLUMN tenant_id;
ALTER TABLE core.idempotency_keys DROP COLUMN tenant_id;
ALTER TABLE audit.events DROP COLUMN tenant_id;
ALTER TABLE core.object_uploads DROP COLUMN tenant_id;
ALTER TABLE core.attestation_signature_requests DROP COLUMN tenant_id;
ALTER TABLE core.verification_case_claims DROP COLUMN tenant_id;
ALTER TABLE chain.reorg_events DROP COLUMN tenant_id;
ALTER TABLE core.verification_case_transitions DROP COLUMN tenant_id;
ALTER TABLE core.attestation_disputes DROP COLUMN tenant_id;
ALTER TABLE chain.anchor_proposals DROP COLUMN tenant_id;
ALTER TABLE core.governance_proposals DROP COLUMN tenant_id;
ALTER TABLE core.governance_votes DROP COLUMN tenant_id;
ALTER TABLE core.governance_transitions DROP COLUMN tenant_id;
ALTER TABLE core.governance_vote_weights DROP COLUMN tenant_id;
ALTER TABLE core.authority_versions DROP COLUMN tenant_id;
ALTER TABLE core.evidence_stale_signals DROP COLUMN tenant_id;
ALTER TABLE core.role_grant_requests DROP COLUMN tenant_id;
ALTER TABLE core.wallet_disable_events DROP COLUMN tenant_id;
ALTER TABLE core.notifications DROP COLUMN tenant_id;
ALTER TABLE core.notification_reads DROP COLUMN tenant_id;
ALTER TABLE core.project_lifecycle_transitions DROP COLUMN tenant_id;
ALTER TABLE core.notification_sinks DROP COLUMN tenant_id;
ALTER TABLE core.notification_deliveries DROP COLUMN tenant_id;
ALTER TABLE chain.gas_spend DROP COLUMN tenant_id;
ALTER TABLE core.role_revocation_requests DROP COLUMN tenant_id;
ALTER TABLE core.document_link_rules DROP COLUMN tenant_id;
ALTER TABLE core.document_links DROP COLUMN tenant_id;
ALTER TABLE core.jurisdiction_profiles DROP COLUMN tenant_id;
ALTER TABLE core.document_impacts DROP COLUMN tenant_id;
ALTER TABLE core.governance_execution_records DROP COLUMN tenant_id;
ALTER TABLE core.registry_publication_drafts DROP COLUMN tenant_id;
ALTER TABLE core.gate_decision_signature_requests DROP COLUMN tenant_id;
ALTER TABLE core.source_reconciliation_tasks DROP COLUMN tenant_id;
ALTER TABLE core.disclosure_restriction_events DROP COLUMN tenant_id;
ALTER TABLE core.source_connection_transitions DROP COLUMN tenant_id;
ALTER TABLE core.credential_status_events DROP COLUMN tenant_id;
ALTER TABLE core.provenance_axis_history DROP COLUMN tenant_id;
ALTER TABLE core.project_fact_versions DROP COLUMN tenant_id;
ALTER TABLE core.project_parties DROP COLUMN tenant_id;
ALTER TABLE core.project_party_versions DROP COLUMN tenant_id;
ALTER TABLE core.project_registration_requests DROP COLUMN tenant_id;
ALTER TABLE core.claim_derivations DROP COLUMN tenant_id;
ALTER TABLE core.project_stakeholder_events DROP COLUMN tenant_id;
ALTER TABLE core.document_requirements DROP COLUMN tenant_id;
ALTER TABLE core.break_glass_elevations DROP COLUMN tenant_id;
ALTER TABLE core.connection_security_reviews DROP COLUMN tenant_id;
ALTER TABLE chain.anchor_sends DROP COLUMN tenant_id;
ALTER TABLE core.claim_types DROP COLUMN tenant_id;
ALTER TABLE core.evidence_ledger_snapshots DROP COLUMN tenant_id;
ALTER TABLE core.source_observations DROP COLUMN tenant_id;
ALTER TABLE core.cre_reports DROP COLUMN tenant_id;
ALTER TABLE core.sessions DROP COLUMN tenant_id;
ALTER TABLE core.service_tokens DROP COLUMN tenant_id;
ALTER TABLE core.invitations DROP COLUMN tenant_id;
ALTER TABLE core.email_challenges DROP COLUMN tenant_id;
ALTER TABLE core.email_change_requests DROP COLUMN tenant_id;
ALTER TABLE core.webauthn_credentials DROP COLUMN tenant_id;
ALTER TABLE core.totp_authenticators DROP COLUMN tenant_id;
ALTER TABLE core.recovery_codes DROP COLUMN tenant_id;
ALTER TABLE core.webauthn_challenges DROP COLUMN tenant_id;
ALTER TABLE core.session_factor_proofs DROP COLUMN tenant_id;
ALTER TABLE core.external_identities DROP COLUMN tenant_id;
ALTER TABLE core.oidc_login_transactions DROP COLUMN tenant_id;
ALTER TABLE core.wallet_binding_challenges DROP COLUMN tenant_id;
ALTER TABLE core.subject_suspensions DROP COLUMN tenant_id;
ALTER TABLE core.registry_proposals DROP COLUMN tenant_id;
ALTER TABLE chain.safe_execution_history DROP COLUMN tenant_id;
ALTER TABLE core.schema_activation_clocks DROP COLUMN tenant_id;
ALTER TABLE core.wallet_recoveries DROP COLUMN tenant_id;
ALTER TABLE core.mfa_reset_requests DROP COLUMN tenant_id;
DROP FUNCTION core.registry_tenant();
DROP FUNCTION core.current_tenant();
DROP TABLE core.tenants;

-- 5. Keys, foreign keys and indexes without the tenant. Names lose the tenant too.
ALTER TABLE chain.anchor_proposals ADD CONSTRAINT anchor_proposals_execution_identity UNIQUE (id, transaction_id, chain_id);
ALTER TABLE core.attestation_schemas ADD CONSTRAINT attestation_schemas_schema_key_schema_version_key UNIQUE (schema_key, schema_version);
ALTER TABLE core.claim_types ADD CONSTRAINT claim_types_claim_type_catalog_version_key UNIQUE (claim_type, catalog_version);
ALTER TABLE core.compliance_policy_sets ADD CONSTRAINT compliance_policy_sets_rule_set_id_rule_set_versi_key UNIQUE (rule_set_id, rule_set_version);
ALTER TABLE core.idempotency_keys ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (key);
ALTER TABLE core.jurisdiction_profiles ADD CONSTRAINT jurisdiction_profiles_jurisdiction_profile_versio_key UNIQUE (jurisdiction, profile_version);
ALTER TABLE core.notification_sinks ADD CONSTRAINT notification_sinks_url_key UNIQUE (url);
ALTER TABLE core.object_uploads ADD CONSTRAINT object_uploads_object_key_key UNIQUE (object_key);
ALTER TABLE core.object_uploads ADD CONSTRAINT object_uploads_project_id_content_hash_key UNIQUE (project_id, content_hash);
ALTER TABLE core.object_uploads ADD CONSTRAINT upload_project_scope_key UNIQUE (project_id, id);
ALTER TABLE core.projects ADD CONSTRAINT projects_project_key_key UNIQUE (project_key);
ALTER TABLE core.registry_proposals ADD CONSTRAINT registry_proposals_item_version_key UNIQUE (kind, item_key, item_version);
ALTER TABLE core.schema_activation_clocks ADD CONSTRAINT schema_activation_clocks_pkey PRIMARY KEY (schema_key);
ALTER TABLE core.source_connections ADD CONSTRAINT source_connections_connection_key_key UNIQUE (connection_key);
ALTER TABLE chain.anchor_batches ADD CONSTRAINT anchor_batch_project_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE chain.safe_execution_history ADD CONSTRAINT safe_execution_history_proposal_id_transaction_id_i_fkey FOREIGN KEY (proposal_id, transaction_id, chain_id) REFERENCES chain.anchor_proposals (id, transaction_id, chain_id);
ALTER TABLE chain.safe_execution_history ADD CONSTRAINT safe_execution_history_transaction_id_fkey FOREIGN KEY (transaction_id) REFERENCES chain.transactions (id);
ALTER TABLE chain.transactions ADD CONSTRAINT transactions_batch_same_scope FOREIGN KEY (batch_id) REFERENCES chain.anchor_batches (id);
ALTER TABLE chain.transactions ADD CONSTRAINT transactions_replacement_same_scope FOREIGN KEY (replaced_by_id) REFERENCES chain.transactions (id);
ALTER TABLE core.artifacts ADD CONSTRAINT artifacts_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.artifacts ADD CONSTRAINT artifacts_receipt_same_scope FOREIGN KEY (source_receipt_id) REFERENCES core.source_receipts (id);
ALTER TABLE core.artifacts ADD CONSTRAINT artifacts_superseded_same_scope FOREIGN KEY (superseded_by) REFERENCES core.artifacts (id);
ALTER TABLE core.assignments ADD CONSTRAINT assignments_assigned_by_same_scope FOREIGN KEY (assigned_by) REFERENCES core.subjects (id);
ALTER TABLE core.assignments ADD CONSTRAINT assignments_case_same_scope FOREIGN KEY (case_id) REFERENCES core.verification_cases (id);
ALTER TABLE core.assignments ADD CONSTRAINT assignments_credential_same_scope FOREIGN KEY (credential_id) REFERENCES core.credentials (id);
ALTER TABLE core.assignments ADD CONSTRAINT assignments_revoked_by_same_scope FOREIGN KEY (revoked_by) REFERENCES core.subjects (id);
ALTER TABLE core.assignments ADD CONSTRAINT assignments_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.attestation_disputes ADD CONSTRAINT attestation_disputes_attestation_id_fkey FOREIGN KEY (attestation_id) REFERENCES core.verification_attestations (id);
ALTER TABLE core.attestation_signature_requests ADD CONSTRAINT signature_request_attestation_same_scope FOREIGN KEY (attestation_id) REFERENCES core.verification_attestations (id);
ALTER TABLE core.authority_versions ADD CONSTRAINT authority_versions_authority_id_fkey FOREIGN KEY (authority_id) REFERENCES core.authorities (id);
ALTER TABLE core.break_glass_elevations ADD CONSTRAINT break_glass_decider_same_scope FOREIGN KEY (decided_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.break_glass_elevations ADD CONSTRAINT break_glass_incident_recorder_same_scope FOREIGN KEY (incident_recorded_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.break_glass_elevations ADD CONSTRAINT break_glass_releaser_same_scope FOREIGN KEY (released_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.break_glass_elevations ADD CONSTRAINT break_glass_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.claim_conflicts ADD CONSTRAINT claim_conflicts_claim_same_scope FOREIGN KEY (claim_id) REFERENCES core.claims (id);
ALTER TABLE core.claim_derivations ADD CONSTRAINT claim_derivations_author_subject_id_fkey FOREIGN KEY (author_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.claim_derivations ADD CONSTRAINT claim_derivations_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES core.claims (id);
ALTER TABLE core.claim_types ADD CONSTRAINT catalog_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.claims ADD CONSTRAINT claims_catalog_same_scope FOREIGN KEY (catalog_entry_id) REFERENCES core.claim_types (id);
ALTER TABLE core.claims ADD CONSTRAINT claims_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.claims ADD CONSTRAINT claims_source_receipt_fk FOREIGN KEY (source_receipt_id) REFERENCES core.source_receipts (id);
ALTER TABLE core.claims ADD CONSTRAINT claims_submitted_by_same_scope FOREIGN KEY (submitted_by) REFERENCES core.subjects (id);
ALTER TABLE core.claims ADD CONSTRAINT claims_superseded_by_same_scope FOREIGN KEY (superseded_by_claim_id) REFERENCES core.claims (id);
ALTER TABLE core.claims ADD CONSTRAINT claims_supersedes_same_scope FOREIGN KEY (supersedes_claim_id) REFERENCES core.claims (id);
ALTER TABLE core.compliance_assessments ADD CONSTRAINT assessments_policy_same_scope FOREIGN KEY (policy_set_id) REFERENCES core.compliance_policy_sets (id);
ALTER TABLE core.compliance_assessments ADD CONSTRAINT assessments_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.compliance_policy_sets ADD CONSTRAINT policy_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.compliance_policy_sets ADD CONSTRAINT policy_sets_superseded_same_scope FOREIGN KEY (superseded_by) REFERENCES core.compliance_policy_sets (id);
ALTER TABLE core.connection_security_reviews ADD CONSTRAINT connection_review_same_scope FOREIGN KEY (connection_id) REFERENCES core.source_connections (id);
ALTER TABLE core.connection_security_reviews ADD CONSTRAINT connection_reviewer_same_scope FOREIGN KEY (reviewed_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.cre_reports ADD CONSTRAINT cre_reports_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.cre_reports ADD CONSTRAINT cre_reports_registry_version_id_fkey FOREIGN KEY (registry_version_id) REFERENCES core.registry_entry_versions (id);
ALTER TABLE core.credential_status_events ADD CONSTRAINT credential_status_events_credential_id_fkey FOREIGN KEY (credential_id) REFERENCES core.credentials (id);
ALTER TABLE core.credentials ADD CONSTRAINT credentials_issuer_authority_same_scope FOREIGN KEY (issuer_authority_id) REFERENCES core.authorities (id);
ALTER TABLE core.credentials ADD CONSTRAINT credentials_org_same_scope FOREIGN KEY (organization_id) REFERENCES core.organizations (id);
ALTER TABLE core.credentials ADD CONSTRAINT credentials_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.disclosure_restriction_events ADD CONSTRAINT disclosure_restriction_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.disclosure_restriction_events ADD CONSTRAINT disclosure_restriction_events_restriction_id_fkey FOREIGN KEY (restriction_id) REFERENCES core.disclosure_restrictions (id);
ALTER TABLE core.disclosure_restrictions ADD CONSTRAINT disclosure_restrictions_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.disclosure_restrictions ADD CONSTRAINT disclosure_restrictions_superseded_by_same_scope FOREIGN KEY (superseded_by_id) REFERENCES core.disclosure_restrictions (id);
ALTER TABLE core.document_impacts ADD CONSTRAINT document_impact_origin_same_project FOREIGN KEY (project_id, origin_upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.document_impacts ADD CONSTRAINT document_impact_revision_same_project FOREIGN KEY (project_id, revised_by_upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.document_impacts ADD CONSTRAINT document_impact_successor_same_project FOREIGN KEY (project_id, successor_upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.document_impacts ADD CONSTRAINT document_impact_upload_same_project FOREIGN KEY (project_id, upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.document_impacts ADD CONSTRAINT document_impact_via_same_project FOREIGN KEY (project_id, via_upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.document_impacts ADD CONSTRAINT document_impacts_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES core.subjects (id);
ALTER TABLE core.document_link_rules ADD CONSTRAINT document_link_rules_created_by_fkey FOREIGN KEY (created_by) REFERENCES core.subjects (id);
ALTER TABLE core.document_link_rules ADD CONSTRAINT document_link_rules_retired_by_fkey FOREIGN KEY (retired_by) REFERENCES core.subjects (id);
ALTER TABLE core.document_links ADD CONSTRAINT document_link_downstream_same_project FOREIGN KEY (project_id, downstream_upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.document_links ADD CONSTRAINT document_link_upstream_same_project FOREIGN KEY (project_id, upstream_upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.document_links ADD CONSTRAINT document_links_carried_from_link_id_fkey FOREIGN KEY (carried_from_link_id) REFERENCES core.document_links (id);
ALTER TABLE core.document_links ADD CONSTRAINT document_links_created_by_fkey FOREIGN KEY (created_by) REFERENCES core.subjects (id);
ALTER TABLE core.document_links ADD CONSTRAINT document_links_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES core.subjects (id);
ALTER TABLE core.document_links ADD CONSTRAINT document_links_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES core.document_link_rules (id);
ALTER TABLE core.document_requirements ADD CONSTRAINT document_requirements_created_by_fkey FOREIGN KEY (created_by) REFERENCES core.subjects (id);
ALTER TABLE core.document_requirements ADD CONSTRAINT document_requirements_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.document_requirements ADD CONSTRAINT document_requirements_retired_by_fkey FOREIGN KEY (retired_by) REFERENCES core.subjects (id);
ALTER TABLE core.email_challenges ADD CONSTRAINT email_challenges_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.email_change_requests ADD CONSTRAINT email_change_requests_decided_by_subject_id_fkey FOREIGN KEY (decided_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.email_change_requests ADD CONSTRAINT email_change_requests_requested_by_subject_id_fkey FOREIGN KEY (requested_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.email_change_requests ADD CONSTRAINT email_change_requests_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.evidence_ledger_snapshots ADD CONSTRAINT evidence_ledger_snapshots_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.evidence_stale_signals ADD CONSTRAINT stale_signal_policy_same_scope FOREIGN KEY (origin_policy_set_id) REFERENCES core.compliance_policy_sets (id);
ALTER TABLE core.external_identities ADD CONSTRAINT external_identities_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.gate_decision_signature_requests ADD CONSTRAINT gate_signature_request_assessment_same_scope FOREIGN KEY (input_assessment_id) REFERENCES core.compliance_assessments (id);
ALTER TABLE core.gate_decision_signature_requests ADD CONSTRAINT gate_signature_request_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.gate_decision_signature_requests ADD CONSTRAINT gate_signature_request_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.gate_decisions ADD CONSTRAINT gate_decision_signature_request_same_scope FOREIGN KEY (signature_request_id) REFERENCES core.gate_decision_signature_requests (id);
ALTER TABLE core.gate_decisions ADD CONSTRAINT gate_decisions_assessment_same_scope FOREIGN KEY (input_assessment_id) REFERENCES core.compliance_assessments (id);
ALTER TABLE core.gate_decisions ADD CONSTRAINT gate_decisions_decider_same_scope FOREIGN KEY (decision_maker_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.gate_decisions ADD CONSTRAINT gate_decisions_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.governance_execution_records ADD CONSTRAINT governance_execution_records_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES core.governance_proposals (id);
ALTER TABLE core.governance_proposals ADD CONSTRAINT governance_proposals_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.governance_transitions ADD CONSTRAINT governance_transitions_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES core.governance_proposals (id);
ALTER TABLE core.governance_vote_weights ADD CONSTRAINT governance_vote_weights_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES core.governance_proposals (id);
ALTER TABLE core.governance_votes ADD CONSTRAINT governance_votes_proposal_id_fkey FOREIGN KEY (proposal_id) REFERENCES core.governance_proposals (id);
ALTER TABLE core.invitations ADD CONSTRAINT invitations_accepted_subject_id_fkey FOREIGN KEY (accepted_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.invitations ADD CONSTRAINT invitations_invited_by_subject_id_fkey FOREIGN KEY (invited_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.invitations ADD CONSTRAINT invitations_invited_project_id_fkey FOREIGN KEY (invited_project_id) REFERENCES core.projects (id);
ALTER TABLE core.invitations ADD CONSTRAINT invitations_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES core.organizations (id);
ALTER TABLE core.invitations ADD CONSTRAINT invitations_revoked_by_subject_id_fkey FOREIGN KEY (revoked_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_decider_same_scope FOREIGN KEY (decided_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_requester_same_scope FOREIGN KEY (requested_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.mfa_reset_requests ADD CONSTRAINT mfa_reset_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.notifications ADD CONSTRAINT notifications_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.object_uploads ADD CONSTRAINT object_uploads_artifact_same_scope FOREIGN KEY (promoted_artifact_id) REFERENCES core.artifacts (id);
ALTER TABLE core.object_uploads ADD CONSTRAINT object_uploads_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.object_uploads ADD CONSTRAINT object_uploads_uploader_same_scope FOREIGN KEY (uploaded_by) REFERENCES core.subjects (id);
ALTER TABLE core.object_uploads ADD CONSTRAINT upload_revoker_same_scope FOREIGN KEY (revoked_by) REFERENCES core.subjects (id);
ALTER TABLE core.object_uploads ADD CONSTRAINT upload_supersedes_same_project FOREIGN KEY (project_id, supersedes_upload_id) REFERENCES core.object_uploads (project_id, id);
ALTER TABLE core.oidc_login_transactions ADD CONSTRAINT oidc_login_transactions_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.project_fact_versions ADD CONSTRAINT project_fact_versions_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.project_fact_versions ADD CONSTRAINT project_fact_versions_recorded_by_subject_id_fkey FOREIGN KEY (recorded_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.project_facts ADD CONSTRAINT project_facts_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.project_facts ADD CONSTRAINT project_facts_recorder_same_scope FOREIGN KEY (recorded_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.project_lifecycle_transitions ADD CONSTRAINT project_lifecycle_transitions_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.project_parties ADD CONSTRAINT project_parties_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES core.organizations (id);
ALTER TABLE core.project_parties ADD CONSTRAINT project_parties_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.project_parties ADD CONSTRAINT project_parties_submitted_by_subject_id_fkey FOREIGN KEY (submitted_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.project_party_versions ADD CONSTRAINT project_party_versions_party_id_fkey FOREIGN KEY (party_id) REFERENCES core.project_parties (id);
ALTER TABLE core.project_party_versions ADD CONSTRAINT project_party_versions_recorded_by_subject_id_fkey FOREIGN KEY (recorded_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.project_registration_requests ADD CONSTRAINT project_registration_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.project_registration_requests ADD CONSTRAINT project_registration_requests_requested_by_subje_fkey FOREIGN KEY (requested_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.project_stakeholder_events ADD CONSTRAINT project_stakeholder_events_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.project_stakeholder_events ADD CONSTRAINT project_stakeholder_events_recorded_by_subject_i_fkey FOREIGN KEY (recorded_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.project_stakeholder_events ADD CONSTRAINT project_stakeholder_events_supersedes_id_fkey FOREIGN KEY (supersedes_id) REFERENCES core.project_stakeholder_events (id);
ALTER TABLE core.projects ADD CONSTRAINT projects_owner_org_same_scope FOREIGN KEY (owner_organization_id) REFERENCES core.organizations (id);
ALTER TABLE core.recovery_codes ADD CONSTRAINT recovery_codes_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.registry_entry_versions ADD CONSTRAINT registry_versions_entry_same_scope FOREIGN KEY (entry_id) REFERENCES core.registry_entries (id);
ALTER TABLE core.registry_entry_versions ADD CONSTRAINT registry_versions_previous_same_scope FOREIGN KEY (previous_version_id) REFERENCES core.registry_entry_versions (id);
ALTER TABLE core.registry_entry_versions ADD CONSTRAINT registry_versions_superseded_same_scope FOREIGN KEY (superseded_by_id) REFERENCES core.registry_entry_versions (id);
ALTER TABLE core.registry_proposals ADD CONSTRAINT registry_proposals_decider_same_scope FOREIGN KEY (decided_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.registry_proposals ADD CONSTRAINT registry_proposals_proposer_same_scope FOREIGN KEY (proposed_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.registry_publication_drafts ADD CONSTRAINT registry_drafts_decider_same_scope FOREIGN KEY (decided_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.registry_publication_drafts ADD CONSTRAINT registry_drafts_entry_version_same_scope FOREIGN KEY (entry_version_id) REFERENCES core.registry_entry_versions (id);
ALTER TABLE core.registry_publication_drafts ADD CONSTRAINT registry_drafts_proposer_same_scope FOREIGN KEY (proposed_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.registry_review_bundles ADD CONSTRAINT registry_review_bundles_entry_version_id_fkey FOREIGN KEY (entry_version_id) REFERENCES core.registry_entry_versions (id);
ALTER TABLE core.role_bindings ADD CONSTRAINT role_bindings_org_same_scope FOREIGN KEY (organization_id) REFERENCES core.organizations (id);
ALTER TABLE core.role_bindings ADD CONSTRAINT role_bindings_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.role_grant_requests ADD CONSTRAINT role_grant_requests_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.role_revocation_requests ADD CONSTRAINT role_revocation_binding_same_scope FOREIGN KEY (role_binding_id) REFERENCES core.role_bindings (id);
ALTER TABLE core.role_revocation_requests ADD CONSTRAINT role_revocation_decider_same_scope FOREIGN KEY (decided_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.role_revocation_requests ADD CONSTRAINT role_revocation_requester_same_scope FOREIGN KEY (requested_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.service_tokens ADD CONSTRAINT service_tokens_subject_id_fkey FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.session_factor_proofs ADD CONSTRAINT session_factor_proofs_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.sessions ADD CONSTRAINT sessions_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.source_connection_transitions ADD CONSTRAINT source_connection_transitions_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES core.source_connections (id);
ALTER TABLE core.source_connections ADD CONSTRAINT source_connections_authority_same_scope FOREIGN KEY (authority_id) REFERENCES core.authorities (id);
ALTER TABLE core.source_observations ADD CONSTRAINT source_observations_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES core.source_connections (id);
ALTER TABLE core.source_observations ADD CONSTRAINT source_observations_previous_receipt_id_fkey FOREIGN KEY (previous_receipt_id) REFERENCES core.source_receipts (id);
ALTER TABLE core.source_observations ADD CONSTRAINT source_observations_project_id_fkey FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.source_observations ADD CONSTRAINT source_observations_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES core.source_receipts (id);
ALTER TABLE core.source_receipts ADD CONSTRAINT source_receipts_authority_same_scope FOREIGN KEY (authority_id) REFERENCES core.authorities (id);
ALTER TABLE core.source_receipts ADD CONSTRAINT source_receipts_connection_same_scope FOREIGN KEY (connection_id) REFERENCES core.source_connections (id);
ALTER TABLE core.source_receipts ADD CONSTRAINT source_receipts_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.source_reconciliation_tasks ADD CONSTRAINT source_reconciliation_tasks_connection_id_fkey FOREIGN KEY (connection_id) REFERENCES core.source_connections (id);
ALTER TABLE core.source_reconciliation_tasks ADD CONSTRAINT source_reconciliation_tasks_receipt_id_fkey FOREIGN KEY (receipt_id) REFERENCES core.source_receipts (id);
ALTER TABLE core.subject_suspensions ADD CONSTRAINT subject_suspensions_decider_same_scope FOREIGN KEY (decided_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.subject_suspensions ADD CONSTRAINT subject_suspensions_requester_same_scope FOREIGN KEY (requested_by_subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.subject_suspensions ADD CONSTRAINT subject_suspensions_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.subjects ADD CONSTRAINT subjects_organization_same_scope FOREIGN KEY (organization_id) REFERENCES core.organizations (id);
ALTER TABLE core.totp_authenticators ADD CONSTRAINT totp_authenticators_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_assignment_same_scope FOREIGN KEY (assignment_id) REFERENCES core.assignments (id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_case_same_scope FOREIGN KEY (case_id) REFERENCES core.verification_cases (id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_credential_same_scope FOREIGN KEY (credential_id) REFERENCES core.credentials (id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_revoked_by_same_scope FOREIGN KEY (revoked_by) REFERENCES core.subjects (id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_revokes_same_scope FOREIGN KEY (revokes_id) REFERENCES core.verification_attestations (id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_schema_same_scope FOREIGN KEY (schema_id) REFERENCES core.attestation_schemas (id);
ALTER TABLE core.verification_attestations ADD CONSTRAINT attestations_supersedes_same_scope FOREIGN KEY (supersedes_id) REFERENCES core.verification_attestations (id);
ALTER TABLE core.verification_case_claims ADD CONSTRAINT verification_case_claims_case_id_fkey FOREIGN KEY (case_id) REFERENCES core.verification_cases (id);
ALTER TABLE core.verification_case_claims ADD CONSTRAINT verification_case_claims_claim_id_fkey FOREIGN KEY (claim_id) REFERENCES core.claims (id);
ALTER TABLE core.verification_case_transitions ADD CONSTRAINT verification_case_transitions_case_id_fkey FOREIGN KEY (case_id) REFERENCES core.verification_cases (id);
ALTER TABLE core.verification_cases ADD CONSTRAINT verification_cases_project_same_scope FOREIGN KEY (project_id) REFERENCES core.projects (id);
ALTER TABLE core.verification_cases ADD CONSTRAINT verification_cases_schema_same_scope FOREIGN KEY (schema_id) REFERENCES core.attestation_schemas (id);
ALTER TABLE core.wallet_binding_challenges ADD CONSTRAINT wallet_binding_challenges_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.wallet_identities ADD CONSTRAINT wallet_identities_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.webauthn_challenges ADD CONSTRAINT webauthn_challenges_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
ALTER TABLE core.webauthn_credentials ADD CONSTRAINT webauthn_credentials_subject_same_scope FOREIGN KEY (subject_id) REFERENCES core.subjects (id);
CREATE INDEX audit_events_time_idx ON audit.events USING btree (occurred_at DESC);
CREATE UNIQUE INDEX break_glass_elevations_one_open_idx ON core.break_glass_elevations USING btree (subject_id) WHERE (state = ANY (ARRAY['pending'::core.break_glass_state, 'active'::core.break_glass_state]));
CREATE INDEX break_glass_elevations_subject_idx ON core.break_glass_elevations USING btree (subject_id, state);
CREATE INDEX compliance_assessments_latest_idx ON core.compliance_assessments USING btree (project_id, gate_id, generated_at DESC, id);
CREATE INDEX cre_reports_project_idx ON core.cre_reports USING btree (project_id, sequence DESC);
CREATE UNIQUE INDEX cre_reports_public_sequence_idx ON core.cre_reports USING btree (project_id, ((report ->> 'sequence'::text)));
CREATE INDEX cre_reports_public_sequence_order_idx ON core.cre_reports USING btree (project_id, (((report ->> 'sequence'::text))::numeric) DESC);
CREATE INDEX document_impacts_open_idx ON core.document_impacts USING btree (project_id) WHERE (resolution = 'open'::core.document_impact_resolution);
CREATE UNIQUE INDEX document_link_rules_active_pair ON core.document_link_rules USING btree (lower(upstream_type), lower(downstream_type)) WHERE (retired_at IS NULL);
CREATE INDEX document_links_project_idx ON core.document_links USING btree (project_id) WHERE (removed_at IS NULL);
CREATE UNIQUE INDEX document_requirements_active_type ON core.document_requirements USING btree (project_id, lower(document_type)) WHERE (retired_at IS NULL);
CREATE INDEX email_change_requestsx ON core.email_change_requests USING btree (requested_at DESC);
CREATE INDEX evidence_stale_signals_open_idx ON core.evidence_stale_signals USING btree (project_id) WHERE (resolution = 'open'::core.stale_signal_resolution);
CREATE INDEX external_identitiesx ON core.external_identities USING btree (subject_id);
CREATE INDEX governance_proposals_space_idx ON core.governance_proposals USING btree (space, state);
CREATE INDEX invitationsx ON core.invitations USING btree (created_at DESC);
CREATE INDEX mfa_reset_requestsx ON core.mfa_reset_requests USING btree (requested_at DESC);
CREATE INDEX notifications_role_idx ON core.notifications USING btree (audience_role, occurred_at DESC) WHERE (audience_role IS NOT NULL);
CREATE INDEX notifications_subject_idx ON core.notifications USING btree (subject_id, occurred_at DESC) WHERE (subject_id IS NOT NULL);
CREATE UNIQUE INDEX registry_drafts_one_pending_idx ON core.registry_publication_drafts USING btree (registry_type, public_key) WHERE (state = 'pending'::core.registry_draft_state);
CREATE INDEX registry_drafts_subject_idx ON core.registry_publication_drafts USING btree (subject_id, proposed_at DESC);
CREATE INDEX registry_proposals_list_idx ON core.registry_proposals USING btree (kind, proposed_at DESC);
CREATE UNIQUE INDEX registry_proposals_one_pending_idx ON core.registry_proposals USING btree (kind, item_key) WHERE (state = 'pending'::core.registry_proposal_state);
CREATE UNIQUE INDEX role_grant_requests_one_pending_idx ON core.role_grant_requests USING btree (subject_id, role, COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE (state = 'pending'::core.role_grant_state);
CREATE INDEX role_grant_requests_pending_idx ON core.role_grant_requests USING btree (state, requested_at DESC);
CREATE INDEX role_revocation_requests_pending_idx ON core.role_revocation_requests USING btree (state, requested_at DESC);
CREATE INDEX source_observations_scope_idx ON core.source_observations USING btree (project_id, connection_id, observed_at DESC);
CREATE INDEX source_observations_scope_sequence_idx ON core.source_observations USING btree (project_id, connection_id, query_scope_hash, observation_sequence DESC) WHERE (outcome <> 'out_of_order'::text);
CREATE INDEX source_observations_scope_time_idx ON core.source_observations USING btree (project_id, connection_id, query_scope_hash, observed_at DESC, observation_sequence DESC) WHERE (outcome <> 'out_of_order'::text);
CREATE INDEX source_observations_success_scope_time_idx ON core.source_observations USING btree (project_id, connection_id, query_scope_hash, observed_at DESC, observation_sequence DESC) WHERE (outcome = ANY (ARRAY['baseline'::text, 'unchanged'::text, 'changed'::text]));
CREATE INDEX source_receipts_confirmed_scope_time_idx ON core.source_receipts USING btree (project_id, connection_id, query_scope_hash, received_at DESC, id DESC) WHERE ((result = 'confirmed_from_source'::core.source_result) AND (raw_hash IS NOT NULL) AND ((channel_evidence ->> 'collector'::text) = 'server_adapter'::text));
CREATE INDEX subject_suspensionsx ON core.subject_suspensions USING btree (requested_at DESC);
CREATE INDEX wallet_recoveries_subject ON core.wallet_recoveries USING btree (subject_id, created_at DESC);

-- 6. Functions. Bodies are the current definitions with the tenant removed; a function whose
--    arguments or result named the tenant is dropped and recreated with its grants.
DROP FUNCTION core.accept_invitation(text,bytea,text,uuid,text,uuid,text,integer);
DROP FUNCTION core.claim_oidc_transaction(text,text,core.oidc_provider,uuid);
DROP FUNCTION core.complete_email_change(text,bytea,text,text);
DROP FUNCTION core.complete_email_change(text,bytea,text,text,text);
DROP FUNCTION core.complete_oidc_invitation(uuid,text,text,text,text,text,uuid,uuid,uuid,text,integer);
DROP FUNCTION core.complete_oidc_link(uuid,uuid,text,text,text,text,uuid);
DROP FUNCTION core.complete_oidc_link(uuid,uuid,text,text,text,text,uuid,text);
DROP FUNCTION core.complete_oidc_sign_in(uuid,text,text,uuid,text,integer);
DROP FUNCTION core.consume_email_challenge(core.email_challenge_purpose,text,uuid,bytea);
DROP FUNCTION core.create_wallet_binding_challenge(uuid,uuid,text,integer,text);
DROP FUNCTION core.end_subject_elevations(uuid,uuid,uuid,text);
DROP FUNCTION core.find_person_by_email(text);
DROP FUNCTION core.insert_email_code_session(uuid,uuid,uuid,uuid,text,integer);
DROP FUNCTION core.insert_oidc_session(uuid,core.oidc_provider,uuid,uuid,uuid,text,integer);
DROP FUNCTION core.issue_email_challenge(uuid,core.email_challenge_purpose,text,uuid,uuid,uuid,uuid,bytea,text,text,text);
DROP FUNCTION core.live_wallet_binding_challenge(uuid,uuid);
DROP FUNCTION core.oidc_complete(uuid,text,uuid,uuid,uuid);
DROP FUNCTION core.outbox_emit(uuid,text,uuid,integer,uuid,jsonb);
DROP FUNCTION core.record_provenance_axis(uuid,text,uuid,text,text,text,text);
DROP FUNCTION core.resolve_service_token(text);
DROP FUNCTION core.resolve_session(text);
DROP FUNCTION core.revoke_subject_identities(uuid,uuid,text);
DROP FUNCTION core.start_email_challenge(core.email_challenge_purpose,text,text,uuid,bytea,text,text,text);
DROP FUNCTION core.start_oidc_transaction(uuid,core.oidc_provider,core.oidc_purpose,text,text,text,bytea,text,uuid,text,text,text);
DROP FUNCTION core.verify_sign_in_code(text,bytea,text,text,uuid,text,integer);

CREATE OR REPLACE FUNCTION chain.check_anchor_leaf_project()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  batch_project uuid;
BEGIN
  SELECT b.project_id INTO batch_project
    FROM chain.anchor_batches b WHERE b.id = NEW.batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor batch is unavailable' USING ERRCODE = '23514';
  END IF;
  IF batch_project IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM core.registry_entry_versions v
        JOIN core.registry_entries e ON e.id = v.entry_id
        LEFT JOIN core.verification_attestations a
          ON e.registry_type = 'verification' AND a.id = e.subject_id
        LEFT JOIN core.verification_cases c ON c.id = a.case_id
        WHERE v.id = NEW.entry_version_id
          AND ((e.registry_type = 'project' AND e.subject_id = batch_project) OR c.project_id = batch_project)
  ) THEN
    RAISE EXCEPTION 'Anchor leaf must belong to the batch project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION chain.check_safe_execution_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'chain', 'pg_temp'
AS $function$
BEGIN
  PERFORM 1 FROM chain.anchor_proposals p
  WHERE p.id = NEW.proposal_id AND p.transaction_id = NEW.transaction_id AND p.chain_id = NEW.chain_id
    AND ((p.state = 'executed' AND NEW.evidence_kind = 'proposal_execution')
      OR (p.state = 'rejected' AND NEW.evidence_kind = 'nonce_replacement'))
  FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Safe execution history requires matching proposal state and evidence kind' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION chain.freeze_executed_proposal_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'chain', 'pg_temp'
AS $function$
BEGIN
  IF OLD.state IN ('executed', 'rejected') AND ROW(
    NEW.id, NEW.transaction_id, NEW.chain_id, NEW.safe_address,
    NEW.contract_address, NEW.calldata, NEW.calldata_hash, NEW.safe_tx_hash, NEW.state, NEW.resolved_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.transaction_id, OLD.chain_id, OLD.safe_address,
    OLD.contract_address, OLD.calldata, OLD.calldata_hash, OLD.safe_tx_hash, OLD.state, OLD.resolved_at
  ) THEN
    RAISE EXCEPTION 'Executed Safe proposal identity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.accept_invitation(p_token_hash text, p_code_hmac bytea, p_ip_key text, p_subject_id uuid, p_display_name text, p_session_id uuid, p_session_token_hash text, p_ttl_seconds integer)
 RETURNS TABLE(status text, retry_after_seconds integer, subject_id uuid, organization_id uuid, invitation_id uuid, challenge_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v core.invitations%ROWTYPE;
  r RECORD;
  v_expires TIMESTAMPTZ;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO v FROM core.invitations i
  WHERE i.token_hash = p_token_hash AND i.state = 'pending' AND i.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'invitation_invalid'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_retry := core.take_auth_rate('code_verify', 'invitation:' || v.id, 10, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, v.organization_id, v.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO r FROM core.consume_email_challenge('invitation', v.email, v.id, p_code_hmac);
  IF r.status <> 'ok' THEN
    RETURN QUERY SELECT r.status, 0,NULL::UUID, v.organization_id, v.id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_email(v.email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v.email) THEN
    UPDATE core.invitations
    SET state = 'expired', version = version + 1
    WHERE id = v.id;
    RETURN QUERY SELECT 'email_unavailable'::TEXT, 0,NULL::UUID, v.organization_id, v.id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO core.subjects (id,kind, display_name, assurance_level, email, organization_id)
  VALUES (p_subject_id,'person', p_display_name, 'wallet_only', v.email, v.organization_id);

  UPDATE core.invitations
  SET state = 'accepted', accepted_at = now(), accepted_subject_id = p_subject_id, version = version + 1
  WHERE id = v.id;
  UPDATE core.email_challenges SET subject_id = p_subject_id WHERE id = r.challenge_id;

  v_expires := core.insert_email_code_session(
    r.challenge_id, p_subject_id, p_session_id, p_session_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT, 0,p_subject_id, v.organization_id, v.id, r.challenge_id, v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.accept_invitation(text, bytea, text, uuid, text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.accept_invitation(text, bytea, text, uuid, text, uuid, text, integer) TO mpc_app;

CREATE OR REPLACE FUNCTION core.apply_document_link_rule(p_rule uuid, p_subject uuid, p_upload uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  rule core.document_link_rules%ROWTYPE;
  pair RECORD;
  created INTEGER := 0;
  step INTEGER;
BEGIN
  SELECT * INTO rule FROM core.document_link_rules WHERE id = p_rule AND retired_at IS NULL;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  FOR pair IN
    SELECT up.project_id, up.id AS upstream, down.id AS downstream
    FROM core.object_uploads up
    JOIN core.object_uploads down
      ON down.project_id = up.project_id
     AND down.id <> up.id
    WHERE lower(up.document_type) = lower(rule.upstream_type)
      AND lower(down.document_type) = lower(rule.downstream_type)
      AND up.state NOT IN ('scanned_infected', 'rejected')
      AND down.state NOT IN ('scanned_infected', 'rejected')
      AND up.revoked_at IS NULL
      AND down.revoked_at IS NULL
      AND core.document_successor(up.id) IS NULL
      AND core.document_successor(down.id) IS NULL
      AND (p_upload IS NULL OR up.id = p_upload OR down.id = p_upload)
    ORDER BY up.project_id, up.uploaded_at, down.uploaded_at
  LOOP
    IF rule.kind = 'depends_on'
       AND core.document_link_would_cycle(pair.upstream, pair.downstream)
    THEN
      CONTINUE;
    END IF;

    INSERT INTO core.document_links (project_id, upstream_upload_id, downstream_upload_id, kind, origin,
      rule_id, created_by
    ) VALUES (pair.project_id, pair.upstream, pair.downstream, rule.kind, 'rule',
      rule.id, p_subject
    )
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS step = ROW_COUNT;
    created := created + step;
  END LOOP;

  RETURN created;
END
$function$;

CREATE OR REPLACE FUNCTION core.apply_document_link_rules_for(p_upload uuid, p_subject uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  doc_type TEXT;
  rule RECORD;
  created INTEGER := 0;
BEGIN
  SELECT document_type INTO doc_type
  FROM core.object_uploads WHERE id = p_upload;
  IF doc_type IS NULL THEN
    RETURN 0;
  END IF;

  FOR rule IN
    SELECT r.id FROM core.document_link_rules r
    WHERE r.retired_at IS NULL
      AND (lower(r.upstream_type) = lower(doc_type) OR lower(r.downstream_type) = lower(doc_type))
    ORDER BY r.created_at
  LOOP
    created := created + core.apply_document_link_rule(rule.id, p_subject, p_upload);
  END LOOP;

  RETURN created;
END
$function$;

CREATE OR REPLACE FUNCTION core.apply_document_supersede()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  previous UUID := NEW.supersedes_upload_id;
BEGIN
  IF NEW.state <> 'promoted' OR previous IS NULL THEN
    RETURN NEW;
  END IF;
  IF OLD.state = 'promoted' AND OLD.supersedes_upload_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  PERFORM core.record_document_impacts(previous, 'superseded', NEW.id);

  UPDATE core.document_impacts
  SET resolution = 'revised',
      resolved_at = now(),
      revised_by_upload_id = NEW.id,
      resolution_note = format('Replaced by a new version (upload %s)', NEW.id)
  WHERE upload_id = previous AND resolution = 'open';

  -- Links that already touch the new version are left to the person who made them. A carried
  -- link that would close a loop is skipped rather than failing the promotion.
  INSERT INTO core.document_links (project_id, upstream_upload_id, downstream_upload_id, kind, origin,
    carried_from_link_id, note
  )
  SELECT moved.project_id, moved.upstream, moved.downstream, moved.kind,
         'carried_over', moved.id, moved.note
  FROM (
    SELECT l.id, l.project_id, l.kind, l.note,
           CASE WHEN l.upstream_upload_id = previous THEN NEW.id ELSE l.upstream_upload_id END
             AS upstream,
           CASE WHEN l.downstream_upload_id = previous THEN NEW.id ELSE l.downstream_upload_id END
             AS downstream
    FROM core.document_links l
    WHERE l.removed_at IS NULL
      AND (l.upstream_upload_id = previous OR l.downstream_upload_id = previous)
      AND l.upstream_upload_id <> NEW.id
      AND l.downstream_upload_id <> NEW.id
  ) moved
  WHERE NOT (moved.kind = 'depends_on'
             AND core.document_link_would_cycle(moved.upstream, moved.downstream))
  ON CONFLICT DO NOTHING;

  UPDATE core.document_links
  SET removed_at = now(),
      removal_reason = format('Moved to the new version (upload %s)', NEW.id)
  WHERE removed_at IS NULL
    AND (upstream_upload_id = previous OR downstream_upload_id = previous);

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.apply_invited_workspace_role()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
BEGIN
  UPDATE core.subjects SET assurance_level = CASE WHEN NEW.invited_role='project_member'
    THEN 'identity_bound'::core.assurance_level ELSE 'high_assurance'::core.assurance_level END,
    version=version+1
  WHERE id=NEW.accepted_subject_id AND email=NEW.email AND organization_id=NEW.organization_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Invitation recipient mismatch'; END IF;
  INSERT INTO core.role_bindings(id,subject_id, role, organization_id, project_id, scope_kind, governance_scope)
  VALUES (gen_random_uuid(),NEW.accepted_subject_id, NEW.invited_role,
    CASE WHEN NEW.invited_role <> 'administrator' THEN NEW.organization_id END,
    NEW.invited_project_id, CASE WHEN NEW.invited_role='administrator' THEN 'registry' ELSE 'organization' END, 'none');
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION core.approve_wallet_recovery(p_session uuid, p_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
DECLARE actor core.sessions := core.mfa_lock_session(p_session);
BEGIN
  IF actor.recovery_limited OR NOT EXISTS (SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id
    WHERE b.subject_id=actor.subject_id AND b.role='administrator' AND b.revoked_at IS NULL
      AND b.project_id IS NULL AND coalesce(b.scope_kind,'registry')='registry' AND b.jurisdiction IS NULL
      AND s.kind='person' AND s.suspended_at IS NULL AND s.assurance_level >= 'high_assurance') THEN RETURN false; END IF;
  UPDATE core.wallet_recoveries SET approved_by=actor.subject_id, approved_at=now() WHERE id=p_id
    AND cancelled_at IS NULL AND consumed_at IS NULL AND (approved_by IS NULL OR (approved_by=subject_id AND subject_id<>actor.subject_id)) AND confirmed_at IS NOT NULL
    AND (subject_id <> actor.subject_id OR NOT core.has_other_wallet_recovery_admin(actor.subject_id))
    AND created_at>now()-interval '24 hours' AND core.wallet_recovery_session_live(p_id);
  RETURN FOUND;
END $function$;

CREATE OR REPLACE FUNCTION core.begin_totp_enrolment(p_id uuid, p_session_id uuid, p_ciphertext bytea, p_nonce bytea)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_expires TIMESTAMPTZ := now() + interval '10 minutes';
BEGIN
  PERFORM core.mfa_assert_enrolment(v, 'totp');
  UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'superseded'
  WHERE subject_id = v.subject_id AND confirmed_at IS NULL AND revoked_at IS NULL;
  INSERT INTO core.totp_authenticators (
    id,subject_id, secret_ciphertext, secret_nonce, pending_expires_at
  ) VALUES (p_id,v.subject_id, p_ciphertext, p_nonce, v_expires);
  RETURN v_expires;
END
$function$;

CREATE OR REPLACE FUNCTION core.bind_wallet_by_proof(p_session_id uuid, p_challenge_id uuid, p_signer text, p_wallet_id uuid, p_replace_cause text, p_previous_signer text)
 RETURNS TABLE(wallet_id uuid, wallet_address text, chain_id integer, previous_assurance core.assurance_level, assurance core.assurance_level, replaced_wallet_id uuid, replaced_wallet_address text, replaced_chain_id integer, replaced_bound_via text, rebind_of uuid, rebind_same_subject boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge core.wallet_binding_challenges;
  v_active core.wallet_identities;
  v_last core.wallet_identities;
  v_rebind core.wallet_identities;
  v_before core.assurance_level;
  v_after core.assurance_level;
  v_self_recovery boolean := false;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, true);

  IF p_replace_cause IS NULL OR p_replace_cause NOT IN ('rotation', 'key_lost', 'key_compromised') THEN
    RAISE EXCEPTION 'WALLET_REASON_INVALID: not a reason a person gives for replacing a wallet'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_challenge FROM core.wallet_binding_challenges c
  WHERE c.id = p_challenge_id AND c.session_id = v.id
    AND c.subject_id = v.subject_id AND c.consumed_at IS NULL AND c.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND OR v_challenge.wallet_address <> lower(p_signer) THEN
    RAISE EXCEPTION 'WALLET_CHALLENGE_INVALID: no live binding challenge of this session matches'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_active FROM core.wallet_identities w
  WHERE w.subject_id = v.subject_id AND w.disabled_at IS NULL
  FOR UPDATE;
  -- The screen showed what this binding replaces; if that changed, the person did not agree.
  IF v_active.id IS DISTINCT FROM v_challenge.replaces_wallet_id THEN
    RAISE EXCEPTION 'WALLET_CHALLENGE_INVALID: the account''s wallet changed since this challenge'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_active.id IS NOT NULL AND v_active.wallet_address = v_challenge.wallet_address
     AND v_active.chain_id = v_challenge.chain_id THEN
    RAISE EXCEPTION 'WALLET_ALREADY_ACTIVE: this wallet already is the account''s signing wallet'
      USING ERRCODE = 'unique_violation';
  END IF;

  -- History of this address across the Registry: a key moves between accounts'
  -- views of it. Every comparison is NULL-safe and an unknown answers "refuse":
  --   * compromised (directly, or as the cause of a replace): never again, not even the same person;
  --   * disabled by an admin (decider is not the wallet's subject, a NULL subject included): never;
  --   * lost (directly or as a replace cause), consolidated by 0130, or disabled with no recorded
  --     event: only the subject that held it — someone else may have found the key;
  --   * rotation and offboarding by the holder: anyone who proves the key.
  -- One refusal code, so the answer does not say why.
  IF EXISTS (
    SELECT 1 FROM core.wallet_identities w
    LEFT JOIN core.wallet_disable_events e ON e.wallet_identity_id = w.id
    WHERE w.wallet_address = v_challenge.wallet_address AND w.chain_id = v_challenge.chain_id
      AND w.disabled_at IS NOT NULL
      AND (
        e.reason_code IS NOT DISTINCT FROM 'key_compromised'
        OR e.replace_cause IS NOT DISTINCT FROM 'key_compromised'
        OR (e.id IS NOT NULL
            AND e.reason_code IS DISTINCT FROM 'consolidated_single_wallet'
            AND e.disabled_by_subject_id IS DISTINCT FROM w.subject_id)
        OR ((e.id IS NULL
             OR e.reason_code IS NOT DISTINCT FROM 'key_lost'
             OR e.replace_cause IS NOT DISTINCT FROM 'key_lost'
             OR e.reason_code IS NOT DISTINCT FROM 'consolidated_single_wallet')
            AND w.subject_id IS DISTINCT FROM v.subject_id)
      )
  ) THEN
    RAISE EXCEPTION 'WALLET_UNAVAILABLE: this wallet cannot be bound'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_active.id IS NULL THEN
    SELECT * INTO v_last FROM core.wallet_identities w
    WHERE w.subject_id = v.subject_id
    ORDER BY w.disabled_at DESC, w.created_at DESC, w.id DESC LIMIT 1;
  END IF;
  -- A holder can restore their most recent key with a fresh signature. A new
  -- key cannot bootstrap a replacement by disabling the existing key first.
  IF (v_active.id IS NOT NULL AND v_active.wallet_address IS DISTINCT FROM lower(p_previous_signer))
     OR (v_last.id IS NOT NULL AND (
       v_last.wallet_address IS DISTINCT FROM lower(p_signer) OR v_last.chain_id <> v_challenge.chain_id
       OR NOT EXISTS (SELECT 1 FROM core.wallet_disable_events e
         WHERE e.wallet_identity_id = v_last.id AND e.disabled_by_subject_id = v.subject_id
           AND e.reason_code IN ('rotation', 'key_lost', 'offboarding'))
       OR EXISTS (SELECT 1 FROM core.wallet_identities w WHERE w.wallet_address = v_last.wallet_address
         AND w.chain_id = v_last.chain_id AND w.id <> v_last.id AND w.created_at >= v_last.disabled_at)
     )) THEN
    UPDATE core.wallet_recoveries r SET consumed_at=now() FROM core.subjects owner
    WHERE r.session_id=v.id AND r.subject_id=v.subject_id AND owner.id=r.subject_id
      AND owner.email=r.email AND owner.suspended_at IS NULL AND r.wallet_address=v_challenge.wallet_address
      AND r.chain_id=v_challenge.chain_id AND r.previous_wallet_id=coalesce(v_active.id,v_last.id)
      AND r.previous_version=coalesce(v_active.version,v_last.version) AND r.confirmed_at IS NOT NULL
      AND r.approved_at <= v_challenge.created_at AND r.approved_by IS NOT NULL AND r.consumed_at IS NULL AND r.cancelled_at IS NULL
      AND r.created_at>now()-interval '24 hours'
      AND (r.approved_by <> r.subject_id OR core.wallet_recovery_self_approval_valid(r.subject_id))
    RETURNING r.approved_by = r.subject_id INTO v_self_recovery;
    IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_PREVIOUS_SIGNATURE_REQUIRED: previous signing authority required'
      USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  SELECT * INTO v_rebind FROM core.wallet_identities w
  WHERE w.wallet_address = v_challenge.wallet_address AND w.chain_id = v_challenge.chain_id
    AND w.disabled_at IS NOT NULL
  ORDER BY w.disabled_at DESC, w.created_at DESC, w.id DESC
  LIMIT 1;

  SELECT s.assurance_level INTO v_before FROM core.subjects s WHERE s.id = v.subject_id;
  v_after := v_before;

  IF v_active.id IS NOT NULL THEN
    UPDATE core.wallet_identities SET disabled_at = now(), version = version + 1 WHERE id = v_active.id;
    INSERT INTO core.wallet_disable_events (
      id,wallet_identity_id, reason_code, replace_cause, detail, disabled_by_subject_id
    ) VALUES (
      gen_random_uuid(),v_active.id, 'replaced', p_replace_cause,
      'Replaced by wallet ' || p_wallet_id::text, v.subject_id
    );
    -- As a disable of an operator-bound wallet (0122): the operator's verification went with that
    -- wallet, so the level falls to the floor until an admin verifies the person again.
    IF v_active.bound_via = 'operator' AND NOT v_self_recovery THEN
      v_after := 'wallet_only';
    END IF;
  END IF;

  BEGIN
    INSERT INTO core.wallet_identities (
      id,subject_id, wallet_address, chain_id, assurance_level, bound_at, bound_via
    ) VALUES (
      p_wallet_id,v.subject_id, v_challenge.wallet_address, v_challenge.chain_id,
      'wallet_only', now(), 'proof'
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'WALLET_UNAVAILABLE: this wallet cannot be bound'
      USING ERRCODE = 'insufficient_privilege';
  END;

  UPDATE core.wallet_binding_challenges
  SET consumed_at = now(), wallet_identity_id = p_wallet_id
  WHERE id = v_challenge.id;

  -- The bind rule (0122): a proof never raises the level; the higher of the two stays.
  -- (The new row is `wallet_only`, so this keeps v_after.)
  v_after := GREATEST(
    v_after,
    (SELECT max(w.assurance_level) FROM core.wallet_identities w
     WHERE w.subject_id = v.subject_id AND w.disabled_at IS NULL)
  );
  IF v_after IS DISTINCT FROM v_before THEN
    UPDATE core.subjects SET assurance_level = v_after, version = version + 1 WHERE id = v.subject_id;
  END IF;

  RETURN QUERY SELECT p_wallet_id, v_challenge.wallet_address, v_challenge.chain_id, v_before, v_after,
    v_active.id, v_active.wallet_address, v_active.chain_id, v_active.bound_via,
    v_rebind.id, CASE WHEN v_rebind.id IS NULL THEN NULL ELSE v_rebind.subject_id = v.subject_id END;
END
$function$;

CREATE OR REPLACE FUNCTION core.cancel_suspended_wallet_recoveries()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
BEGIN
  UPDATE core.wallet_recoveries SET cancelled_at=now()
  WHERE (approved_by=NEW.id OR subject_id=NEW.id)
    AND consumed_at IS NULL AND cancelled_at IS NULL;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION core.check_cre_report_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id=v.entry_id
    WHERE v.id=NEW.registry_version_id
      AND e.registry_type='project' AND e.subject_id=NEW.project_id
      AND v.published_at IS NOT NULL AND v.status IN ('published','revoked','superseded')
      AND v.content_hash=NEW.report ->> 'contentHash'
      AND v.version::text=NEW.report ->> 'registryVersion'
  ) THEN
    RAISE EXCEPTION 'CRE report must reference its approved project version' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.check_source_observation_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.source_receipts r
    WHERE r.id=NEW.receipt_id
      AND r.project_id=NEW.project_id AND r.connection_id=NEW.connection_id
      AND r.query_basis=NEW.query_basis
      AND r.channel_evidence->>'collector'='server_adapter'
  ) OR (NEW.previous_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.source_receipts r
    WHERE r.id=NEW.previous_receipt_id
      AND r.project_id=NEW.project_id AND r.connection_id=NEW.connection_id
      AND r.query_basis=NEW.query_basis AND r.result='confirmed_from_source'
  )) THEN
    RAISE EXCEPTION 'Observation must match its server-collected receipt scope'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.check_standing_role()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.role NOT IN ('project_member','reviewer','administrator','scan_service','cre_reporter') THEN
    RAISE EXCEPTION 'Unknown standing role' USING ERRCODE='check_violation';
  END IF;
  IF NEW.scope_kind IS NULL THEN
    NEW.scope_kind := CASE WHEN NEW.role='project_member' THEN 'organization' ELSE 'registry' END;
  END IF;
  IF NEW.role='project_member' AND NEW.scope_kind='registry' THEN
    RAISE EXCEPTION 'Project membership cannot grant Registry-wide project access' USING ERRCODE='check_violation';
  END IF;
  IF NEW.governance_scope IS NULL THEN
    NEW.governance_scope := CASE WHEN NEW.role <> 'project_member' THEN 'none'
      WHEN NEW.project_id IS NOT NULL THEN 'project' ELSE 'protocol' END;
  END IF;
  IF NEW.governance_scope <> 'none' AND NEW.role <> 'project_member'
     OR NEW.governance_scope='project' AND NEW.project_id IS NULL
     OR NEW.governance_scope='protocol' AND NEW.project_id IS NOT NULL THEN
    RAISE EXCEPTION 'Invalid governance namespace' USING ERRCODE='check_violation';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION core.claim_oidc_transaction(p_state_hash text, p_binding_hash text, p_provider core.oidc_provider, p_session_id uuid)
 RETURNS TABLE(status text, transaction_id uuid, purpose core.oidc_purpose, secret bytea, nonce_hash text, redirect_uri text, invitation_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions;
BEGIN
  SELECT * INTO v FROM core.oidc_login_transactions t WHERE t.state_hash = p_state_hash FOR UPDATE;
  IF NOT FOUND
     OR v.claimed_at IS NOT NULL
     OR v.provider <> p_provider
     OR NOT core.digest_equal(decode(v.binding_hash, 'hex'), decode(p_binding_hash, 'hex'))
     OR (v.purpose = 'link') <> (p_session_id IS NOT NULL)
     OR (v.purpose = 'link' AND v.session_id <> p_session_id) THEN
    RETURN QUERY SELECT 'state_invalid'::TEXT, NULL::UUID, NULL::core.oidc_purpose, NULL::BYTEA,
      NULL::TEXT, NULL::TEXT,NULL::UUID;
    RETURN;
  END IF;

  UPDATE core.oidc_login_transactions SET claimed_at = now(), secret_ciphertext = NULL WHERE id = v.id;

  IF v.expires_at <= now() THEN
    RETURN QUERY SELECT 'state_expired'::TEXT, v.id, v.purpose, NULL::BYTEA, NULL::TEXT, NULL::TEXT,v.invitation_id;
    RETURN;
  END IF;
  RETURN QUERY SELECT 'claimed'::TEXT, v.id, v.purpose, v.secret_ciphertext, v.nonce_hash,
    v.redirect_uri,v.invitation_id;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.claim_oidc_transaction(text, text, core.oidc_provider, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.claim_oidc_transaction(text, text, core.oidc_provider, uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_email_change(p_new_email text, p_code_hmac bytea, p_email_key text, p_ip_key text, p_owner_code text)
 RETURNS TABLE(status text, retry_after_seconds integer, subject_id uuid, email_change_id uuid, previous_email text, revoked_sessions integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_email TEXT := core.normalize_email(p_new_email);
  r RECORD;
  v core.email_change_requests%ROWTYPE;
  v_previous TEXT;
  v_suspended TIMESTAMPTZ;
  v_revoked INTEGER;
  v_removed TEXT[];
  v_subject_id UUID;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry = 0 THEN
    v_retry := core.take_auth_rate('code_verify', 'email:' || p_email_key, 10, interval '15 minutes');
  END IF;
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  -- 0132 (F3): the person's subject row before the challenge and the request. Consuming the code
  -- locks the challenge, which a suspension holding the subject would supersede: the old order
  -- deadlocked with it. The live challenge for the address names the person; if a newer one
  -- replaces it in between, its person is locked below as before.
  SELECT c.subject_id INTO v_subject_id FROM core.email_challenges c
  WHERE c.purpose = 'email_change' AND c.email = v_email
    AND c.consumed_at IS NULL AND c.superseded_at IS NULL;
  IF v_subject_id IS NOT NULL THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;

  IF v_subject_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.email_challenges c JOIN core.subjects s ON s.id = c.subject_id
    WHERE c.purpose = 'email_change' AND c.email = v_email AND c.subject_id = v_subject_id
      AND c.consumed_at IS NULL AND c.superseded_at IS NULL
      AND c.owner_proof_digest = sha256(convert_to(s.email || ':' || p_owner_code, 'UTF8'))
  ) THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT * INTO r FROM core.consume_email_challenge('email_change', v_email, NULL, p_code_hmac);
  IF r.status <> 'ok' THEN
    RETURN QUERY SELECT r.status, 0,r.subject_id, r.email_change_id, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT * INTO v FROM core.email_change_requests c
  WHERE c.id = r.email_change_id AND c.state = 'approved' AND c.decided_at > now() - interval '72 hours'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0,r.subject_id, r.email_change_id, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v.subject_id FOR UPDATE;
  IF v_suspended IS NOT NULL THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0,v.subject_id, v.id, NULL::TEXT, 0;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.email_challenges c JOIN core.subjects s ON s.id = c.subject_id
    WHERE c.id = r.challenge_id AND c.email_change_id = v.id
      AND c.owner_proof_digest = sha256(convert_to(s.email || ':' || p_owner_code, 'UTF8'))
  ) THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0,v.subject_id, v.id, NULL::TEXT, 0;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v_email) THEN
    UPDATE core.email_change_requests SET state = 'expired', version = version + 1 WHERE id = v.id;
    RETURN QUERY SELECT 'email_unavailable'::TEXT, 0,v.subject_id, v.id, NULL::TEXT, 0;
    RETURN;
  END IF;

  SELECT s.email INTO v_previous FROM core.subjects s WHERE s.id = v.subject_id;
  UPDATE core.subjects SET email = v_email, version = version + 1 WHERE id = v.subject_id;
  UPDATE core.email_change_requests
  SET state = 'completed', completed_at = now(), previous_email = v_previous, version = version + 1
  WHERE id = v.id;

  v_removed := core.revoke_subject_identities(v.subject_id, 'email_change');

  IF v_previous IS NOT NULL THEN
    PERFORM core.supersede_email_challenge('sign_in', v_previous);
    INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
    VALUES (
      gen_random_uuid(), 'email_changed_notice', v_previous,
      jsonb_build_object('removedSignIns', to_jsonb(v_removed)), 'pending',
      now() + interval '1 day'
    );
  END IF;

  v_revoked := core.revoke_subject_sessions(v.subject_id, 'email_changed');

  RETURN QUERY SELECT 'completed'::TEXT, 0,v.subject_id, v.id, v_previous, v_revoked;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.complete_email_change(text, bytea, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_email_change(text, bytea, text, text, text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_oidc_invitation(p_transaction_id uuid, p_issuer text, p_subject_key text, p_idp_tenant text, p_verified_email text, p_email_hash text, p_identity_id uuid, p_subject_id uuid, p_session_id uuid, p_token_hash text, p_ttl_seconds integer)
 RETURNS TABLE(status text, subject_id uuid, organization_id uuid, invitation_id uuid, identity_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'invitation_accept');
  v_invitation core.invitations%ROWTYPE;
  v_expires TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_invitation FROM core.invitations i
  WHERE i.id = v.invitation_id AND i.state = 'pending' AND i.expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    PERFORM core.oidc_complete(v.id, 'invitation_invalid', NULL, NULL);
    RETURN QUERY SELECT 'invitation_invalid'::TEXT,NULL::UUID, NULL::UUID, v.invitation_id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_verified_email IS NULL OR core.normalize_email(p_verified_email) <> v_invitation.email THEN
    PERFORM core.oidc_complete(v.id, 'email_mismatch', NULL, NULL);
    RETURN QUERY SELECT 'email_mismatch'::TEXT,NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_external_identity(v.provider, p_issuer, p_subject_key);
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
      AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL);
    RETURN QUERY SELECT 'identity_unavailable'::TEXT,NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_invitation.email);
  IF EXISTS (SELECT 1 FROM core.subjects s WHERE s.email = v_invitation.email) THEN
    UPDATE core.invitations SET state = 'expired', version = version + 1 WHERE id = v_invitation.id;
    PERFORM core.oidc_complete(v.id, 'email_unavailable', NULL, NULL);
    RETURN QUERY SELECT 'email_unavailable'::TEXT,NULL::UUID, v_invitation.organization_id, v_invitation.id, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO core.subjects (id,kind, display_name, assurance_level, email, organization_id)
  VALUES (p_subject_id,'person', v.display_name, 'wallet_only',
          v_invitation.email, v_invitation.organization_id);
  UPDATE core.invitations
  SET state = 'accepted', accepted_at = now(), accepted_subject_id = p_subject_id, version = version + 1
  WHERE id = v_invitation.id;
  -- A code still out for this invitation can no longer accept it.
  UPDATE core.email_challenges SET superseded_at = now()
  WHERE invitation_id = v_invitation.id AND consumed_at IS NULL AND superseded_at IS NULL;
  UPDATE core.email_outbox
  SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
  WHERE invitation_id = v_invitation.id AND template = 'invitation_code' AND state = 'pending';

  INSERT INTO core.external_identities (
    id,subject_id, provider, issuer, subject_key, idp_tenant, email_hash, linked_via, last_used_at
  ) VALUES (
    p_identity_id,p_subject_id, v.provider, p_issuer, p_subject_key,
    p_idp_tenant, p_email_hash, 'invitation', now()
  );
  PERFORM core.oidc_complete(v.id, 'session', p_subject_id, p_identity_id);
  v_expires := core.insert_oidc_session(
    v.id, v.provider, p_subject_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT,p_subject_id,
    v_invitation.organization_id, v_invitation.id, p_identity_id, v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.complete_oidc_invitation(uuid, text, text, text, text, text, uuid, uuid, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_oidc_invitation(uuid, text, text, text, text, text, uuid, uuid, uuid, text, integer) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_oidc_link(p_transaction_id uuid, p_session_id uuid, p_issuer text, p_subject_key text, p_idp_tenant text, p_email_hash text, p_identity_id uuid, p_verified_email text)
 RETURNS TABLE(status text, identity_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET row_security TO 'off'
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_session core.sessions := core.mfa_lock_session(p_session_id);
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'link');
BEGIN
  IF v.session_id <> v_session.id OR v.subject_id <> v_session.subject_id THEN
    RAISE EXCEPTION 'OIDC_TRANSACTION_INVALID: the transaction belongs to another session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_session.recovery_limited THEN
    PERFORM core.oidc_complete(v.id, 'step_up_required', NULL, NULL);
    RETURN QUERY SELECT 'step_up_required'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = v_session.subject_id
      AND s.email = core.normalize_email(p_verified_email) AND s.suspended_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL);
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  PERFORM core.lock_external_identity(v.provider, p_issuer, p_subject_key);
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
      AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'unavailable', NULL, NULL);
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::UUID;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM core.external_identities i
    WHERE i.subject_id = v_session.subject_id AND i.provider = v.provider AND i.revoked_at IS NULL
  ) THEN
    PERFORM core.oidc_complete(v.id, 'provider_already_linked', NULL, NULL);
    RETURN QUERY SELECT 'provider_already_linked'::TEXT, NULL::UUID;
    RETURN;
  END IF;

  INSERT INTO core.external_identities (
    id,subject_id, provider, issuer, subject_key, idp_tenant, email_hash, linked_via
  ) VALUES (
    p_identity_id,v_session.subject_id, v.provider, p_issuer, p_subject_key,
    p_idp_tenant, p_email_hash, 'link'
  );
  PERFORM core.oidc_complete(v.id, 'linked', NULL, p_identity_id);
  RETURN QUERY SELECT 'linked'::TEXT, p_identity_id;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.complete_oidc_link(uuid, uuid, text, text, text, text, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_oidc_link(uuid, uuid, text, text, text, text, uuid, text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_oidc_sign_in(p_transaction_id uuid, p_issuer text, p_subject_key text, p_session_id uuid, p_token_hash text, p_ttl_seconds integer)
 RETURNS TABLE(status text, subject_id uuid, identity_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction_id, 'sign_in');
  v_identity core.external_identities;
  v_subject_id UUID;
  v_expires TIMESTAMPTZ;
BEGIN
  -- 0133 (N1): the person first. An identity's subject never changes, so reading it unlocked is
  -- enough to know which row to lock. `FOR KEY SHARE` is what the login transaction and the
  -- session take on the person below anyway; taken here, a revocation holding the person
  -- `FOR UPDATE` makes this wait before it holds the identity, and one that comes later waits for
  -- this sign-in instead of for an identity this sign-in holds.
  SELECT i.subject_id INTO v_subject_id FROM core.external_identities i
  WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
    AND i.revoked_at IS NULL;
  IF v_subject_id IS NOT NULL THEN
    PERFORM 1 FROM core.subjects s WHERE s.id = v_subject_id FOR KEY SHARE;
  END IF;

  -- 0132 (F1): found and locked in one statement. Whatever revokes the identity (an MFA reset, an
  -- address change, an unlink, a suspension) holds its row until it commits; this UPDATE waits for
  -- it and, under READ COMMITTED, re-checks `revoked_at` on the committed row. A revoked identity
  -- therefore signs nobody in, however the two interleave. When this one locks first, the
  -- revocation waits for it and then ends the session it created (`revoke_subject_sessions` reads
  -- after the identity lock is released).
  UPDATE core.external_identities i SET last_used_at = now()
  WHERE i.provider = v.provider AND i.issuer = p_issuer AND i.subject_key = p_subject_key
    AND i.revoked_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM core.subjects s WHERE s.id = i.subject_id AND s.suspended_at IS NOT NULL
    )
  RETURNING i.* INTO v_identity;
  IF v_identity.id IS NULL THEN
    PERFORM core.oidc_complete(v.id, 'not_found', NULL, NULL);
    RETURN QUERY SELECT 'not_found'::TEXT,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  PERFORM core.oidc_complete(v.id, 'session', v_identity.subject_id, v_identity.id);
  v_expires := core.insert_oidc_session(
    v.id, v.provider, v_identity.subject_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT,v_identity.subject_id, v_identity.id, v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.complete_oidc_sign_in(uuid, text, text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_oidc_sign_in(uuid, text, text, uuid, text, integer) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_totp(p_session_id uuid, p_totp_id uuid, p_step bigint, p_recovery_hashes text[])
 RETURNS TABLE(activated boolean, recovery_codes_stored boolean, session_ended boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_row core.totp_authenticators;
  v_activated BOOLEAN := false;
  v_stored BOOLEAN := false;
  v_ended BOOLEAN := false;
BEGIN
  SELECT * INTO v_row FROM core.totp_authenticators
  WHERE id = p_totp_id AND subject_id = v.subject_id AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_TOTP_NOT_ENROLLED: not a TOTP of this subject' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_step IS NULL OR p_step < 0 OR p_step <= COALESCE(v_row.last_used_step, -1) THEN
    RAISE EXCEPTION 'MFA_TOTP_REPLAYED: this code was already used' USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_row.confirmed_at IS NULL THEN
    IF v_row.pending_expires_at <= now() THEN
      RAISE EXCEPTION 'MFA_TOTP_NOT_ENROLLED: the setup expired' USING ERRCODE = 'insufficient_privilege';
    END IF;
    PERFORM core.mfa_assert_enrolment(v, 'totp');
    -- Only a recovery-limited session gets here with a TOTP already active: it replaces it.
    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'replaced_after_recovery'
    WHERE subject_id = v.subject_id AND confirmed_at IS NOT NULL AND revoked_at IS NULL;
    v_activated := true;
  END IF;

  UPDATE core.totp_authenticators
  SET confirmed_at = COALESCE(confirmed_at, now()), last_used_step = p_step, last_used_at = now(),
      failed_attempts = 0, failure_window_started_at = NULL
  WHERE id = v_row.id;

  IF v.second_factor IS DISTINCT FROM 'passkey' THEN
    v_ended := core.mfa_raise_session(v, 'totp', NULL, NULL, v_row.id, p_step, NULL);
  END IF;
  IF v_activated THEN
    v_stored := core.mfa_store_recovery_codes(v, p_recovery_hashes, true);
  END IF;
  RETURN QUERY SELECT v_activated, v_stored, v_ended;
END
$function$;

CREATE OR REPLACE FUNCTION core.complete_webauthn_authentication(p_session_id uuid, p_challenge text, p_credential_id text, p_new_sign_count bigint, p_user_verified boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge UUID;
  v_credential core.webauthn_credentials;
BEGIN
  v_challenge := core.mfa_consume_challenge(v, 'authentication', p_challenge);
  IF p_user_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'MFA_USER_VERIFICATION_REQUIRED: the authenticator did not verify the user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_credential FROM core.webauthn_credentials
  WHERE credential_id = p_credential_id AND subject_id = v.subject_id
    AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_CREDENTIAL_UNKNOWN: not an active passkey of this subject'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_new_sign_count IS NULL OR NOT (
    (p_new_sign_count = 0 AND v_credential.sign_count = 0) OR p_new_sign_count > v_credential.sign_count
  ) THEN
    RAISE EXCEPTION 'MFA_COUNTER_REGRESSION: the sign counter did not increase'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE core.webauthn_credentials SET sign_count = p_new_sign_count, last_used_at = now()
  WHERE id = v_credential.id;
  RETURN core.mfa_raise_session(v, 'passkey', v_challenge, v_credential.id, NULL, NULL, NULL);
END
$function$;

CREATE OR REPLACE FUNCTION core.complete_webauthn_registration(p_session_id uuid, p_challenge text, p_credential_id text, p_public_key bytea, p_sign_count bigint, p_transports text[], p_aaguid uuid, p_user_verified boolean, p_device_type text, p_backed_up boolean, p_name text, p_recovery_hashes text[])
 RETURNS TABLE(passkey_id uuid, recovery_codes_stored boolean, session_ended boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_challenge UUID;
  v_id UUID := gen_random_uuid();
  v_ended BOOLEAN;
  v_stored BOOLEAN;
BEGIN
  v_challenge := core.mfa_consume_challenge(v, 'registration', p_challenge);
  IF p_user_verified IS NOT TRUE THEN
    RAISE EXCEPTION 'MFA_USER_VERIFICATION_REQUIRED: the authenticator did not verify the user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- Checked again at completion: the subject may have gained a factor since the options.
  PERFORM core.mfa_assert_enrolment(v, 'passkey');

  BEGIN
    INSERT INTO core.webauthn_credentials (
      id,subject_id, credential_id, public_key, sign_count, transports, aaguid,
      user_verified, device_type, backed_up, name
    ) VALUES (
      v_id,v.subject_id, p_credential_id, p_public_key, p_sign_count,
      COALESCE(p_transports, '{}'), p_aaguid, p_user_verified, p_device_type, p_backed_up, p_name
    );
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'MFA_CREDENTIAL_EXISTS: this authenticator is already registered'
      USING ERRCODE = 'unique_violation';
  END;

  v_ended := core.mfa_raise_session(v, 'passkey', v_challenge, v_id, NULL, NULL, NULL);
  v_stored := core.mfa_store_recovery_codes(v, p_recovery_hashes, true);
  RETURN QUERY SELECT v_id, v_stored, v_ended;
END
$function$;

CREATE OR REPLACE FUNCTION core.confirm_wallet_recovery(p_session uuid, p_id uuid, p_proof uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
DECLARE actor core.sessions := core.mfa_lock_session(p_session);
BEGIN
  UPDATE core.wallet_recoveries r SET confirmed_at=coalesce(confirmed_at,now())
  FROM core.subjects s WHERE r.id=p_id AND r.session_id=p_session
    AND r.subject_id=actor.subject_id AND s.id=r.subject_id AND s.email=r.email AND s.suspended_at IS NULL
    AND NOT actor.recovery_limited AND r.cancelled_at IS NULL AND r.consumed_at IS NULL AND r.created_at>now()-interval '10 minutes'
    AND r.proof_digest=sha256(convert_to(p_proof::text,'UTF8'));
  RETURN FOUND;
END $function$;

CREATE OR REPLACE FUNCTION core.consume_email_challenge(p_purpose core.email_challenge_purpose, p_email text, p_invitation_id uuid, p_code_hmac bytea)
 RETURNS TABLE(status text, challenge_id uuid, subject_id uuid, email_change_id uuid)
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v core.email_challenges%ROWTYPE;
BEGIN
  SELECT * INTO v FROM core.email_challenges c
  WHERE c.purpose = p_purpose AND c.email = p_email
    AND c.consumed_at IS NULL AND c.superseded_at IS NULL
    AND (p_invitation_id IS NULL OR c.invitation_id = p_invitation_id)
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, NULL::UUID,NULL::UUID, NULL::UUID;
    RETURN;
  END IF;
  IF v.expires_at <= now() THEN
    RETURN QUERY SELECT 'code_expired'::TEXT, v.id,v.subject_id, v.email_change_id;
    RETURN;
  END IF;
  IF v.attempts >= 5 THEN
    RETURN QUERY SELECT 'attempts_exhausted'::TEXT, v.id,v.subject_id, v.email_change_id;
    RETURN;
  END IF;

  UPDATE core.email_challenges SET attempts = attempts + 1 WHERE id = v.id;

  IF NOT core.digest_equal(v.code_hmac, p_code_hmac)
     OR (v.subject_id IS NULL AND v.purpose <> 'invitation') THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, v.id,v.subject_id, v.email_change_id;
    RETURN;
  END IF;

  UPDATE core.email_challenges
  SET consumed_at = now(), consumed_txid = pg_current_xact_id()
  WHERE id = v.id;
  RETURN QUERY SELECT 'ok'::TEXT, v.id,v.subject_id, v.email_change_id;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.consume_email_challenge(core.email_challenge_purpose, text, uuid, bytea) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.consume_recovery_code(p_session_id uuid, p_code_hash text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_code UUID;
BEGIN
  IF v.second_factor IS NOT NULL THEN
    RAISE EXCEPTION 'MFA_ALREADY_SATISFIED: this session already proved a second factor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.recovery_codes SET consumed_at = now(), consumed_by_session_id = v.id
  WHERE id = (
    SELECT id FROM core.recovery_codes
    WHERE subject_id = v.subject_id AND code_hash = p_code_hash
      AND consumed_at IS NULL AND voided_at IS NULL
    LIMIT 1
    FOR UPDATE
  )
  RETURNING id INTO v_code;
  IF v_code IS NULL THEN
    RAISE EXCEPTION 'MFA_RECOVERY_CODE_INVALID: not a usable recovery code of this subject'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM core.mfa_raise_session(v, 'recovery_code', NULL, NULL, NULL, NULL, v_code);
  RETURN core.mfa_revoke_other_sessions(v, v.id, 'recovery_code_used');
END
$function$;

CREATE OR REPLACE FUNCTION core.create_invitation(p_id uuid, p_organization_id uuid, p_email text, p_invited_by uuid, p_token_hash text, p_link text)
 RETURNS TABLE(status text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v_email TEXT := core.normalize_email(p_email);
  v_now TIMESTAMPTZ := now();
BEGIN
  IF core.current_actor() IS DISTINCT FROM p_invited_by THEN
    RAISE EXCEPTION 'an invitation is created by its inviter' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM core.organizations o WHERE o.id = p_organization_id) THEN
    RETURN QUERY SELECT 'organization_unknown'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s WHERE s.id = p_invited_by AND s.kind = 'person'
  ) THEN
    RAISE EXCEPTION 'inviter % is not a person in the Registry', p_invited_by
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  PERFORM core.lock_email(v_email);
  IF core.email_in_use(v_email) THEN
    RETURN QUERY SELECT 'unavailable'::TEXT, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO core.invitations (
    id,organization_id, email, invited_by_subject_id, token_hash, created_at, expires_at
  ) VALUES (
    p_id,p_organization_id, v_email, p_invited_by, p_token_hash,
    v_now, v_now + interval '72 hours'
  );
  INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at, invitation_id)
  VALUES (
    gen_random_uuid(), 'invitation_link', v_email,
    jsonb_build_object('link', p_link, 'expiresAt', to_char(
      (v_now + interval '72 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI"Z"'
    )),
    'pending', v_now + interval '72 hours', p_id
  );
  RETURN QUERY SELECT 'created'::TEXT, v_now + interval '72 hours';
END
$function$;

CREATE OR REPLACE FUNCTION core.create_role_invitation(p_id uuid, p_org uuid, p_email text, p_session uuid, p_hash text, p_link text, p_role text, p_project uuid, p_basis text)
 RETURNS TABLE(status text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
DECLARE
  actor core.sessions := core.mfa_lock_session(p_session);
  result record;
BEGIN
  IF actor.recovery_limited OR NOT EXISTS (
    SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id
    WHERE b.subject_id=actor.subject_id AND b.role='administrator'
      AND b.revoked_at IS NULL AND b.project_id IS NULL AND b.scope_kind='registry' AND b.jurisdiction IS NULL
      AND s.suspended_at IS NULL AND s.assurance_level='high_assurance'
  ) THEN
    RETURN QUERY SELECT 'not_authorized'::text, NULL::timestamptz;
    RETURN;
  END IF;
  IF p_project IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.projects WHERE id=p_project AND (p_role='reviewer' OR owner_organization_id=p_org)
  ) THEN
    RETURN QUERY SELECT 'project_unknown'::text, NULL::timestamptz;
    RETURN;
  END IF;
  SELECT * INTO result FROM core.create_invitation(p_id,p_org,p_email,actor.subject_id,p_hash,p_link);
  IF result.status='created' THEN
    UPDATE core.invitations SET invited_role=p_role, invited_project_id=p_project, identity_basis=trim(p_basis)
    WHERE id=p_id;
  END IF;
  RETURN QUERY SELECT result.status::text, result.expires_at::timestamptz;
END $function$;

CREATE OR REPLACE FUNCTION core.create_wallet_binding_challenge(p_session_id uuid, p_challenge_id uuid, p_wallet text, p_chain_id integer, p_nonce text)
 RETURNS TABLE(issued_at timestamp with time zone, expires_at timestamp with time zone, subject_id uuid, replaces_wallet_id uuid, replaces_wallet_address text, replaces_chain_id integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_active core.wallet_identities;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, true);

  SELECT * INTO v_active FROM core.wallet_identities w
  WHERE w.subject_id = v.subject_id AND w.disabled_at IS NULL;
  IF v_active.id IS NOT NULL AND v_active.wallet_address = lower(p_wallet) AND v_active.chain_id = p_chain_id THEN
    RAISE EXCEPTION 'WALLET_ALREADY_ACTIVE: this wallet already is the account''s signing wallet'
      USING ERRCODE = 'unique_violation';
  END IF;

  DELETE FROM core.wallet_binding_challenges c WHERE c.session_id = v.id AND c.consumed_at IS NULL;
  RETURN QUERY
  INSERT INTO core.wallet_binding_challenges AS c (
    id, subject_id, session_id, wallet_address, chain_id, nonce, issued_at, expires_at,
    replaces_wallet_id
  ) VALUES (
    p_challenge_id, v.subject_id, v.id, lower(p_wallet), p_chain_id, p_nonce,
    date_trunc('second', now()), date_trunc('second', now()) + interval '5 minutes', v_active.id
  )
  RETURNING c.issued_at, c.expires_at, c.subject_id,
    c.replaces_wallet_id, v_active.wallet_address, v_active.chain_id;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.create_wallet_binding_challenge(uuid, uuid, text, integer, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.create_wallet_binding_challenge(uuid, uuid, text, integer, text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.create_webauthn_challenge(p_session_id uuid, p_purpose core.webauthn_challenge_purpose, p_challenge text)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_expires TIMESTAMPTZ := now() + interval '5 minutes';
BEGIN
  IF p_purpose = 'registration' THEN
    PERFORM core.mfa_assert_enrolment(v, 'passkey');
  ELSIF NOT core.mfa_has_passkey(v.subject_id) THEN
    RAISE EXCEPTION 'MFA_NO_PASSKEY: the subject has no passkey' USING ERRCODE = 'insufficient_privilege';
  END IF;

  DELETE FROM core.webauthn_challenges
  WHERE session_id = v.id AND purpose = p_purpose AND consumed_at IS NULL;
  INSERT INTO core.webauthn_challenges (id,subject_id, session_id, purpose, challenge, expires_at)
  VALUES (gen_random_uuid(),v.subject_id, v.id, p_purpose, p_challenge, v_expires);
  RETURN v_expires;
END
$function$;

CREATE OR REPLACE FUNCTION core.decide_email_change(p_id uuid, p_decided_by uuid, p_approve boolean, p_reason text, p_expected_version integer, p_challenge_id uuid, p_code_hmac bytea, p_code text)
 RETURNS TABLE(status text, version integer, subject_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v core.email_change_requests%ROWTYPE;
  v_suspended TIMESTAMPTZ;
  v_subject_id UUID;
BEGIN
  IF core.current_actor() IS DISTINCT FROM p_decided_by THEN
    RAISE EXCEPTION 'a decision is made by the authenticated actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 0132 (F3): the person's subject row first, then the request (see the header). The request's
  -- subject never changes, so reading it unlocked is enough to know which row to lock.
  SELECT r.subject_id INTO v_subject_id FROM core.email_change_requests r
  WHERE r.id = p_id;
  IF FOUND THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;
  SELECT * INTO v FROM core.email_change_requests r
  WHERE r.id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::INTEGER, NULL::UUID;
    RETURN;
  END IF;
  IF v.version <> p_expected_version THEN
    RETURN QUERY SELECT 'version_mismatch'::TEXT, v.version, v.subject_id;
    RETURN;
  END IF;
  IF v.state <> 'pending' THEN
    RETURN QUERY SELECT 'not_pending'::TEXT, v.version, v.subject_id;
    RETURN;
  END IF;

  IF p_approve THEN
    SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v.subject_id FOR UPDATE;
    IF v_suspended IS NOT NULL THEN
      RETURN QUERY SELECT 'subject_suspended'::TEXT, v.version, v.subject_id;
      RETURN;
    END IF;
  END IF;

  UPDATE core.email_change_requests
  SET state = CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END,
      decided_by_subject_id = p_decided_by, decided_at = now(), decision_reason = p_reason,
      version = version + 1
  WHERE id = v.id;

  IF p_approve THEN
    PERFORM core.issue_email_challenge(
      p_challenge_id, 'email_change', v.new_email, v.subject_id, NULL, v.id,
      p_code_hmac, 'email_change_code', v.new_email, p_code
    );
  END IF;
  RETURN QUERY SELECT CASE WHEN p_approve THEN 'approved' ELSE 'rejected' END, v.version + 1, v.subject_id;
END
$function$;

CREATE OR REPLACE FUNCTION core.decide_mfa_reset(p_request_id uuid, p_decider uuid, p_approve boolean, p_reason text, p_expected_version integer)
 RETURNS TABLE(revoked_sessions integer, revoked_authenticators integer, voided_recovery_codes integer, new_version integer, released_elevations jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_request core.mfa_reset_requests;
  v_sessions INTEGER := 0;
  v_authenticators INTEGER := 0;
  v_count INTEGER;
  v_codes INTEGER := 0;
  v_removed TEXT[] := ARRAY[]::TEXT[];
  v_suspended TIMESTAMPTZ;
  v_released JSONB := '[]'::jsonb;
  v_subject_id UUID;
BEGIN
  IF core.current_actor() IS DISTINCT FROM p_decider THEN
    RAISE EXCEPTION 'a decision is made by the authenticated actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 0132 (F3): the person's subject row first, then the request (see the header). The request's
  -- subject never changes, so reading it unlocked is enough to know which row to lock.
  SELECT r.subject_id INTO v_subject_id FROM core.mfa_reset_requests r
  WHERE r.id = p_request_id;
  IF FOUND THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;
  SELECT * INTO v_request FROM core.mfa_reset_requests
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_RESET_NOT_FOUND: no such reset request' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_request.version <> p_expected_version THEN
    RAISE EXCEPTION 'MFA_RESET_VERSION_MISMATCH: current version is %', v_request.version
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_request.state <> 'pending' THEN
    RAISE EXCEPTION 'MFA_RESET_ALREADY_DECIDED: the request is %', v_request.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_decider = v_request.requested_by_subject_id THEN
    RAISE EXCEPTION 'MFA_RESET_SELF_APPROVAL: the proposer cannot decide' USING ERRCODE = 'check_violation';
  END IF;
  IF p_decider = v_request.subject_id THEN
    RAISE EXCEPTION 'MFA_RESET_SELF_TARGET: the person reset cannot decide' USING ERRCODE = 'check_violation';
  END IF;

  IF p_approve THEN
    SELECT suspended_at INTO v_suspended FROM core.subjects WHERE id = v_request.subject_id FOR UPDATE;
    IF v_suspended IS NOT NULL THEN
      RAISE EXCEPTION 'MFA_RESET_SUBJECT_SUSPENDED: the person is suspended' USING ERRCODE = 'check_violation';
    END IF;
    IF core.recovery_separation_conflict(v_request.subject_id, p_decider, 'mfa_reset')
       OR core.recovery_separation_conflict(v_request.subject_id, v_request.requested_by_subject_id, 'mfa_reset') THEN
      RAISE EXCEPTION 'MFA_RESET_SEPARATION_REQUIRED: the proposer or decider took part in a recent email change or suspension of this person'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE core.mfa_reset_requests
  SET state = CASE WHEN p_approve THEN 'approved'::core.mfa_reset_state ELSE 'rejected' END,
      decided_by_subject_id = p_decider,
      decided_at = now(),
      decision_reason = p_reason,
      enrolment_window_until = CASE WHEN p_approve THEN now() + interval '24 hours' END,
      version = version + 1
  WHERE id = v_request.id;

  IF p_approve THEN
    UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'mfa_reset'
    WHERE subject_id = v_request.subject_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_count;

    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'mfa_reset'
    WHERE subject_id = v_request.subject_id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_authenticators + v_count;

    UPDATE core.recovery_codes SET voided_at = now()
    WHERE subject_id = v_request.subject_id
      AND consumed_at IS NULL AND voided_at IS NULL;
    GET DIAGNOSTICS v_codes = ROW_COUNT;

    v_removed := core.revoke_subject_identities(v_request.subject_id, 'mfa_reset');

    -- 0129: an approved elevation ends with the factors it was approved over. The person enrols
    -- new ones in the reset's window; break-glass needs a new approval.
    v_released := core.end_subject_elevations(v_request.subject_id, p_decider, 'mfa_reset');

    v_sessions := core.revoke_subject_sessions(v_request.subject_id, 'mfa_reset');

    INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
    SELECT gen_random_uuid(), 'mfa_reset_notice', a.address,
           jsonb_build_object('removedSignIns', to_jsonb(v_removed)), 'pending', now() + interval '1 day'
    FROM (
      SELECT s.email AS address FROM core.subjects s
      WHERE s.id = v_request.subject_id AND s.email IS NOT NULL
      UNION
      SELECT c.previous_email FROM core.email_change_requests c
      WHERE c.subject_id = v_request.subject_id AND c.state = 'completed'
        AND c.previous_email IS NOT NULL AND c.completed_at > now() - interval '90 days'
    ) a;
  END IF;

  RETURN QUERY SELECT v_sessions, v_authenticators, v_codes, v_request.version + 1, v_released;
END
$function$;

CREATE OR REPLACE FUNCTION core.decide_subject_suspension(p_request_id uuid, p_decider uuid, p_approve boolean, p_reason text, p_expected_version integer)
 RETURNS TABLE(revoked_sessions integer, revoked_authenticators integer, revoked_identities integer, new_version integer, closed_requests jsonb)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  v_request core.subject_suspensions;
  v_subject core.subjects;
  v_sessions INTEGER := 0;
  v_authenticators INTEGER := 0;
  v_count INTEGER;
  v_removed TEXT[] := ARRAY[]::TEXT[];
  v_closed JSONB := '[]'::jsonb;
  v_part JSONB;
  v_email TEXT;
  v_subject_id UUID;
  v_invitation UUID;
BEGIN
  IF core.current_actor() IS DISTINCT FROM p_decider THEN
    RAISE EXCEPTION 'a decision is made by the authenticated actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- 0132 (F3): the person's subject row first, then the request (see the header). The request's
  -- subject never changes, so reading it unlocked is enough to know which row to lock.
  SELECT r.subject_id INTO v_subject_id FROM core.subject_suspensions r
  WHERE r.id = p_request_id;
  IF FOUND THEN
    PERFORM 1 FROM core.subjects WHERE id = v_subject_id FOR UPDATE;
  END IF;
  SELECT * INTO v_request FROM core.subject_suspensions
  WHERE id = p_request_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SUSPENSION_NOT_FOUND: no such request' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_request.version <> p_expected_version THEN
    RAISE EXCEPTION 'SUSPENSION_VERSION_MISMATCH: current version is %', v_request.version
      USING ERRCODE = 'serialization_failure';
  END IF;
  IF v_request.state <> 'pending' THEN
    RAISE EXCEPTION 'SUSPENSION_ALREADY_DECIDED: the request is %', v_request.state
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_decider = v_request.subject_id THEN
    RAISE EXCEPTION 'SUSPENSION_SELF_TARGET: the person cannot decide' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_subject FROM core.subjects
  WHERE id = v_request.subject_id
  FOR UPDATE;

  IF p_approve THEN
    IF (v_request.action = 'suspend') <> (v_subject.suspended_at IS NULL) THEN
      RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person''s state changed since the proposal'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  UPDATE core.subject_suspensions
  SET state = CASE WHEN p_approve THEN 'approved'::core.mfa_reset_state ELSE 'rejected' END,
      decided_by_subject_id = p_decider,
      decided_at = now(),
      decision_reason = p_reason,
      enrolment_window_until = CASE WHEN p_approve AND action = 'reinstate' THEN now() + interval '24 hours' END,
      version = version + 1
  WHERE id = v_request.id;

  IF p_approve AND v_request.action = 'suspend' THEN
    UPDATE core.subjects SET suspended_at = now(), version = version + 1 WHERE id = v_subject.id;

    -- The person's own recovery requests (S-M1). An email change's code dies with its request.
    FOR v_email IN
      SELECT c.new_email FROM core.email_change_requests c
      WHERE c.subject_id = v_subject.id AND c.state IN ('pending', 'approved')
    LOOP
      PERFORM core.supersede_email_challenge('email_change', v_email);
    END LOOP;
    WITH closed AS (
      UPDATE core.email_change_requests
      SET state = 'expired', closed_reason = 'subject_suspended', version = version + 1
      WHERE subject_id = v_subject.id AND state IN ('pending', 'approved')
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'email_change_request', 'id', id, 'reason', 'subject_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.mfa_reset_requests
      SET state = 'rejected', closed_reason = 'subject_suspended', decided_at = now(), version = version + 1
      WHERE subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', id, 'reason', 'subject_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    -- An approved reset's open window ends with the suspension (`mfa_reset_window_open`).
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', r.id, 'reason', 'window_closed')), '[]')
    INTO v_part FROM core.mfa_reset_requests r
    WHERE r.subject_id = v_subject.id AND r.state = 'approved' AND r.enrolment_window_until > now();
    v_closed := v_closed || v_part;

    -- What the person proposed and nobody decided yet (S-L1).
    FOR v_email IN
      SELECT c.new_email FROM core.email_change_requests c
      WHERE c.requested_by_subject_id = v_subject.id AND c.state IN ('pending', 'approved')
    LOOP
      PERFORM core.supersede_email_challenge('email_change', v_email);
    END LOOP;
    WITH closed AS (
      UPDATE core.email_change_requests
      SET state = 'expired', closed_reason = 'proposer_suspended', version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state IN ('pending', 'approved')
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'email_change_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.mfa_reset_requests
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.subject_suspensions
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'subject_suspension', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.role_grant_requests
      SET state = 'withdrawn', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'role_grant_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.role_revocation_requests
      SET state = 'withdrawn', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE requested_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'role_revocation_request', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.registry_proposals
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE proposed_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'registry_proposal', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.registry_publication_drafts
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE proposed_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'registry_publication_draft', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.break_glass_elevations
      SET state = 'rejected', closed_reason = 'proposer_suspended', decided_at = now(), version = version + 1
      WHERE subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'break_glass_elevation', 'id', id, 'reason', 'proposer_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    -- 0132 (F2): what the person approved or created that has not taken effect yet. An approved
    -- email change still waiting for its code, an approved reset whose enrolment window is open,
    -- and a pending invitation all act on the approver's word later; a suspended approver's word
    -- no longer counts. Decided and completed requests stay as they are (frozen history).
    FOR v_email IN
      SELECT c.new_email FROM core.email_change_requests c
      WHERE c.decided_by_subject_id = v_subject.id AND c.state = 'approved'
    LOOP
      PERFORM core.supersede_email_challenge('email_change', v_email);
    END LOOP;
    WITH closed AS (
      UPDATE core.email_change_requests
      SET state = 'expired', closed_reason = 'approver_suspended', version = version + 1
      WHERE decided_by_subject_id = v_subject.id AND state = 'approved'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'email_change_request', 'id', id, 'reason', 'approver_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    WITH closed AS (
      UPDATE core.mfa_reset_requests
      SET closed_reason = 'approver_suspended', version = version + 1
      WHERE decided_by_subject_id = v_subject.id AND state = 'approved' AND closed_reason IS NULL
        AND enrolment_window_until > now()
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'mfa_reset_request', 'id', id, 'reason', 'approver_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    FOR v_invitation IN
      SELECT i.id FROM core.invitations i
      WHERE i.invited_by_subject_id = v_subject.id AND i.state = 'pending'
    LOOP
      UPDATE core.email_challenges SET superseded_at = now()
      WHERE invitation_id = v_invitation AND consumed_at IS NULL AND superseded_at IS NULL;
      UPDATE core.email_outbox
      SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
      WHERE invitation_id = v_invitation AND state = 'pending';
    END LOOP;
    WITH closed AS (
      UPDATE core.invitations
      SET state = 'expired', closed_reason = 'inviter_suspended', version = version + 1
      WHERE invited_by_subject_id = v_subject.id AND state = 'pending'
      RETURNING id
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'invitation', 'id', id, 'reason', 'inviter_suspended')), '[]')
    INTO v_part FROM closed;
    v_closed := v_closed || v_part;

    -- 0129 (L-1): an approved elevation ends with the suspension. Reinstating does not bring it
    -- back; a new one needs a new approval.
    v_closed := v_closed || core.end_subject_elevations(v_subject.id, p_decider, 'subject_suspended');

    UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'suspension'
    WHERE subject_id = v_subject.id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_count;

    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'suspension'
    WHERE subject_id = v_subject.id AND revoked_at IS NULL;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_authenticators := v_authenticators + v_count;

    UPDATE core.recovery_codes SET voided_at = now()
    WHERE subject_id = v_subject.id
      AND consumed_at IS NULL AND voided_at IS NULL;

    v_removed := core.revoke_subject_identities(v_subject.id, 'suspension');

    DELETE FROM core.oidc_login_transactions t
    WHERE t.completed_at IS NULL
      AND t.session_id IN (SELECT s.id FROM core.sessions s WHERE s.subject_id = v_subject.id);
    DELETE FROM core.wallet_binding_challenges c
    WHERE c.subject_id = v_subject.id AND c.consumed_at IS NULL;
    DELETE FROM core.webauthn_challenges c
    WHERE c.subject_id = v_subject.id AND c.consumed_at IS NULL;
    IF v_subject.email IS NOT NULL THEN
      PERFORM core.supersede_email_challenge('sign_in', v_subject.email);
    END IF;

    v_sessions := core.revoke_subject_sessions(v_subject.id, 'suspension');

    IF v_subject.email IS NOT NULL THEN
      INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
      VALUES (
        gen_random_uuid(), 'account_suspended_notice', v_subject.email,
        jsonb_build_object('removedSignIns', to_jsonb(v_removed)), 'pending', now() + interval '1 day'
      );
    END IF;
  ELSIF p_approve THEN
    UPDATE core.subjects SET suspended_at = NULL, version = version + 1 WHERE id = v_subject.id;
    IF v_subject.email IS NOT NULL THEN
      INSERT INTO core.email_outbox (id, template, recipient, params, state, expires_at)
      VALUES (
        gen_random_uuid(), 'account_reinstated_notice', v_subject.email, '{}'::jsonb, 'pending',
        now() + interval '1 day'
      );
    END IF;
  END IF;

  RETURN QUERY SELECT v_sessions, v_authenticators, COALESCE(array_length(v_removed, 1), 0),
    v_request.version + 1, v_closed;
END
$function$;

CREATE OR REPLACE FUNCTION core.degrade_connection_on_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT core.source_result_degrades_connection(NEW.result) THEN
    RETURN NEW;
  END IF;

  PERFORM set_config(
    'app.connection_transition_reason',
    format('Source result %s recorded (receipt %s)', NEW.result, NEW.id),
    true
  );

  UPDATE core.source_connections
  SET state = 'degraded', version = version + 1
  WHERE id = NEW.connection_id AND state = 'active';

  IF FOUND THEN
    INSERT INTO core.source_reconciliation_tasks (connection_id, receipt_id, trigger_result)
    VALUES (NEW.connection_id, NEW.id, NEW.result)
    ON CONFLICT (connection_id) WHERE state = 'open' DO NOTHING;
  END IF;

  PERFORM set_config('app.connection_transition_reason', '', true);
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.disable_own_wallet(p_session_id uuid, p_wallet_id uuid, p_reason_code text, p_detail text)
 RETURNS TABLE(wallet_address text, chain_id integer, bound_via text, version integer, revoked_sessions integer, previous_assurance core.assurance_level, assurance core.assurance_level)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_wallet core.wallet_identities;
  v_before core.assurance_level;
  v_after core.assurance_level;
  v_revoked INTEGER;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, false);

  IF p_reason_code IS NULL OR p_reason_code NOT IN ('key_lost', 'key_compromised', 'rotation', 'offboarding') THEN
    RAISE EXCEPTION 'WALLET_REASON_INVALID: not a reason a person gives' USING ERRCODE = 'check_violation';
  END IF;

  SELECT * INTO v_wallet FROM core.wallet_identities w
  WHERE w.id = p_wallet_id AND w.subject_id = v.subject_id
    AND w.disabled_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'WALLET_UNKNOWN: not an active wallet of this subject' USING ERRCODE = 'no_data_found';
  END IF;

  UPDATE core.wallet_identities SET disabled_at = now(), version = version + 1 WHERE id = v_wallet.id;
  INSERT INTO core.wallet_disable_events (
    id,wallet_identity_id, reason_code, detail, disabled_by_subject_id
  ) VALUES (gen_random_uuid(),v_wallet.id, p_reason_code, p_detail, v.subject_id);

  SELECT s.assurance_level INTO v_before FROM core.subjects s WHERE s.id = v.subject_id;
  v_after := v_before;
  IF v_wallet.bound_via = 'operator' THEN
    v_after := COALESCE(
      (SELECT max(w.assurance_level) FROM core.wallet_identities w
       WHERE w.subject_id = v.subject_id AND w.disabled_at IS NULL),
      'wallet_only'
    );
    IF v_after IS DISTINCT FROM v_before THEN
      UPDATE core.subjects SET assurance_level = v_after, version = version + 1 WHERE id = v.subject_id;
    END IF;
  END IF;

  -- AC-27: whoever may hold the key must not keep a session.
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'wallet_disabled'
  WHERE subject_id = v.subject_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_revoked = ROW_COUNT;

  RETURN QUERY SELECT v_wallet.wallet_address, v_wallet.chain_id, v_wallet.bound_via,
    v_wallet.version + 1, v_revoked, v_before, v_after;
END
$function$;

CREATE OR REPLACE FUNCTION core.enqueue_notification_delivery()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO core.notification_deliveries (notification_id, sink_id)
  SELECT NEW.id, s.id FROM core.notification_sinks s
  WHERE s.state = 'active';
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.external_identity_person_only()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = NEW.subject_id AND s.kind = 'person'
  ) THEN
    RAISE EXCEPTION 'an external identity belongs to a person subject' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.guard_catalog_claim_content()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE document_id UUID;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.catalog_entry_id IS DISTINCT FROM OLD.catalog_entry_id
      OR NEW.catalog_version IS DISTINCT FROM OLD.catalog_version
      OR NEW.structured_values IS DISTINCT FROM OLD.structured_values
      OR NEW.document_upload_ids IS DISTINCT FROM OLD.document_upload_ids THEN
      RAISE EXCEPTION 'Structured claim content is immutable; create a correction';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.catalog_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.claim_types c WHERE c.id = NEW.catalog_entry_id AND c.claim_type = NEW.claim_type
      AND c.catalog_version = NEW.catalog_version AND c.effective_from <= now()
  ) THEN RAISE EXCEPTION 'Claim requires an effective matching catalog version'; END IF;
  IF NEW.catalog_entry_id IS NOT NULL AND NEW.source_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.source_receipts r WHERE r.id = NEW.source_receipt_id AND r.project_id = NEW.project_id
  ) THEN RAISE EXCEPTION 'Structured claim source receipt must belong to the same project'; END IF;
  FOREACH document_id IN ARRAY NEW.document_upload_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM core.object_uploads u WHERE u.id = document_id AND u.project_id = NEW.project_id
        AND u.state::text IN ('scanned_clean', 'promoted') AND u.revoked_at IS NULL
    ) THEN RAISE EXCEPTION 'Claim document must be an active scanned upload of this project'; END IF;
    INSERT INTO core.lineage_edges (id,from_id, to_id, relation_type)
    VALUES (gen_random_uuid(),NEW.id, document_id, 'derived_from')
    ON CONFLICT (from_id, to_id, relation_type) DO NOTHING;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.guard_claim_type_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  previous_version INTEGER;
  previous_effective_from TIMESTAMPTZ;
BEGIN
  SELECT catalog_version, effective_from INTO previous_version, previous_effective_from
  FROM core.claim_types
  WHERE claim_type = NEW.claim_type
  ORDER BY catalog_version DESC LIMIT 1;

  IF NEW.catalog_version <> COALESCE(previous_version, 0) + 1 THEN
    RAISE EXCEPTION 'Claim type versions must be consecutive' USING ERRCODE = 'raise_exception';
  END IF;
  IF NEW.effective_from < previous_effective_from THEN
    RAISE EXCEPTION 'A claim type version cannot take effect before its predecessor'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.guard_demo_definition_project()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.project_id IS NOT NULL AND (NOT core.project_definition_applies(NEW.project_id,NEW.project_id)
    OR NOT EXISTS(SELECT 1 FROM audit.events e WHERE e.resource_id=NEW.project_id AND e.command='dev_demo.started')) THEN
    RAISE EXCEPTION 'Project-bound definitions require an original synthetic demo';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION core.guard_gate_decision_independence()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE actors UUID[];
BEGIN
  SELECT a.evidence_actor_ids INTO actors FROM core.compliance_assessments a
  WHERE a.id=NEW.input_assessment_id AND a.project_id=NEW.project_id;
  IF actors IS NULL THEN RAISE EXCEPTION 'Gate assessment requires contributor provenance; reassess'; END IF;
  IF NEW.decision_maker_subject_id=ANY(actors) THEN
    RAISE EXCEPTION 'Gate decider must be independent of assessment evidence contributors';
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION core.guard_jurisdiction_profile_version()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  previous_version        INTEGER;
  previous_state          TEXT;
  previous_effective_from TIMESTAMPTZ;
BEGIN
  SELECT profile_version, state, effective_from
    INTO previous_version, previous_state, previous_effective_from
  FROM core.jurisdiction_profiles
  WHERE jurisdiction = NEW.jurisdiction
  ORDER BY profile_version DESC
  LIMIT 1;

  IF previous_version IS NULL THEN
    IF NEW.profile_version <> 1 OR NEW.state <> 'approved' THEN
      RAISE EXCEPTION 'The first version of a jurisdiction profile is version 1 and approved'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.profile_version <> previous_version + 1 THEN
    RAISE EXCEPTION 'Jurisdiction profile versions are consecutive: expected %, got %',
      previous_version + 1, NEW.profile_version
      USING ERRCODE = 'raise_exception';
  END IF;

  -- Readiness takes the highest version already in effect. That is the version in force only if
  -- versions take effect in order; a backdated version would override its predecessor's period.
  IF NEW.effective_from < previous_effective_from THEN
    RAISE EXCEPTION 'A jurisdiction profile version cannot take effect before the previous one (%)',
      previous_effective_from
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.state <> previous_state AND (previous_state, NEW.state) NOT IN (
    ('approved', 'stale'), ('approved', 'suspended'),
    ('stale', 'approved'), ('stale', 'suspended'),
    ('suspended', 'approved')
  ) THEN
    RAISE EXCEPTION 'Jurisdiction profile transition % → % is not allowed', previous_state, NEW.state
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.guard_ledger_input_write()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  row_data JSONB;
  project UUID;
  lock_keys BIGINT[] := '{}';
  lock_key BIGINT;
BEGIN
  FOR row_data IN SELECT value FROM jsonb_array_elements(
    CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
      WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
      ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END
  ) LOOP
    IF TG_ARGV[0]='configuration' THEN
      lock_keys := array_append(lock_keys,hashtextextended('ledger-config', 0));
    ELSE
      project := (row_data ->> 'project_id')::uuid;
      IF TG_TABLE_NAME='projects' THEN
        project := (row_data ->> 'id')::uuid;
      ELSIF TG_TABLE_NAME='claim_conflicts' THEN
        -- Hold the parent against concurrent reparenting while resolving the project.
        SELECT c.project_id INTO project FROM core.claims c
          WHERE c.id=(row_data ->> 'claim_id')::uuid FOR SHARE;
      ELSIF TG_TABLE_NAME='verification_attestations' THEN
        SELECT c.project_id INTO project FROM core.verification_cases c
          WHERE c.id=(row_data ->> 'case_id')::uuid FOR SHARE;
      END IF;
      IF project IS NOT NULL THEN
        lock_keys := array_append(lock_keys,
          hashtextextended('ledger-project:' || project::text,0));
      END IF;
    END IF;
  END LOOP;
  -- Moves cover both scopes in deterministic order. Hash collisions only add contention.
  FOR lock_key IN SELECT DISTINCT key FROM unnest(lock_keys) key ORDER BY key LOOP
    PERFORM pg_advisory_xact_lock(lock_key);
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.guard_project_definition_scope()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF TG_TABLE_NAME='claims' THEN
    IF TG_OP='UPDATE' AND NEW.project_id IS NOT DISTINCT FROM OLD.project_id
      AND NEW.catalog_entry_id IS NOT DISTINCT FROM OLD.catalog_entry_id THEN RETURN NEW; END IF;
    IF EXISTS(SELECT 1 FROM core.claim_types c WHERE c.id=NEW.catalog_entry_id
      AND NOT core.project_definition_applies(c.project_id,NEW.project_id)) THEN
      RAISE EXCEPTION 'Catalog entry belongs to another project';
    END IF;
  ELSE
    IF EXISTS(SELECT 1 FROM core.compliance_policy_sets p WHERE p.id=NEW.policy_set_id
      AND NOT core.project_definition_applies(p.project_id,NEW.project_id)) THEN
      RAISE EXCEPTION 'Policy belongs to another project';
    END IF;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION core.guard_registry_proposal()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'A registry proposal must be proposed as pending. Deciding is a separate step'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'A decided registry proposal cannot be modified. Propose a new version'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (NEW.kind, NEW.item_key, NEW.item_version, NEW.payload, NEW.rationale,
      NEW.effective_from, NEW.proposed_by_subject_id, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.kind, OLD.item_key, OLD.item_version, OLD.payload, OLD.rationale,
      OLD.effective_from, OLD.proposed_by_subject_id, OLD.proposed_at) THEN
    RAISE EXCEPTION 'A registry proposal cannot be modified after it is proposed. Propose a new version'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.guard_registry_publication_draft()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.state <> 'pending' THEN
      RAISE EXCEPTION 'A registry draft must be created as pending. Publishing is a separate step'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'A decided registry draft cannot be modified. Create a new draft'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (NEW.registry_type, NEW.subject_id, NEW.public_key, NEW.projection,
      NEW.source_snapshot_hash, NEW.commercial_reuse, NEW.published_as_commercial_basis,
      NEW.policy_version, NEW.schema_version, NEW.contains_person_level_identifier,
      NEW.lawful_basis, NEW.purpose, NEW.retention, NEW.irreversibility_acknowledged_at,
      NEW.proposed_by_subject_id, NEW.proposed_at)
     IS DISTINCT FROM
     (OLD.registry_type, OLD.subject_id, OLD.public_key, OLD.projection,
      OLD.source_snapshot_hash, OLD.commercial_reuse, OLD.published_as_commercial_basis,
      OLD.policy_version, OLD.schema_version, OLD.contains_person_level_identifier,
      OLD.lawful_basis, OLD.purpose, OLD.retention, OLD.irreversibility_acknowledged_at,
      OLD.proposed_by_subject_id, OLD.proposed_at) THEN
    RAISE EXCEPTION 'A registry draft cannot be modified after it is created. Create a new draft'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.guard_reserved_catalog_key()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF TG_TABLE_NAME = 'registry_proposals' THEN
    IF NEW.kind::text = 'claim_type'
       AND (TG_OP = 'INSERT' OR NEW.state::text = 'approved')
       AND (core.is_reserved_catalog_key(NEW.item_key)
            OR core.is_reserved_catalog_key(NEW.payload->>'claimType')) THEN
      RAISE EXCEPTION 'Claim type key is reserved for the legacy project confirmation matrix';
    END IF;
  ELSIF TG_TABLE_NAME = 'claim_types' THEN
    IF core.is_reserved_catalog_key(NEW.claim_type) THEN
      RAISE EXCEPTION 'Claim type key is reserved for the legacy project confirmation matrix';
    END IF;
  ELSIF NEW.catalog_entry_id IS NOT NULL AND core.is_reserved_catalog_key(NEW.claim_type) THEN
    IF NEW.supersedes_claim_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM core.claims previous
      WHERE previous.id=NEW.supersedes_claim_id
        AND previous.project_id=NEW.project_id AND previous.claim_type=NEW.claim_type
        AND previous.catalog_entry_id=NEW.catalog_entry_id
        AND previous.catalog_version=NEW.catalog_version
        AND previous.superseded_by_claim_id IS NULL
    ) THEN
      RAISE EXCEPTION 'Claim type key is reserved for the legacy project confirmation matrix';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.insert_email_code_session(p_challenge_id uuid, p_subject_id uuid, p_session_id uuid, p_token_hash text, p_ttl_seconds integer)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO core.sessions (
    id, token_hash,subject_id, first_factor, email_challenge_id, expires_at
  ) VALUES (
    p_session_id, p_token_hash,p_subject_id, 'email_code', p_challenge_id,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.insert_email_code_session(uuid, uuid, uuid, text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.insert_oidc_session(p_transaction_id uuid, p_provider core.oidc_provider, p_subject_id uuid, p_session_id uuid, p_token_hash text, p_ttl_seconds integer)
 RETURNS timestamp with time zone
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_expires TIMESTAMPTZ;
BEGIN
  IF p_ttl_seconds IS NULL OR p_ttl_seconds < 1 OR p_ttl_seconds > 28800 THEN
    RAISE EXCEPTION 'session TTL must be between 1 second and 8 hours'
      USING ERRCODE = 'check_violation';
  END IF;
  INSERT INTO core.sessions (
    id, token_hash,subject_id, first_factor, oidc_transaction_id, expires_at
  ) VALUES (
    p_session_id, p_token_hash,p_subject_id,
    p_provider::text::core.session_first_factor, p_transaction_id,
    now() + make_interval(secs => p_ttl_seconds)
  )
  RETURNING expires_at INTO v_expires;
  RETURN v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.insert_oidc_session(uuid, core.oidc_provider, uuid, uuid, text, integer) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.issue_email_challenge(p_id uuid, p_purpose core.email_challenge_purpose, p_email text, p_subject_id uuid, p_invitation_id uuid, p_email_change_id uuid, p_code_hmac bytea, p_template text, p_recipient text, p_code text)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_now TIMESTAMPTZ := now();
  v_owner_email TEXT;
  v_owner_code TEXT;
BEGIN
  IF p_code !~ '^[0-9]{8}$' THEN
    RAISE EXCEPTION 'a code is 8 digits' USING ERRCODE = 'check_violation';
  END IF;
  PERFORM core.supersede_email_challenge(p_purpose, p_email);
  IF p_purpose = 'email_change' AND p_subject_id IS NOT NULL AND p_email_change_id IS NOT NULL THEN
    SELECT s.email INTO STRICT v_owner_email FROM core.subjects s
    WHERE s.id = p_subject_id;
    v_owner_code := gen_random_uuid()::text;
  END IF;
  INSERT INTO core.email_challenges (
    id, purpose, email,subject_id, invitation_id, email_change_id, code_hmac,
    created_at, expires_at, owner_proof_digest
  ) VALUES (
    p_id, p_purpose, p_email,p_subject_id, p_invitation_id, p_email_change_id,
    p_code_hmac, v_now, v_now + interval '10 minutes',
    sha256(convert_to(v_owner_email || ':' || v_owner_code, 'UTF8'))
  );
  INSERT INTO core.email_outbox (
    id, template, recipient, params, state, settled_at, expires_at, challenge_id, invitation_id
  ) VALUES (
    gen_random_uuid(), p_template, p_recipient,
    CASE WHEN p_recipient IS NULL THEN NULL
         ELSE jsonb_build_object('code', p_code, 'expiresMinutes', 10) END,
    CASE WHEN p_recipient IS NULL THEN 'suppressed' ELSE 'pending' END,
    CASE WHEN p_recipient IS NULL THEN v_now ELSE NULL END,
    v_now + interval '10 minutes', p_id, p_invitation_id
  );
  IF v_owner_code IS NOT NULL THEN
    INSERT INTO core.email_outbox(id, template, recipient, params, state, expires_at, challenge_id)
    VALUES (gen_random_uuid(), 'email_change_owner', v_owner_email,
      jsonb_build_object('code', v_owner_code, 'destination', p_email), 'pending', v_now + interval '10 minutes', p_id);
  END IF;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.issue_email_challenge(uuid, core.email_challenge_purpose, text, uuid, uuid, uuid, bytea, text, text, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.link_google_workspace_account(p_transaction uuid, p_issuer text, p_subject_key text, p_email text, p_email_hash text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  flow core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction, 'sign_in');
  person core.subjects;
  linked_id UUID;
BEGIN
  IF flow.provider <> 'google' OR p_issuer <> 'https://accounts.google.com' OR p_email IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM core.external_identities
    WHERE provider = 'google' AND issuer = p_issuer AND subject_key = p_subject_key
  ) THEN RETURN NULL; END IF;

  SELECT * INTO person FROM core.subjects
  WHERE email = core.normalize_email(p_email) AND kind = 'person' AND suspended_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM core.lock_external_identity(flow.provider, p_issuer, p_subject_key);

  IF EXISTS (
    SELECT 1 FROM core.external_identities
    WHERE provider = 'google'
      AND (subject_id = person.id OR (issuer = p_issuer AND subject_key = p_subject_key))
  ) THEN RETURN NULL; END IF;

  INSERT INTO core.external_identities (
    id,subject_id, provider, issuer, subject_key, email_hash, linked_via, requires_mfa
  ) VALUES (
    gen_random_uuid(),person.id, 'google', p_issuer, p_subject_key, p_email_hash, 'link', true
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO linked_id;
  RETURN linked_id;
END
$function$;

CREATE OR REPLACE FUNCTION core.list_own_sessions(p_session_id uuid)
 RETURNS TABLE(session_id uuid, first_factor core.session_first_factor, second_factor core.session_second_factor, issued_at timestamp with time zone, last_seen_at timestamp with time zone, expires_at timestamp with time zone, is_current boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_subject UUID;
BEGIN
  SELECT s.subject_id INTO v_subject FROM core.sessions s
  WHERE s.id = p_session_id AND s.subject_id = core.current_actor()
    AND s.revoked_at IS NULL
    AND s.expires_at > now();
  IF v_subject IS NULL THEN
    RAISE EXCEPTION 'MFA_SESSION_INVALID: no live session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN QUERY
  SELECT s.id, s.first_factor, s.second_factor, s.issued_at, s.last_seen_at, s.expires_at,
         s.id = p_session_id
  FROM core.sessions s
  WHERE s.subject_id = v_subject
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND COALESCE(s.last_seen_at, s.issued_at) > now() - interval '30 minutes'
    AND s.first_factor <> 'siwe_legacy'
    AND NOT EXISTS (
      SELECT 1
      FROM core.session_factor_proofs p
      LEFT JOIN core.webauthn_credentials c ON c.id = p.webauthn_credential_id
      LEFT JOIN core.totp_authenticators t ON t.id = p.totp_authenticator_id
      WHERE p.id = s.second_factor_proof_id
        AND (c.revoked_at IS NOT NULL OR t.revoked_at IS NOT NULL)
    )
  ORDER BY s.issued_at DESC, s.id;
END
$function$;

CREATE OR REPLACE FUNCTION core.lock_ledger_publication_inputs(p_project uuid)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
BEGIN
  -- Invoker rights preserve RLS; reject missing/foreign projects before taking any lock.
  IF core.current_actor() IS NULL OR NOT EXISTS (
    SELECT 1 FROM core.projects WHERE id=p_project
  ) THEN
    RAISE EXCEPTION 'Project is not accessible' USING ERRCODE='42501';
  END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ledger-config', 0))
     OR NOT pg_try_advisory_xact_lock(hashtextextended('ledger-project:' || p_project::text, 0)) THEN
    RAISE EXCEPTION 'Evidence is being updated' USING ERRCODE='55P03';
  END IF;
  -- Also detect a lifecycle writer that has locked the project but has not reached its trigger.
  PERFORM 1 FROM core.projects WHERE id=p_project FOR UPDATE NOWAIT;
END
$function$;

CREATE OR REPLACE FUNCTION core.match_google_workspace_invitation(p_transaction uuid, p_issuer text, p_subject_key text, p_verified_email text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
DECLARE
  flow core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction, 'sign_in');
  invitation core.invitations;
BEGIN
  IF flow.provider <> 'google' OR p_issuer <> 'https://accounts.google.com'
     OR p_verified_email IS NULL THEN RETURN NULL; END IF;

  -- Even a previously revoked link must never be resurrected by an email match.
  IF EXISTS (SELECT 1 FROM core.external_identities WHERE provider = 'google'
             AND issuer = p_issuer AND subject_key = p_subject_key) THEN RETURN NULL; END IF;
  SELECT * INTO invitation FROM core.invitations
    WHERE email = core.normalize_email(p_verified_email) AND state = 'pending' AND expires_at > now();
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE core.oidc_login_transactions SET purpose = 'invitation_accept',
    invitation_id = invitation.id,
    display_name = 'Registry member' WHERE id = flow.id;
  RETURN invitation.id;
END
$function$;

CREATE OR REPLACE FUNCTION core.mfa_consume_challenge(v core.sessions, p_purpose core.webauthn_challenge_purpose, p_challenge text)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_id UUID;
BEGIN
  UPDATE core.webauthn_challenges
  SET consumed_at = now(), consumed_by_session_id = v.id
  WHERE session_id = v.id AND purpose = p_purpose
    AND challenge = p_challenge AND consumed_at IS NULL AND expires_at > now()
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'MFA_CHALLENGE_INVALID: no live % challenge of this session matches', p_purpose
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_id;
END
$function$;

CREATE OR REPLACE FUNCTION core.mfa_enrolment_verdict(v core.sessions, p_kind text)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_passkey BOOLEAN := core.mfa_has_passkey(v.subject_id);
  v_totp BOOLEAN := core.mfa_has_totp(v.subject_id);
BEGIN
  IF p_kind NOT IN ('passkey', 'totp') THEN
    RAISE EXCEPTION 'unknown factor kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- Re-enrolment is what a recovery code is for; the code already revoked every other session.
  IF v.recovery_limited THEN
    RETURN 'allowed';
  END IF;
  IF v.second_factor IS NULL THEN
    -- Without this, anyone holding the first factor (a mailbox, an identity provider account)
    -- could add their own authenticator to an account that already has one.
    IF v_passkey OR v_totp THEN
      RETURN 'MFA_STEP_UP_REQUIRED';
    END IF;
    IF core.mfa_creation_window_open(v.subject_id) OR core.mfa_reset_window_open(v.subject_id) THEN
      RETURN 'allowed';
    END IF;
    -- A first-time Google invitee may defer setup until their first privileged task.
    -- Tie the exception to this session's original live invitation identity. Never
    -- reopen setup for someone who enrolled, recovered, changed address or was suspended.
    IF v.first_factor = 'google' AND EXISTS (
      SELECT 1 FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = v.oidc_transaction_id AND i.subject_id = v.subject_id AND i.provider = 'google'
        AND i.linked_via = 'invitation' AND i.revoked_at IS NULL
    ) AND NOT EXISTS (SELECT 1 FROM core.webauthn_credentials WHERE subject_id = v.subject_id)
      AND NOT EXISTS (SELECT 1 FROM core.totp_authenticators WHERE subject_id = v.subject_id AND confirmed_at IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM core.recovery_codes WHERE subject_id = v.subject_id)
      AND NOT EXISTS (SELECT 1 FROM core.mfa_reset_requests WHERE subject_id = v.subject_id)
      AND NOT EXISTS (SELECT 1 FROM core.email_change_requests WHERE subject_id = v.subject_id AND state = 'completed')
      AND NOT EXISTS (SELECT 1 FROM core.subject_suspensions WHERE subject_id = v.subject_id AND action = 'suspend' AND state = 'approved')
    THEN RETURN 'allowed'; END IF;
    RETURN 'MFA_ENROLMENT_WINDOW_CLOSED';
  END IF;
  IF p_kind = 'passkey' AND v_passkey AND v.second_factor <> 'passkey' THEN
    RETURN 'MFA_PASSKEY_REQUIRED';
  END IF;
  IF p_kind = 'totp' AND v_totp THEN
    RETURN 'MFA_TOTP_ALREADY_ENROLLED';
  END IF;
  RETURN 'allowed';
END
$function$;

CREATE OR REPLACE FUNCTION core.mfa_lock_session(p_session_id uuid)
 RETURNS core.sessions
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions;
  v_subject UUID;
BEGIN
  -- The caller acts as the session's own subject (`app.actor_subject_id`); a session id of
  -- anyone else is no live session.
  SELECT subject_id INTO v_subject FROM core.sessions
  WHERE id = p_session_id
    AND subject_id = core.current_actor()
    AND revoked_at IS NULL
    AND expires_at > now();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_SESSION_INVALID: no live session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM 1 FROM core.subjects WHERE id = v_subject FOR UPDATE;
  SELECT * INTO v FROM core.sessions
  WHERE id = p_session_id
    AND revoked_at IS NULL
    AND expires_at > now()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_SESSION_INVALID: no live session'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A wallet signature carries no second factor (0108 `sessions_legacy_single_factor`); legacy
  -- sessions go when wallet sign-in is removed and do not enrol.
  IF v.first_factor = 'siwe_legacy' THEN
    RAISE EXCEPTION 'MFA_LEGACY_SESSION: a wallet session has no second factor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v;
END
$function$;

CREATE OR REPLACE FUNCTION core.mfa_raise_session(v core.sessions, p_factor core.session_second_factor, p_challenge uuid, p_credential uuid, p_totp uuid, p_step bigint, p_recovery_code uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_proof UUID := gen_random_uuid();
BEGIN
  INSERT INTO core.session_factor_proofs (
    id,subject_id, session_id, factor, webauthn_challenge_id, webauthn_credential_id,
    totp_authenticator_id, totp_step, recovery_code_id
  ) VALUES (
    v_proof,v.subject_id, v.id, p_factor, p_challenge, p_credential, p_totp, p_step,
    p_recovery_code
  );
  UPDATE core.sessions
  SET second_factor = p_factor,
      second_factor_at = now(),
      second_factor_proof_id = v_proof,
      -- A recovery code limits the session; any real factor proved afterwards lifts the limit.
      recovery_limited = (p_factor = 'recovery_code')
  WHERE id = v.id;
  -- Journey 5 (plan, clarified 2026-11-02): a recovering session that proves a real factor has
  -- finished the recovery, and then every session of the subject ends — this one too. The person
  -- signs in again with the new factor, so nothing the recovery code opened outlives it.
  IF v.recovery_limited AND p_factor <> 'recovery_code' THEN
    PERFORM core.mfa_revoke_other_sessions(v, NULL, 'recovery_completed');
    RETURN true;
  END IF;
  RETURN false;
END
$function$;

CREATE OR REPLACE FUNCTION core.mfa_reset_separation_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_suspended TIMESTAMPTZ;
BEGIN
  SELECT suspended_at INTO v_suspended FROM core.subjects
  WHERE id = NEW.subject_id FOR UPDATE;
  -- 0132 (F5): a person that cannot be read refuses (the separation below would read nothing too).
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_RESET_SUBJECT_UNREADABLE: subject % cannot be read', NEW.subject_id
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF v_suspended IS NOT NULL THEN
    RAISE EXCEPTION 'MFA_RESET_SUBJECT_SUSPENDED: the person is suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.origin <> 'admin' THEN
    RETURN NEW;
  END IF;
  IF core.recovery_separation_conflict(NEW.subject_id, NEW.requested_by_subject_id, 'mfa_reset') THEN
    RAISE EXCEPTION 'MFA_RESET_SEPARATION_REQUIRED: the proposer took part in a recent email change or suspension of this person'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.mfa_revoke_other_sessions(v core.sessions, p_keep uuid, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = p_reason
  WHERE subject_id = v.subject_id AND revoked_at IS NULL
    AND id IS DISTINCT FROM p_keep;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;

CREATE OR REPLACE FUNCTION core.mfa_store_recovery_codes(v core.sessions, p_hashes text[], p_only_if_none boolean)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_set UUID := gen_random_uuid();
BEGIN
  IF p_only_if_none AND EXISTS (
    SELECT 1 FROM core.recovery_codes
    WHERE subject_id = v.subject_id AND consumed_at IS NULL AND voided_at IS NULL
  ) THEN
    RETURN false;
  END IF;
  IF p_hashes IS NULL
     OR cardinality(p_hashes) <> 10
     OR (SELECT count(DISTINCT h) FROM unnest(p_hashes) AS h) <> 10 THEN
    RAISE EXCEPTION 'a recovery code set is exactly ten distinct codes' USING ERRCODE = 'check_violation';
  END IF;
  UPDATE core.recovery_codes SET voided_at = now()
  WHERE subject_id = v.subject_id AND consumed_at IS NULL AND voided_at IS NULL;
  INSERT INTO core.recovery_codes (id,subject_id, set_id, code_hash)
  SELECT gen_random_uuid(),v.subject_id, v_set, h FROM unnest(p_hashes) AS h;
  RETURN true;
END
$function$;

CREATE OR REPLACE FUNCTION core.notify_document_impacts()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO core.notifications (kind, audience_role, project_id, summary, link)
  SELECT 'document_impact', 'reviewer', i.project_id,
         format('%s document(s) need a second look: a document they rest on was %s',
                count(*),
                CASE i.cause::text WHEN 'superseded' THEN 'replaced by a new version'
                                   WHEN 'revoked' THEN 'revoked'
                                   ELSE 'past its validity date' END),
         '/w/projects/' || i.project_id || '/impacts'
  FROM inserted i
  GROUP BY i.project_id, i.origin_upload_id, i.cause;
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.notify_evidence_stale()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.target_type = 'project_lifecycle' THEN
    INSERT INTO core.notifications (kind, audience_role, project_id, summary, link)
    VALUES ('evidence_stale', 'reviewer', NEW.project_id,
      'Suspension to consider: ' || NEW.reason,
      '/w/projects/' || NEW.project_id
    );
    RETURN NEW;
  END IF;

  INSERT INTO core.notifications (kind, audience_role, project_id, summary, link)
  VALUES ('evidence_stale', 'reviewer', NEW.project_id,
    'Evidence became stale: ' || NEW.reason,
    '/w/work'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.notify_readiness_gap()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.status <> 'gap' THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.notifications (kind, audience_role, project_id, summary, link)
  VALUES ('readiness_gap', 'reviewer', NEW.project_id,
    'Readiness assessment found a gap',
    '/w/projects/' || NEW.project_id || '/readiness'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.notify_registry_revoked()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_key TEXT;
  target_project UUID;
BEGIN
  IF NEW.status <> 'revoked' OR OLD.status = 'revoked' THEN
    RETURN NEW;
  END IF;

  SELECT e.public_key, p.id INTO target_key, target_project
  FROM core.registry_entries e
  LEFT JOIN core.projects p ON p.id = e.subject_id
  WHERE e.id = NEW.entry_id;

  INSERT INTO core.notifications (kind, audience_role, project_id, summary, link)
  VALUES ('registry_revoked', 'administrator', target_project,
    'Public record revoked: ' || coalesce(target_key, '(no key)'),
    '/w/registries'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.notify_review_assigned()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_project UUID;
BEGIN
  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  INSERT INTO core.notifications (kind, subject_id, project_id, summary, link)
  VALUES ('review_assigned', NEW.subject_id, target_project,
    'Review assigned',
    '/w/projects/' || target_project || '/verification'
  );
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION core.open_bootstrap_enrolment_window(p_subject_id uuid)
 RETURNS TABLE(opened boolean, reset_id uuid, window_until timestamp with time zone)
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_subject core.subjects;
  v_id UUID;
  v_until TIMESTAMPTZ;
BEGIN
  SELECT * INTO v_subject FROM core.subjects WHERE id = p_subject_id AND kind = 'person' FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no such person %', p_subject_id USING ERRCODE = 'no_data_found';
  END IF;

  IF core.mfa_has_passkey(p_subject_id) OR core.mfa_has_totp(p_subject_id) THEN
    RETURN QUERY SELECT false, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;
  IF core.mfa_creation_window_open(p_subject_id) THEN
    RETURN QUERY SELECT false, NULL::UUID, v_subject.created_at + interval '24 hours';
    RETURN;
  END IF;
  -- 0133 (L1): the reset branch of `core.mfa_reset_window_open` — not closed (0132, F2), and
  -- decided after the person's last suspension or completed address change (0128).
  SELECT r.id, r.enrolment_window_until INTO v_id, v_until
  FROM core.mfa_reset_requests r,
    LATERAL (
      SELECT GREATEST(
        (SELECT max(s.decided_at) FROM core.subject_suspensions s
         WHERE s.subject_id = p_subject_id AND s.action = 'suspend' AND s.state = 'approved'),
        (SELECT max(c.completed_at) FROM core.email_change_requests c
         WHERE c.subject_id = p_subject_id AND c.state = 'completed')
      ) AS at
    ) b
  WHERE r.subject_id = p_subject_id AND r.state = 'approved' AND r.enrolment_window_until > now()
    AND r.closed_reason IS NULL
    AND (b.at IS NULL OR r.decided_at > b.at)
  ORDER BY r.enrolment_window_until DESC LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT false, v_id, v_until;
    RETURN;
  END IF;

  v_id := gen_random_uuid();
  INSERT INTO core.mfa_reset_requests (
    id,subject_id, reason, requested_by_subject_id, state, decided_at,
    enrolment_window_until, origin
  ) VALUES (
    v_id,p_subject_id,
    'Bootstrap re-run: no second factor enrolled', NULL, 'approved', now(),
    now() + interval '24 hours', 'bootstrap'
  );
  RETURN QUERY SELECT true, v_id, now() + interval '24 hours';
END
$function$;

CREATE OR REPLACE FUNCTION core.outbox_on_anchor_reorg()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'core', 'chain', 'pg_temp'
AS $function$
DECLARE
  v_batch UUID;
  v_version INTEGER;
BEGIN
  SELECT t.batch_id, t.version INTO v_batch, v_version
  FROM chain.transactions t WHERE t.id = NEW.transaction_id;

  PERFORM core.outbox_emit('anchor.reorged', COALESCE(v_batch, NEW.transaction_id),
    COALESCE(v_version, 1), NULL,
    jsonb_build_object(
      'transactionId', NEW.transaction_id,
      'batchRowId', v_batch,
      'previousBlockNumber', NEW.previous_block_number,
      'previousBlockHash', NEW.previous_block_hash,
      'detectedState', NEW.detected_state
    )
  );
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.outbox_on_anchor_transaction_state()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'core', 'chain', 'pg_temp'
AS $function$
DECLARE
  v_event TEXT;
BEGIN
  IF NEW.state = 'confirmed' THEN
    v_event := 'anchor.confirmed';
  ELSIF NEW.state IN ('failed', 'reverted', 'dropped') THEN
    v_event := 'anchor.failed';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM core.outbox_emit(v_event, COALESCE(NEW.batch_id, NEW.id), NEW.version, NULL,
    jsonb_build_object(
      'transactionId', NEW.id,
      'batchRowId', NEW.batch_id,
      'chainId', NEW.chain_id,
      'txHash', NEW.tx_hash,
      'blockNumber', NEW.block_number,
      'fromState', OLD.state,
      'toState', NEW.state
    )
  );
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.outbox_on_credential_status()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_event TEXT;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.current_status <> 'valid' THEN
      RETURN NULL;
    END IF;
    v_event := 'credential.verified';
  ELSIF NEW.current_status = 'expired' THEN
    v_event := 'credential.expired';
  ELSIF NEW.current_status = 'revoked' THEN
    v_event := 'credential.revoked';
  ELSE
    RETURN NULL;
  END IF;

  PERFORM core.outbox_emit(v_event, NEW.id, NEW.version, NULL,
    jsonb_build_object(
      'credentialId', NEW.id,
      'subjectId', NEW.subject_id,
      'credentialType', NEW.credential_type,
      'fromStatus', CASE WHEN TG_OP = 'UPDATE' THEN OLD.current_status END,
      'toStatus', NEW.current_status
    )
  );
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.outbox_on_evidence_version()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_version INTEGER := 1
    + (CASE WHEN NEW.superseded_by IS NOT NULL THEN 1 ELSE 0 END)
    + (CASE WHEN NEW.revoked_at IS NOT NULL THEN 1 ELSE 0 END);
BEGIN
  IF OLD.superseded_by IS NULL AND NEW.superseded_by IS NOT NULL THEN
    PERFORM core.outbox_emit('evidence.version.superseded', NEW.id, v_version, NEW.project_id,
      jsonb_build_object(
        'artifactId', NEW.id,
        'kind', NEW.kind,
        'supersededBy', NEW.superseded_by
      )
    );
  END IF;

  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL THEN
    PERFORM core.outbox_emit('evidence.version.revoked', NEW.id, v_version, NEW.project_id,
      jsonb_build_object(
        'artifactId', NEW.id,
        'kind', NEW.kind,
        'revokedAt', NEW.revoked_at
      )
    );
  END IF;

  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.outbox_on_governance_proposal_created()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
BEGIN
  PERFORM core.outbox_emit('governance.proposal.created', NEW.id, NEW.version, NEW.project_id,
    jsonb_build_object(
      'proposalId', NEW.id,
      'space', NEW.space,
      'proposalType', NEW.proposal_type,
      'state', NEW.state
    )
  );
  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.outbox_on_governance_transition()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_project UUID;
  v_version INTEGER;
BEGIN
  SELECT p.project_id, p.version INTO v_project, v_version
  FROM core.governance_proposals p
  WHERE p.id = NEW.proposal_id;

  IF NEW.to_state IN ('succeeded', 'defeated', 'no_quorum') THEN
    PERFORM core.outbox_emit('governance.proposal.finalized', NEW.proposal_id,
      COALESCE(v_version, 1), v_project,
      jsonb_build_object(
        'proposalId', NEW.proposal_id,
        'transitionId', NEW.id,
        'result', NEW.to_state
      )
    );
  END IF;

  IF NEW.to_state = 'execution_pending' OR NEW.from_state = 'execution_pending' THEN
    PERFORM core.outbox_emit('execution.status.changed', NEW.proposal_id,
      COALESCE(v_version, 1), v_project,
      jsonb_build_object(
        'proposalId', NEW.proposal_id,
        'transitionId', NEW.id,
        'fromState', NEW.from_state,
        'toState', NEW.to_state
      )
    );
  END IF;

  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.propagate_attestation_to_signals()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_project UUID;
BEGIN
  IF NEW.state <> 'stale_candidate' OR OLD.state = 'stale_candidate' THEN
    RETURN NEW;
  END IF;

  SELECT c.project_id INTO target_project
  FROM core.verification_cases c WHERE c.id = NEW.case_id;

  IF target_project IS NULL THEN
    RETURN NEW;
  END IF;

  -- Signal only the latest assessment. Past assessments are judgments of their time and
  -- are not up for review now.
  INSERT INTO core.evidence_stale_signals (
    id,project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(),target_project,
         'compliance_assessment', a.id, NEW.id,
         coalesce(NEW.stale_reason, 'Underlying attestation needs re-review')
  FROM core.compliance_assessments a
  WHERE a.project_id = target_project
  ORDER BY a.generated_at DESC
  LIMIT 1
  ON CONFLICT DO NOTHING;

  -- Published Registry versions of the project and of this attestation. **Never taken down
  -- automatically** — leave a signal only.
  INSERT INTO core.evidence_stale_signals (
    id,project_id, target_type, target_id,
    origin_attestation_id, reason
  )
  SELECT gen_random_uuid(),target_project,
         'registry_entry_version', v.id, NEW.id,
         coalesce(NEW.stale_reason, 'Underlying attestation needs re-review')
  FROM core.registry_entry_versions v
  JOIN core.registry_entries e ON e.id = v.entry_id
  WHERE (
      (e.registry_type = 'project' AND e.subject_id = target_project)
      OR (e.registry_type = 'verification' AND e.subject_id = NEW.id)
    )
    AND v.status = 'published'
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.propagate_claim_to_attestations()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.stale_since IS NULL OR OLD.stale_since IS NOT NULL THEN
    RETURN NEW;
  END IF;

  UPDATE core.verification_attestations a
  SET state = 'stale_candidate',
      stale_reason = format('Underlying claim became stale: %s', NEW.stale_reason)
  WHERE a.state = 'active'
    AND NEW.id = ANY (a.claim_scope);

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.propagate_policy_to_assessments()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;
  IF NEW.state NOT IN ('superseded', 'retired', 'effective') THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.evidence_stale_signals (
    id,project_id, target_type, target_id, origin_policy_set_id, reason
  )
  SELECT gen_random_uuid(),latest.project_id, 'compliance_assessment',
         latest.id, latest.policy_set_id,
         CASE WHEN NEW.state = 'effective' THEN
           format('Assessed under policy %s version %s; version %s is now effective',
                  NEW.rule_set_id, used.rule_set_version, NEW.rule_set_version)
         ELSE
           format('Assessed under policy %s version %s, which was %s',
                  NEW.rule_set_id, used.rule_set_version, NEW.state)
         END
  FROM (
    SELECT DISTINCT ON (a.project_id, a.gate_id)
           a.id, a.project_id, a.policy_set_id
    FROM core.compliance_assessments a
    WHERE TRUE
    ORDER BY a.project_id, a.gate_id, a.generated_at DESC, a.id
  ) latest
  JOIN core.compliance_policy_sets used ON used.id = latest.policy_set_id
  WHERE used.rule_set_id = NEW.rule_set_id
    AND CASE WHEN NEW.state = 'effective' THEN used.id <> NEW.id ELSE used.id = NEW.id END
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.propagate_schema_to_attestations()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.state IS NOT DISTINCT FROM OLD.state THEN
    RETURN NEW;
  END IF;

  IF NEW.state IN ('superseded', 'retired') THEN
    UPDATE core.verification_attestations a
    SET state = 'stale_candidate',
        stale_reason = format('Attestation schema %s version %s was %s',
                              NEW.schema_key, NEW.schema_version, NEW.state)
    WHERE a.schema_id = NEW.id
      AND a.state = 'active';
  ELSIF NEW.state = 'active' THEN
    UPDATE core.verification_attestations a
    SET state = 'stale_candidate',
        stale_reason = format('Attestation schema %s has a new active version %s (attested under %s)',
                              NEW.schema_key, NEW.schema_version, old_schema.schema_version)
    FROM core.attestation_schemas old_schema
    WHERE old_schema.schema_key = NEW.schema_key
      AND old_schema.id <> NEW.id
      AND a.schema_id = old_schema.id
      AND a.state = 'active';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.propose_project_suspension()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_project UUID;
  target_state core.at_lifecycle_state;
BEGIN
  IF NEW.state <> 'stale_candidate' OR OLD.state = 'stale_candidate' THEN
    RETURN NEW;
  END IF;

  SELECT p.id, p.lifecycle_state INTO target_project, target_state
  FROM core.verification_cases c
  JOIN core.projects p ON p.id = c.project_id
  WHERE c.id = NEW.case_id;

  IF target_project IS NULL
     OR target_state NOT IN ('registered', 'offering_open', 'offering_closed', 'active',
                             'branch_vote', 'continuing', 'divested', 'closure')
  THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.evidence_stale_signals (
    id,project_id, target_type, target_id, origin_attestation_id, reason
  )
  SELECT gen_random_uuid(),target_project, 'project_lifecycle', target_project,
         NEW.id,
         format('Evidence behind this %s project was shaken; consider suspending it. '
                'Nothing is suspended automatically. Cause: %s',
                target_state, coalesce(NEW.stale_reason, 'attestation needs re-review'))
  WHERE NOT EXISTS (
    SELECT 1 FROM core.evidence_stale_signals s
    WHERE s.target_type = 'project_lifecycle'
      AND s.target_id = target_project
      AND s.resolution = 'open'
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_break_glass_elevation()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.target IS DISTINCT FROM OLD.target
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'break_glass_elevations: purpose, target and expiry cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF (OLD.decided_at IS NOT NULL AND (
        NEW.decided_at IS DISTINCT FROM OLD.decided_at
        OR NEW.decided_by_subject_id IS DISTINCT FROM OLD.decided_by_subject_id
        OR NEW.decision_reason IS DISTINCT FROM OLD.decision_reason))
     OR (OLD.incident_recorded_at IS NOT NULL AND (
        NEW.incident_recorded_at IS DISTINCT FROM OLD.incident_recorded_at
        OR NEW.incident_reference IS DISTINCT FROM OLD.incident_reference
        OR NEW.incident_summary IS DISTINCT FROM OLD.incident_summary))
     OR (OLD.released_at IS NOT NULL AND (
        NEW.released_at IS DISTINCT FROM OLD.released_at
        OR NEW.release_cause IS DISTINCT FROM OLD.release_cause
        OR NEW.release_recovery_verification IS DISTINCT FROM OLD.release_recovery_verification)) THEN
    RAISE EXCEPTION 'break_glass_elevations: a recorded decision, incident or release cannot be rewritten'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF OLD.state IN ('rejected', 'released') AND NEW.state IS DISTINCT FROM OLD.state THEN
    RAISE EXCEPTION 'break_glass_elevations: a closed elevation cannot be reopened'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_claim_content()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.project_id        IS DISTINCT FROM OLD.project_id
     OR NEW.claim_type        IS DISTINCT FROM OLD.claim_type
     OR NEW.value_text        IS DISTINCT FROM OLD.value_text
     OR NEW.unit              IS DISTINCT FROM OLD.unit
     OR NEW.as_of             IS DISTINCT FROM OLD.as_of
     OR NEW.source_coordinate IS DISTINCT FROM OLD.source_coordinate
     OR NEW.source_receipt_id IS DISTINCT FROM OLD.source_receipt_id
     OR NEW.submitted_by      IS DISTINCT FROM OLD.submitted_by
     OR NEW.supersedes_claim_id IS DISTINCT FROM OLD.supersedes_claim_id
     OR NEW.correction_reason IS DISTINCT FROM OLD.correction_reason
     OR NEW.created_at        IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION
      'A claim''s content cannot be modified. Correct it with a new claim version that supersedes it'
      USING ERRCODE = 'raise_exception';
  END IF;

  -- The successor link is written once. Re-pointing it would rewrite which version replaced this one.
  IF OLD.superseded_by_claim_id IS NOT NULL
     AND NEW.superseded_by_claim_id IS DISTINCT FROM OLD.superseded_by_claim_id
  THEN
    RAISE EXCEPTION 'A claim''s successor cannot be changed once recorded'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_document_impact()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.resolution <> 'open' THEN
    RAISE EXCEPTION 'A closed document impact cannot be changed (current: %)', OLD.resolution;
  END IF;

  IF (NEW.project_id, NEW.upload_id, NEW.origin_upload_id,
      NEW.successor_upload_id, NEW.cause, NEW.depth, NEW.via_upload_id, NEW.via_kind,
      NEW.detected_at)
     IS DISTINCT FROM
     (OLD.project_id, OLD.upload_id, OLD.origin_upload_id,
      OLD.successor_upload_id, OLD.cause, OLD.depth, OLD.via_upload_id, OLD.via_kind,
      OLD.detected_at)
  THEN
    RAISE EXCEPTION 'The cause and time of a document impact cannot be changed';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_document_link()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.removed_at IS NOT NULL THEN
    RAISE EXCEPTION 'A removed document link cannot be changed. Create a new link instead';
  END IF;

  IF (NEW.project_id, NEW.upstream_upload_id, NEW.downstream_upload_id,
      NEW.kind, NEW.origin, NEW.rule_id, NEW.carried_from_link_id, NEW.note,
      NEW.created_by, NEW.created_at)
     IS DISTINCT FROM
     (OLD.project_id, OLD.upstream_upload_id, OLD.downstream_upload_id,
      OLD.kind, OLD.origin, OLD.rule_id, OLD.carried_from_link_id, OLD.note,
      OLD.created_by, OLD.created_at)
  THEN
    RAISE EXCEPTION 'A document link can only be removed, not edited';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_document_requirement()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'A document requirement cannot be deleted. Retire it with a reason';
  END IF;

  IF OLD.retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'A retired document requirement cannot be changed';
  END IF;

  IF NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.document_type IS DISTINCT FROM OLD.document_type
     OR NEW.tier IS DISTINCT FROM OLD.tier
     OR NEW.note IS DISTINCT FROM OLD.note
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'A document requirement is changed by retiring it and declaring a new one';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_role_binding()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'role_bindings: a revoked binding cannot be changed. Grant again through a new proposal'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.subject_id IS DISTINCT FROM OLD.subject_id
     OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
     OR NEW.role IS DISTINCT FROM OLD.role
     OR NEW.granted_at IS DISTINCT FROM OLD.granted_at THEN
    RAISE EXCEPTION 'role_bindings: who holds which role cannot be rewritten. Revoke and grant instead'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_role_revocation_request()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.state <> 'pending' THEN
    RAISE EXCEPTION 'role_revocation_requests: a decided proposal cannot be changed'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.role_binding_id IS DISTINCT FROM OLD.role_binding_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.requested_by_subject_id IS DISTINCT FROM OLD.requested_by_subject_id
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
    RAISE EXCEPTION 'role_revocation_requests: what was proposed cannot be changed'
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.protect_upload_identity()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.object_key IS DISTINCT FROM OLD.object_key
     OR NEW.byte_size  IS DISTINCT FROM OLD.byte_size
     OR NEW.project_id IS DISTINCT FROM OLD.project_id
  THEN
    RAISE EXCEPTION 'The identity of an uploaded object cannot be modified. Upload a new object instead'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.record_connection_transition()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  reason TEXT := NULLIF(current_setting('app.connection_transition_reason', true), '');
  actor  UUID := NULLIF(current_setting('app.actor_subject_id', true), '')::UUID;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.state = NEW.state THEN
    RETURN NEW;
  END IF;

  INSERT INTO core.source_connection_transitions (connection_id, from_state, to_state, actor_subject_id, reason
  ) VALUES (NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END,
    NEW.state, actor,
    COALESCE(reason, 'Changed outside an API request (for example, authority approval withdrawn)')
  );

  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.record_document_impacts(p_origin uuid, p_cause core.document_impact_cause, p_successor uuid)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  origin_row core.object_uploads%ROWTYPE;
  inserted INTEGER := 0;
  step INTEGER;
BEGIN
  SELECT * INTO origin_row FROM core.object_uploads WHERE id = p_origin;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  -- One INSERT for the whole change. The notification trigger runs once per statement; two
  -- statements (the expired document, then what rests on it) would notify twice for one change.
  INSERT INTO core.document_impacts (project_id, upload_id, origin_upload_id, successor_upload_id,
    cause, depth, via_upload_id, via_kind, origin_valid_until
  )
  SELECT origin_row.project_id, candidate.upload_id, p_origin, p_successor,
         p_cause, candidate.depth, candidate.via_upload_id, candidate.via_kind,
         CASE WHEN p_cause = 'expired' THEN origin_row.valid_until END
  FROM (
    -- An expired document needs a second look itself. A replaced or revoked one does not: a new
    -- version is the answer.
    SELECT p_origin AS upload_id, 0 AS depth, NULL::UUID AS via_upload_id,
           NULL::core.document_link_kind AS via_kind
    WHERE p_cause = 'expired'
    UNION ALL
    SELECT t.upload_id, t.depth, t.via_upload_id, t.via_kind
    FROM core.document_impact_targets(p_origin) t
    JOIN core.object_uploads target ON target.id = t.upload_id
    WHERE target.state NOT IN ('scanned_infected', 'rejected')
      AND target.revoked_at IS NULL
  ) candidate
  ON CONFLICT (upload_id, origin_upload_id, cause, origin_valid_until) DO NOTHING;
  GET DIAGNOSTICS step = ROW_COUNT;
  inserted := inserted + step;

  -- The first stale time is the record; rows already marked keep theirs.
  UPDATE core.claims c
  SET stale_since = now(),
      stale_reason = CASE p_cause::text
        WHEN 'superseded' THEN
          format('Evidence document was replaced by a new version (upload %s)', p_successor)
        WHEN 'revoked' THEN
          format('Evidence document was revoked (upload %s)', p_origin)
        ELSE
          format('Evidence document passed its validity date %s (upload %s)',
                 origin_row.valid_until, p_origin)
      END
  FROM core.source_receipts r
  WHERE c.source_receipt_id = r.id
    AND r.channel_evidence ->> 'documentUploadId' = p_origin::text
    AND c.stale_since IS NULL;

  RETURN inserted;
END
$function$;

CREATE OR REPLACE FUNCTION core.record_provenance_axis(p_kind text, p_subject uuid, p_axis text, p_from text, p_to text, p_op text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO core.provenance_axis_history (subject_kind, subject_id, axis, from_value, to_value, cause, actor_subject_id
  ) VALUES (p_kind, p_subject, p_axis, p_from, p_to,
    coalesce(
      nullif(current_setting('mpc.provenance_cause', true), ''),
      CASE p_op WHEN 'INSERT' THEN 'created' ELSE 'unattributed_update' END
    ),
    nullif(current_setting('mpc.provenance_actor', true), '')::uuid
  );
END
$function$;

CREATE OR REPLACE FUNCTION core.record_schema_activation()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.state='active' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state) THEN
    INSERT INTO core.schema_activation_clocks(schema_key,epoch)
    VALUES(NEW.schema_key,1)
    ON CONFLICT(schema_key) DO UPDATE
      SET epoch=core.schema_activation_clocks.epoch+1;
  END IF;
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION core.refuse_suspended_actor()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_new JSONB := to_jsonb(NEW);
  v_old JSONB := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  v_column TEXT;
  v_actor UUID;
  v_suspended TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'INSERT' AND NEW.closed_reason IS NOT NULL THEN
    RAISE EXCEPTION 'REQUEST_CLOSED_REASON_RESERVED: only a suspension closes a request'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  FOREACH v_column IN ARRAY TG_ARGV LOOP
    v_actor := (v_new ->> v_column)::UUID;
    CONTINUE WHEN v_actor IS NULL;
    CONTINUE WHEN TG_OP = 'UPDATE' AND v_actor IS NOT DISTINCT FROM (v_old ->> v_column)::UUID;
    -- 0132 (F5): an actor that cannot be read refuses. The row's foreign key says the actor
    -- exists, so only an owner filtered by RLS reads nothing here.
    -- 0133 (L2): `FOR KEY SHARE` — the lock this statement's foreign-key check takes on the same
    -- row anyway — waits for a suspension of the actor still in progress and re-reads the
    -- committed row; a suspension that starts later waits for this transaction and then closes
    -- what it approved.
    SELECT s.suspended_at INTO v_suspended FROM core.subjects s WHERE s.id = v_actor FOR KEY SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'ACTOR_UNREADABLE: actor % of % cannot be read', v_actor, TG_TABLE_NAME
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF v_suspended IS NOT NULL THEN
      RAISE EXCEPTION 'ACTOR_SUSPENDED: a suspended account takes part in no decision'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END LOOP;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.remove_authenticator(p_session_id uuid, p_kind text, p_id uuid)
 RETURNS TABLE(revoked_sessions integer, current_session_ended boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_target UUID;
  v_remaining INTEGER;
  v_required INTEGER;
  v_count INTEGER;
  v_ended BOOLEAN;
BEGIN
  IF v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_RECOVERY_REENROLMENT_REQUIRED: enrol a new factor first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_kind = 'passkey' THEN
    SELECT id INTO v_target FROM core.webauthn_credentials
    WHERE id = p_id AND subject_id = v.subject_id AND revoked_at IS NULL
    FOR UPDATE;
  ELSIF p_kind = 'totp' THEN
    SELECT id INTO v_target FROM core.totp_authenticators
    WHERE subject_id = v.subject_id AND confirmed_at IS NOT NULL
      AND revoked_at IS NULL
    FOR UPDATE;
  ELSE
    RAISE EXCEPTION 'unknown factor kind %', p_kind USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_target IS NULL THEN
    RAISE EXCEPTION 'MFA_AUTHENTICATOR_UNKNOWN: not an active % of this subject', p_kind
      USING ERRCODE = 'no_data_found';
  END IF;

  -- The strongest factor the subject holds, the one being removed included: a TOTP-level session
  -- must not strip a passkey off the account.
  v_required := CASE WHEN core.mfa_has_passkey(v.subject_id) THEN 3 ELSE 2 END;
  IF core.mfa_session_rank(v) < v_required THEN
    RAISE EXCEPTION '%: removing a factor needs a session at aal%',
      CASE WHEN v_required = 3 THEN 'MFA_PASSKEY_REQUIRED' ELSE 'MFA_STEP_UP_REQUIRED' END, v_required
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_remaining := (SELECT count(*)::int FROM core.webauthn_credentials
                  WHERE subject_id = v.subject_id AND revoked_at IS NULL)
               + (CASE WHEN core.mfa_has_totp(v.subject_id) THEN 1 ELSE 0 END) - 1;
  IF v_remaining < 1 THEN
    RAISE EXCEPTION 'MFA_LAST_FACTOR: the last passkey or TOTP cannot be removed; an admin reset replaces it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF p_kind = 'passkey' THEN
    UPDATE core.webauthn_credentials SET revoked_at = now(), revoked_reason = 'removed_by_holder'
    WHERE id = v_target;
  ELSE
    UPDATE core.totp_authenticators SET revoked_at = now(), revoked_reason = 'removed_by_holder'
    WHERE id = v_target;
  END IF;

  v_count := core.mfa_revoke_other_sessions(v, v.id, 'authenticator_removed');
  v_ended := EXISTS (
    SELECT 1 FROM core.session_factor_proofs p
    WHERE p.id = v.second_factor_proof_id
      AND (p.webauthn_credential_id = v_target OR p.totp_authenticator_id = v_target)
  );
  IF v_ended THEN
    UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'authenticator_removed' WHERE id = v.id;
  END IF;
  RETURN QUERY SELECT v_count, v_ended;
END
$function$;

CREATE OR REPLACE FUNCTION core.rename_webauthn_credential(p_session_id uuid, p_passkey_id uuid, p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
BEGIN
  IF v.second_factor IS NULL OR v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_STEP_UP_REQUIRED: renaming a passkey needs a second factor'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.webauthn_credentials SET name = p_name
  WHERE id = p_passkey_id AND subject_id = v.subject_id AND revoked_at IS NULL;
  RETURN FOUND;
END
$function$;

CREATE OR REPLACE FUNCTION core.request_email_change(p_id uuid, p_subject_id uuid, p_new_email text, p_reason text, p_requested_by uuid)
 RETURNS TABLE(status text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET row_security TO 'off'
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v_email TEXT := core.normalize_email(p_new_email);
  v_current TEXT;
  v_suspended TIMESTAMPTZ;
BEGIN
  IF core.current_actor() IS DISTINCT FROM p_requested_by THEN
    RAISE EXCEPTION 'an email change is requested by its requester' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s WHERE s.id = p_subject_id AND s.kind = 'person'
  ) THEN
    RETURN QUERY SELECT 'subject_invalid'::TEXT;
    RETURN;
  END IF;

  UPDATE core.email_change_requests SET state = 'expired', version = version + 1
  WHERE subject_id = p_subject_id AND state = 'approved' AND decided_at <= now() - interval '72 hours';

  SELECT s.email, s.suspended_at INTO v_current, v_suspended FROM core.subjects s
  WHERE s.id = p_subject_id FOR UPDATE;
  IF v_suspended IS NOT NULL THEN
    RETURN QUERY SELECT 'subject_suspended'::TEXT;
    RETURN;
  END IF;
  IF v_current IS NULL THEN
    RETURN QUERY SELECT 'no_address'::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM core.email_change_requests r
    WHERE r.subject_id = p_subject_id AND r.state IN ('pending', 'approved')
  ) THEN
    RETURN QUERY SELECT 'already_open'::TEXT;
    RETURN;
  END IF;

  PERFORM core.lock_email(v_email);
  IF core.email_in_use(v_email) THEN
    RETURN QUERY SELECT 'unavailable'::TEXT;
    RETURN;
  END IF;

  INSERT INTO core.email_change_requests (
    id,subject_id, new_email, reason, requested_by_subject_id
  ) VALUES (p_id,p_subject_id, v_email, p_reason, p_requested_by);
  RETURN QUERY SELECT 'created'::TEXT;
END
$function$;

CREATE OR REPLACE FUNCTION core.require_claim_type_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.registry_proposals p
    WHERE p.kind::text = 'claim_type'
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
$function$;

CREATE OR REPLACE FUNCTION core.require_registry_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  seeding BOOLEAN;
  approved BOOLEAN;
BEGIN
  -- The seed path is a superuser/BYPASSRLS connection. The application is not.
  SELECT rolsuper OR rolbypassrls INTO seeding FROM pg_roles WHERE rolname = current_user;
  IF COALESCE(seeding, false) THEN
    RETURN NULL;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM core.registry_proposals p
    WHERE p.kind = TG_ARGV[0]::core.registry_kind
      AND p.state = 'approved'
      AND p.materialized_id = NEW.id
  ) INTO approved;

  IF NOT approved THEN
    RAISE EXCEPTION
      'A % row is written only by approving a proposal that points at it (id %)',
      TG_ARGV[0], NEW.id
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NULL;
END
$function$;

CREATE OR REPLACE FUNCTION core.require_review_commitment()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
 IF NEW.serialization_version='2' AND NOT EXISTS (
   SELECT 1 FROM core.registry_review_bundles b
    WHERE b.entry_version_id=NEW.id
      AND b.bundle_hash=NEW.public_projection->'reviewCommitment'->>'bundleHash'
 ) THEN RAISE EXCEPTION 'Version 2 publication requires its frozen review bundle'; END IF;
 RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION core.require_scoped_policy_approval()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'pg_catalog'
AS $function$
BEGIN
  IF NEW.project_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM core.registry_proposals p WHERE p.kind='policy_set'
      AND p.state='approved' AND p.materialized_id=NEW.id AND p.payload->>'projectId'=NEW.project_id::text
  ) THEN RAISE EXCEPTION 'Project policy scope requires matching approval'; END IF;
  RETURN NULL;
END $function$;

CREATE OR REPLACE FUNCTION core.reserve_totp_attempt(p_session_id uuid, p_pending boolean)
 RETURNS TABLE(totp_id uuid, secret_ciphertext bytea, secret_nonce bytea, last_used_step bigint, attempts_left integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_row core.totp_authenticators;
BEGIN
  SELECT * INTO v_row FROM core.totp_authenticators t
  WHERE t.subject_id = v.subject_id AND t.revoked_at IS NULL
    AND CASE WHEN p_pending THEN t.confirmed_at IS NULL AND t.pending_expires_at > now()
             ELSE t.confirmed_at IS NOT NULL END
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'MFA_TOTP_NOT_ENROLLED: no % TOTP for this subject',
      CASE WHEN p_pending THEN 'pending' ELSE 'active' END
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF v_row.failure_window_started_at IS NULL OR v_row.failure_window_started_at <= now() - interval '15 minutes' THEN
    v_row.failed_attempts := 0;
    v_row.failure_window_started_at := now();
  END IF;
  IF v_row.failed_attempts >= 5 THEN
    RAISE EXCEPTION 'MFA_TOTP_LOCKED: too many attempts; try again after %',
      to_char((v_row.failure_window_started_at + interval '15 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE core.totp_authenticators t
  SET failed_attempts = v_row.failed_attempts + 1, failure_window_started_at = v_row.failure_window_started_at
  WHERE t.id = v_row.id;

  RETURN QUERY SELECT v_row.id, v_row.secret_ciphertext, v_row.secret_nonce, v_row.last_used_step,
    4 - v_row.failed_attempts;
END
$function$;

CREATE OR REPLACE FUNCTION core.revoke_invitation(p_id uuid, p_revoked_by uuid, p_expected_version integer)
 RETURNS TABLE(status text, version integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
#variable_conflict use_column
DECLARE
  v core.invitations%ROWTYPE;
BEGIN
  IF core.current_actor() IS DISTINCT FROM p_revoked_by THEN
    RAISE EXCEPTION 'a decision is made by the authenticated actor' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT * INTO v FROM core.invitations i
  WHERE i.id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'not_found'::TEXT, NULL::INTEGER;
    RETURN;
  END IF;
  IF v.version <> p_expected_version THEN
    RETURN QUERY SELECT 'version_mismatch'::TEXT, v.version;
    RETURN;
  END IF;
  IF v.state <> 'pending' OR v.expires_at <= now() THEN
    RETURN QUERY SELECT 'not_pending'::TEXT, v.version;
    RETURN;
  END IF;

  UPDATE core.invitations
  SET state = 'revoked', revoked_at = now(), revoked_by_subject_id = p_revoked_by, version = version + 1
  WHERE id = v.id;
  UPDATE core.email_challenges SET superseded_at = now()
  WHERE invitation_id = v.id AND consumed_at IS NULL AND superseded_at IS NULL;
  UPDATE core.email_outbox
  SET state = 'superseded', recipient = NULL, params = NULL, settled_at = now()
  WHERE invitation_id = v.id AND state = 'pending';
  RETURN QUERY SELECT 'revoked'::TEXT, v.version + 1;
END
$function$;

CREATE OR REPLACE FUNCTION core.revoke_own_session(p_session_id uuid, p_target_id uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_target core.sessions;
BEGIN
  PERFORM core.wallet_assert_session(v, 2, false);

  SELECT * INTO v_target FROM core.sessions s
  WHERE s.id = p_target_id AND s.subject_id = v.subject_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN 'unknown';
  END IF;
  IF v_target.revoked_at IS NOT NULL OR v_target.expires_at <= now() THEN
    RETURN 'already_ended';
  END IF;

  UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'revoked_by_holder'
  WHERE id = v_target.id;
  RETURN 'revoked';
END
$function$;

CREATE OR REPLACE FUNCTION core.revoke_subject_identities(p_subject_id uuid, p_reason text)
 RETURNS text[]
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_removed TEXT[];
BEGIN
  WITH revoked AS (
    UPDATE core.external_identities
    SET revoked_at = now(), revoked_reason = p_reason
    WHERE subject_id = p_subject_id AND revoked_at IS NULL
    RETURNING provider
  )
  SELECT COALESCE(array_agg(DISTINCT provider::TEXT ORDER BY provider::TEXT), ARRAY[]::TEXT[])
  INTO v_removed FROM revoked;
  RETURN v_removed;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.revoke_subject_identities(uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.revoke_subject_sessions(p_subject_id uuid, p_reason text)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_count INTEGER;
BEGIN
  PERFORM 1 FROM core.subjects WHERE id = p_subject_id FOR UPDATE;
  UPDATE core.sessions SET revoked_at = now(), revoked_reason = p_reason
  WHERE subject_id = p_subject_id AND revoked_at IS NULL;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$function$;

CREATE OR REPLACE FUNCTION core.session_email_challenge_consumed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
BEGIN
  IF NEW.email_challenge_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.email_challenges c
    WHERE c.id = NEW.email_challenge_id
      AND c.consumed_txid = pg_current_xact_id()
      AND c.subject_id = NEW.subject_id
  ) THEN
    RAISE EXCEPTION 'session names email challenge % that this transaction did not consume for its subject',
      NEW.email_challenge_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.session_oidc_transaction_completed()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
BEGIN
  IF NEW.oidc_transaction_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.oidc_login_transactions t
    WHERE t.id = NEW.oidc_transaction_id
      AND t.completed_txid = pg_current_xact_id()
      AND t.outcome = 'session'
      AND t.purpose IN ('sign_in', 'invitation_accept')
      AND t.provider::text = NEW.first_factor::text
      AND t.subject_id = NEW.subject_id
  ) THEN
    RAISE EXCEPTION 'session names login transaction % that this transaction did not complete for its subject',
      NEW.oidc_transaction_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.start_email_challenge(p_purpose core.email_challenge_purpose, p_email text, p_invitation_token_hash text, p_challenge_id uuid, p_code_hmac bytea, p_code text, p_email_key text, p_ip_key text)
 RETURNS TABLE(status text, retry_after_seconds integer, subject_id uuid, invitation_id uuid, email_change_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_email TEXT;
  v_subject UUID;
  v_invitation core.invitations%ROWTYPE;
  v_change core.email_change_requests%ROWTYPE;
BEGIN
  v_retry := core.take_auth_rate('code_start', 'ip:' || p_ip_key, 20, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_purpose = 'invitation' THEN
    SELECT * INTO v_invitation FROM core.invitations i
    WHERE i.token_hash = p_invitation_token_hash AND i.state = 'pending' AND i.expires_at > now()
    FOR UPDATE;
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invitation_invalid'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
    v_retry := core.take_auth_rate('code_start', 'invitation:' || v_invitation.id, 5, interval '15 minutes');
    IF v_retry > 0 THEN
      RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::UUID;
      RETURN;
    END IF;
    PERFORM core.issue_email_challenge(
      p_challenge_id, 'invitation', v_invitation.email, NULL,
      v_invitation.id, NULL, p_code_hmac, 'invitation_code', v_invitation.email, p_code
    );
    RETURN QUERY SELECT 'issued'::TEXT, 0,NULL::UUID, v_invitation.id, NULL::UUID;
    RETURN;
  END IF;

  v_email := core.normalize_email(p_email);
  v_retry := core.take_auth_rate('code_start', 'email:' || p_email_key, 5, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  IF p_purpose = 'sign_in' THEN
    SELECT f.subject_id INTO v_subject FROM core.find_person_by_email(v_email) f;
    PERFORM core.issue_email_challenge(
      p_challenge_id, 'sign_in', v_email, v_subject, NULL, NULL, p_code_hmac,
      'sign_in_code', CASE WHEN v_subject IS NULL THEN NULL ELSE v_email END, p_code
    );
    RETURN QUERY SELECT 'issued'::TEXT, 0,v_subject, NULL::UUID, NULL::UUID;
    RETURN;
  END IF;

  -- email_change
  SELECT * INTO v_change FROM core.email_change_requests r
  WHERE r.new_email = v_email AND r.state = 'approved' AND r.decided_at > now() - interval '72 hours';
  PERFORM core.issue_email_challenge(
    p_challenge_id, 'email_change', v_email, v_change.subject_id, NULL,
    v_change.id, p_code_hmac, 'email_change_code',
    CASE WHEN v_change.id IS NULL THEN NULL ELSE v_email END, p_code
  );
  RETURN QUERY SELECT 'issued'::TEXT, 0,v_change.subject_id, NULL::UUID, v_change.id;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.start_email_challenge(core.email_challenge_purpose, text, text, uuid, bytea, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.start_email_challenge(core.email_challenge_purpose, text, text, uuid, bytea, text, text, text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.start_oidc_transaction(p_id uuid, p_provider core.oidc_provider, p_purpose core.oidc_purpose, p_state_hash text, p_binding_hash text, p_nonce_hash text, p_secret bytea, p_redirect_uri text, p_session_id uuid, p_invitation_token_hash text, p_display_name text, p_ip_key text)
 RETURNS TABLE(status text, retry_after_seconds integer, subject_id uuid, invitation_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_now TIMESTAMPTZ := now();
  v_session core.sessions;
  v_invitation core.invitations%ROWTYPE;
  v_subject UUID;
BEGIN
  v_retry := core.take_auth_rate('oidc_start', 'ip:' || p_ip_key, 30, interval '15 minutes');
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF p_purpose = 'link' THEN
    IF p_session_id IS NULL OR p_invitation_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a link names the caller''s session and nothing else' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_session FROM core.sessions s
    WHERE s.id = p_session_id AND s.subject_id = core.current_actor()
      AND s.revoked_at IS NULL AND s.expires_at > now() AND s.first_factor <> 'siwe_legacy';
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'session_invalid'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    IF v_session.recovery_limited THEN
      RETURN QUERY SELECT 'step_up_required'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
    v_subject := v_session.subject_id;
  ELSIF p_purpose = 'invitation_accept' THEN
    IF p_session_id IS NOT NULL OR p_display_name IS NULL THEN
      RAISE EXCEPTION 'an invitation acceptance names an invitation and a display name' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT * INTO v_invitation FROM core.invitations i
    WHERE i.token_hash = p_invitation_token_hash AND i.state = 'pending' AND i.expires_at > now();
    IF NOT FOUND THEN
      RETURN QUERY SELECT 'invitation_invalid'::TEXT, 0,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
      RETURN;
    END IF;
  ELSE
    IF p_session_id IS NOT NULL OR p_invitation_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'a sign-in names no session and no invitation' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;

  INSERT INTO core.oidc_login_transactions (
    id, provider, purpose, state_hash, binding_hash, nonce_hash, secret_ciphertext, redirect_uri,subject_id, session_id, invitation_id, display_name, created_at, expires_at
  ) VALUES (
    p_id, p_provider, p_purpose, p_state_hash, p_binding_hash, p_nonce_hash, p_secret, p_redirect_uri,v_subject, CASE WHEN p_purpose = 'link' THEN p_session_id END,
    v_invitation.id, CASE WHEN p_purpose = 'invitation_accept' THEN p_display_name END,
    v_now, v_now + interval '10 minutes'
  );
  RETURN QUERY SELECT 'started'::TEXT, 0,v_subject, v_invitation.id, v_now + interval '10 minutes';
END
$function$;
REVOKE EXECUTE ON FUNCTION core.start_oidc_transaction(uuid, core.oidc_provider, core.oidc_purpose, text, text, text, bytea, text, uuid, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.start_oidc_transaction(uuid, core.oidc_provider, core.oidc_purpose, text, text, text, bytea, text, uuid, text, text, text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.start_wallet_recovery(p_session uuid, p_chain integer, p_wallet text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
DECLARE
  actor core.sessions := core.mfa_lock_session(p_session);
  previous core.wallet_identities;
  mailbox text;
  challenge uuid := gen_random_uuid();
  proof uuid := gen_random_uuid();
BEGIN
  SELECT email INTO mailbox FROM core.subjects WHERE id=actor.subject_id AND kind='person' AND suspended_at IS NULL;
  SELECT * INTO previous FROM core.wallet_identities
    WHERE subject_id=actor.subject_id
    ORDER BY (disabled_at IS NULL) DESC, disabled_at DESC, created_at DESC,id DESC LIMIT 1;
  IF actor.recovery_limited OR mailbox IS NULL OR previous.id IS NULL OR p_chain <= 0
     OR p_wallet !~ '^0x[0-9a-f]{40}$' OR previous.wallet_address=p_wallet THEN RETURN NULL; END IF;
  IF EXISTS (SELECT 1 FROM core.wallet_recoveries WHERE subject_id=actor.subject_id
    AND created_at > now()-interval '1 minute') THEN RETURN NULL; END IF;
  UPDATE core.wallet_recoveries SET cancelled_at=now() WHERE subject_id=actor.subject_id AND consumed_at IS NULL AND cancelled_at IS NULL;
  INSERT INTO core.wallet_recoveries(id,subject_id,session_id,previous_wallet_id,previous_version,
    chain_id,wallet_address,email,proof_digest)
    VALUES(challenge,actor.subject_id,p_session,previous.id,previous.version,p_chain,p_wallet,
      mailbox,sha256(convert_to(proof::text,'UTF8')));
  INSERT INTO core.email_outbox(id,template,recipient,params,state,expires_at)
    VALUES(gen_random_uuid(),'wallet_recovery',mailbox,jsonb_build_object('code',proof,'address',p_wallet,'chainId',p_chain),
      'pending',now()+interval '10 minutes');
  RETURN challenge;
END $function$;

CREATE OR REPLACE FUNCTION core.subject_suspension_proposal_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v_subject core.subjects;
BEGIN
  SELECT * INTO v_subject FROM core.subjects
  WHERE id = NEW.subject_id
  FOR UPDATE;
  IF NOT FOUND OR v_subject.kind <> 'person' THEN
    RAISE EXCEPTION 'SUSPENSION_NOT_A_PERSON: only a person is suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'suspend' AND v_subject.suspended_at IS NOT NULL THEN
    RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person is already suspended' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.action = 'reinstate' AND v_subject.suspended_at IS NULL THEN
    RAISE EXCEPTION 'SUSPENSION_STATE_CONFLICT: the person is not suspended' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.sweep_credential_expiry(p_now timestamp with time zone)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  target RECORD;
  total INTEGER := 0;
BEGIN
    FOR target IN
      SELECT c.id, c.expires_at FROM core.credentials c
      WHERE c.expires_at <= p_now
        AND EXISTS (
          SELECT 1 FROM core.verification_attestations a
          WHERE a.credential_id = c.id AND a.state = 'active'
        )
      ORDER BY c.id
    LOOP
      total := total + core.mark_credential_attestations_stale(
        target.id,
        format('Signing credential passed its expiry %s (credential %s); its status at signing is kept unchanged',
               target.expires_at, target.id)
      );
    END LOOP;

  RETURN total;
END
$function$;

CREATE OR REPLACE FUNCTION core.sweep_document_expiry(p_today date)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  target RECORD;
  total INTEGER := 0;
BEGIN
    FOR target IN
      SELECT u.id FROM core.object_uploads u
      WHERE u.valid_until < p_today
        AND u.state NOT IN ('scanned_infected', 'rejected')
    LOOP
      total := total + core.detect_document_expiry(target.id, p_today);
    END LOOP;

  RETURN total;
END
$function$;

CREATE OR REPLACE FUNCTION core.track_artifact_lifecycle()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM core.record_provenance_axis('artifact', NEW.id, 'artifact_lifecycle', NULL, NEW.lifecycle_state, TG_OP);
  ELSIF NEW.lifecycle_state IS DISTINCT FROM OLD.lifecycle_state THEN
    PERFORM core.record_provenance_axis('artifact', NEW.id, 'artifact_lifecycle',
      OLD.lifecycle_state, NEW.lifecycle_state, TG_OP);
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.track_claim_axes()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM core.record_provenance_axis('claim', NEW.id, 'evidence_tier', NULL, NEW.evidence_tier::text, TG_OP);
    PERFORM core.record_provenance_axis('claim', NEW.id, 'verification_state', NULL, NEW.verification_state::text, TG_OP);
    RETURN NEW;
  END IF;

  IF NEW.evidence_tier IS DISTINCT FROM OLD.evidence_tier THEN
    PERFORM core.record_provenance_axis('claim', NEW.id, 'evidence_tier',
      OLD.evidence_tier::text, NEW.evidence_tier::text, TG_OP);
  END IF;
  IF NEW.verification_state IS DISTINCT FROM OLD.verification_state THEN
    PERFORM core.record_provenance_axis('claim', NEW.id, 'verification_state',
      OLD.verification_state::text, NEW.verification_state::text, TG_OP);
  END IF;
  RETURN NEW;
END
$function$;

CREATE OR REPLACE FUNCTION core.unlink_external_identity(p_session_id uuid, p_identity_id uuid)
 RETURNS TABLE(revoked_sessions integer, current_session_ended boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
DECLARE
  v core.sessions := core.mfa_lock_session(p_session_id);
  v_target core.external_identities;
  v_count INTEGER;
  v_ended BOOLEAN;
BEGIN
  IF v.recovery_limited THEN
    RAISE EXCEPTION 'MFA_RECOVERY_REENROLMENT_REQUIRED: enrol a new factor first'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  SELECT * INTO v_target FROM core.external_identities
  WHERE id = p_identity_id AND subject_id = v.subject_id AND revoked_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OIDC_IDENTITY_UNKNOWN: not a live identity of this subject'
      USING ERRCODE = 'no_data_found';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM core.subjects WHERE id = v.subject_id AND email IS NOT NULL)
     AND NOT EXISTS (
       SELECT 1 FROM core.external_identities
       WHERE subject_id = v.subject_id AND revoked_at IS NULL AND id <> v_target.id
     ) THEN
    RAISE EXCEPTION 'OIDC_LAST_SIGN_IN_METHOD: the last way to sign in cannot be unlinked'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  UPDATE core.external_identities SET revoked_at = now(), revoked_reason = 'unlinked_by_holder'
  WHERE id = v_target.id;

  v_ended := EXISTS (
    SELECT 1 FROM core.oidc_login_transactions t
    WHERE t.id = v.oidc_transaction_id AND t.identity_id = v_target.id
  );
  UPDATE core.sessions s SET revoked_at = now(), revoked_reason = 'identity_unlinked'
  FROM core.oidc_login_transactions t
  WHERE s.oidc_transaction_id = t.id AND t.identity_id = v_target.id
    AND s.revoked_at IS NULL AND s.id <> v.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_ended THEN
    UPDATE core.sessions SET revoked_at = now(), revoked_reason = 'identity_unlinked' WHERE id = v.id;
  END IF;
  RETURN QUERY SELECT v_count, v_ended;
END
$function$;

CREATE OR REPLACE FUNCTION core.verify_sign_in_code(p_email text, p_code_hmac bytea, p_email_key text, p_ip_key text, p_session_id uuid, p_token_hash text, p_ttl_seconds integer)
 RETURNS TABLE(status text, retry_after_seconds integer, subject_id uuid, challenge_id uuid, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
#variable_conflict use_column
DECLARE
  v_retry INTEGER;
  v_email TEXT := core.normalize_email(p_email);
  r RECORD;
  v_expires TIMESTAMPTZ;
BEGIN
  v_retry := core.take_auth_rate('code_verify', 'ip:' || p_ip_key, 50, interval '15 minutes');
  IF v_retry = 0 THEN
    v_retry := core.take_auth_rate('code_verify', 'email:' || p_email_key, 10, interval '15 minutes');
  END IF;
  IF v_retry > 0 THEN
    RETURN QUERY SELECT 'rate_limited'::TEXT, v_retry,NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT * INTO r FROM core.consume_email_challenge('sign_in', v_email, NULL, p_code_hmac);
  IF r.status <> 'ok' THEN
    RETURN QUERY SELECT r.status, 0,r.subject_id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM core.subjects s
    WHERE s.id = r.subject_id AND s.kind = 'person' AND s.email = v_email
      AND s.suspended_at IS NULL
  ) THEN
    RETURN QUERY SELECT 'code_invalid'::TEXT, 0,r.subject_id, r.challenge_id, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  v_expires := core.insert_email_code_session(
    r.challenge_id, r.subject_id, p_session_id, p_token_hash, p_ttl_seconds
  );
  RETURN QUERY SELECT 'session_created'::TEXT, 0,r.subject_id, r.challenge_id, v_expires;
END
$function$;
REVOKE EXECUTE ON FUNCTION core.verify_sign_in_code(text, bytea, text, text, uuid, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.verify_sign_in_code(text, bytea, text, text, uuid, text, integer) TO mpc_app;

CREATE OR REPLACE FUNCTION core.actor_live_bindings()
 RETURNS TABLE(organization_id uuid, project_id uuid, jurisdiction text[], scope_kind text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT b.organization_id, b.project_id, b.jurisdiction,
    COALESCE(b.scope_kind, CASE WHEN b.role = 'project_member' THEN 'organization' ELSE 'registry' END)
  FROM core.role_bindings AS b
  JOIN core.subjects AS s ON s.id = b.subject_id
  WHERE b.subject_id = core.current_actor()
    AND b.revoked_at IS NULL
    AND s.suspended_at IS NULL
$function$;

CREATE OR REPLACE FUNCTION core.actor_project_ids()
 RETURNS uuid[]
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT COALESCE(array_agg(DISTINCT p.id), '{}')
  FROM core.actor_live_bindings() AS b
  JOIN core.projects AS p ON
       b.project_id = p.id
    OR (b.project_id IS NULL AND b.scope_kind = 'registry')
    OR (b.project_id IS NULL AND b.scope_kind = 'organization'
        AND b.organization_id = p.owner_organization_id)
  WHERE b.jurisdiction IS NULL OR p.host_country_iso3::text = ANY(b.jurisdiction)
$function$;

CREATE OR REPLACE FUNCTION core.actor_reaches_project(p_id uuid, p_owner_organization_id uuid, p_host_country text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT EXISTS (
    SELECT FROM core.actor_live_bindings() AS b
    WHERE (b.jurisdiction IS NULL OR p_host_country = ANY(b.jurisdiction))
      AND (b.project_id = p_id
        OR (b.project_id IS NULL AND b.scope_kind = 'registry')
        OR (b.project_id IS NULL AND b.scope_kind = 'organization'
            AND b.organization_id = p_owner_organization_id))
  )
$function$;

CREATE OR REPLACE FUNCTION core.actor_registry_wide()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT EXISTS (
    SELECT FROM core.actor_live_bindings() AS b
    WHERE b.project_id IS NULL AND b.scope_kind = 'registry' AND b.jurisdiction IS NULL
  )
$function$;

CREATE OR REPLACE FUNCTION core.complete_email_change(p_new_email text, p_code_hmac bytea, p_email_key text, p_ip_key text)
 RETURNS TABLE(status text, retry_after_seconds integer, subject_id uuid, email_change_id uuid, previous_email text, revoked_sessions integer)
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$ SELECT * FROM core.complete_email_change($1,$2,$3,$4,NULL::text) $function$;
REVOKE EXECUTE ON FUNCTION core.complete_email_change(text, bytea, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_email_change(text, bytea, text, text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.complete_oidc_link(p_transaction_id uuid, p_session_id uuid, p_issuer text, p_subject_key text, p_idp_tenant text, p_email_hash text, p_identity_id uuid)
 RETURNS TABLE(status text, identity_id uuid)
 LANGUAGE sql
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$ SELECT * FROM core.complete_oidc_link($1, $2, $3, $4, $5, $6, $7, NULL::text) $function$;
REVOKE EXECUTE ON FUNCTION core.complete_oidc_link(uuid, uuid, text, text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.complete_oidc_link(uuid, uuid, text, text, text, text, uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.effective_stage_policy_sets(p_project uuid, p_at timestamp with time zone)
 RETURNS SETOF core.compliance_policy_sets
 LANGUAGE sql
 STABLE STRICT
 SET search_path TO 'pg_catalog'
AS $function$
  SELECT DISTINCT ON (p.gate_id) p.*
  FROM core.projects project JOIN core.compliance_policy_sets p ON TRUE
  WHERE project.id=p_project AND core.project_definition_applies(p.project_id,project.id)
    AND p.state='effective' AND p.effective_from<=p_at AND p.superseded_by IS NULL
    AND p.jurisdiction_profile=project.host_country_iso3
    AND p.gate_id=ANY(ARRAY['stage.exploration','stage.resource_defined','stage.feasibility','stage.permitted','stage.production'])
  ORDER BY p.gate_id,(p.project_id IS NOT NULL) DESC,p.effective_from DESC,p.created_at DESC,p.id
$function$;

CREATE OR REPLACE FUNCTION core.end_subject_elevations(p_subject_id uuid, p_releaser uuid, p_cause text)
 RETURNS jsonb
 LANGUAGE sql
 SET search_path TO 'core', 'pg_temp'
AS $function$
  WITH released AS (
    UPDATE core.break_glass_elevations
    SET state = 'released',
        released_by_subject_id = p_releaser,
        released_at = now(),
        release_cause = p_cause,
        release_recovery_verification = CASE p_cause
          WHEN 'subject_suspended' THEN 'Every session and factor of the person was revoked by the suspension'
          ELSE 'Every session and factor of the person was revoked by the MFA reset'
        END,
        version = version + 1
    WHERE subject_id = p_subject_id
      AND state = 'active' AND expires_at > now()
    RETURNING id
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object('kind', 'break_glass_elevation', 'id', id, 'reason', p_cause)), '[]')
  FROM released
$function$;
REVOKE EXECUTE ON FUNCTION core.end_subject_elevations(uuid, uuid, text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.find_person_by_email(p_email text)
 RETURNS TABLE(subject_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT s.id
  FROM core.subjects s
  WHERE s.email = core.normalize_email(p_email) AND s.kind = 'person' AND s.suspended_at IS NULL
$function$;
REVOKE EXECUTE ON FUNCTION core.find_person_by_email(text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.has_other_wallet_recovery_admin(p_holder uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM core.role_bindings b
    JOIN core.subjects s ON s.id=b.subject_id
    WHERE b.subject_id<>p_holder
      AND b.role='administrator' AND b.revoked_at IS NULL
      AND b.project_id IS NULL AND coalesce(b.scope_kind,'registry')='registry' AND b.jurisdiction IS NULL
      AND s.kind='person' AND s.suspended_at IS NULL AND s.assurance_level >= 'high_assurance'
      AND (s.email IS NOT NULL OR EXISTS (SELECT 1 FROM core.subject_sign_in_providers(ARRAY[s.id])))
  )
$function$;

CREATE OR REPLACE FUNCTION core.ledger_claim_health(p_project uuid, p_asof timestamp with time zone)
 RETURNS TABLE(id uuid, claim_type text, catalog_entry_id uuid, catalog_version integer, grade core.grade, as_of date, value_text text, stale boolean, has_evidence boolean, conflict_ids uuid[], conflict_types text[], upload_ids uuid[], signal_ids uuid[], excluded_by_rule boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog'
AS $function$
  WITH claim_uploads AS (
    SELECT c.id, ARRAY(
      SELECT DISTINCT u.id FROM core.object_uploads u
      WHERE u.project_id = c.project_id
        AND (u.id = ANY(c.document_upload_ids) OR EXISTS (
          SELECT 1 FROM core.source_receipts r WHERE r.id = c.source_receipt_id AND r.channel_evidence ->> 'documentUploadId' = u.id::text
        )) ORDER BY u.id
    ) AS uploads
    FROM core.claims c WHERE c.project_id=p_project AND c.catalog_entry_id IS NOT NULL
      AND c.superseded_by_claim_id IS NULL
  )
  SELECT c.id,c.claim_type,c.catalog_entry_id,c.catalog_version,c.grade,c.as_of,c.value_text,
    (COALESCE(c.as_of > (p_asof AT TIME ZONE 'UTC')::date, FALSE)
      OR (c.stale_since IS NOT NULL AND c.stale_since <= p_asof)
      OR EXISTS (SELECT 1 FROM core.evidence_stale_signals s
        WHERE s.project_id=c.project_id AND s.origin_claim_id=c.id AND s.resolution='open')
      OR EXISTS (SELECT 1 FROM core.object_uploads u WHERE u.id = ANY(cu.uploads)
        AND (u.revoked_at IS NOT NULL OR u.state IN ('rejected','scanned_infected')
          OR u.valid_until < (p_asof AT TIME ZONE 'UTC')::date
          OR core.document_successor(u.id) IS NOT NULL
          OR EXISTS (SELECT 1 FROM core.document_impacts di WHERE di.upload_id=u.id AND di.resolution='open')
          OR EXISTS (
            SELECT 1 FROM core.object_uploads upstream
            CROSS JOIN LATERAL core.document_impact_targets(upstream.id) targets
            WHERE upstream.project_id=c.project_id
              AND targets.upload_id=u.id AND (upstream.revoked_at IS NOT NULL
                OR upstream.valid_until < (p_asof AT TIME ZONE 'UTC')::date
                OR core.document_successor(upstream.id) IS NOT NULL)
          )))) AS stale,
    ((cardinality(cu.uploads)>0 OR EXISTS (
      SELECT 1 FROM core.source_receipts receipt WHERE receipt.id=c.source_receipt_id
        AND receipt.project_id=c.project_id
        AND receipt.result='confirmed_from_source' AND receipt.freshness_status='fresh'
    )) AND NOT EXISTS (
      SELECT 1 FROM core.object_uploads u WHERE u.id=ANY(cu.uploads)
        AND (u.state <> 'promoted' OR u.revoked_at IS NOT NULL)
    )) AS has_evidence,
    ARRAY(SELECT cc.id FROM core.claim_conflicts cc WHERE cc.claim_id=c.id AND cc.resolved_at IS NULL ORDER BY cc.id),
    ARRAY(SELECT cc.conflict_type FROM core.claim_conflicts cc WHERE cc.claim_id=c.id AND cc.resolved_at IS NULL ORDER BY cc.id),
    cu.uploads,
    ARRAY(SELECT s.id FROM core.evidence_stale_signals s WHERE s.project_id=c.project_id
      AND s.origin_claim_id=c.id AND s.resolution='open' ORDER BY s.id),
    c.excluded_by_rule
  FROM core.claims c JOIN claim_uploads cu ON cu.id=c.id ORDER BY c.id
$function$;

CREATE OR REPLACE FUNCTION core.list_external_identities(p_session_id uuid)
 RETURNS TABLE(id uuid, provider core.oidc_provider, issuer text, idp_tenant text, linked_via text, created_at timestamp with time zone, last_used_at timestamp with time zone, revoked_at timestamp with time zone)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT i.id, i.provider, i.issuer, i.idp_tenant, i.linked_via, i.created_at, i.last_used_at, i.revoked_at
  FROM core.sessions s
  JOIN core.external_identities i ON i.subject_id = s.subject_id
  WHERE s.id = p_session_id AND s.subject_id = core.current_actor()
    AND s.revoked_at IS NULL AND s.expires_at > now()
  ORDER BY i.created_at DESC
  LIMIT 50
$function$;

CREATE OR REPLACE FUNCTION core.live_wallet_binding_challenge(p_session_id uuid, p_challenge_id uuid)
 RETURNS TABLE(id uuid, subject_id uuid, wallet_address text, chain_id integer, nonce text, issued_at timestamp with time zone, expires_at timestamp with time zone, replaces_wallet_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT c.id, c.subject_id, c.wallet_address, c.chain_id, c.nonce, c.issued_at,
         c.expires_at, c.replaces_wallet_id
  FROM core.wallet_binding_challenges c
  WHERE c.id = p_challenge_id AND c.session_id = p_session_id
    AND c.subject_id = core.current_actor()
    AND c.consumed_at IS NULL AND c.expires_at > now()
$function$;
REVOKE EXECUTE ON FUNCTION core.live_wallet_binding_challenge(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.live_wallet_binding_challenge(uuid, uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.live_webauthn_challenge(p_session_id uuid, p_purpose core.webauthn_challenge_purpose)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT challenge FROM core.webauthn_challenges
  WHERE session_id = p_session_id AND purpose = p_purpose
    AND EXISTS (SELECT FROM core.sessions s WHERE s.id = p_session_id AND s.subject_id = core.current_actor())
    AND consumed_at IS NULL AND expires_at > now()
$function$;

CREATE OR REPLACE FUNCTION core.oidc_complete(p_transaction_id uuid, p_outcome text, p_subject uuid, p_identity uuid)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'core', 'pg_temp'
AS $function$
  UPDATE core.oidc_login_transactions
  SET completed_at = now(), completed_txid = pg_current_xact_id(), outcome = p_outcome,
      subject_id = COALESCE(p_subject, subject_id),
      identity_id = COALESCE(p_identity, identity_id)
  WHERE id = p_transaction_id
$function$;
REVOKE EXECUTE ON FUNCTION core.oidc_complete(uuid, text, uuid, uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION core.outbox_emit(p_event_type text, p_aggregate_id uuid, p_aggregate_version integer, p_project_id uuid, p_payload jsonb)
 RETURNS void
 LANGUAGE sql
 SET search_path TO 'core', 'pg_temp'
AS $function$
  INSERT INTO core.outbox (
    id,event_type, schema_version, aggregate_id, aggregate_version,
    project_id, payload, correlation_id
  ) VALUES (
    gen_random_uuid(),p_event_type, 1, p_aggregate_id, p_aggregate_version,
    p_project_id, p_payload, 'txid:' || txid_current()::text
  )
$function$;

CREATE OR REPLACE FUNCTION core.public_evidence_ledger_current(p_version uuid, p_evaluated_at timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE STRICT SECURITY DEFINER
 SET search_path TO 'pg_catalog'
 SET jit TO 'off'
AS $function$
  WITH published AS (
    SELECT e.subject_id,v.public_projection
    FROM core.registry_entry_versions v JOIN core.registry_entries e ON e.id=v.entry_id
    WHERE v.id=p_version AND e.registry_type='project'
      AND v.status IN ('published','revoked','superseded') AND v.published_at IS NOT NULL
  ), frozen AS (
    SELECT p.subject_id,s.snapshot
    FROM published p JOIN core.evidence_ledger_snapshots s
      ON s.id::text=p.public_projection #>> '{evidenceLedger,snapshotId}' AND s.project_id=p.subject_id
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
        WHERE signal.target_type='registry_entry_version'
          AND signal.target_id=p_version AND signal.resolution='open'
          -- Every version signal starts from a review that became stale. That review's own
          -- items already warn through its state; another item's review is outside this
          -- item's input scope. A signal without a recorded origin still warns conservatively.
          AND (signal.origin_attestation_id IS NULL OR signal.origin_attestation_id::text IN (
            SELECT jsonb_array_elements_text(item -> 'attestationIds')))
      ) OR EXISTS (
        SELECT 1 FROM core.verification_attestations a
        JOIN core.credentials cr ON cr.id=a.credential_id
        JOIN core.attestation_schemas sch ON sch.id=a.schema_id
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
            JOIN core.verification_cases vc ON vc.id=a.case_id
            JOIN core.credentials cr ON cr.id=a.credential_id
            JOIN core.attestation_schemas sch ON sch.id=a.schema_id
            WHERE vc.project_id=f.subject_id AND h.id=ANY(a.claim_scope)
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
        CROSS JOIN LATERAL jsonb_array_elements(policy.definition -> 'requirements') requirement
        JOIN core.claims dated ON dated.id::text IN (SELECT jsonb_array_elements_text(item -> 'claimIds')) AND dated.project_id=f.subject_id
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
        JOIN core.claims graded ON graded.project_id=f.subject_id
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
        WHERE manual.project_id=f.subject_id
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
          WHERE c.project_id=f.subject_id
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
          JOIN core.verification_cases vc ON vc.id=a.case_id
          WHERE vc.project_id=f.subject_id
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
$function$;

CREATE OR REPLACE FUNCTION core.resolve_role_bindings(p_subject_id uuid)
 RETURNS TABLE(role text, organization_id uuid, project_id uuid, jurisdiction text[], scope_kind text, governance_scope text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  SELECT r.role,r.organization_id,r.project_id,r.jurisdiction,
    COALESCE(r.scope_kind, CASE WHEN r.role='project_member' THEN 'organization' ELSE 'registry' END), COALESCE(r.governance_scope,'none')
  FROM core.role_bindings r
  WHERE r.subject_id=p_subject_id AND r.revoked_at IS NULL
  ORDER BY (r.project_id IS NULL), r.role, r.project_id, r.organization_id
$function$;

CREATE OR REPLACE FUNCTION core.resolve_service_token(p_token_hash text)
 RETURNS TABLE(token_id uuid, subject_id uuid, scopes text[], assurance_level core.assurance_level, expires_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  UPDATE core.service_tokens t
  SET last_used_at = now()
  FROM core.subjects s
  WHERE t.token_hash = p_token_hash
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
    AND s.id = t.subject_id
    AND s.kind = 'service'
  RETURNING t.id, t.subject_id, t.scopes, s.assurance_level, t.expires_at
$function$;
REVOKE EXECUTE ON FUNCTION core.resolve_service_token(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_service_token(text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.resolve_session(p_token_hash text)
 RETURNS TABLE(session_id uuid, subject_id uuid, first_factor core.session_first_factor, second_factor core.session_second_factor, second_factor_at timestamp with time zone, recovery_limited boolean, assurance_level core.assurance_level, expires_at timestamp with time zone)
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
 SET row_security TO 'off'
AS $function$
  UPDATE core.sessions s
  SET last_seen_at = now()
  WHERE s.token_hash = p_token_hash
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND COALESCE(s.last_seen_at, s.issued_at) > now() - interval '30 minutes'
    AND s.first_factor <> 'siwe_legacy'
    AND s.subject_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM core.subjects x WHERE x.id = s.subject_id AND x.suspended_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM core.session_factor_proofs p
      LEFT JOIN core.webauthn_credentials c ON c.id = p.webauthn_credential_id
      LEFT JOIN core.totp_authenticators t ON t.id = p.totp_authenticator_id
      WHERE p.id = s.second_factor_proof_id
        AND (c.revoked_at IS NOT NULL OR t.revoked_at IS NOT NULL)
    )
    -- 0132 (F1): a Google / Microsoft session stands on the identity its transaction completed
    -- with; once that identity is revoked (or gone), the session does not resolve.
    AND (s.oidc_transaction_id IS NULL OR EXISTS (
      SELECT 1
      FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = s.oidc_transaction_id AND i.revoked_at IS NULL
    ))
  RETURNING
    s.id, s.subject_id, s.first_factor, s.second_factor, s.second_factor_at,
    s.recovery_limited,
    (SELECT subject.assurance_level FROM core.subjects subject WHERE subject.id = s.subject_id),
    s.expires_at
$function$;
REVOKE EXECUTE ON FUNCTION core.resolve_session(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_session(text) TO mpc_app;

CREATE OR REPLACE FUNCTION core.subject_sign_in_providers(p_subject_ids uuid[])
 RETURNS TABLE(subject_id uuid, provider core.oidc_provider)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'core', 'pg_temp'
AS $function$
  SELECT DISTINCT i.subject_id, i.provider
  FROM core.external_identities i
  WHERE i.subject_id = ANY(p_subject_ids)
    AND i.revoked_at IS NULL
    AND (SELECT core.actor_live())
  ORDER BY i.subject_id, i.provider
$function$;

CREATE OR REPLACE FUNCTION core.wallet_recovery_self_approval_valid(p_holder uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id
    WHERE b.subject_id=p_holder
      AND b.role='administrator' AND b.revoked_at IS NULL AND b.project_id IS NULL
      AND coalesce(b.scope_kind,'registry')='registry' AND b.jurisdiction IS NULL
      AND s.kind='person' AND s.suspended_at IS NULL AND s.assurance_level >= 'high_assurance'
  ) AND NOT core.has_other_wallet_recovery_admin(p_holder)
$function$;

CREATE OR REPLACE FUNCTION core.wallet_recovery_session_live(p_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'core', 'pg_temp'
AS $function$
  SELECT EXISTS (
    SELECT 1 FROM core.wallet_recoveries r
    JOIN core.sessions s ON s.id=r.session_id AND s.subject_id=r.subject_id
    JOIN core.subjects holder ON holder.id=r.subject_id
    WHERE r.id=p_id AND holder.email=r.email AND NOT s.recovery_limited
    AND s.revoked_at IS NULL
    AND s.expires_at > now()
    AND COALESCE(s.last_seen_at, s.issued_at) > now() - interval '30 minutes'
    AND s.first_factor <> 'siwe_legacy'
    AND s.subject_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM core.subjects x WHERE x.id = s.subject_id AND x.suspended_at IS NOT NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM core.session_factor_proofs p
      LEFT JOIN core.webauthn_credentials c ON c.id = p.webauthn_credential_id
      LEFT JOIN core.totp_authenticators t ON t.id = p.totp_authenticator_id
      WHERE p.id = s.second_factor_proof_id
        AND (c.revoked_at IS NOT NULL OR t.revoked_at IS NOT NULL)
    )
    -- 0132 (F1): a Google / Microsoft session stands on the identity its transaction completed
    -- with; once that identity is revoked (or gone), the session does not resolve.
    AND (s.oidc_transaction_id IS NULL OR EXISTS (
      SELECT 1
      FROM core.oidc_login_transactions t
      JOIN core.external_identities i ON i.id = t.identity_id
      WHERE t.id = s.oidc_transaction_id AND i.revoked_at IS NULL
    ))
  )
$function$;

-- 8. Views and column triggers without the tenant.
-- Invoker rights: the reader's row-level security applies. claims_without_evidence previously
-- ran with its owner's rights and so was not filtered for the reader.
CREATE VIEW core.claims_without_evidence WITH (security_invoker = true) AS
  SELECT id, project_id, claim_type, evidence_tier, verification_state, grade, created_at
  FROM core.claims AS c
  WHERE source_receipt_id IS NULL;
GRANT SELECT ON core.claims_without_evidence TO mpc_app;

CREATE VIEW core.document_status WITH (security_invoker = true) AS
  WITH successors AS MATERIALIZED (
    SELECT object_uploads.id, object_uploads.project_id, object_uploads.supersedes_upload_id
    FROM core.object_uploads
    WHERE object_uploads.supersedes_upload_id IS NOT NULL AND object_uploads.state = 'promoted'
  )
  SELECT u.project_id, u.id AS upload_id, u.document_type, lower(u.document_type) AS type_key,
    u.valid_until, u.valid_until - CURRENT_DATE AS days_until_expiry, u.state, u.uploaded_at,
    u.original_filename, u.version,
    CASE
      WHEN u.state IN ('scanned_infected', 'rejected') THEN 'unusable'
      WHEN s.id IS NOT NULL THEN 'superseded'
      WHEN u.state <> 'promoted' THEN 'pending'
      WHEN u.valid_until < CURRENT_DATE THEN 'expired'
      ELSE 'current'
    END AS status
  FROM core.object_uploads AS u
  LEFT JOIN successors AS s ON s.supersedes_upload_id = u.id AND s.project_id = u.project_id;
GRANT SELECT ON core.document_status TO mpc_app;

CREATE TRIGGER sessions_email_challenge_consumed BEFORE INSERT OR UPDATE OF email_challenge_id, subject_id, first_factor
  ON core.sessions FOR EACH ROW EXECUTE FUNCTION core.session_email_challenge_consumed();
CREATE TRIGGER sessions_oidc_transaction_completed BEFORE INSERT OR UPDATE OF oidc_transaction_id, subject_id, first_factor
  ON core.sessions FOR EACH ROW EXECUTE FUNCTION core.session_oidc_transaction_completed();
CREATE TRIGGER external_identities_person_only BEFORE INSERT OR UPDATE OF subject_id
  ON core.external_identities FOR EACH ROW EXECUTE FUNCTION core.external_identity_person_only();

-- 9. Actor policies for every record that had a tenant policy and has none yet.
--    Optional project: a project row is judged by project reach, a Registry-level row by a
--    live actor.
CREATE POLICY actor_project_scope ON audit.events
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON chain.anchor_batches
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.claim_types
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.compliance_policy_sets
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.evidence_stale_signals
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.governance_proposals
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.notifications
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.outbox
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.role_bindings
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.role_grant_requests
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
CREATE POLICY actor_project_scope ON core.source_receipts
  USING ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]))
  WITH CHECK ((project_id IS NULL AND (SELECT core.actor_live())) OR (SELECT core.actor_registry_wide()) OR project_id = ANY((SELECT core.actor_project_ids())::uuid[]));
--    Records of a project-owned parent are visible exactly when the parent is.
CREATE POLICY actor_parent_scope ON core.verification_case_claims
  USING (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = verification_case_claims.case_id))
  WITH CHECK (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = verification_case_claims.case_id));
CREATE POLICY actor_parent_scope ON core.verification_case_transitions
  USING (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = verification_case_transitions.case_id))
  WITH CHECK (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = verification_case_transitions.case_id));
CREATE POLICY actor_parent_scope ON core.assignments
  USING (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = assignments.case_id))
  WITH CHECK (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = assignments.case_id));
CREATE POLICY actor_parent_scope ON core.verification_attestations
  USING (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = verification_attestations.case_id))
  WITH CHECK (EXISTS (SELECT FROM core.verification_cases AS parent WHERE parent.id = verification_attestations.case_id));
CREATE POLICY actor_parent_scope ON core.attestation_disputes
  USING (EXISTS (SELECT FROM core.verification_attestations AS parent WHERE parent.id = attestation_disputes.attestation_id))
  WITH CHECK (EXISTS (SELECT FROM core.verification_attestations AS parent WHERE parent.id = attestation_disputes.attestation_id));
CREATE POLICY actor_parent_scope ON core.attestation_signature_requests
  USING (EXISTS (SELECT FROM core.verification_attestations AS parent WHERE parent.id = attestation_signature_requests.attestation_id))
  WITH CHECK (EXISTS (SELECT FROM core.verification_attestations AS parent WHERE parent.id = attestation_signature_requests.attestation_id));
CREATE POLICY actor_parent_scope ON core.claim_conflicts
  USING (EXISTS (SELECT FROM core.claims AS parent WHERE parent.id = claim_conflicts.claim_id))
  WITH CHECK (EXISTS (SELECT FROM core.claims AS parent WHERE parent.id = claim_conflicts.claim_id));
CREATE POLICY actor_parent_scope ON core.claim_derivations
  USING (EXISTS (SELECT FROM core.claims AS parent WHERE parent.id = claim_derivations.claim_id))
  WITH CHECK (EXISTS (SELECT FROM core.claims AS parent WHERE parent.id = claim_derivations.claim_id));
CREATE POLICY actor_parent_scope ON core.project_party_versions
  USING (EXISTS (SELECT FROM core.project_parties AS parent WHERE parent.id = project_party_versions.party_id))
  WITH CHECK (EXISTS (SELECT FROM core.project_parties AS parent WHERE parent.id = project_party_versions.party_id));
CREATE POLICY actor_parent_scope ON core.governance_execution_records
  USING (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_execution_records.proposal_id))
  WITH CHECK (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_execution_records.proposal_id));
CREATE POLICY actor_parent_scope ON core.governance_transitions
  USING (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_transitions.proposal_id))
  WITH CHECK (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_transitions.proposal_id));
CREATE POLICY actor_parent_scope ON core.governance_vote_weights
  USING (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_vote_weights.proposal_id))
  WITH CHECK (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_vote_weights.proposal_id));
CREATE POLICY actor_parent_scope ON core.governance_votes
  USING (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_votes.proposal_id))
  WITH CHECK (EXISTS (SELECT FROM core.governance_proposals AS parent WHERE parent.id = governance_votes.proposal_id));
CREATE POLICY actor_parent_scope ON core.notification_deliveries
  USING (EXISTS (SELECT FROM core.notifications AS parent WHERE parent.id = notification_deliveries.notification_id))
  WITH CHECK (EXISTS (SELECT FROM core.notifications AS parent WHERE parent.id = notification_deliveries.notification_id));
CREATE POLICY actor_parent_scope ON core.notification_reads
  USING (EXISTS (SELECT FROM core.notifications AS parent WHERE parent.id = notification_reads.notification_id))
  WITH CHECK (EXISTS (SELECT FROM core.notifications AS parent WHERE parent.id = notification_reads.notification_id));
CREATE POLICY actor_parent_scope ON core.role_revocation_requests
  USING (EXISTS (SELECT FROM core.role_bindings AS parent WHERE parent.id = role_revocation_requests.role_binding_id))
  WITH CHECK (EXISTS (SELECT FROM core.role_bindings AS parent WHERE parent.id = role_revocation_requests.role_binding_id));
--    Registry reference data, account and chain records: any live actor, as any member of the
--    single tenant could before. The API decides which of them a person may act on.
CREATE POLICY actor_live_scope ON chain.anchor_proposals
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON chain.anchor_sends
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON chain.gas_spend
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON chain.reorg_events
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON chain.safe_execution_history
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON chain.transactions
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.attestation_schemas
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.authorities
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.authority_versions
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.break_glass_elevations
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.connection_security_reviews
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.credential_status_events
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.credentials
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.document_link_rules
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.email_challenges
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.email_change_requests
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.external_identities
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.idempotency_keys
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.invitations
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.jurisdiction_profiles
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.lineage_edges
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.mfa_reset_requests
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.notification_sinks
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.oidc_login_transactions
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.organizations
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.provenance_axis_history
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.recovery_codes
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.registry_entries
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.registry_entry_versions
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.registry_proposals
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.registry_publication_drafts
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.schema_activation_clocks
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.service_tokens
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.session_factor_proofs
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.sessions
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.source_connection_transitions
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.source_connections
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.source_reconciliation_tasks
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.subject_suspensions
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.subjects
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.totp_authenticators
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.wallet_binding_challenges
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.wallet_disable_events
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.wallet_identities
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.wallet_recoveries
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.webauthn_challenges
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
CREATE POLICY actor_live_scope ON core.webauthn_credentials
  USING ((SELECT core.actor_live()))
  WITH CHECK ((SELECT core.actor_live()));
--    Audit rows: the writer records its own act. A row reads by reach like any other, but it is
--    written as the actor it names — before a session exists (sign-in codes, invitations: no
--    actor, no subject), by a subject whose own act just narrowed its reach (a revoked binding,
--    a suspension), or by a deployment task (no actor). The API decided the act before the row;
--    the row cannot name anyone else as its actor.
CREATE POLICY audit_own_actor ON audit.events FOR INSERT
  WITH CHECK (actor_subject_id IS NOT DISTINCT FROM core.current_actor());

-- The scan worker had a deployment tenant to scope its queue by. It now acts as its own service
-- subject, found from the token it already holds: the same identity the API authenticates its
-- reports with. Its Registry-wide `scan_service` binding is what reaches every project's uploads.
GRANT EXECUTE ON FUNCTION core.resolve_service_token(TEXT) TO mpc_worker;
-- Policies are evaluated with the caller's privileges, so a worker login that does not bypass
-- row-level security needs the same predicates the API's role has. They read only the caller's
-- own bindings.
GRANT EXECUTE ON FUNCTION core.current_actor(), core.actor_registry_wide(), core.actor_project_ids(),
  core.actor_reaches_project(UUID, UUID, TEXT), core.actor_live() TO mpc_worker;

-- 10. Role scope: the Registry-wide scope replaces the tenant-wide one.
-- Revoked bindings are renamed too so one vocabulary holds for every row. Only this
-- migration-owner transaction may touch revoked bindings or scopes.
ALTER TABLE core.role_bindings DISABLE TRIGGER role_bindings_guard;
ALTER TABLE core.role_bindings DISABLE TRIGGER role_bindings_scope_guard;
UPDATE core.role_bindings SET scope_kind = 'registry' WHERE scope_kind = 'tenant';
ALTER TABLE core.role_bindings ENABLE TRIGGER role_bindings_scope_guard;
ALTER TABLE core.role_bindings ENABLE TRIGGER role_bindings_guard;
ALTER TABLE core.role_grant_requests DISABLE TRIGGER role_grant_scope_guard;
UPDATE core.role_grant_requests SET scope_kind = 'registry' WHERE scope_kind = 'tenant';
ALTER TABLE core.role_grant_requests ENABLE TRIGGER role_grant_scope_guard;
ALTER TABLE core.role_bindings ADD CONSTRAINT role_bindings_scope_kind_check
  CHECK (scope_kind IN ('registry', 'organization', 'none'));
ALTER TABLE core.role_grant_requests ADD CONSTRAINT role_grant_requests_scope_kind_check
  CHECK (scope_kind IN ('registry', 'organization', 'none'));
ALTER TABLE core.oidc_login_transactions ADD CONSTRAINT oidc_tx_link_bound
  CHECK (purpose <> 'link' OR subject_id IS NOT NULL);
ALTER TABLE core.oidc_login_transactions ADD CONSTRAINT oidc_tx_session_outcome
  CHECK (outcome IS DISTINCT FROM 'session' OR (identity_id IS NOT NULL AND subject_id IS NOT NULL));

-- 11. Fail the migration on anything left behind.
DO $$
DECLARE
  v_left TEXT;
BEGIN
  SELECT string_agg(n.nspname || '.' || c.relname, ', ') INTO v_left
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('core', 'chain', 'audit') AND c.relrowsecurity
    AND NOT EXISTS (SELECT FROM pg_policy p WHERE p.polrelid = c.oid AND p.polpermissive);
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'RLS tables without a permissive policy: %', v_left;
  END IF;

  SELECT string_agg(attrelid::regclass::text, ', ') INTO v_left
  FROM pg_attribute WHERE attname = 'tenant_id' AND NOT attisdropped
    AND attrelid IN (SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                     WHERE n.nspname IN ('core', 'chain', 'audit'));
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'tenant columns remain: %', v_left;
  END IF;

  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO v_left
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname IN ('core', 'chain', 'audit') AND p.prokind = 'f'
    AND regexp_replace(pg_get_functiondef(p.oid), 'idp_tenant', '', 'g') ~* 'tenant';
  IF v_left IS NOT NULL THEN
    RAISE EXCEPTION 'functions still name the tenant: %', v_left;
  END IF;

  IF EXISTS (SELECT FROM core.role_bindings WHERE scope_kind = 'tenant')
     OR EXISTS (SELECT FROM core.role_grant_requests WHERE scope_kind = 'tenant') THEN
    RAISE EXCEPTION 'tenant role scopes remain';
  END IF;
END
$$;
