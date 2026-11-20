-- Evaluate at approval, using the authenticated session's transaction-local tenant.
-- Different holder: ordinary administrator approval. Same holder: confirmed mailbox
-- and no other administrator able to sign in and exercise tenant-wide authority.
CREATE FUNCTION core.has_other_wallet_recovery_admin(p_holder uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog,core,pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM core.role_bindings b
    JOIN core.subjects s ON s.tenant_id=b.tenant_id AND s.id=b.subject_id
    WHERE b.tenant_id=core.current_tenant() AND b.subject_id<>p_holder
      AND b.role='administrator' AND b.revoked_at IS NULL
      AND b.project_id IS NULL AND coalesce(b.scope_kind,'tenant')='tenant' AND b.jurisdiction IS NULL
      AND s.kind='person' AND s.suspended_at IS NULL AND s.assurance_level >= 'high_assurance'
      AND (s.email IS NOT NULL OR EXISTS (SELECT 1 FROM core.subject_sign_in_providers(ARRAY[s.id])))
  )
$$;
REVOKE ALL ON FUNCTION core.has_other_wallet_recovery_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.has_other_wallet_recovery_admin(uuid) TO mpc_app;

CREATE OR REPLACE FUNCTION core.approve_wallet_recovery(p_session uuid,p_id uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog,core,pg_temp AS $$
DECLARE actor core.sessions := core.mfa_lock_session(p_session);
BEGIN
  IF actor.recovery_limited OR NOT EXISTS (SELECT 1 FROM core.role_bindings b JOIN core.subjects s ON s.id=b.subject_id
    WHERE b.tenant_id=actor.tenant_id AND b.subject_id=actor.subject_id AND b.role='administrator' AND b.revoked_at IS NULL
      AND b.project_id IS NULL AND coalesce(b.scope_kind,'tenant')='tenant' AND b.jurisdiction IS NULL
      AND s.kind='person' AND s.suspended_at IS NULL AND s.assurance_level >= 'high_assurance') THEN RETURN false; END IF;
  UPDATE core.wallet_recoveries SET approved_by=actor.subject_id, approved_at=now() WHERE id=p_id AND tenant_id=actor.tenant_id
    AND cancelled_at IS NULL AND consumed_at IS NULL AND approved_by IS NULL AND confirmed_at IS NOT NULL
    AND (subject_id <> actor.subject_id OR NOT core.has_other_wallet_recovery_admin(actor.subject_id))
    AND created_at>now()-interval '24 hours' AND core.wallet_recovery_session_live(p_id);
  RETURN FOUND;
END $$;
