import type postgres from "postgres";

/**
 * tenant 세션 컨텍스트.
 *
 * 02 §2.5: 모든 쿼리는 tenant scope 안에서 실행된다. RLS 정책이
 * `app.current_tenant`를 읽으므로, 이 함수를 거치지 않은 쿼리는 아무 행도 보지
 * 못한다. 기본값이 "전부 허용"이 아니라 "아무것도 없음"인 것이 의도다.
 */
export interface TenantContext {
  readonly tenantId: string;
  readonly projectId?: string;
}

export async function withTenant<T>(
  sql: postgres.Sql,
  context: TenantContext,
  work: (tx: postgres.TransactionSql) => Promise<T>,
): Promise<T> {
  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.current_tenant', ${context.tenantId}, true)`;
    if (context.projectId !== undefined) {
      await tx`SELECT set_config('app.current_project', ${context.projectId}, true)`;
    }
    return work(tx);
  }) as Promise<T>;
}
