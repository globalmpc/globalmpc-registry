import { defineConfig } from "vitest/config";

/**
 * web의 단위 테스트만 잡는다.
 *
 * `e2e/`는 Playwright 스펙이다. 범위를 좁히지 않으면 vitest가 그 파일들을
 * 자기 테스트로 읽고 `@playwright/test`의 훅에서 곧바로 깨진다.
 */
export default defineConfig({
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
  },
});
