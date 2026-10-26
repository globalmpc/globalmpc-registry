-- Keep catalog applicability separate from the fixed confirmation matrix. Historical catalog
-- rows and finalized evidence stay byte-for-byte intact; only new writes are refused.
CREATE FUNCTION core.is_reserved_catalog_key(key TEXT) RETURNS BOOLEAN
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT key = ANY(ARRAY['relationship', 'consent', 'rights', 'issuer', 'spv', 'legal_structure', 'source_data']::text[])
$$;

CREATE FUNCTION core.guard_reserved_catalog_key() RETURNS TRIGGER
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
    RAISE EXCEPTION 'Claim type key is reserved for the legacy project confirmation matrix';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER catalog_proposal_reserved_key_guard BEFORE INSERT OR UPDATE ON core.registry_proposals
  FOR EACH ROW EXECUTE FUNCTION core.guard_reserved_catalog_key();
CREATE TRIGGER catalog_type_reserved_key_guard BEFORE INSERT ON core.claim_types
  FOR EACH ROW EXECUTE FUNCTION core.guard_reserved_catalog_key();
CREATE TRIGGER catalog_claim_reserved_key_guard BEFORE INSERT ON core.claims
  FOR EACH ROW EXECUTE FUNCTION core.guard_reserved_catalog_key();
