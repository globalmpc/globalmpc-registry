-- Preserve exact signing context; legacy signatures stay explicitly without it.
ALTER TABLE core.verification_attestations ADD COLUMN signing_envelope JSONB;
CREATE FUNCTION core.protect_signing_envelope() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.state <> 'draft' AND NEW.signing_envelope IS DISTINCT FROM OLD.signing_envelope THEN
    RAISE EXCEPTION 'Signed envelope is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER signing_envelope_immutable BEFORE UPDATE ON core.verification_attestations
FOR EACH ROW EXECUTE FUNCTION core.protect_signing_envelope();

CREATE TABLE core.registry_review_bundles (
  entry_version_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES core.tenants(id),
  project_id UUID NOT NULL REFERENCES core.projects(id),
  bundle JSONB NOT NULL,
  bundle_hash TEXT NOT NULL CHECK(bundle_hash ~ '^0x[0-9a-f]{64}$'),
  FOREIGN KEY (tenant_id,entry_version_id) REFERENCES core.registry_entry_versions(tenant_id,id)
);
ALTER TABLE core.registry_review_bundles ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.registry_review_bundles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.registry_review_bundles
 USING(tenant_id=core.current_tenant()) WITH CHECK(tenant_id=core.current_tenant());
GRANT SELECT,INSERT ON core.registry_review_bundles TO mpc_app;
CREATE TRIGGER review_bundle_no_mutation BEFORE UPDATE OR DELETE ON core.registry_review_bundles
 FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

-- Retain the exact anchored leaf even when the live version is later revoked/superseded.
ALTER TABLE chain.anchor_batch_leaves ADD COLUMN leaf_payload JSONB;
ALTER TABLE core.registry_review_bundles ADD CONSTRAINT review_bundle_project_tenant
 FOREIGN KEY(tenant_id,project_id) REFERENCES core.projects(tenant_id,id);

-- A v2 version must atomically publish its frozen commitment, never just advertise one.
CREATE FUNCTION core.require_review_commitment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.serialization_version='2' AND NOT EXISTS (
   SELECT 1 FROM core.registry_review_bundles b
    WHERE b.entry_version_id=NEW.id AND b.tenant_id=NEW.tenant_id
      AND b.bundle_hash=NEW.public_projection->'reviewCommitment'->>'bundleHash'
 ) THEN RAISE EXCEPTION 'Version 2 publication requires its frozen review bundle'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER registry_review_commitment_required
 AFTER INSERT ON core.registry_entry_versions DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION core.require_review_commitment();
CREATE TRIGGER review_bundle_no_truncate BEFORE TRUNCATE ON core.registry_review_bundles
 FOR EACH STATEMENT EXECUTE FUNCTION core.reject_truncate();
