import { execFileSync } from "node:child_process";
import { connect } from "node:net";
import postgres from "postgres";

/**
 * Prepares the DB before the servers start.
 *
 * Runs the seed as a child process instead of importing it. Playwright loads the
 * config as CJS, but `@mpc/db` is an ESM module that locates its migrations via
 * `import.meta.url`, so a direct import breaks. A separate process lets tsx run it as ESM.
 */

/**
 * Keeps two runs from overlapping on the same DB.
 *
 * **Why:** the seed **drops and recreates the whole schema.** When a second run
 * starts, the first run's tables vanish underneath it, and the first run fails
 * because it cannot find the projects it created. The cause is not the run itself,
 * so it is **easy to mistake for a code problem** — three cases were misinvestigated that way.
 *
 * An advisory lock is used because **it releases itself when the process dies.** A file
 * lock or a table row leaves traces of a killed run that block the next run.
 *
 * The lock lives only as long as this connection. That is why the connection stays
 * open after globalSetup finishes and is held until teardown.
 */
const LOCK_KEY = 0x6d70_6332; // "mpc2" — denotes one E2E run of this repository.

let lockConnection: postgres.Sql | undefined;

async function acquireRunLock(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  const [row] = await sql<{ locked: boolean }[]>`
    SELECT pg_try_advisory_lock(${LOCK_KEY}) AS locked
  `;

  if (!row?.locked) {
    await sql.end({ timeout: 5 });
    throw new Error(
      [
        "Another run is already attached to the same E2E database.",
        "",
        "  The seed recreates the whole schema, so when two runs overlap the one that",
        "  started first loses its data. That failure looks like a code problem.",
        "",
        "  Wait for it to finish, or pass a different `E2E_DATABASE_URL`.",
      ].join("\n"),
    );
  }

  lockConnection = sql;
}

/**
 * Reports whether an already-running server is being reused.
 *
 * `reuseExistingServer` in `playwright.config.ts` is on outside CI. If something is
 * listening on the port, playwright **uses it as is without applying its own `env`.**
 *
 * **So changing the config does nothing.** On 2026-09-09 a 12-minute run was wasted
 * that way — `RATE_LIMIT_MAX` was raised, but the old server was reused, the failure
 * persisted, and the search went elsewhere on the assumption the config was wrong.
 *
 * This does not block. Starting your own server and running with `E2E_SKIP_SEED=1`
 * is a normal flow. **It only fixes the silence.**
 */
async function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host: "127.0.0.1" });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function warnAboutReusedServers(): Promise<void> {
  const reused = (
    await Promise.all(
      [
        { port: 3001, name: "API" },
        { port: 3000, name: "web" },
      ].map(async (server) => ((await isListening(server.port)) ? server : null)),
    )
  ).filter((server) => server !== null);

  if (reused.length === 0) return;

  const names = reused.map((server) => `${server.name}(:${server.port})`).join(" · ");
  process.stdout.write(
    [
      `Reusing already-running servers — ${names}`,
      "  The env in playwright.config.ts does not apply to them. If you changed the config,",
      "  stop those processes first.",
      "",
    ].join("\n"),
  );
}

/**
 * Checks that the DB the seed writes to is the DB the app connects to.
 *
 * **There are two URLs.** The seed connects as a superuser, the app as a role under
 * RLS. Override only one and the other falls back to the default (port 55432), and
 * at that moment **the seed and the app see different databases.**
 *
 * The symptom is nasty. Even if the app's DB does not exist, the API starts and the
 * public screens render empty and pass. **Only what requires sign-in breaks** — the
 * screen shows only "Sign-in failed" and says nothing about the DB anywhere.
 *
 * On 2026-09-09, 42 failures in this state were mistaken for code problems and three
 * hours were spent. User and password may differ, so only **host, port and database
 * name** are compared.
 */
function assertAppUrlMatchesSeed(seedUrl: string, appUrl: string | undefined): void {
  if (!appUrl) return;

  const target = (raw: string): string => {
    const parsed = new URL(raw);
    return `${parsed.hostname}:${parsed.port}${parsed.pathname}`;
  };

  const seedTarget = target(seedUrl);
  const appTarget = target(appUrl);
  if (seedTarget === appTarget) return;

  throw new Error(
    [
      "The DB the seed writes to differs from the DB the app connects to.",
      "",
      `  seed  → ${seedTarget}   (E2E_DATABASE_URL)`,
      `  app   → ${appTarget}   (E2E_APP_DATABASE_URL)`,
      "",
      "  In this state only the public screens pass and everything that requires sign-in breaks.",
      "  The screens do not show the cause.",
      "",
      "  Set both, or use the defaults for both.",
    ].join("\n"),
  );
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  // `playwright.config.ts` puts this value into the environment. The default lives
  // only there and not here — once the two places had diverging ports, the seed saw
  // 55433, the app 55432, and the screens kept showing an old seed.
  const url = process.env["E2E_DATABASE_URL"];
  if (!url) {
    throw new Error("E2E_DATABASE_URL is missing. Run through playwright.config.ts.");
  }

  assertAppUrlMatchesSeed(url, process.env["E2E_APP_DATABASE_URL"]);
  await acquireRunLock(url);
  await warnAboutReusedServers();

  // The seed recreates the whole schema. Any process attached from outside, such as
  // the anchor worker, is cut off mid-run. In that setup the caller runs the seed
  // first and it is skipped here.
  //
  // **The lock is taken even then.** A run that skips the seed uses the same DB, so
  // overlapping runs see each other's data.
  if (process.env["E2E_SKIP_SEED"] === "1") {
    process.stdout.write("E2E seed skipped (E2E_SKIP_SEED=1)\n");
  } else {
    execFileSync("pnpm", ["exec", "tsx", "e2e/seed-cli.ts"], {
      cwd: __dirname + "/..",
      env: { ...process.env, DATABASE_URL: url },
      stdio: "inherit",
    });
  }

  return async () => {
    // Closing the connection also releases the lock. It is released explicitly so
    // that a failure leaves in the log what went wrong.
    if (!lockConnection) return;
    await lockConnection`SELECT pg_advisory_unlock(${LOCK_KEY})`.catch(() => undefined);
    await lockConnection.end({ timeout: 5 }).catch(() => undefined);
    lockConnection = undefined;
  };
}
