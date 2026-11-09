import { BUILT_SERVER } from "./e2e/server-mode";
import { defineConfig, devices } from "@playwright/test";
import { generatePrivateKey } from "viem/accounts";
import { E2E_MAX_RETRIES } from "./e2e/catalog-fixtures";
import { DEMO_PEOPLE } from "./e2e/demo-people";

/**
 * The demo people's keys are **generated at run time** (`e2e/demo-people.ts`).
 *
 * Each person signs in as an account — an emailed code, then a passkey — and holds a wallet that
 * only signs. Both keys are made here: a key in the repository would let anyone who knows it act
 * as that role wherever the seed ran, and it would stay in past commits after deletion.
 *
 * The same value goes to the seed (the addresses role bindings attach to, and the passkeys'
 * public keys, derived from these keys) and to the specs (the wallet that signs, the virtual
 * authenticator that answers). Workers re-read this config file, so generating new keys here
 * would diverge from the runner; a value already in the environment is reused. The web gets none.
 */
const DEMO_ACCOUNT_KEYS =
  process.env["E2E_DEMO_ACCOUNT_KEYS"] ??
  JSON.stringify(Object.fromEntries(DEMO_PEOPLE.map((label) => [label, generatePrivateKey()])));

// globalSetup and seed-cli are child processes. Pass values down through the environment.
process.env["E2E_DEMO_ACCOUNT_KEYS"] = DEMO_ACCOUNT_KEYS;

// The scan service's token is derived from these keys (`e2e/scan-service-token.ts`), so the seed
// step and every shard agree on it without another variable to pass between CI steps.

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
 * The default points at the port exposed by postgres in `docker/docker-compose.yml` (55432).
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

/**
 * Ports — 3000 (web) and 3001 (API) unless `E2E_WEB_PORT` / `E2E_API_PORT` say otherwise.
 *
 * A second checkout can then run the suite beside a development stack that already holds the
 * default ports, instead of being handed that stack's servers by `reuseExistingServer` (which
 * applies none of the env below). CI sets neither, so it runs exactly as before.
 *
 * The web origin is also the WebAuthn origin (its host is the relying party) and the base of
 * invitation links, so everything that names it derives from the one port.
 */
const WEB_PORT = Number(process.env["E2E_WEB_PORT"] ?? 3000);
const API_PORT = Number(process.env["E2E_API_PORT"] ?? 3001);
const WEB_ORIGIN = `http://localhost:${WEB_PORT}`;
/** The mock Google / Microsoft (`e2e/oidc-relay.ts`); 3102 unless `E2E_OIDC_PORT` says otherwise. */
const OIDC_PORT = Number(process.env["E2E_OIDC_PORT"] ?? 3102);
process.env["E2E_WEB_PORT"] = String(WEB_PORT);
process.env["E2E_API_PORT"] = String(API_PORT);
process.env["E2E_OIDC_PORT"] = String(OIDC_PORT);

/**
 * The OIDC clients the mock provider serves — the values of `TEST_GOOGLE_CLIENT` and
 * `TEST_MICROSOFT_CLIENT` in `apps/api/test/helpers/mock-oidc.ts`, which the relay runs. Test
 * values for a provider that exists only in this process tree; written out because that module
 * is ESM-only and this config is loaded as CommonJS.
 */
const MOCK_OIDC_ENV = {
  OIDC_TEST_RELAY_URL: `http://127.0.0.1:${OIDC_PORT}`,
  GOOGLE_CLIENT_ID: "test-google-client.apps.example",
  GOOGLE_CLIENT_SECRET: "test-google-client-secret",
  MICROSOFT_CLIENT_ID: "5b4f3a2c-0000-4000-8000-00000000c1d1",
  MICROSOFT_CLIENT_SECRET: "test-microsoft-client-secret",
  // The directory the mock's Microsoft tokens name (`e2e/oidc.ts` MOCK_MICROSOFT_TENANT).
  MICROSOFT_ALLOWED_TENANTS: "11111111-1111-4111-8111-111111111111",
};

