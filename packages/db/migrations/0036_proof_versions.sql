-- inclusion proof에 규격 버전을 담는다.
--
-- **문제:** proof는 "이 바이트가 이 batch에 있었다"를 말하지만, 검증자가 그
-- 바이트를 **어떤 규격으로 다시 만들어야 하는지**는 말하지 않는다. leaf는
-- canonical serialization으로 만들어지고 그 규격은 버전이 있다. 버전을 모르면
-- 재구성이 재현되지 않고, 재현되지 않으면 proof는 "믿어라"가 된다.
--
-- **결정 (2026-09-09, 사용자 지시): 비식별 버전 문자열 셋만 담는다.**
--
-- `policy_version` · `schema_version` · `serialization_version`. 셋 다 규격을
-- 가리키는 이름이며 **어떤 주체도 식별하지 않는다.** leaf의 원문이나
-- `subject_id`를 담자는 것이 아니다 — 그것은 별개 결정이며 여기서 정하지
-- 않는다(D-41).
--
-- `serialization_version`은 route가 `"1"`로 **고정해 내보내고 있었다.** 컬럼에
-- 기본값 `'1'`이 있어 지금까지는 같았지만, 규격을 올리면(CLAUDE.md — 이미
-- anchor된 root를 재현하려면 버전을 올린다) 응답만 옛 값을 계속 말한다.
-- 저장된 값을 그대로 내보내야 그 사고가 생기지 않는다.

DROP FUNCTION IF EXISTS core.public_inclusion_proof(UUID);

CREATE FUNCTION core.public_inclusion_proof(p_entry_version_id UUID)
RETURNS TABLE (
  leaf_hash             TEXT,
  batch_row_id          UUID,
  merkle_root           TEXT,
  external_batch_id     TEXT,
  transaction_state     TEXT,
  transaction_hash      TEXT,
  block_number          BIGINT,
  policy_version        TEXT,
  schema_version        TEXT,
  serialization_version TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT l.leaf_hash, l.batch_id, b.merkle_root, b.batch_id,
         t.state::text, t.tx_hash, t.block_number,
         v.policy_version, v.schema_version, v.serialization_version
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

REVOKE EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_inclusion_proof(UUID) TO mpc_app;
