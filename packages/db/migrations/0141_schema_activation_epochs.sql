-- Track activation events, not schema creation order. Existing signatures stay unknown (NULL).
CREATE TABLE core.schema_activation_clocks (
  tenant_id UUID NOT NULL REFERENCES core.tenants(id) ON DELETE CASCADE,
  schema_key TEXT NOT NULL,
  epoch BIGINT NOT NULL CHECK (epoch > 0),
  PRIMARY KEY (tenant_id,schema_key)
);
ALTER TABLE core.schema_activation_clocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.schema_activation_clocks FORCE ROW LEVEL SECURITY;
CREATE POLICY schema_activation_clock_tenant ON core.schema_activation_clocks
  USING (tenant_id=core.current_tenant()) WITH CHECK (tenant_id=core.current_tenant());
REVOKE ALL ON core.schema_activation_clocks FROM PUBLIC,mpc_app;
GRANT SELECT ON core.schema_activation_clocks TO mpc_app;

-- AFTER the schema write's existing configuration barrier. A version can activate repeatedly;
-- its family clock is retained even if an unreferenced version is later removed.
CREATE FUNCTION core.record_schema_activation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF NEW.state='active' AND (TG_OP='INSERT' OR OLD.state IS DISTINCT FROM NEW.state) THEN
    INSERT INTO core.schema_activation_clocks(tenant_id,schema_key,epoch)
    VALUES(NEW.tenant_id,NEW.schema_key,1)
    ON CONFLICT(tenant_id,schema_key) DO UPDATE
      SET epoch=core.schema_activation_clocks.epoch+1;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION core.record_schema_activation() FROM PUBLIC;
CREATE TRIGGER schema_activation_clock AFTER INSERT OR UPDATE OF state ON core.attestation_schemas
  FOR EACH ROW EXECUTE FUNCTION core.record_schema_activation();

ALTER TABLE core.verification_attestations ADD COLUMN schema_activation_epoch BIGINT
  CHECK (schema_activation_epoch IS NULL OR schema_activation_epoch >= 0);
CREATE FUNCTION core.guard_signed_schema_epoch() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF OLD.state<>'draft' AND NEW.schema_activation_epoch IS DISTINCT FROM OLD.schema_activation_epoch THEN
    RAISE EXCEPTION 'Signed schema activation epoch is immutable; create a new review' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signed_schema_epoch_immutable BEFORE UPDATE OF schema_activation_epoch ON core.verification_attestations
  FOR EACH ROW EXECUTE FUNCTION core.guard_signed_schema_epoch();
