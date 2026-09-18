import { defineConfig, devices } from "@playwright/test";
import { generatePrivateKey } from "viem/accounts";

/**
 * Demo account keys are **generated at run time.**
 *
 * A key in the repository lets anyone who knows it log in with that role at the deployed address.
 * It stays in past commits even after deletion, so it is never committed in the first place.
 *
 * The same value goes to three places — the web (account cards and signing), seed (addresses that
 * role_bindings attach to), and worker processes. Workers re-read this config file, so generating
 * new keys here would diverge from the runner. If keys already exist, they are reused.
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

// globalSetup and seed-cli are child processes. Pass values down through the environment.
process.env["E2E_DEMO_ACCOUNT_KEYS"] = DEMO_ACCOUNT_KEYS;

/**
 * E2E configuration.
 *
 * Starts the API and the web together. With only the web, screens render but there is no way to
 * verify that real data flows — no different from a mockup.
 *
 * Uses an E2E-only DB (`mpc_e2e`). globalSetup recreates the schema and seeds fixed
 * accounts.
 */

/**
 * The default points at the port exposed by postgres in `docker-compose.yml` (55432).
 *
 * That port was moved off the host's 5432, so if the default here diverges, a local run
 * without env fails at connection. Only the DB name differs (`mpc_e2e`) so `mpc_dev`
 * is not touched — globalSetup drops and recreates the schema every time.
 *
 * compose does not create that DB. Create it manually once.
 *
 *   createdb -h localhost -p 55432 -U postgres mpc_e2e
 *
 * CI uses its own postgres service, so both URLs are overridden via env.
 */
const SUPERUSER_URL =
  process.env["E2E_DATABASE_URL"] ?? "postgres://postgres:postgres@localhost:55432/mpc_e2e";
const APP_URL =
  process.env["E2E_APP_DATABASE_URL"] ??
  "postgres://mpc_app_login:app@localhost:55432/mpc_e2e";

// globalSetup runs in the same process, not a child, but seed is a child process.
// Pinning the value in the environment here removes **defaults living in two places** — if they diverge,
// seed goes into another DB and the app silently diverges while reading old data.
process.env["E2E_DATABASE_URL"] = SUPERUSER_URL;
/**
 * Pin the app URL as well.
 *
 * The incident in the comment above **happened again in another form.** Setting only `E2E_DATABASE_URL`
 * and leaving `E2E_APP_DATABASE_URL` puts seed into the given DB while **the API connects to the
 * default DB.** If that DB is missing, the API starts but reads nothing — public screens
 * render fine in an empty state and pass, while **only things that need login all fail.**
 * The cause shows nowhere on screen, so it looks like a code problem.
 *
 * globalSetup checks this value against the seed target.
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
   * Assertion timeout — the default 5 seconds is not enough.
   *
   * Because of `reuseExistingServer: !CI`, CI always starts a fresh dev server, and Next compiles
   * a route **on first access**. Assertions that go to a new route, such as navigation right after
   * registration, exceed 5 seconds only on the first run.
   *
   * Not covered by retries — a retry passes because the route is already compiled the second time,
   * and then "slow path" cannot be told apart from "broken path".
   */
  expect: { timeout: 15_000 },

  use: {
    baseURL: "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },

  /**
   * Desktop for everything, plus one phone project for field uploads — spec 11 §11.9.
   *
   * Only uploads are held to the phone: review and approval stay desktop-first, and running every
   * spec twice would double the suite for screens that are not meant for a phone.
   */
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testIgnore: /mobile-upload\.spec\.ts/,
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
      testMatch: /mobile-upload\.spec\.ts/,
    },
  ],

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
         * Raise the login limit only during E2E.
         *
         * The default is 10 per minute (`AUTH_RATE_LIMIT_MAX`). A single spec logs in switching between
         * several roles, so one run easily exceeds that, and once exceeded a 429 shows up as
         * a login failure and **breaks tests unrelated to the cause.** The goal is to keep the limit
         * itself low, so the default is left unchanged.
         */
        AUTH_RATE_LIMIT_MAX: "1000",
        /**
         * Raise the general limit only during E2E as well — 2026-09-10 audit.
         *
         * This was empty, so the default 300/min applied as-is. **Every E2E
         * request counts as one requester** — Playwright calls the API directly, so
         * `request.ip` is always 127.0.0.1. With 74 specs running in parallel, 300 is exceeded
         * within a minute, and once exceeded a 429 appears as **a failure unrelated to the cause**.
         *
         * That is exactly how the role switch in `review-lifecycle.spec.ts:42` was cut off:
         * the screen showed both `No account connected` and `429 RATE_LIMITED`,
         * and it passed on automatic retry, so it looked flaky.
         *
         * The goal is to keep the limit itself low, so the default is left unchanged.
         * Tests of rate-limit behavior live separately in `rate-limit.test.ts`.
         */
        RATE_LIMIT_MAX: "20000",
      },
    },
    {
      // The `--webpack` flag lives in the dev script of `package.json`. Calling next directly
      // here would split the flag across two places.
      command: "pnpm dev",
      port: 3000,
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
      env: {
        // E2E logs in with demo accounts. Without this value the login screen has no
        // accounts and every spec stops at the first step. Deployment builds do not provide this value,
        // so no demo accounts exist there.
        NEXT_PUBLIC_DEMO_ACCOUNT_KEYS: DEMO_ACCOUNT_KEYS,
      },
    },
  ],

  metadata: { superuserDatabaseUrl: SUPERUSER_URL },
});
