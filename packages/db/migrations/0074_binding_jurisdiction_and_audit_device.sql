-- Jurisdiction scope on role bindings (02 §2.5) and device metadata on audit events (02 §2.7).
--
-- 1. `jurisdiction[]` is an attribute 02 §2.5 lists for data location, deployment and the scope
--    of a legal opinion. A binding may now carry it. NULL means the binding is not scoped by
--    jurisdiction and behaves exactly as before; a non-NULL array limits the binding to projects
--    whose host jurisdiction is in it. An empty array is refused: it would read as "scoped to
--    nothing" to one reader and "unscoped" to another.
--
-- 2. 02 §2.7 asks every mutation record for "IP/device risk metadata". The server sees only two
--    such facts: the client address and the user agent. It records the address class and a hash
--    of the user agent — nothing is scored. A risk score would need inputs and a model that do
--    not exist, and a made-up number in an append-only log cannot be corrected later.

ALTER TABLE core.role_bindings
  ADD COLUMN jurisdiction TEXT[]
    CHECK (jurisdiction IS NULL OR (
      cardinality(jurisdiction) > 0
      AND array_position(jurisdiction, NULL) IS NULL
    ));

ALTER TABLE core.role_grant_requests
  ADD COLUMN jurisdiction TEXT[]
    CHECK (jurisdiction IS NULL OR (
      cardinality(jurisdiction) > 0
      AND array_position(jurisdiction, NULL) IS NULL
    ));

/**
 * A binding's jurisdiction is part of what the binding is.
 *
 * Widening it in place would hand a person reach that no grant proposal approved — the same
 * reason 0042 forbids rewriting the role or project. Change it by revoking and granting again.
 * Kept as its own trigger so the 0042 guard function stays as it is.
 */
CREATE OR REPLACE FUNCTION core.protect_role_binding_jurisdiction() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.jurisdiction IS DISTINCT FROM OLD.jurisdiction THEN
    RAISE EXCEPTION 'role_bindings: jurisdiction scope cannot be rewritten. Revoke and grant instead'
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER role_bindings_jurisdiction_guard
  BEFORE UPDATE ON core.role_bindings
  FOR EACH ROW EXECUTE FUNCTION core.protect_role_binding_jurisdiction();

-- The resolver returns the scope with the binding. The return type changes, so the function is
-- dropped and recreated; body, ordering and security attributes are those of 0026.
DROP FUNCTION core.resolve_role_bindings(UUID);

CREATE FUNCTION core.resolve_role_bindings(p_subject_id UUID)
RETURNS TABLE (
  role            TEXT,
  organization_id UUID,
  project_id      UUID,
  jurisdiction    TEXT[]
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT r.role, r.organization_id, r.project_id, r.jurisdiction
  FROM core.role_bindings r
  WHERE r.subject_id = p_subject_id
    AND r.revoked_at IS NULL
  ORDER BY (r.project_id IS NULL), r.role, r.project_id, r.organization_id
$$;

REVOKE EXECUTE ON FUNCTION core.resolve_role_bindings(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_role_bindings(UUID) TO mpc_app;

-- Device metadata. Both nullable: paths without an HTTP request (CLI, worker) have neither.
ALTER TABLE audit.events
  ADD COLUMN request_ip_class TEXT
    CHECK (request_ip_class IN ('loopback', 'private', 'link_local', 'public', 'unknown')),
  ADD COLUMN user_agent_hash TEXT
    CHECK (user_agent_hash ~ '^[0-9a-f]{64}$');
