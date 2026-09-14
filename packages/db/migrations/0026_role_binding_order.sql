-- 역할 바인딩 반환 순서를 고정한다 — 02 §2.7
--
-- `resolve_role_bindings`에 ORDER BY가 없었다. 같은 주체를 두 번 조회해도 같은
-- 순서가 나온다는 보장이 없고, 계획이 바뀌면 순서도 바뀐다.
--
-- 순서가 눈에 보이는 곳이 두 군데다. 권한 판정은 **하나라도 통과하면 허용**이므로
-- 순서가 결과를 바꾸지 않는다. 하지만 감사 기록과 화면에 보이는 역할 목록은
-- 순서를 그대로 쓴다 — 같은 사람의 같은 행위가 실행마다 다른 역할로 남을 수
-- 있었다.
--
-- 좁은 바인딩을 먼저 둔다. 프로젝트 바인딩은 그 프로젝트에만, 조직 바인딩은 그
-- 조직 전체에 닿으므로, 앞에 오는 것이 뒤에 오는 것보다 권한 범위가 넓지 않다.
-- 그 뒤는 역할 이름 순이다 — 의미가 있어서가 아니라 같은 입력에 같은 출력을
-- 주기 위해서다.

CREATE OR REPLACE FUNCTION core.resolve_role_bindings(p_subject_id UUID)
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
  ORDER BY (r.project_id IS NULL), r.role, r.project_id, r.organization_id
$$;
