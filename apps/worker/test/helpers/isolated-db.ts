import postgres from "postgres";
import { runMigrations } from "@mpc/db";

/**
 * 이 파일 전용 데이터베이스에 붙는다.
 *
 * **outbox 조회는 tenant 경계를 넘는다.** worker가 모든 tenant의 이벤트를
 * 발행하는 것이 설계다(0012). 그래서 다른 테스트 파일과 DB를 공유하면 그쪽이
 * 넣은 행이 `LIMIT` 안에 먼저 들어와 이 파일의 행을 배치 밖으로 밀어낸다.
 * 발행은 정상인데 단언만 깨지는 간헐 실패가 된다.
 *
 * 프로덕션의 전역 스코프를 테스트 편의로 좁히지 않는다 — 좁히면 worker가
 * 무엇을 보는지가 테스트와 운영에서 달라진다. 대신 DB를 나눈다.
 */
export async function connectIsolated(suffix: string): Promise<postgres.Sql> {
  const base = process.env["DATABASE_URL"];
  if (!base) throw new Error("DATABASE_URL이 필요하다");

  const url = new URL(base);
  const database = `${decodeURIComponent(url.pathname.slice(1))}_${suffix}`;

  const admin = postgres(base, { onnotice: () => {}, max: 1 });
  try {
    // CREATE DATABASE는 파라미터화할 수 없다. suffix는 호출부의 리터럴이다.
    await admin.unsafe(`CREATE DATABASE "${database}"`);
  } catch (error) {
    // 42P04 = duplicate_database. 이미 있으면 그대로 쓴다.
    if ((error as { code?: string }).code !== "42P04") throw error;
  } finally {
    await admin.end();
  }

  url.pathname = `/${encodeURIComponent(database)}`;
  const sql = postgres(url.toString(), { onnotice: () => {} });
  await runMigrations(sql);

  // 앞선 실행이 남긴 미발행 행은 이번 실행의 배치를 밀어낸다. 같은 이유로
  // 격리했으므로 시작 상태도 비워 둔다.
  await sql`TRUNCATE core.outbox, core.inbox`;

  return sql;
}
