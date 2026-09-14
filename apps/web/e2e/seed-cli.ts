import { seedE2eDatabase } from "./seed";

/**
 * Entry point for running the seed.
 *
 * Does not use top-level await. `apps/web` is a Next.js app, so its package.json
 * has no `type: module`, and tsx transpiles this file to CJS.
 */
const url = process.env["DATABASE_URL"];

if (!url) {
  process.stderr.write("DATABASE_URL is required\n");
  process.exit(1);
}

seedE2eDatabase(url)
  .then(() => {
    process.stdout.write("E2E seed done\n");
  })
  .catch((error: unknown) => {
    process.stderr.write(`E2E seed failed: ${String(error)}\n`);
    process.exit(1);
  });
