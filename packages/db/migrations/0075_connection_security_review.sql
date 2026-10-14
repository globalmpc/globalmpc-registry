-- Security review before a source connection goes live — spec 02 §2.8.
--
-- 02 §2.8: a Source Connection Admin configures a connection, and "security and data rights
-- review" approves it. Until now the configurer could also switch the connection to `active` in
-- the same request — the review step did not exist.
--
-- A review is its own record, written by a `security_operator`, and it covers **one version**
-- of the connection. Activation requires an approved review of exactly the version being
-- activated, so a configuration changed after review has to be reviewed again. The application
-- additionally refuses activation by the reviewer themself (two people, as for role grants).
--
-- Seed and bootstrap paths run as a superuser and insert fixture connections directly; like the
-- bootstrap CLI they are a once-per-deployment act, not a standing path, and are exempt. The
-- application role (`mpc_app`) never is.

CREATE TABLE core.connection_security_reviews (
  id                     UUID PRIMARY KEY,
  tenant_id              UUID NOT NULL REFERENCES core.tenants(id),
  connection_id          UUID NOT NULL,
  -- The connection version this review looked at.
  connection_version     INTEGER NOT NULL CHECK (connection_version > 0),
  decision               TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
  reason                 TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  reviewed_by_subject_id UUID NOT NULL,
  reviewed_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT connection_review_same_tenant
    FOREIGN KEY (tenant_id, connection_id) REFERENCES core.source_connections (tenant_id, id),
  CONSTRAINT connection_reviewer_same_tenant
    FOREIGN KEY (tenant_id, reviewed_by_subject_id) REFERENCES core.subjects (tenant_id, id)
);

CREATE INDEX connection_security_reviews_connection_idx
  ON core.connection_security_reviews (connection_id, connection_version, reviewed_at DESC);

-- A review is a record of what someone decided. The app role gets no UPDATE grant, and a
-- decision that changes is a new review row, so the history keeps both.
CREATE TRIGGER connection_security_reviews_no_delete
  BEFORE DELETE ON core.connection_security_reviews
  FOR EACH ROW EXECUTE FUNCTION core.reject_delete();

ALTER TABLE core.connection_security_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.connection_security_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY connection_security_reviews_tenant ON core.connection_security_reviews FOR ALL
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

GRANT SELECT, INSERT ON core.connection_security_reviews TO mpc_app;

/**
 * Activation needs an approved review of the version being activated.
 *
 * Checked on the transition into `active` only — a connection already active stays active.
 * Changing where an active connection points (endpoint, credential reference, authentication,
 * access basis) is refused as well: it would move a reviewed connection somewhere nobody
 * reviewed. Such a change goes through `planned` or `disabled`, a new review, and activation.
 *
 * The latest review of that version decides: a rejection after an approval withdraws it.
 */
CREATE OR REPLACE FUNCTION core.check_connection_security_review() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
  latest_decision TEXT;
BEGIN
  IF (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.state = 'active' AND NEW.state = 'active' THEN
    IF NEW.endpoint IS DISTINCT FROM OLD.endpoint
       OR NEW.secret_reference IS DISTINCT FROM OLD.secret_reference
       OR NEW.authentication_method IS DISTINCT FROM OLD.authentication_method
       OR NEW.access_basis IS DISTINCT FROM OLD.access_basis
       OR NEW.terms_license IS DISTINCT FROM OLD.terms_license
       OR NEW.commercial_reuse IS DISTINCT FROM OLD.commercial_reuse
       OR NEW.disclosure_permission IS DISTINCT FROM OLD.disclosure_permission THEN
      RAISE EXCEPTION 'An active connection cannot be re-pointed without a new security review'
        USING ERRCODE = 'raise_exception';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.state <> 'active' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'A connection cannot be created active; it needs a security review first'
      USING ERRCODE = 'raise_exception';
  END IF;

  IF NEW.endpoint IS DISTINCT FROM OLD.endpoint
     OR NEW.secret_reference IS DISTINCT FROM OLD.secret_reference
     OR NEW.authentication_method IS DISTINCT FROM OLD.authentication_method
     OR NEW.access_basis IS DISTINCT FROM OLD.access_basis
     OR NEW.terms_license IS DISTINCT FROM OLD.terms_license
     OR NEW.commercial_reuse IS DISTINCT FROM OLD.commercial_reuse
     OR NEW.disclosure_permission IS DISTINCT FROM OLD.disclosure_permission THEN
    RAISE EXCEPTION 'Activation cannot change the reviewed configuration in the same step'
      USING ERRCODE = 'raise_exception';
  END IF;

  SELECT r.decision INTO latest_decision
  FROM core.connection_security_reviews r
  WHERE r.connection_id = OLD.id AND r.connection_version = OLD.version
  ORDER BY r.reviewed_at DESC, r.id DESC
  LIMIT 1;

  IF latest_decision IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'Connection version % has no approved security review', OLD.version
      USING ERRCODE = 'raise_exception';
  END IF;

  RETURN NEW;
END
$$;

CREATE TRIGGER source_connections_require_security_review
  BEFORE INSERT OR UPDATE ON core.source_connections
  FOR EACH ROW EXECUTE FUNCTION core.check_connection_security_review();
