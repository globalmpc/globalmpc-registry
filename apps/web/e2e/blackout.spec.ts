import { expect, test, type Page } from "@playwright/test";

/**
 * Material-information blackout — 11 §11.12, AC-30.
 *
 * The screen shows the reason, authority, scope, start, and restriction ID next to the affected
 * action. The same ID is what the API returns when it refuses the action.
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

test.describe("material-information blackout", () => {
  test("an active restriction is shown with its ID next to the affected action", async ({ page }) => {
    const projectKey = `BLACKOUT-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Blackout check");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    // Tenant A also has the reviewer's own firm (02 §2.4 rule 2), so the owner is chosen.
    await page.getByRole("combobox", { name: "Owning organization" }).selectOption(
      "aaaaaaaa-0000-0000-0000-000000000001",
    );
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    // No restriction, no notice.
    await expect(page.getByTestId("blackout-notice")).toHaveCount(0);

    const token = await page.evaluate(() => window.localStorage.getItem("mpc.session.token"));
    const headers = { authorization: `Bearer ${token}` };

    const created = await page.request.post(
      `/api/v1/projects/${projectId}/disclosure-restrictions`,
      {
        headers: { ...headers, "idempotency-key": `e2e-blackout-create-${projectKey}` },
        data: {
          subjectScope: [projectId],
          restrictedActionTypes: ["registry.publish"],
          materialInfoRef: "board-minutes",
          reason: "Resource estimate revision pending disclosure",
          legalBasis: "Listing rule",
          authority: "Disclosure committee",
          expectedNextUpdateAt: "2030-01-01T00:00:00.000Z",
        },
      },
    );
    expect(created.status()).toBe(201);
    const restriction = (await created.json()) as { restrictionId: string; version: number };

    const activated = await page.request.post(
      `/api/v1/disclosure-restrictions/${restriction.restrictionId}/activate`,
      {
        headers: {
          ...headers,
          "idempotency-key": `e2e-blackout-activate-${projectKey}`,
          "if-match": `"${restriction.version}"`,
        },
        data: { reason: "Material information identified" },
      },
    );
    expect(activated.ok()).toBe(true);

    await page.goto(`/w/projects/${projectId}/publication`);
    const notice = page.getByTestId("blackout-notice");
    await expect(notice).toContainText("Resource estimate revision pending disclosure");
    await expect(notice).toContainText("Disclosure committee");
    await expect(notice).toContainText("registry.publish");
    await expect(notice).toContainText(restriction.restrictionId);
  });
});
