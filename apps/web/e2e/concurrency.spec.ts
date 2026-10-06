import { expect, test } from "@playwright/test";

/**
 * Concurrent edit E2E — 07 §7.1.
 *
 * Two people have the same claim open and each records a conflict. Without optimistic
 * concurrency control, the later request overwrites the earlier judgment without a trace.
 *
 * What this spec checks is not "an error occurs" but **whether the screen says what happened**.
 * Collapsing it into "failed" leaves the user unaware that they must reload.
 */

test.describe("concurrent edits", () => {
  test("a request unaware of an earlier change is rejected and told the current version", async ({ browser }) => {
    const projectKey = `RACE-${Date.now()}`;

    // --- Setup: project and claim ----------------------------------------
    const operator = await browser.newContext();
    const operatorPage = await operator.newPage();
    await operatorPage.goto("/connect");
    await operatorPage.getByRole("button", { name: /Operator A/ }).click();
    // The token exists only after SIWE signing and verification finish. Without waiting,
    // the next screen renders without a session.
    await expect(operatorPage.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await operatorPage.goto("/w/projects/new");
    await operatorPage.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await operatorPage.getByRole("textbox", { name: "Name" }).fill("For the concurrent edit check");
    await operatorPage.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await operatorPage.getByRole("button", { name: "Register" }).click();
    await expect(operatorPage.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(operatorPage.url()).pathname.split("/").pop() as string;
    await operator.close();

    // --- The same person opens the same screen in two windows ------------
    // Separate browser contexts need separate sessions. This checks a version conflict,
    // not permissions, so both windows use the same role.
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await firstPage.goto("/connect");
    await firstPage.getByRole("button", { name: /Steward A/ }).click();
    await expect(firstPage.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await firstPage.goto(`/w/projects/${projectId}/data-room`);
    await firstPage.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(firstPage.getByText("mining_right_registration")).toBeVisible();

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await secondPage.goto("/connect");
    await secondPage.getByRole("button", { name: /Steward A/ }).click();
    await expect(secondPage.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await secondPage.goto(`/w/projects/${projectId}/data-room`);
    // Both windows see the same v1.
    await expect(secondPage.getByText("v1")).toBeVisible();

    // --- The first window records first ---------------------------------
    await firstPage.getByRole("button", { name: "Record a conflict" }).click();
    await expect(firstPage.getByText("v2")).toBeVisible();

    // --- The second window still holds v1 --------------------------------
    await secondPage.getByRole("button", { name: "Record a conflict" }).click();

    const notice = secondPage.getByTestId("error-notice");
    await expect(notice).toBeVisible();
    // Not a failure but the fact that "it changed in the meantime". The screen says so.
    await expect(notice).toContainText("412");
    await expect(notice).toContainText("RESOURCE_VERSION_MISMATCH");
    await expect(notice).toContainText("You were looking at");
    await expect(notice).toContainText("v2");
    // It also states that retrying will not resolve it.
    await expect(notice).toContainText("Retrying will produce the same result.");

    // --- After reloading, recording can continue --------------------------
    await secondPage.reload();
    await expect(secondPage.getByText("v2")).toBeVisible();
    await secondPage.getByRole("button", { name: "Record a conflict" }).click();
    await expect(secondPage.getByText("v3")).toBeVisible();
    await expect(secondPage.getByTestId("error-notice")).toHaveCount(0);

    await first.close();
    await second.close();
  });
});
