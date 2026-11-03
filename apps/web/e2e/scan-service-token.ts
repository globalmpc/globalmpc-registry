import { createHmac } from "node:crypto";

/**
 * The scan service's E2E token, derived from the run's demo account keys.
 *
 * The seed, every Playwright shard and every worker process are separate processes, and CI passes
 * only `E2E_DEMO_ACCOUNT_KEYS` between its steps (the seed runs as its own step before
 * Playwright). A token generated per process would differ between the seed that stores its hash
 * and the spec that sends it. Derived from those keys, it is the same everywhere in one run, new
 * on every run, and never committed — the same properties as the keys themselves.
 *
 * Fails without the keys rather than falling back to a fixed value: a fixed token would be a
 * usable credential in the repository.
 */
export function e2eScanServiceToken(env: NodeJS.ProcessEnv = process.env): string {
  const keys = env["E2E_DEMO_ACCOUNT_KEYS"];
  if (!keys) {
    throw new Error("E2E_DEMO_ACCOUNT_KEYS is unset. Run through playwright.config.ts.");
  }
  const secret = createHmac("sha256", keys).update("mpc/e2e/scan-service-token/v1").digest("base64url");
  return `mpcsvc_${secret}`;
}
