-- Existing links decide the account. A new Workspace identity can bind only to
-- the unique current person at the verified address. Historical links preserve
-- explicit unlink and recovery decisions. The ordinary sign-in still issues AAL1.
ALTER TABLE core.external_identities ADD COLUMN requires_mfa BOOLEAN NOT NULL DEFAULT false;

CREATE FUNCTION core.link_google_workspace_account(
  p_transaction UUID, p_issuer TEXT, p_subject_key TEXT, p_email TEXT, p_email_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = core, pg_temp
SET row_security = off
AS $$
DECLARE
  flow core.oidc_login_transactions := core.oidc_lock_claimed(p_transaction, 'sign_in');
  person core.subjects;
  linked_id UUID;
BEGIN
  IF flow.provider <> 'google' OR p_issuer <> 'https://accounts.google.com' OR p_email IS NULL THEN
    RETURN NULL;
  END IF;

  IF EXISTS (
    SELECT 1 FROM core.external_identities
    WHERE provider = 'google' AND issuer = p_issuer AND subject_key = p_subject_key
  ) THEN RETURN NULL; END IF;

  SELECT * INTO person FROM core.subjects
  WHERE email = core.normalize_email(p_email) AND kind = 'person' AND suspended_at IS NULL
  FOR UPDATE;
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM core.lock_external_identity(flow.provider, p_issuer, p_subject_key);

  IF EXISTS (
    SELECT 1 FROM core.external_identities
    WHERE provider = 'google'
      AND (subject_id = person.id OR (issuer = p_issuer AND subject_key = p_subject_key))
  ) THEN RETURN NULL; END IF;

  INSERT INTO core.external_identities (
    id, tenant_id, subject_id, provider, issuer, subject_key, email_hash, linked_via, requires_mfa
  ) VALUES (
    gen_random_uuid(), person.tenant_id, person.id, 'google', p_issuer, p_subject_key, p_email_hash, 'link', true
  )
  ON CONFLICT DO NOTHING
  RETURNING id INTO linked_id;
  RETURN linked_id;
END
$$;
REVOKE ALL ON FUNCTION core.link_google_workspace_account(UUID,TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.link_google_workspace_account(UUID,TEXT,TEXT,TEXT,TEXT) TO mpc_app;

CREATE FUNCTION core.google_session_requires_mfa(p_session UUID) RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE
SET search_path = core, pg_temp
SET row_security = off
AS $$
  SELECT COALESCE((
    SELECT i.requires_mfa
    FROM core.sessions s
    JOIN core.oidc_login_transactions t ON t.id = s.oidc_transaction_id
    JOIN core.external_identities i ON i.id = t.identity_id
    WHERE s.id = p_session
  ), false)
$$;
REVOKE ALL ON FUNCTION core.google_session_requires_mfa(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.google_session_requires_mfa(UUID) TO mpc_app;
