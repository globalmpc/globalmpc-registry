import { expect, test, type Page } from "@playwright/test";

/**
 * Review lifecycle E2E — 04 §4.2 and §4.4.
 *
 * The golden path goes in one direction only, "assign → sign". Real reviews have what
 * lies between — requesting changes when evidence is insufficient, and disputing after
 * a problem is found post-signature.
 *
 * What this spec checks:
 *
 * - State cannot change without a reason.
 * - The path taken stays on screen. Going back does not erase it.
 * - A dispute does not erase the signature.
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

test.describe("review lifecycle", () => {
  test.setTimeout(120_000);

  test("change requests and disputes remain on record", async ({ page }) => {
    const projectKey = `LIFE-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("For the review lifecycle check");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    // --- Claim and assignment (data_steward) ------------------------------
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(page.getByText("mining_right_registration")).toBeVisible();

    await page.goto(`/w/projects/${projectId}/verification`);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Assign the review" }).click();
    await expect(page.getByTestId("selected-case")).toContainText("assigned");

    // --- State cannot change without a reason ----------------------------
    await expect(page.getByTestId("transition-in_review")).toBeDisabled();

    await page.getByLabel("Reason (required)").fill("Starting the review");
    await expect(page.getByTestId("transition-in_review")).toBeEnabled();
    await page.getByTestId("transition-in_review").click();
    await expect(page.getByTestId("selected-case")).toContainText("in_review");

    // --- Change request ---------------------------------------------------
    await page.getByLabel("Reason (required)").fill("The registry lookup has no as-of date");
    await page.getByTestId("transition-changes_requested").click();
    await expect(page.getByTestId("selected-case")).toContainText("changes_requested");

    // The path taken remains. From the current state alone, a case reassigned after
    // being sent back looks the same as one that progressed from the start.
    const history = page.getByTestId("transition-history");
    await expect(history).toBeVisible();
    await expect(history).toContainText("assigned → in_review");
    await expect(history).toContainText("The registry lookup has no as-of date");

    // --- Back to review after changes (data_steward) ---------------------
    // Moving the state back is the job of whoever handles evidence. The reviewer does not
    // have the claim.curate permission (02 §2.3).
    await page.getByLabel("Reason (required)").fill("The as-of date has been supplied");
    await page.getByTestId("transition-in_review").click();
    await expect(page.getByTestId("selected-case")).toContainText("in_review");

    // --- The reviewer signs (reviewer_cp_qp) ------------------------------
    await connectAs(page, "Reviewer A");
    await page.goto(`/w/projects/${projectId}/verification`);
    await page.getByRole("button", { name: "Open this case" }).first().click();

    // The reviewer cannot change the state. Signing is their act.
    await page.getByLabel("Reason (required)").fill("Attempting it without the role");
    await page.getByTestId("transition-cancelled").click();
    await expect(page.getByTestId("error-notice")).toContainText("AUTHORIZATION_DENIED");

    await page.getByRole("button", { name: "Create the draft" }).click();
    await page.getByRole("button", { name: "Create a signature request" }).click();
    await page.getByTestId("sign-attestation").click();
    await expect(page.getByTestId("signed-result")).toContainText("signed");

    // --- Dispute ----------------------------------------------------------
    await page.getByTestId("dispute-attestation").click();
    await expect(page.getByTestId("signed-result")).toContainText("disputed");

    // The signer's address remains. Erasing the signature loses "who judged what, and when",
    // which is indistinguishable from hiding a faulty review.
    await expect(page.getByTestId("signed-result")).toContainText("0x");

    // --- Dispute resolution -----------------------------------------------
    const disputes = page.getByTestId("dispute-table");
    await expect(disputes).toBeVisible();
    await expect(disputes).toContainText("unresolved");

    // Cannot resolve without a basis.
    const resolveButton = page.locator('[data-testid^="resolve-dismissed-"]').first();
    await expect(resolveButton).toBeDisabled();

    await page.getByLabel("Basis for resolution (required)").fill("The as-of date was checked and is sound");
    await resolveButton.click();

    // Dismissal makes the review valid again, and the dispute record remains.
    await expect(page.getByTestId("signed-result")).toContainText("active");
    await expect(disputes).toContainText("dismissed");
    await expect(disputes).toContainText("The as-of date was checked and is sound");
  });

  test("the audit screen shows actions and hides details", async ({ page }) => {
    // Audit lookup requires audit.read. The steward does not have it.
    await connectAs(page, "Steward A");
    await page.goto("/w/audit");
    await expect(page.getByTestId("error-notice")).toContainText("AUTHORIZATION_DENIED");

    await connectAs(page, "Operator A");
    await page.goto("/w/audit");

    await expect(page.getByTestId("audit-table")).toBeVisible();
    // The same screen also shows whether event publishing is lagging.
    await expect(page.getByTestId("outbox-backlog")).toBeVisible();
    await expect(page.getByText("What this screen does not show")).toBeVisible();
  });
});
