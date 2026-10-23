-- Publication must hold a stable set of assessment inputs through commit, including inserts.
-- A short, fail-fast database barrier covers API, worker and direct SQL writers alike.
-- Plain reads remain concurrent; NOWAIT avoids waiting behind existing row/table writers.
CREATE FUNCTION core.lock_ledger_publication_inputs() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  LOCK TABLE core.projects, core.claim_types, core.claims, core.source_receipts,
    core.object_uploads, core.artifacts, core.claim_conflicts, core.verification_attestations,
    core.verification_cases, core.credentials, core.attestation_schemas,
    core.project_fact_versions, core.compliance_policy_sets, core.jurisdiction_profiles,
    core.evidence_stale_signals, core.document_impacts, core.document_links
    IN EXCLUSIVE MODE NOWAIT;
END
$$;
REVOKE ALL ON FUNCTION core.lock_ledger_publication_inputs() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.lock_ledger_publication_inputs() TO mpc_app;
