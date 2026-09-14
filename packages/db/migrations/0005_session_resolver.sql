-- Session-resolution functions.
--
-- **Why (design cycle):**
--
-- `core.wallet_identities` and `core.role_bindings` have RLS, and the policy
-- requires `tenant_id = core.current_tenant()`. But at login the tenant is not yet
-- known — the lookup exists to find it. Left as is, the auth path always gets 0 rows
-- and login is impossible.
--
-- So only the auth path is split into SECURITY DEFINER functions. The application cannot
-- bypass RLS by any means other than these two functions.
--
-- **Security boundary:**
--
-- 1. Both functions return **only rows that exactly match** the input wallet/subject. No
--    arbitrary lookup or listing.
-- 2. `search_path` is pinned to prevent function hijacking.
-- 3. Wallet ownership is proven by the SIWE signature (authentication step of 02 §2.9).
--    These functions only answer "what is linked to this wallet"; they do not judge ownership.
-- 4. Return values contain no PII — only IDs, roles, and assurance level.

CREATE FUNCTION core.resolve_wallet_session(p_wallet TEXT, p_chain_id INTEGER)
RETURNS TABLE (
  subject_id      UUID,
  tenant_id       UUID,
  assurance_level core.assurance_level
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT w.subject_id, w.tenant_id, w.assurance_level
  FROM core.wallet_identities w
  WHERE w.wallet_address = p_wallet
    AND w.chain_id = p_chain_id
    AND w.disabled_at IS NULL
  LIMIT 1
$$;

CREATE FUNCTION core.resolve_role_bindings(p_subject_id UUID)
RETURNS TABLE (
  role            TEXT,
  organization_id UUID,
  project_id      UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT r.role, r.organization_id, r.project_id
  FROM core.role_bindings r
  WHERE r.subject_id = p_subject_id
    AND r.revoked_at IS NULL
$$;

REVOKE EXECUTE ON FUNCTION core.resolve_wallet_session(TEXT, INTEGER) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.resolve_role_bindings(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.resolve_wallet_session(TEXT, INTEGER) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.resolve_role_bindings(UUID) TO mpc_app;
