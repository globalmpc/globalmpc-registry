import postgres from "postgres";
import type { AppConfig } from "./config.js";

/**
 * 연결 팩토리.
 *
 * 애플리케이션은 `mpc_app` role로 접속한다. superuser로 접속하면 RLS가 우회되고
 * (BYPASSRLS) tenant 격리가 성립하지 않는다 — 02 §2.5.
 */
export function createDb(config: AppConfig): postgres.Sql {
  return postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 30,
    // 쿼리 텍스트에 값이 섞이면 로그에 PII가 남는다.
    onnotice: () => {},
  });
}
