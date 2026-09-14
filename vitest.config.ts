import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/api", "apps/worker", "apps/web"],
    /**
     * DB 테스트가 같은 PostgreSQL 인스턴스를 공유한다.
     * `packages/db`는 스키마 lifecycle 자체를 검증하므로 DROP SCHEMA를 하고,
     * `apps/*`는 그 위에서 고유 tenant로 격리한다. 병렬로 돌면 한쪽의 DROP이
     * 다른 쪽의 테스트 중간에 끼어든다.
     *
     * **`fileParallelism`만으로는 막히지 않는다.** 이 값은 project 안에서만
     * 적용되고, project 사이에는 걸리지 않는다 — `packages/db`의 마이그레이션과
     * `apps/api`의 `setupFixture`가 동시에 돌아
     * `duplicate key value violates unique constraint "pg_namespace_nspname_index"`
     * 로 깨진다. worker를 하나로 묶어야 project 경계까지 직렬이 된다.
     *
     * 측정(2026-09-09): 이 두 줄이 없으면 4회 중 3회 실패, 있으면 5회 중 5회 통과.
     * 소요는 33s로 동일하다 — 병렬이 실제로 벌어 주는 시간이 없다.
     */
    fileParallelism: false,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
