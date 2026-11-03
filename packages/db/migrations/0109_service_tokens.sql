-- Service tokens — decision D7.
--
-- The scan worker signed in with SIWE using its own private key, and the CRE workflow sent a
-- person's 8-hour session token. Neither is a person, and neither should hold a credential that
-- works on every route a person can reach. A service token is:
--
-- - **opaque and hashed** — only the keccak256 of the token is stored, as for sessions;
-- - **bound to a `service` subject** — the subject's role bindings still decide what it may do;
-- - **route-scoped** — `scopes` lists the service routes it may call. The API maps each route to
--   at most one scope and refuses a service token on any route without one, so no person route is
--   ever reachable with it. The allowed scope names are checked here and in the API contract
--   (`SERVICE_SCOPES`), and a test keeps the two lists equal;
-- - **expiring** — at most 400 days after issue;
-- - **rotated with overlap** — a rotation issues a new token (`rotated_from` names the old one)
--   and shortens the old one's expiry to the overlap window, so a deployment can roll the new
--   secret out while the old one still works, then the old one ends on its own.
--
-- Issued, rotated and revoked only by the operator CLI over the migration connection
-- (`pnpm --filter @mpc/api service-token`). The API can only resolve them.

CREATE TABLE core.service_tokens (
  id            UUID PRIMARY KEY,
  tenant_id     UUID NOT NULL REFERENCES core.tenants (id),
  subject_id    UUID NOT NULL,
  -- What the token is for, e.g. "scan-worker". Shown by the CLI; never a secret.
  label         TEXT NOT NULL CHECK (label ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  token_hash    TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^0x[0-9a-f]{64}$'),
  scopes        TEXT[] NOT NULL CHECK (
    cardinality(scopes) > 0 AND scopes <@ ARRAY['scan_result', 'cre_report']::TEXT[]
  ),
  issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL,
  rotated_from  UUID REFERENCES core.service_tokens (id),
  revoked_at    TIMESTAMPTZ,
  last_used_at  TIMESTAMPTZ,
  FOREIGN KEY (tenant_id, subject_id) REFERENCES core.subjects (tenant_id, id),
  CONSTRAINT service_token_lifetime
    CHECK (expires_at > issued_at AND expires_at <= issued_at + interval '400 days')
);

CREATE INDEX service_tokens_subject_idx ON core.service_tokens (subject_id) WHERE revoked_at IS NULL;

ALTER TABLE core.service_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE core.service_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON core.service_tokens
  USING (tenant_id = core.current_tenant())
  WITH CHECK (tenant_id = core.current_tenant());

REVOKE ALL ON core.service_tokens FROM PUBLIC;

/** A service token belongs to a service subject. A person never holds one. */
CREATE FUNCTION core.service_token_subject_is_service() RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = core, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM core.subjects WHERE id = NEW.subject_id AND kind = 'service'
  ) THEN
    RAISE EXCEPTION 'service token subject % is not a service subject', NEW.subject_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER service_tokens_subject_is_service
  BEFORE INSERT OR UPDATE OF subject_id ON core.service_tokens
  FOR EACH ROW EXECUTE FUNCTION core.service_token_subject_is_service();

/**
 * Finds a live service token by hash and marks it used.
 *
 * Refused (no row): revoked, expired, or bound to a subject that is no longer a service.
 */
CREATE FUNCTION core.resolve_service_token(p_token_hash TEXT)
RETURNS TABLE (
  token_id        UUID,
  subject_id      UUID,
  tenant_id       UUID,
  scopes          TEXT[],
  assurance_level core.assurance_level,
  expires_at      TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
VOLATILE
SET search_path = core, pg_temp
AS $$
  UPDATE core.service_tokens t
  SET last_used_at = now()
  FROM core.subjects s
  WHERE t.token_hash = p_token_hash
    AND t.revoked_at IS NULL
    AND t.expires_at > now()
    AND s.id = t.subject_id
    AND s.kind = 'service'
  RETURNING t.id, t.subject_id, t.tenant_id, t.scopes, s.assurance_level, t.expires_at
$$;

REVOKE EXECUTE ON FUNCTION core.resolve_service_token(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.resolve_service_token(TEXT) TO mpc_app;
