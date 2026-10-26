-- Reserved catalog definitions remain closed to new claims. Permit only a
-- same-project, same-catalog correction chain of historical claims; the existing
-- one-successor index and immutable parent links continue to prevent forks.
CREATE OR REPLACE FUNCTION core.guard_reserved_catalog_key() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
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
      WHERE previous.id=NEW.supersedes_claim_id AND previous.tenant_id=NEW.tenant_id
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
$$;
