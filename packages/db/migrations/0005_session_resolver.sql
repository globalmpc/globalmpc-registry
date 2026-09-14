-- 세션 해석 전용 함수.
--
-- **왜 필요한가 (설계 순환):**
--
-- `core.wallet_identities`와 `core.role_bindings`에는 RLS가 걸려 있고 정책은
-- `tenant_id = core.current_tenant()`를 요구한다. 그런데 로그인 시점에는 아직
-- tenant를 모른다 — tenant를 알아내려고 조회하는 것이기 때문이다. 그대로 두면
-- 인증 경로가 항상 0행을 받아 로그인이 불가능하다.
--
-- 그래서 인증 경로만 SECURITY DEFINER 함수로 분리한다. 애플리케이션은 이 두
-- 함수 외에는 어떤 방법으로도 RLS를 우회하지 못한다.
--
-- **보안 경계:**
--
-- 1. 두 함수는 입력 wallet/subject에 **정확히 대응하는 행만** 반환한다. 임의
--    조회나 목록 조회를 제공하지 않는다.
-- 2. `search_path`를 고정해 함수 하이재킹을 막는다.
-- 3. wallet 소유 증명은 SIWE 서명이 담당한다(02 §2.9의 authentication 단계).
--    이 함수는 "이 wallet에 무엇이 연결돼 있는가"만 답하며 소유를 판정하지 않는다.
-- 4. 반환값에 PII가 없다 — ID·역할·assurance level뿐이다.

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
