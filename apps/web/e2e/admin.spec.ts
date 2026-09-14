import { expect, test, type Page } from "@playwright/test";

/**
 * Administration E2E.
 *
 * Before this screen existed, the only way to add a person to a deployed system was to
 * run a CLI on the server. What this checks is not "the screen renders" but **whether a
 * change started in the browser reaches the DB and comes back to the screen**.
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

test.describe("Administration", () => {
  test("adds a person without the CLI and sees them in the list", async ({ page }) => {
    const name = `Added in browser ${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByRole("button", { name: "Add person" }).click();

    await expect(page.getByTestId("admin-subjects")).toContainText(name);
    // Created with neither wallet nor role. Each is a separate, deliberate step.
    await expect(page.getByTestId("admin-locked")).toContainText(name);
  });

  test("the proposer has no decision button", async ({ page }) => {
    const name = `Grant target ${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByRole("button", { name: "Add person" }).click();
    await expect(page.getByTestId("admin-subjects")).toContainText(name);

    const row = page.getByTestId("admin-subjects").locator("tr", { hasText: name });
    await row.getByRole("button", { name: "Propose role" }).click();
    await page.getByRole("textbox", { name: "Role" }).fill("data_steward");
    await page.getByRole("textbox", { name: "Why" }).fill("Handles evidence registration");
    await page.getByRole("button", { name: "Propose", exact: true }).click();

    // 02 §2.8 — proposal and approval are done by different people. The server blocks it,
    // but a pressable button that is always rejected makes the screen look broken.
    const grants = page.getByTestId("admin-role-grants");
    await expect(grants).toContainText(name);
    await expect(grants.locator("tr", { hasText: name })).toContainText(
      "You proposed this — someone else decides.",
    );
    await expect(
      grants.locator("tr", { hasText: name }).getByRole("button", { name: "Approve" }),
    ).toHaveCount(0);
  });

  test("without admin permission, access is blocked with a reason", async ({ page }) => {
    await connectAs(page, "Steward A");
    await page.goto("/w/admin");

    await expect(page.getByTestId("error-notice")).toContainText("AUTHORIZATION_DENIED");
  });
});
