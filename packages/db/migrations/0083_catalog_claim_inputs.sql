-- Structured claims pin immutable approved definitions; legacy text remains untouched.
ALTER TABLE core.claim_types ADD CONSTRAINT claim_types_tenant_id_id_unique UNIQUE (tenant_id, id);
ALTER TABLE core.claims
  ADD COLUMN catalog_entry_id UUID,
  ADD COLUMN catalog_version INTEGER,
  ADD COLUMN structured_values JSONB,
  ADD COLUMN document_upload_ids UUID[] NOT NULL DEFAULT '{}',
  ADD CONSTRAINT claims_catalog_same_tenant FOREIGN KEY (tenant_id, catalog_entry_id)
    REFERENCES core.claim_types(tenant_id, id),
  ADD CONSTRAINT claims_catalog_fields_together CHECK (
    (catalog_entry_id IS NULL AND catalog_version IS NULL AND structured_values IS NULL)
    OR (catalog_entry_id IS NOT NULL AND catalog_version IS NOT NULL AND structured_values IS NOT NULL AND catalog_version > 0 AND jsonb_typeof(structured_values) = 'object')
  ),
  ADD CONSTRAINT claims_document_count CHECK (cardinality(document_upload_ids) <= 20);

CREATE FUNCTION core.guard_catalog_claim_content() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
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
    SELECT 1 FROM core.claim_types c WHERE c.id = NEW.catalog_entry_id
      AND c.tenant_id = NEW.tenant_id AND c.claim_type = NEW.claim_type
      AND c.catalog_version = NEW.catalog_version AND c.effective_from <= now()
  ) THEN RAISE EXCEPTION 'Claim requires an effective matching catalog version'; END IF;
  IF NEW.catalog_entry_id IS NOT NULL AND NEW.source_receipt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM core.source_receipts r WHERE r.id = NEW.source_receipt_id
      AND r.tenant_id = NEW.tenant_id AND r.project_id = NEW.project_id
  ) THEN RAISE EXCEPTION 'Structured claim source receipt must belong to the same project'; END IF;
  FOREACH document_id IN ARRAY NEW.document_upload_ids LOOP
    IF NOT EXISTS (
      SELECT 1 FROM core.object_uploads u WHERE u.id = document_id
        AND u.tenant_id = NEW.tenant_id AND u.project_id = NEW.project_id
        AND u.state::text IN ('scanned_clean', 'promoted') AND u.revoked_at IS NULL
    ) THEN RAISE EXCEPTION 'Claim document must be an active scanned upload of this project'; END IF;
    INSERT INTO core.lineage_edges (id, tenant_id, from_id, to_id, relation_type)
    VALUES (gen_random_uuid(), NEW.tenant_id, NEW.id, document_id, 'derived_from')
    ON CONFLICT (from_id, to_id, relation_type) DO NOTHING;
  END LOOP;
  RETURN NEW;
END
$$;
CREATE TRIGGER catalog_claim_content_guard BEFORE INSERT OR UPDATE ON core.claims
  FOR EACH ROW EXECUTE FUNCTION core.guard_catalog_claim_content();
