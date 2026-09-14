-- 로컬 스택용 login role.
--
-- migration이 만드는 `mpc_app`·`mpc_worker`는 NOLOGIN이다. 붙을 수 있는 멤버를
-- 따로 둔다 — 권한 경계는 그대로 두고 접속만 가능하게 한다.
--
-- 실제 배포에서는 이 파일을 쓰지 않는다. IAM·secret manager가 자격증명을 관리하고
-- 비밀번호가 저장소에 들어가지 않는다.

DO $$
BEGIN
  CREATE ROLE mpc_app_login LOGIN PASSWORD 'app' IN ROLE mpc_app;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

DO $$
BEGIN
  CREATE ROLE mpc_worker_login LOGIN PASSWORD 'worker' IN ROLE mpc_worker;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

GRANT USAGE ON SCHEMA core, chain, audit TO mpc_app_login, mpc_worker_login;

-- worker는 여러 tenant를 가로지르는 시스템 과정이다(0012). RLS를 우회하되
-- 우회 범위는 mpc_worker에게 준 권한으로 제한된다.
ALTER ROLE mpc_worker_login BYPASSRLS;
