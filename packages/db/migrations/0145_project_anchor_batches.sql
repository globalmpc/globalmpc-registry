-- NULL preserves the identity and proofs of historical tenant batches.
ALTER TABLE chain.anchor_batches ADD COLUMN project_id uuid;
ALTER TABLE chain.anchor_batches ADD CONSTRAINT anchor_batch_project_scope
  FOREIGN KEY (tenant_id, project_id) REFERENCES core.projects(tenant_id, id);

CREATE FUNCTION chain.check_anchor_leaf_project() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  batch_project uuid;
  batch_tenant uuid;
BEGIN
  SELECT b.project_id, b.tenant_id INTO batch_project, batch_tenant
    FROM chain.anchor_batches b WHERE b.id = NEW.batch_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Anchor batch is unavailable' USING ERRCODE = '23514';
  END IF;
  IF batch_project IS NOT NULL AND NOT EXISTS (
        SELECT 1
        FROM core.registry_entry_versions v
        JOIN core.registry_entries e ON e.id = v.entry_id AND e.tenant_id = v.tenant_id
        LEFT JOIN core.verification_attestations a
          ON e.registry_type = 'verification' AND a.id = e.subject_id AND a.tenant_id = e.tenant_id
        LEFT JOIN core.verification_cases c ON c.id = a.case_id AND c.tenant_id = a.tenant_id
        WHERE v.id = NEW.entry_version_id AND v.tenant_id = batch_tenant
          AND ((e.registry_type = 'project' AND e.subject_id = batch_project) OR c.project_id = batch_project)
  ) THEN
    RAISE EXCEPTION 'Anchor leaf must belong to the batch project' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER anchor_leaf_project_scope
  BEFORE INSERT OR UPDATE ON chain.anchor_batch_leaves
  FOR EACH ROW EXECUTE FUNCTION chain.check_anchor_leaf_project();
