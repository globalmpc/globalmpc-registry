-- Account authentication WP6: the admin list says how a person can sign in.
--
-- Before accounts, "locked" meant "every bound wallet is disabled" — a wallet was the only way
-- in. With accounts a person signs in with their address or a linked Google / Microsoft
-- identity; a wallet is only a signing key (WP5). The admin screen needs to know, per person,
-- which providers are linked, without the application role reading `core.external_identities`
-- (it holds no privilege there, 0120: the rows carry the provider keys).
--
-- This returns only the provider name of each live identity, for subjects of the current tenant.
-- No issuer, key, directory or address leaves the function.

CREATE FUNCTION core.subject_sign_in_providers(p_subject_ids UUID[])
RETURNS TABLE (subject_id UUID, provider core.oidc_provider)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT DISTINCT i.subject_id, i.provider
  FROM core.external_identities i
  WHERE i.tenant_id = core.current_tenant()
    AND i.subject_id = ANY(p_subject_ids)
    AND i.revoked_at IS NULL
  ORDER BY i.subject_id, i.provider
$$;

REVOKE EXECUTE ON FUNCTION core.subject_sign_in_providers(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.subject_sign_in_providers(UUID[]) TO mpc_app;
