import { defineConfig, devices } from "@playwright/test";
import { generatePrivateKey } from "viem/accounts";

/**
 * 데모 계정 키를 **실행할 때 만든다.**
 *
 * 저장소에 두면 그것을 아는 누구나 배포된 주소에서 그 역할로 로그인한다. 지운
 * 뒤에도 과거 커밋에 남으므로, 애초에 넣지 않는다.
 *
 * 같은 값이 세 곳으로 간다 — 웹(계정 카드와 서명), seed(role_bindings가 붙을
 * 주소), 그리고 worker 프로세스. worker는 이 설정 파일을 다시 읽으므로 여기서
 * 새로 만들면 runner와 어긋난다. 이미 있으면 그것을 쓴다.
 */
const DEMO_ACCOUNT_LABELS = [
  "Operator A",
  "Operator B",
  "Operator C",
  "Reader A",
  "Steward A",
  "Approver A",
  "Reviewer A",
  "Proposer A",
  "Voter A",
  "Scan Service",
] as const;

const DEMO_ACCOUNT_KEYS =
  process.env["E2E_DEMO_ACCOUNT_KEYS"] ??
  JSON.stringify(
    Object.fromEntries(DEMO_ACCOUNT_LABELS.map((label) => [label, generatePrivateKey()])),
  );

// globalSetup과 seed-cli는 자식 프로세스다. 환경으로 물려준다.
process.env["E2E_DEMO_ACCOUNT_KEYS"] = DEMO_ACCOUNT_KEYS;

/**
 * E2E 설정.
 *
 * API와 웹을 함께 띄운다. 웹만 띄우면 화면은 렌더되지만 실제 데이터가 흐르는지
 * 검증할 수 없다 — 목업과 다를 게 없어진다.
 *
 * DB는 E2E 전용(`mpc_e2e`)을 쓴다. globalSetup이 스키마를 새로 만들고 고정 계정을
 * seed한다.
 */

/**
 * 기본값은 `docker-compose.yml`의 postgres가 노출하는 포트(55432)를 가리킨다.
 *
 * 호스트의 5432를 피해 옮긴 포트이므로 여기 기본값이 그것과 어긋나면 env를 주지
 * 않은 로컬 실행이 접속부터 실패한다. DB 이름만 `mpc_e2e`로 갈라 `mpc_dev`를
 * 건드리지 않는다 — globalSetup이 스키마를 매번 드롭하고 다시 만든다.
 *
 * 그 DB는 compose가 만들지 않는다. 처음 한 번만 직접 만든다.
 *
 *   createdb -h localhost -p 55432 -U postgres mpc_e2e
 *
 * CI는 자체 postgres service를 쓰므로 두 URL을 env로 덮어쓴다.
 */
const SUPERUSER_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:55432/mpc_e2e";
const APP_URL =
  process.env["E2E_APP_DATABASE_URL"] ??
  "postgres://mpc_app_login:app@localhost:55432/mpc_e2e";

// globalSetup은 자식이 아니라 같은 프로세스에서 돌지만 seed는 자식 프로세스다.
// 여기서 환경에 못 박아 **기본값이 두 곳에 각각 있는 상태**를 없앤다 — 갈리면
// seed가 다른 DB에 들어가고, 앱은 예전 데이터를 보며 조용히 어긋난다.
process.env["E2E_DATABASE_URL"] = SUPERUSER_URL;
/**
 * 앱 URL도 같이 못 박는다.
 *
 * 위 주석의 사고가 **한 번 더 형태를 바꿔 일어났다.** `E2E_DATABASE_URL`만 주고
 * `E2E_APP_DATABASE_URL`을 두면 seed는 준 DB에 들어가고 **API는 기본값의 DB에
 * 붙는다.** 그 DB가 없으면 API는 뜨긴 하지만 아무것도 읽지 못한다 — 공개 화면은
 * 빈 상태로 잘 렌더되므로 통과하고, **로그인이 필요한 것만 전부 깨진다.**
 * 원인이 화면 어디에도 안 보여 코드 문제로 보인다.
 *
 * globalSetup이 이 값을 seed 대상과 대조한다.
 */
