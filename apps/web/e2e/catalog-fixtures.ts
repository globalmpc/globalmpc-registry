/**
 * Claim-type keys of the synthetic catalog fixtures the evidence ledger journeys propose.
 *
 * **Why per attempt:** the seed runs once per Playwright invocation (CI even shares one seed
 * across shards), but a failed test is retried against the same DB. A catalog key is a
 * tenant-wide registry item, so a retry reusing the first attempt's key either hits
 * `REGISTRY_PROPOSAL_PENDING` (the first attempt stopped before approval) or approves catalog
 * version 2 (it stopped after), and the retry fails for a reason that has nothing to do with
 * the original failure. A fresh key per attempt keeps every attempt on catalog version 1.
 *
 * The seeded reviewer credential and its issuer must recognize every key an attempt can use,
 * so seed and specs both derive them from here.
 */

/** Upper bound for Playwright retries. The config uses it, so the seed covers every attempt. */
export const E2E_MAX_RETRIES = 1;

export const CATALOG_FIXTURE_BASES = [
  "synthetic_chain_licence",
  "synthetic_chain_permit",
  "synthetic_ledger_licence",
] as const;
export type CatalogFixtureBase = (typeof CATALOG_FIXTURE_BASES)[number];

/** The key for one attempt (`test.info().retry`). Keys stay within `^[a-z][a-z0-9_]{0,99}$`. */
export function catalogFixtureKey(base: CatalogFixtureBase, retry: number): string {
  if (!Number.isInteger(retry) || retry < 0 || retry > E2E_MAX_RETRIES) {
    // A higher --retries would use a key the seeded credential does not recognize, and the
    // review would fail with a misleading credential-scope error.
    throw new Error(
      `Retry ${retry} exceeds E2E_MAX_RETRIES (${E2E_MAX_RETRIES}); raise it in e2e/catalog-fixtures.ts`,
    );
  }
  return `${base}_r${retry}`;
}

/** Every key any attempt can use — what the seed's credential and issuer scope must cover. */
export const CATALOG_FIXTURE_KEYS: readonly string[] = CATALOG_FIXTURE_BASES.flatMap((base) =>
  Array.from({ length: E2E_MAX_RETRIES + 1 }, (_, retry) => catalogFixtureKey(base, retry)),
);
