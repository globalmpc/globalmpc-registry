-- 공개 hash 조회.
--
-- 방문자가 BscScan에서 본 transaction hash, 증명서의 Merkle root·leaf hash,
-- batch id 중 무엇을 가져와도 **어느 공개 기록이 그 안에 있는지** 답한다.
-- 지금까지 공개 조회는 registry key를 이미 알아야 했다.
--
-- 경계(0009와 같다):
--
-- 1. 게시된 version(`published`·`revoked`·`superseded`)만 낸다. 같은 batch에
--    다른 상태의 leaf가 섞여 있어도 그것은 나가지 않는다.
-- 2. tenant_id·제출자·주소를 반환하지 않는다. anchor leaf에는 제출자 주소가
--    없고(services/anchor-batch.ts), 여기서 새로 붙이지도 않는다.
-- 3. 입력은 정확 일치만 본다. 부분 일치 hash 검색은 존재 여부를 한 글자씩 캐는
--    경로가 된다.

CREATE FUNCTION core.public_hash_lookup(p_hash TEXT)
RETURNS TABLE (
  matched_on        TEXT,
  registry_type     TEXT,
  public_key        TEXT,
  entry_version_id  UUID,
  version           INTEGER,
  status            TEXT,
  merkle_root       TEXT,
  transaction_hash  TEXT
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, chain, pg_temp
AS $$
  SELECT CASE
           WHEN l.leaf_hash = p_hash THEN 'leaf_hash'
           WHEN b.merkle_root = p_hash THEN 'merkle_root'
           WHEN b.batch_id = p_hash THEN 'batch_id'
           ELSE 'transaction_hash'
         END,
         e.registry_type::text,
         e.public_key,
         v.id,
         v.version,
         v.status::text,
         b.merkle_root,
         latest_tx.tx_hash
  FROM chain.anchor_batch_leaves l
  JOIN chain.anchor_batches b ON b.id = l.batch_id
  JOIN core.registry_entry_versions v ON v.id = l.entry_version_id
  JOIN core.registry_entries e ON e.id = v.entry_id
  -- 표시는 가장 최근 제출이다. 교체된 이전 tx hash로 찾아와도 같은 batch로 닿는다.
  LEFT JOIN LATERAL (
    SELECT t.tx_hash FROM chain.transactions t
    WHERE t.batch_id = b.id ORDER BY t.created_at DESC LIMIT 1
  ) latest_tx ON true
  WHERE (
          l.leaf_hash = p_hash
       OR b.merkle_root = p_hash
       OR b.batch_id = p_hash
       OR EXISTS (
            SELECT 1 FROM chain.transactions t
            WHERE t.batch_id = b.id AND t.tx_hash = p_hash
          )
        )
    AND v.status IN ('published', 'revoked', 'superseded')
    AND v.public_projection IS NOT NULL
  ORDER BY e.public_key, v.version DESC
  LIMIT 50
$$;

REVOKE EXECUTE ON FUNCTION core.public_hash_lookup(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_hash_lookup(TEXT) TO mpc_app;
