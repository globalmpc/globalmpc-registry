import { openFooterMenu, openPublicLookup } from "./disclosures";
import { expect, test } from "@playwright/test";

/**
 * Public surface E2E — spec 11 §11.2 and §11.3.
 *
 * Checks what the public screens say **without sign-in**. Checking only that screens
 * render would not distinguish this from a mockup, so it checks whether boundaries
 * decided by the server reach the screen — does only published data appear, and is
 * it stated what is not confirmed.
 */

test.describe("public entry point", () => {
  test("signed-out `/` is not the account connection screen", async ({ page }) => {
    await page.goto("/");

    // This used to be the sign-in screen. Guards against that regression.
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /Verification Registry/ }),
    ).toBeVisible();
  });

  test("explains integrity and readiness without repeating the destination list", async ({ page }) => {
    await page.goto("/");

    await page.getByText("About these records", { exact: true }).click();
    await expect(page.getByText(/Integrity proofs show whether a record has changed/)).toBeVisible();
    await expect(page.getByText(/Evidence readiness does not authorize/)).toBeVisible();
  });

  test("account connection remains available as a link", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("banner").getByRole("link", { name: /Sign in/ }).click();

    await expect(page).toHaveURL(/\/connect$/);
    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  });

  test("the header also leads to account connection", async ({ page }) => {
    await page.goto("/explorer");
    await page.getByRole("banner").getByRole("link", { name: /Sign in/ }).click();

    await expect(page).toHaveURL(/\/connect$/);
  });
});

test.describe("public navigation (11 §11.2)", () => {
  test("keeps important disclosures visible and advanced tools grouped", async ({ page }) => {
    await page.goto("/");
    await openFooterMenu(page);
    const nav = page.getByRole("contentinfo").getByRole("navigation");

    for (const label of ["Advanced record search", "Verification records", "Verify a proof", "Protocol governance"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Disclosures & incidents", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Asset Registry", exact: true })).toHaveCount(0);
  });
});

test.describe("public unified search", () => {
  test("an unknown hash is reported as an empty result, not a permission problem", async ({ page }) => {
    await page.goto("/explorer");
    await openPublicLookup(page);
    await page.getByLabel("Find a record").fill(`0x${"ab".repeat(32)}`);
    await page.getByTestId("global-search-submit").click();

    await expect(page).toHaveURL(/\/explorer\/search\?q=0x/);
    await expect(page.getByTestId("search-empty")).toContainText(/not a permission problem/);
  });

  test("states, with the reason, that wallet addresses are not searchable", async ({ page }) => {
    await page.goto(`/explorer/search?q=0x${"12".repeat(20)}`);
    await expect(page.getByTestId("search-address-notice")).toBeVisible();
  });
});

test.describe("Explorer list", () => {
  test("published records appear without knowing a publicKey", async ({ page }) => {
    await page.goto("/explorer");

    const list = page.getByTestId("public-registry-list");
    await expect(list).toBeVisible();
    // A table appears if the seed published records, otherwise an empty-state notice.
    // Either way it must not be an "enter a search term first" state.
    await expect(list.locator(".public-project-list, [data-testid=public-registry-empty]")).not.toHaveCount(0);
  });

  test("distinguishes an empty result from a permission problem", async ({ page }) => {
    await page.goto("/explorer");
    await page.getByLabel("Search").fill("ZZZ-NOTHING-MATCHES-THIS-ZZZ");
    await page.getByLabel("Search").press("Enter");

    await expect(page.getByTestId("public-registry-empty")).toContainText(
      /Nothing published matches/,
    );
  });
});

test.describe("Proof Verifier", () => {
  test("exists as a standalone screen and states that the browser recomputes", async ({ page }) => {
    await page.goto("/verify");

    await expect(page.getByRole("heading", { name: "Proof Verifier" })).toBeVisible();
    await expect(page.getByText(/recomputed in your browser/)).toBeVisible();
  });

  test("distinguishes not-yet-anchored from a proof failure", async ({ page }) => {
    await page.goto("/verify");
    await page.getByRole("button", { name: "By version id" }).click();
    // A version id that does not exist. The server returns 404 and the screen must say
    // "not yet" — drawing it as a red failure reads as "the proof is broken".
    await page
      .getByLabel("Entry version id")
      .fill("00000000-0000-4000-8000-000000000000");
    await page.getByRole("button", { name: "Check proof" }).click();

    await expect(page.getByTestId("verify-not-anchored")).toBeVisible();
  });
});

test.describe("Asset Registry", () => {
  test("states the reason for inactivity and the remaining gates", async ({ page }) => {
    await page.goto("/asset-registry");

    await expect(page.getByTestId("asset-registry-status")).toContainText(
      /Inactive by decision, not by omission/,
    );
    // No trading path is built (OD-07). There must be no CTA in that direction.
    await expect(page.getByRole("button", { name: /Subscribe|Buy|Order|Transfer/ })).toHaveCount(0);
    // The basis column must carry decision numbers. A gate list without a basis is a roadmap.
    await expect(page.getByRole("cell", { name: /^OD-17 ·/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /^OD-18 ·/ })).toBeVisible();
  });
});

test.describe("Disclosures & Incidents", () => {
  test("the screen states which incident types it does not cover", async ({ page }) => {
    await page.goto("/disclosures");

    // Keeps an empty list from being read as "that never happened".
    //
    // Since the 2026-09-09 decision, only credential revocation remains — its "record" is
    // **a person**, so it cannot be expressed by the "happened + when + which record" rule.
    const scope = page.getByTestId("disclosure-not-covered");
    await expect(scope).toContainText("credential_revocation");

    // These three are now covered. If they remain here, the screen still states the old scope.
    for (const covered of ["suspension", "pause", "dispute"]) {
      await expect(scope).not.toContainText(covered);
    }
  });
});

test.describe("Governance", () => {
  test("opens without sign-in and contains no voter list", async ({ page }) => {
    await page.goto("/governance");

    await expect(page.getByRole("heading", { name: "Governance", exact: true })).toBeVisible();
    await expect(page.getByTestId("public-governance-list")).toBeVisible();
    // The tally is the basis for the outcome, but not a list of voters (AC-32).
    await expect(page.getByText(/Voter A|voter_subject/)).toHaveCount(0);
  });
});