export default defineConfig({
  testDir: "./e2e",
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  // The seed recognizes catalog fixture keys for this many retries (e2e/catalog-fixtures.ts).
  retries: process.env["CI"] ? E2E_MAX_RETRIES : 0,
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
    baseURL: WEB_ORIGIN,
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
      // Google and Microsoft for the account specs: the provider's back channel for the API and
      // the person's approval for the specs. Loopback only; never built or deployed.
      command: "node e2e/server-process.mjs oidc pnpm exec tsx e2e/oidc-relay.ts",
      stdout: "pipe",
      stderr: "pipe",
      url: `http://127.0.0.1:${OIDC_PORT}/__e2e/health`,
      reuseExistingServer: !process.env["CI"],
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 30_000,
      env: { E2E_OIDC_PORT: String(OIDC_PORT) },
    },
    {
      command: "node apps/web/e2e/server-process.mjs api pnpm --filter @mpc/api start",
      stdout: "pipe",
      stderr: "pipe",
      cwd: "../..",
      port: API_PORT,
      reuseExistingServer: !process.env["CI"],
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 60_000,
      env: {
        DATABASE_URL: APP_URL,
        PORT: String(API_PORT),
        // Invitation links and the passkey origin and relying party (`localhost`).
        WEB_ORIGIN,
        // Sign-in codes go to `core.email_outbox`, which the account specs read (`e2e/mailbox.ts`).
        EMAIL_TRANSPORT: "log",
        // Google and Microsoft through the mock provider (`e2e/oidc-relay.ts`). The relay URL is
        // refused in production by the API's own config check.
        ...MOCK_OIDC_ENV,
        CHAIN_ID: "31337",
        SESSION_SECRET: "e2e-session-secret-at-least-32-chars",
        NODE_ENV: "development",
        LOG_LEVEL: "warn",
        /**
         * Raise the login limit only during E2E.
         *
         * The default is 10 per minute (`AUTH_RATE_LIMIT_MAX`). A single spec switches between several
         * people, and a person's first switch is a real sign-in, so one run easily exceeds that, and once exceeded a 429 shows up as
         * a login failure and **breaks tests unrelated to the cause.** The goal is to keep the limit
         * itself low, so the default is left unchanged.
         */
        AUTH_RATE_LIMIT_MAX: "1000",
        /**
         * Raise the general limit only during E2E as well.
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
      // Build once before E2E when selected; local development retains next dev.
      command: `node e2e/server-process.mjs web pnpm ${BUILT_SERVER ? "start" : "dev"} --port ${WEB_PORT}`,
      stdout: "pipe",
      stderr: "pipe",
      port: WEB_PORT,
      reuseExistingServer: !process.env["CI"],
      gracefulShutdown: { signal: "SIGTERM", timeout: 10_000 },
      timeout: 120_000,
      env: {
        NODE_ENV: BUILT_SERVER ? "production" : "development",
        // Webpack's dev server retains compiled routes throughout the browser suite.
        // Bound its heap so it collects before starving Chromium/API on shared CI hosts.
        // Next's dev server restarts itself as the heap nears this bound, and the requests in
        // flight then fail with ERR_CONNECTION_REFUSED (CI run 41522263991, public-surface.spec
        // :78, "approaching the used memory threshold, restarting"). With the WP6/WP7 routes,
        // 1536 MB was reached late in the suite; that runner's cgroup peaked at 4.8 of 16 GB
        // with no OOM event, so 3072 MB keeps a bound without the restart.
        NODE_OPTIONS: `${process.env["NODE_OPTIONS"] ?? ""} --max-old-space-size=3072`.trim(),
        // Where the proxy sends `/api/*`, and the origin its cross-site check expects (WP6).
        API_ORIGIN: `http://localhost:${API_PORT}`,
        WEB_ORIGIN,
      },
    },
  ],

  metadata: { superuserDatabaseUrl: SUPERUSER_URL },
});
