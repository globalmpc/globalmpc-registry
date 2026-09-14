-- 무인증 공개 **목록·검색** — spec 11 §11.2·§11.3.
--
-- 번호가 뒤로 밀린 이유: 처음 `0026`으로 썼는데 같은 번호를 다른 작업이
-- 먼저 가져갔다(`0026_role_binding_order.sql`). 이미 공유된 쪽이 번호를 갖고
-- 아직 밀지 않은 쪽이 옮긴다. 이 파일은 앞의 어느 것에도 기대지 않으므로
-- 뒤로 가도 순서가 깨지지 않는다.
--
-- **왜 필요한가:** 0009가 만든 공개 조회는 `(registry_type, public_key)`를 이미
-- 알고 있어야 한다. 즉 공개 Explorer가 "무엇이 있는지"를 물을 방법이 없다.
-- 화면만 만들면 붙일 데이터가 없다.
--
-- 경계는 0009와 같다. 다른 것은 **여러 entry를 훑는다**는 점뿐이므로 그 훑는
-- 과정에서 경계가 새지 않게 하는 것이 이 함수의 일이다.
--
-- 1. `status IN ('published','revoked','superseded')`만 본다. draft는 나가지 않는다.
-- 2. `public_projection` 컬럼만 반환한다.
-- 3. tenant_id를 반환하지 않는다 — 여러 tenant의 기록이 한 목록에 섞여 나오지만
--    어느 것이 어느 tenant인지 알 수 없다. 이것이 공개 Registry의 의도다.
-- 4. `search_path`를 고정한다.
--
-- **entry마다 최신 version 하나만** 낸다. 이력은 상세 조회(0009)가 갖는다.
-- 목록에 모든 version을 내면 같은 프로젝트가 여러 줄로 보인다.
--
-- **정렬과 페이지네이션은 keyset이다.** OFFSET은 앞쪽에 행이 추가되면 같은
-- 페이지를 두 번 주거나 건너뛴다. 공개 목록은 계속 늘어나므로 그 드리프트가
-- 실제로 일어난다. 정렬 키는 `(published_at, entry_id)`이고 둘 다 반환해
-- 클라이언트가 다음 cursor를 만들 수 있게 한다.

CREATE FUNCTION core.public_registry_list(
  p_registry_type      TEXT,
  p_query              TEXT,
  p_status             TEXT,
  p_limit              INTEGER,
  p_after_published_at TIMESTAMPTZ,
  p_after_entry_id     UUID
)
RETURNS TABLE (
  entry_id          UUID,
  public_key        TEXT,
  entry_version_id  UUID,
  version           INTEGER,
  status            core.registry_entry_status,
  public_projection JSONB,
  published_at      TIMESTAMPTZ,
  -- keyset cursor가 쓰는 정렬 키. `published_at`과 같지 않을 수 있으므로
  -- (NULL 방어) 별도로 낸다 — 호출자가 published_at으로 cursor를 만들면
  -- 그 페이지가 어긋난다.
  sort_at           TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  superseded_by_id  UUID
)
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = core, pg_temp
AS $$
  WITH latest AS (
    SELECT DISTINCT ON (e.id)
           e.id  AS entry_id,
           e.public_key,
           v.id  AS entry_version_id,
           v.version,
           v.status,
           v.public_projection,
           -- published_at은 게시 시점에 채워지지만 정렬 키가 NULL이면 keyset이
           -- 성립하지 않는다. 방어적으로 created_at으로 떨어뜨린다.
           COALESCE(v.published_at, v.created_at) AS sort_at,
           v.published_at,
           v.revoked_at,
           v.superseded_by_id
    FROM core.registry_entry_versions v
    JOIN core.registry_entries e ON e.id = v.entry_id
    WHERE e.registry_type = p_registry_type::core.registry_type
      AND v.status IN ('published', 'revoked', 'superseded')
      AND v.public_projection IS NOT NULL
    ORDER BY e.id, v.version DESC
  ),
  -- 사용자 입력의 `%`·`_`는 와일드카드가 아니라 글자다. 이스케이프하지 않으면
  -- `%`만 넣어도 전체가 걸리고, 그것은 검색이 아니라 우회다.
  needle AS (
    SELECT CASE
             WHEN p_query IS NULL OR btrim(p_query) = '' THEN NULL
             ELSE '%' || replace(replace(replace(p_query, '\', '\\'), '%', '\%'), '_', '\_') || '%'
           END AS pattern
  )
  SELECT latest.entry_id,
         latest.public_key,
         latest.entry_version_id,
         latest.version,
         latest.status,
         latest.public_projection,
         latest.published_at,
         latest.sort_at,
         latest.revoked_at,
         latest.superseded_by_id
  FROM latest, needle
  WHERE (p_status IS NULL OR latest.status = p_status::core.registry_entry_status)
    AND (
      needle.pattern IS NULL
      OR latest.public_key ILIKE needle.pattern
      OR latest.public_projection->>'projectName' ILIKE needle.pattern
      OR latest.public_projection->>'projectKey'  ILIKE needle.pattern
      OR latest.public_projection->>'hostCountry' ILIKE needle.pattern
      OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(
                  CASE WHEN jsonb_typeof(latest.public_projection->'mineral') = 'array'
                       THEN latest.public_projection->'mineral'
                       ELSE '[]'::jsonb END
                ) AS m(value)
           WHERE m.value ILIKE needle.pattern
         )
    )
    -- keyset. 정렬이 내림차순이므로 "cursor보다 뒤"는 더 작은 값이다.
    AND (
      p_after_published_at IS NULL
      OR latest.sort_at < p_after_published_at
      OR (latest.sort_at = p_after_published_at AND latest.entry_id < p_after_entry_id)
    )
  ORDER BY latest.sort_at DESC, latest.entry_id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 20), 1), 100)
$$;

-- 목록은 정렬 키로 훑는다. entry마다 최신 version을 고르는 것도 같은 인덱스가 돕는다.
CREATE INDEX registry_entry_versions_public_list_idx
  ON core.registry_entry_versions (entry_id, version DESC)
  WHERE status IN ('published', 'revoked', 'superseded');

REVOKE EXECUTE ON FUNCTION core.public_registry_list(TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION core.public_registry_list(TEXT, TEXT, TEXT, INTEGER, TIMESTAMPTZ, UUID) TO mpc_app;
