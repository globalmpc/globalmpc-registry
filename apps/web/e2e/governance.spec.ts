import { expect, test, type Page } from "@playwright/test";

/**
 * Governance E2E — 04 §4.5, OD-06.
 *
 * What this spec checks is not whether voting works but **whether the screen says what
 * a vote does not create**. The biggest risk of this screen is that a passed proposal
 * reads as "approved".
 */

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("Governance", () => {
  test.setTimeout(120_000);

  test("runs from proposal to close with the limitations always visible", async ({ page }) => {
    const title = `Proposal ${Date.now()}`;

    await connectAs(page, "Proposer A");
    await page.goto("/w/governance");

    // The boundary notice is always above the list.
    await expect(page.getByTestId("governance-boundary")).toContainText("no legal fact");

    // Cannot propose without a reason.
    await page.getByLabel("Title").fill(title);
    await expect(page.getByTestId("create-proposal")).toBeDisabled();

    await page.getByLabel("Rationale (required)").fill("The current schema cannot carry limitations");

    /**
     * The quorum denominator — 09 §9.6.
     *
     * Before the token is deployed, a person enters it. Voting cannot open without this
     * value — using the sum of cast votes as the denominator makes
     * `turnout × D >= turnout × N` always true, so `no_quorum` structurally never occurs.
     */
    await expect(page.getByTestId("create-proposal")).toBeDisabled();
    await page.getByLabel("Eligible weight (required)").fill("100");

    await page.getByTestId("create-proposal").click();

    const table = page.getByTestId("proposal-table");
    await expect(table).toContainText(title);

    const stateCell = page.locator('[data-testid^="proposal-state-"]').first();
    const proposalId = (await stateCell.getAttribute("data-testid"))!.replace(
      "proposal-state-",
      "",
    );
    await expect(stateCell).toHaveText("draft");

    // State changes also require a reason.
    await expect(page.getByTestId(`advance-review-${proposalId}`)).toBeDisabled();
    await page.getByLabel("Reason for the state change (required)").fill("Starting the review");

    for (const next of ["review", "announced", "voting"]) {
      await page.getByTestId(`advance-${next}-${proposalId}`).click();
      await expect(stateCell).toHaveText(next);
    }

    /**
     * States where the weight came from, next to the tally — 04 §4.5.
     *
     * Before the token is deployed, tallies use manually entered values. If the screen
     * does not say so, a manual tally reads as on-chain evidence.
     */
    await expect(page.getByTestId(`weight-source-${proposalId}`)).toContainText("Entered manually");

    // Also states the quorum denominator. A ratio alone does not say what it is a ratio of.
    await expect(page.getByTestId(`quorum-${proposalId}`)).toContainText("of 100");
    await expect(page.getByTestId(`quorum-${proposalId}`)).toContainText("entered manually");

    // --- Vote (protocol_voter) --------------------------------------------
    await connectAs(page, "Voter A");
    await page.goto("/w/governance");
    await page.getByLabel("Vote weight").fill("100");
    await page.getByTestId(`vote-for-${proposalId}`).click();
    await expect(page.getByTestId("proposal-table")).toContainText("For 100");

    // --- Close (proposer) -------------------------------------------------
    await connectAs(page, "Proposer A");
    await page.goto("/w/governance");
    await page.getByLabel("Reason for the state change (required)").fill("The for votes prevail");

    // Only the one outcome the tally indicates is offered. Showing all three would read as
    // choosing while ignoring the votes.
    await expect(page.getByTestId(`advance-defeated-${proposalId}`)).toHaveCount(0);
    await page.getByTestId(`advance-succeeded-${proposalId}`).click();

    await expect(page.locator(`[data-testid="proposal-state-${proposalId}"]`)).toHaveText(
      "succeeded",
    );

    // Even after passing, the limitation notice stays. Passing is not approval.
    await expect(page.getByTestId("governance-boundary")).toContainText(
      "does not happen automatically",
    );
  });

  test("voters cannot propose and proposers cannot vote", async ({ page }) => {
    await connectAs(page, "Voter A");
    await page.goto("/w/governance");
    // The proposal form itself is not shown.
    await expect(page.getByTestId("create-proposal")).toHaveCount(0);

    await connectAs(page, "Proposer A");
    await page.goto("/w/governance");
    await expect(page.getByLabel("Vote weight")).toHaveCount(0);
  });
});
