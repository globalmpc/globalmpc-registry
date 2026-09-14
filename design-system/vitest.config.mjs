import { defineConfig } from "vitest/config";

/**
 * design-system 자체 설정. 이 파일이 없으면 vitest가 상위 디렉터리의
 * 저장소 루트 `vitest.config.ts`를 집어 그 `projects`(apps/api 등)를 이 폴더
 * 기준으로 찾다가 기동에 실패한다.
 */
export default defineConfig({
  test: {
    include: ["test/**/*.test.{js,mjs,ts}"],
  },
});
