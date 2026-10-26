-- Freeze only this project's evidence. Tenant-wide definitions use a separate shared/exclusive
-- barrier so a publication cannot stop another tenant's (or another project's) evidence writes.
-- The old privileged table-lock entry point must no longer be callable by application clients.
REVOKE ALL ON FUNCTION core.lock_ledger_publication_inputs() FROM mpc_app, PUBLIC;

CREATE FUNCTION core.lock_ledger_publication_inputs(p_project UUID) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  tenant UUID := core.current_tenant();
BEGIN
  -- Invoker rights preserve RLS; reject missing/foreign projects before taking any lock.
  IF tenant IS NULL OR NOT EXISTS (
    SELECT 1 FROM core.projects WHERE tenant_id=tenant AND id=p_project
  ) THEN
    RAISE EXCEPTION 'Project is not accessible' USING ERRCODE='42501';
  END IF;
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended('ledger-config:' || tenant::text, 0))
     OR NOT pg_try_advisory_xact_lock(hashtextextended('ledger-project:' || tenant::text || ':' || p_project::text, 0)) THEN
    RAISE EXCEPTION 'Evidence is being updated' USING ERRCODE='55P03';
  END IF;
  -- Also detect a lifecycle writer that has locked the project but has not reached its trigger.
  PERFORM 1 FROM core.projects WHERE tenant_id=tenant AND id=p_project FOR UPDATE NOWAIT;
END
$$;
REVOKE ALL ON FUNCTION core.lock_ledger_publication_inputs(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.lock_ledger_publication_inputs(UUID) TO mpc_app;

-- Database triggers include inserts and direct SQL/worker writes, not only API mutation paths.
-- Definer rights are limited to resolving the row's parent under its explicit tenant: workers
-- need not receive additional SELECT/UPDATE privileges to participate in the barrier.
CREATE FUNCTION core.guard_ledger_input_write() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  row_data JSONB;
  tenant UUID;
  project UUID;
  lock_keys BIGINT[] := '{}';
  lock_key BIGINT;
BEGIN
  FOR row_data IN SELECT value FROM jsonb_array_elements(
    CASE TG_OP WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
      WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
      ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END
  ) LOOP
    tenant := (row_data ->> 'tenant_id')::uuid;
    IF TG_ARGV[0]='configuration' THEN
      lock_keys := array_append(lock_keys,hashtextextended('ledger-config:' || tenant::text,0));
    ELSE
      project := (row_data ->> 'project_id')::uuid;
      IF TG_TABLE_NAME='projects' THEN
        project := (row_data ->> 'id')::uuid;
      ELSIF TG_TABLE_NAME='claim_conflicts' THEN
        -- Hold the parent against concurrent reparenting while resolving the project.
        SELECT c.project_id INTO project FROM core.claims c
          WHERE c.tenant_id=tenant AND c.id=(row_data ->> 'claim_id')::uuid FOR SHARE;
      ELSIF TG_TABLE_NAME='verification_attestations' THEN
        SELECT c.project_id INTO project FROM core.verification_cases c
          WHERE c.tenant_id=tenant AND c.id=(row_data ->> 'case_id')::uuid FOR SHARE;
      END IF;
      IF project IS NOT NULL THEN
        lock_keys := array_append(lock_keys,
          hashtextextended('ledger-project:' || tenant::text || ':' || project::text,0));
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
$$;
REVOKE ALL ON FUNCTION core.guard_ledger_input_write() FROM PUBLIC;

-- TRUNCATE cannot be project-scoped and does not fire row triggers. Reject it rather than
-- leaving a privileged bulk writer outside the publication barrier.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['projects','claims','source_receipts','object_uploads',
    'artifacts','claim_conflicts','verification_attestations','verification_cases',
    'project_fact_versions','evidence_stale_signals','document_impacts','document_links'] LOOP
    EXECUTE format('CREATE TRIGGER aaaa_ledger_publication_barrier BEFORE INSERT OR UPDATE OR DELETE ON core.%I
      FOR EACH ROW EXECUTE FUNCTION core.guard_ledger_input_write(''project'')',table_name);
    EXECUTE format('CREATE TRIGGER ledger_publication_no_truncate BEFORE TRUNCATE ON core.%I
      FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate()',table_name);
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['claim_types','credentials','attestation_schemas',
    'compliance_policy_sets','jurisdiction_profiles'] LOOP
    EXECUTE format('CREATE TRIGGER aaaa_ledger_publication_barrier BEFORE INSERT OR UPDATE OR DELETE ON core.%I
      FOR EACH ROW EXECUTE FUNCTION core.guard_ledger_input_write(''configuration'')',table_name);
    EXECUTE format('CREATE TRIGGER ledger_publication_no_truncate BEFORE TRUNCATE ON core.%I
      FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate()',table_name);
  END LOOP;
END
$$;
