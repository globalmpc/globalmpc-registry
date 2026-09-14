-- Row Level Security — tenant 격리
--
-- 02 §2.5 / 06 §6.8: tenant 데이터는 논리·권한·암호키로 분리한다.
--
-- 중요: RLS는 **tenant 경계만** 강제한다. 역할·민감도·assignment·conflict·
-- resource state는 02 §2.1의 7개 조건 전체를 애플리케이션 authorization
-- 레이어가 평가한다. RLS 통과가 authorization 통과가 아니다.
--
-- 세션 변수는 매 요청 트랜잭션 시작 시 설정한다:
--   SET LOCAL app.current_tenant = '<uuid>';
-- 설정하지 않으면 아무 행도 보이지 않는다. 기본값이 "전부 허용"이 되면
-- 설정 누락이 조용한 데이터 유출이 된다.

-- role은 클러스터 전역 객체다. 같은 클러스터의 다른 DB가 이미 만들었을 수 있으므로
-- 멱등하게 생성한다.
DO $$
BEGIN
  CREATE ROLE mpc_app NOLOGIN;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app;

CREATE OR REPLACE FUNCTION core.current_tenant() RETURNS UUID
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid
$$;

DO $$
DECLARE
  target RECORD;
BEGIN
  FOR target IN
    SELECT c.relname, n.nspname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN information_schema.columns col
      ON col.table_schema = n.nspname
     AND col.table_name = c.relname
     AND col.column_name = 'tenant_id'
    WHERE n.nspname IN ('core', 'chain')
      AND c.relkind = 'r'
  LOOP
    EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', target.nspname, target.relname);
    EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', target.nspname, target.relname);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = core.current_tenant()) '
      'WITH CHECK (tenant_id = core.current_tenant())',
      target.nspname, target.relname
    );
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE ON %I.%I TO mpc_app',
      target.nspname, target.relname
    );
  END LOOP;
END
$$;

-- tenant_id가 없는 부속 테이블은 상위 테이블의 RLS를 통해서만 접근된다.
GRANT SELECT, INSERT ON chain.anchor_batch_leaves TO mpc_app;
GRANT SELECT, INSERT ON core.inbox TO mpc_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, chain, audit TO mpc_app;
