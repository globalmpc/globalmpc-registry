-- Append-only tables reject TRUNCATE as well (02 §2.7, invariant 4).
--
-- Every guard so far is a row-level `BEFORE UPDATE` / `BEFORE DELETE` trigger. TRUNCATE fires
-- neither: it removes the rows without visiting them, so the table owner — and with `CASCADE`,
-- the owner of any parent table such as `core.tenants` — could empty an append-only table in one
-- statement. `0003` revoked TRUNCATE on `audit.events` from PUBLIC, but a privilege does not bind
-- the owner and can be re-granted by mistake; that is why the DELETE guards are triggers too.
--
-- The tables below are exactly those that carry a DELETE-rejecting trigger as of `0075`, read
-- from the catalog. `packages/db/test/schema.test.ts` asserts the same rule against the live
-- catalog, so a later table that gets a DELETE guard without a TRUNCATE guard fails there.
--
-- `chain.reorg_events` is not here: it has no DELETE trigger and relies on withheld privileges
-- (`0012`), which bind every role except its owner.
--
-- A superuser can still drop the trigger or the table (threat model T6). This closes the
-- one-statement path that skipped the existing guards, not the superuser.

CREATE OR REPLACE FUNCTION core.reject_truncate() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%.% is append-only: TRUNCATE rejected', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'raise_exception';
END
$$;

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit.events
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER chain_anchor_batches_no_truncate
  BEFORE TRUNCATE ON chain.anchor_batches
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER attestation_signature_requests_no_truncate
  BEFORE TRUNCATE ON core.attestation_signature_requests
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER authority_versions_no_truncate
  BEFORE TRUNCATE ON core.authority_versions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER break_glass_elevations_no_truncate
  BEFORE TRUNCATE ON core.break_glass_elevations
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER claim_derivations_no_truncate
  BEFORE TRUNCATE ON core.claim_derivations
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER claims_no_truncate
  BEFORE TRUNCATE ON core.claims
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER compliance_assessments_no_truncate
  BEFORE TRUNCATE ON core.compliance_assessments
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER connection_security_reviews_no_truncate
  BEFORE TRUNCATE ON core.connection_security_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER credential_status_events_no_truncate
  BEFORE TRUNCATE ON core.credential_status_events
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER disclosure_restriction_events_no_truncate
  BEFORE TRUNCATE ON core.disclosure_restriction_events
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER disclosure_restrictions_no_truncate
  BEFORE TRUNCATE ON core.disclosure_restrictions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER document_impacts_no_truncate
  BEFORE TRUNCATE ON core.document_impacts
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER document_links_no_truncate
  BEFORE TRUNCATE ON core.document_links
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER document_requirements_no_truncate
  BEFORE TRUNCATE ON core.document_requirements
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER evidence_stale_signals_no_truncate
  BEFORE TRUNCATE ON core.evidence_stale_signals
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER gate_decision_signature_requests_no_truncate
  BEFORE TRUNCATE ON core.gate_decision_signature_requests
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER gate_decisions_no_truncate
  BEFORE TRUNCATE ON core.gate_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER governance_execution_records_no_truncate
  BEFORE TRUNCATE ON core.governance_execution_records
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER governance_proposals_no_truncate
  BEFORE TRUNCATE ON core.governance_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER governance_transitions_no_truncate
  BEFORE TRUNCATE ON core.governance_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER governance_vote_weights_no_truncate
  BEFORE TRUNCATE ON core.governance_vote_weights
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER governance_votes_no_truncate
  BEFORE TRUNCATE ON core.governance_votes
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER jurisdiction_profiles_no_truncate
  BEFORE TRUNCATE ON core.jurisdiction_profiles
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER object_uploads_no_truncate
  BEFORE TRUNCATE ON core.object_uploads
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER project_fact_versions_no_truncate
  BEFORE TRUNCATE ON core.project_fact_versions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER project_parties_no_truncate
  BEFORE TRUNCATE ON core.project_parties
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER project_party_versions_no_truncate
  BEFORE TRUNCATE ON core.project_party_versions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER project_registration_requests_no_truncate
  BEFORE TRUNCATE ON core.project_registration_requests
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER project_stakeholder_events_no_truncate
  BEFORE TRUNCATE ON core.project_stakeholder_events
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER provenance_axis_history_no_truncate
  BEFORE TRUNCATE ON core.provenance_axis_history
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER registry_entry_versions_no_truncate
  BEFORE TRUNCATE ON core.registry_entry_versions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER registry_proposals_no_truncate
  BEFORE TRUNCATE ON core.registry_proposals
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER registry_publication_drafts_no_truncate
  BEFORE TRUNCATE ON core.registry_publication_drafts
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER role_revocation_requests_no_truncate
  BEFORE TRUNCATE ON core.role_revocation_requests
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER source_connection_transitions_no_truncate
  BEFORE TRUNCATE ON core.source_connection_transitions
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER source_receipts_no_truncate
  BEFORE TRUNCATE ON core.source_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER source_reconciliation_tasks_no_truncate
  BEFORE TRUNCATE ON core.source_reconciliation_tasks
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();

CREATE TRIGGER verification_attestations_no_truncate
  BEFORE TRUNCATE ON core.verification_attestations
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();
