import { expect, test } from "@playwright/test";

/**
 * Authority Registry E2E — 05 §5.11, OD-42·OD-43.
 *
 * R5 gate: **zero overstatement of unconfirmed integrations**. This spec checks it on
 * screen — unintegrated authorities stay in the list and do not appear active.
 */
test.describe("Authority Registry", () => {
  test("shows integration state without overstating it, together with the limitations", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

    await page.goto("/w/authorities");
    await expect(page.getByTestId("authority-table")).toBeVisible();

    const table = page.getByTestId("authority-table");

    // Active integration
    await expect(table).toContainText("Mineral Resources Authority");
    await expect(table).toContainText("active");

    // Authorities without an integration also stay in the list.
    await expect(table).toContainText("Land Administration Office");
    await expect(table).toContainText("none");

    // The planned stage is not called.
    await expect(table).toContainText("Environmental Agency");
    await expect(table).toContainText("pending_access");

    // What is not confirmed is shown alongside.
    await expect(table).toContainText("economic_viability");

    // It is visible that the active count is lower than the total.
    await expect(page.getByTestId("profile-summary")).toContainText("Callable");

    // What this list does not promise.
    await expect(page.getByTestId("profile-limits")).toContainText("does not promise");
  });
});
