import { randomBytes } from "node:crypto";
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

  test("binds a wallet at the level the operator chose, only with what was checked", async ({ page }) => {
    // Q-032 — a fixed level left reviewer and approver roles below their minimum on any
    // wallet bound here. The level is now a choice, and the choice needs a stated basis.
    const name = `Wallet target ${Date.now()}`;
    const address = `0x${randomBytes(20).toString("hex")}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByRole("button", { name: "Add person" }).click();
    const row = page.getByTestId("admin-subjects").locator("tr", { hasText: name });
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: "Bind wallet" }).click();
    await page.getByRole("textbox", { name: "Wallet address" }).fill(address);
    await page.getByRole("combobox", { name: "Assurance level" }).selectOption("high_assurance");

    // No stated basis, no bind.
    const bind = page.getByRole("button", { name: "Bind", exact: true });
    await expect(bind).toBeDisabled();
    await page
      .getByRole("textbox", { name: "What you checked (required)" })
      .fill("ID document checked in person");
    await expect(bind).toBeEnabled();
    await bind.click();

    await expect(row.getByTestId("wallet-address")).toHaveText(address);
    await expect(row.getByTestId("wallet-assurance")).toHaveText("high_assurance");
  });

  test("the proposer of a revocation has no decision button", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    // A seeded person with one non-admin role. Tenant A has no second operator in the E2E seed,
    // so the proposal stays pending and the role itself is never revoked.
    const row = page.getByTestId("admin-subjects").locator("tr", { hasText: "Voter A" });
    await expect(row).toContainText("protocol_voter");

    // The seed runs once per run and CI retries once. On a retry the first attempt's proposal
    // is already open, and the row shows that instead of the button.
    const propose = row.getByRole("button", { name: "Propose revocation" });
    if ((await propose.count()) > 0) {
      await propose.click();
      await page.getByLabel("Revocation reason").selectOption("duty_change");
      await page.getByRole("textbox", { name: "What changed" }).fill("No longer votes for the protocol");
      await page.getByRole("button", { name: "Submit revocation" }).click();
    }

    // 02 §2.8 — the same rule as grants: a different person decides.
    await expect(row).toContainText("revocation pending");
    const revocations = page.getByTestId("admin-role-revocations");
    const pending = revocations.locator("tr", { hasText: "Voter A" });
    await expect(pending).toContainText("You proposed this — someone else decides.");
    await expect(pending.getByRole("button", { name: "Approve" })).toHaveCount(0);
  });

  test("the last approver cannot propose revoking their own role", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    // Operator A is the only approver in tenant A. Revoking that role would leave the tenant
    // recoverable only through the bootstrap CLI, so the server refuses the proposal.
    const row = page.getByTestId("admin-subjects").locator("tr", { hasText: "Operator A" });
    await row.getByRole("button", { name: "Propose revocation" }).click();
    await page.getByRole("textbox", { name: "What changed" }).fill("Stepping down");
    await page.getByRole("button", { name: "Submit revocation" }).click();

    await expect(page.getByTestId("error-notice")).toContainText("ROLE_REVOCATION_LAST_APPROVER");
    await expect(row).not.toContainText("revocation pending");
  });

  test("without admin permission, access is blocked with a reason", async ({ page }) => {
    await connectAs(page, "Steward A");
    await page.goto("/w/admin");

    await expect(page.getByTestId("error-notice")).toContainText("AUTHORIZATION_DENIED");
  });
});
