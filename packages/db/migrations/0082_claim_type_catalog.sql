-- Claim definitions are reviewed data; existing claims keep their current free-text keys.
ALTER TYPE core.registry_kind ADD VALUE 'claim_type';

CREATE TABLE core.claim_types (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES core.tenants(id),
  claim_type TEXT NOT NULL CHECK (claim_type ~ '^[a-z][a-z0-9_]{0,99}$'),
  catalog_version INTEGER NOT NULL CHECK (catalog_version > 0),
  display_name TEXT NOT NULL CHECK (length(btrim(display_name)) > 0),
  description TEXT CHECK (description IS NULL OR length(btrim(description)) > 0),
  definition JSONB NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  effective_from TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, claim_type, catalog_version)
);

CREATE FUNCTION core.guard_claim_type_version() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  previous_version INTEGER;
  previous_effective_from TIMESTAMPTZ;
BEGIN
  SELECT catalog_version, effective_from INTO previous_version, previous_effective_from
  FROM core.claim_types
  WHERE tenant_id = NEW.tenant_id AND claim_type = NEW.claim_type
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
$$;

CREATE TRIGGER claim_types_version_guard BEFORE INSERT ON core.claim_types
  FOR EACH ROW EXECUTE FUNCTION core.guard_claim_type_version();
CREATE FUNCTION core.reject_claim_type_mutation() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'A claim type version cannot be modified or deleted. Propose a new version'
    USING ERRCODE = 'raise_exception';
END
$$;
CREATE TRIGGER claim_types_immutable BEFORE UPDATE OR DELETE ON core.claim_types
  FOR EACH ROW EXECUTE FUNCTION core.reject_claim_type_mutation();

-- Match the reviewed content too: pointing an unrelated proposal at a row cannot bless it.
-- Deferred because the existing decision route materializes before marking the proposal approved.
-- No bootstrap bypass is needed: this catalog intentionally starts empty.
CREATE FUNCTION core.require_claim_type_approval() RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.registry_proposals p
    WHERE p.tenant_id = NEW.tenant_id AND p.kind::text = 'claim_type'
      AND p.state = 'approved' AND p.materialized_id = NEW.id
      AND p.item_key = NEW.claim_type AND p.effective_from = NEW.effective_from
      AND p.payload = jsonb_build_object(
        'claimType', NEW.claim_type, 'displayName', NEW.display_name,
        'description', NEW.description, 'definition', NEW.definition)
  ) THEN
    RAISE EXCEPTION 'A claim type row requires an approved proposal matching its content'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER claim_types_require_approval AFTER INSERT ON core.claim_types
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION core.require_claim_type_approval();

ALTER TABLE core.claim_types ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.claim_types FORCE ROW LEVEL SECURITY;
CREATE POLICY claim_types_tenant ON core.claim_types FOR ALL
  USING (tenant_id = core.current_tenant()) WITH CHECK (tenant_id = core.current_tenant());
GRANT SELECT, INSERT ON core.claim_types TO mpc_app;
CREATE TRIGGER claim_types_no_truncate BEFORE TRUNCATE ON core.claim_types
  FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();
