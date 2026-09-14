-- 무인증 공개 조회 — spec 07 §7.1, OD-02.
--
-- **왜 필요한가:** Public Explorer는 tenant를 모른다. 로그인하지 않은 독자가
-- 조회하기 때문이다. 그런데 `registry_entry_versions`에는 RLS가 걸려 있고 정책이
-- `tenant_id = core.current_tenant()`를 요구하므로, 공개 조회는 항상 0행을 받는다.
--
-- 세션 해석과 같은 문제이고 같은 해법을 쓴다 — 공개 경로만 SECURITY DEFINER
-- 함수로 분리한다.
--
-- **보안 경계:**
--
-- 1. `status IN ('published','revoked','superseded')`만 반환한다. draft는 절대
--    나가지 않는다.
-- 2. `public_projection` 컬럼만 반환한다. `source_snapshot_hash` 같은 내부
--    필드는 노출하지 않는다.
-- 3. tenant_id를 반환하지 않는다. 어느 tenant의 기록인지 알 수 없다.
-- 4. `search_path`를 고정해 함수 하이재킹을 막는다.

CREATE FUNCTION core.public_registry_versions(p_registry_type TEXT, p_public_key TEXT)
RETURNS TABLE (
  id                UUID,
  public_projection JSONB,
  version           INTEGER,
  status            core.registry_entry_status,
  published_at      TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  superseded_by_id  UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  SELECT v.id, v.public_projection, v.version, v.status,
         v.published_at, v.revoked_at, v.superseded_by_id
  FROM core.registry_entry_versions v
  JOIN core.registry_entries e ON e.id = v.entry_id
  WHERE e.registry_type = p_registry_type::core.registry_type
    AND e.public_key = p_public_key
    AND v.status IN ('published', 'revoked', 'superseded')
    AND v.public_projection IS NOT NULL
  ORDER BY v.version DESC
$$;

-- inclusion proof도 무인증 조회 대상이다(OD-02: proof는 무로그인 read-only).
CREATE FUNCTION core.public_inclusion_proof(p_entry_version_id UUID)
RETURNS TABLE (
  leaf_hash          TEXT,
  batch_row_id       UUID,
  merkle_root        TEXT,
  external_batch_id  TEXT,
  transaction_state  TEXT,
  transaction_hash   TEXT,
  block_number       BIGINT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT l.leaf_hash, l.batch_id, b.merkle_root, b.batch_id,
         t.state::text, t.tx_hash, t.block_number
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  LEFT JOIN LATERAL (
    SELECT state, tx_hash, block_number FROM chain.transactions
    WHERE batch_id = b.id ORDER BY created_at DESC LIMIT 1
  ) t ON true
  WHERE l.entry_version_id = p_entry_version_id
    -- 게시되지 않은 version의 proof는 제공하지 않는다.
    AND v.status IN ('published', 'revoked', 'superseded')
$$;

CREATE FUNCTION core.public_batch_leaves(p_batch_row_id UUID)
RETURNS TABLE (leaf_hash TEXT)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = chain, pg_temp
AS $$
  SELECT leaf_hash FROM chain.anchor_batch_leaves WHERE batch_id = p_batch_row_id
$$;

REVOKE EXECUTE ON FUNCTION core.public_registry_versions(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION core.public_batch_leaves(UUID) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION core.public_registry_versions(TEXT, TEXT) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) TO mpc_app;
GRANT EXECUTE ON FUNCTION core.public_batch_leaves(UUID) TO mpc_app;
