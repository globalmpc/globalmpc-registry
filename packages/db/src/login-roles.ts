import type postgres from "postgres";

/**
 * 접속 가능한 login role을 만든다.
 *
 * migration이 만드는 `mpc_app`·`mpc_worker`는 NOLOGIN이다. 권한 경계는 그것들이
 * 갖고, 붙을 수 있는 멤버를 따로 둔다.
 *
 * **SQL 파일이 아니라 코드인 이유가 있다.** 배포 환경에서는 저장소 파일을 컨테이너에
 * 마운트할 수 없다 — Coolify는 compose의 상대경로 bind mount를 호스트 절대경로로
 * 바꾸는데 그 경로에 저장소가 없다. 같은 이미지 안에서 도는 코드로 두면 마운트가
 * 필요 없고, `$$` PL/pgSQL 블록이 셸을 지나지 않으므로 따옴표 문제도 사라진다.
 *
 * **비밀번호는 매번 다시 맞춘다.** role이 이미 있을 때 만들기만 시도하고 넘어가면,
 * 재배포에서 새로 만든 비밀번호가 반영되지 않아 API가 붙지 못한다 — 원인이
 * "인증 실패"로만 보여 찾기 어렵다.
 *
 * RLS를 우회하는 연결(superuser)로 부른다.
 */

export interface LoginRolePasswords {
  readonly appPassword: string;
  readonly workerPassword: string;
}

export class LoginRoleError extends Error {
  readonly code = "LOGIN_ROLE_INVALID";
}

const APP_LOGIN = "mpc_app_login";
const WORKER_LOGIN = "mpc_worker_login";

export async function ensureLoginRoles(
  sql: postgres.Sql,
  passwords: LoginRolePasswords,
): Promise<{ created: string[] }> {
  for (const [name, value] of [
    ["appPassword", passwords.appPassword],
    ["workerPassword", passwords.workerPassword],
  ] as const) {
    if (value.trim() === "") {
      throw new LoginRoleError(`${name}가 비어 있다`);
    }
  }

  const created: string[] = [];

  for (const [role, parent, password] of [
    [APP_LOGIN, "mpc_app", passwords.appPassword],
    [WORKER_LOGIN, "mpc_worker", passwords.workerPassword],
  ] as const) {
    const existing = await sql<{ rolname: string }[]>`
      SELECT rolname FROM pg_roles WHERE rolname = ${role}
    `;

    if (existing.length === 0) {
      // role 이름은 상수라 식별자 주입 경로가 없다. 비밀번호는 아래에서 파라미터로
      // 넘긴다 — 문자열로 이어붙이지 않는다.
      await sql.unsafe(`CREATE ROLE ${role} LOGIN IN ROLE ${parent}`);
      created.push(role);
    }

    // `ALTER ROLE ... PASSWORD`는 파라미터 바인딩을 받지 않는다. 문자열로
    // 이어붙이면 따옴표가 들어간 비밀번호에서 깨지므로, 서버의 `format`으로
    // 이스케이프된 문장을 만들어 그것을 실행한다. `::text` 캐스팅이 없으면
    // 서버가 파라미터 타입을 정하지 못한다.
    const [built] = await sql<{ statement: string }[]>`
      SELECT format('ALTER ROLE %I WITH PASSWORD %L', ${role}::text, ${password}::text)
        AS statement
    `;
    if (!built) throw new LoginRoleError("ALTER ROLE 문을 만들지 못했다");

    /**
     * 이 문장은 비밀번호를 평문으로 담는다.
     *
     * `log_statement`가 `ddl`이나 `all`이면 그대로 DB 로그에 남고, 로그는 보통
     * 비밀보다 넓게 읽힌다. 이 트랜잭션 동안만 문장 로깅을 끈다 — 세션 단위이므로
     * 다른 연결의 설정을 건드리지 않고, 트랜잭션이 끝나면 되돌아간다.
     *
     * `SET LOCAL`은 트랜잭션 안에서만 의미가 있으므로 트랜잭션으로 감싼다.
     */
    await sql.begin(async (tx) => {
      await tx.unsafe("SET LOCAL log_statement = 'none'");
      await tx.unsafe(built.statement);
    });
  }

  await sql.unsafe(
    `GRANT USAGE ON SCHEMA core, chain, audit TO ${APP_LOGIN}, ${WORKER_LOGIN}`,
  );

  // worker는 여러 tenant를 가로지르는 시스템 과정이다(0012). RLS를 우회하되 우회
  // 범위는 mpc_worker에게 준 권한으로 제한된다.
  await sql.unsafe(`ALTER ROLE ${WORKER_LOGIN} BYPASSRLS`);

  return { created };
}