process.env["E2E_APP_DATABASE_URL"] = APP_URL;

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  reporter: process.env["CI"] ? [["github"], ["list"]] : [["list"]],

  globalSetup: "./e2e/global-setup.ts",

  /**
   * assertion 타임아웃 — 기본값 5초로는 부족하다.
   *
   * CI는 `reuseExistingServer: !CI` 때문에 항상 새 dev 서버를 띄우고, Next는
   * route를 **처음 접근할 때** 컴파일한다. 등록 직후 이동처럼 새 route로 가는
   * assertion이 첫 실행에서만 5초를 넘긴다.
   *
   * 재시도로 덮지 않는다 — 재시도는 두 번째에 route가 이미 컴파일돼 있어서
   * 통과하는 것이고, 그러면 "느린 경로"와 "깨진 경로"를 구분할 수 없다.
   */
  expect: { timeout: 15_000 },

  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: [
    {
      command: "pnpm --filter @mpc/api start",
      cwd: "../..",
      port: 3001,
      reuseExistingServer: !process.env["CI"],
      timeout: 60_000,
      env: {
        DATABASE_URL: APP_URL,
        PORT: "3001",
        SIWE_DOMAIN: "localhost:3000",
        SIWE_URI: "http://localhost:3000",
        CHAIN_ID: "97",
        SESSION_SECRET: "e2e-session-secret-at-least-32-chars",
        NODE_ENV: "development",
        LOG_LEVEL: "warn",
        /**
         * 로그인 상한을 E2E 동안만 올린다.
         *
         * 기본값은 1분에 10회다(`AUTH_RATE_LIMIT_MAX`). 스펙 하나가 여러 역할로
         * 갈아타며 로그인하므로 한 실행에서 그 값을 훌쩍 넘고, 넘는 순간 429가
         * 로그인 실패로 나타나 **원인과 무관한 테스트가 깨진다.** 상한 자체를
         * 낮게 유지하는 것이 목적이므로 기본값은 건드리지 않는다.
         */
        AUTH_RATE_LIMIT_MAX: "1000",
        /**
         * 일반 상한도 E2E 동안만 올린다 — 2026-09-10 실사.
         *
         * 여기가 비어 있어서 기본값 300회/분이 그대로 걸렸다. **E2E의 모든
         * 요청은 한 요청자로 셈된다** — Playwright가 API를 직접 부르므로
         * `request.ip`가 전부 127.0.0.1이다. 74개 스펙이 병렬로 돌면 1분 안에
         * 300을 넘고, 넘는 순간 429가 **원인과 무관한 실패**로 나타난다.
         *
         * 실제로 `review-lifecycle.spec.ts:42`의 역할 전환이 그렇게 끊겼다:
         * 화면에 `No account connected`와 `429 RATE_LIMITED`가 같이 남았고
         * 자동 재시도에서 통과해 flaky로 보였다.
         *
         * 상한 자체를 낮게 두는 것이 목적이므로 기본값은 건드리지 않는다.
         * 상한 동작을 보는 시험은 `rate-limit.test.ts`가 따로 갖는다.
         */
        RATE_LIMIT_MAX: "20000",
      },
    },
    {
      // `--webpack` 플래그는 `package.json`의 dev 스크립트가 갖는다. 여기서 next를
      // 직접 부르면 플래그가 두 곳으로 갈린다.
      command: "pnpm dev",
      port: 3000,
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
      env: {
        // E2E는 데모 계정으로 로그인한다. 이 값이 없으면 로그인 화면에 계정이
        // 없어 모든 스펙이 첫 단계에서 멈춘다. 배포 빌드는 이 값을 주지 않으므로
        // 데모 계정이 생기지 않는다.
        NEXT_PUBLIC_DEMO_ACCOUNT_KEYS: DEMO_ACCOUNT_KEYS,
      },
    },
  ],

  metadata: { superuserDatabaseUrl: SUPERUSER_URL },
});
