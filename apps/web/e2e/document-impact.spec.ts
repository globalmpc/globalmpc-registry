import { expect, test, type Page } from "@playwright/test";

/**
 * Document relations E2E.
 *
 * One scenario: a report rests on a license, the license is replaced by a new version, and the
 * report shows up as needing a second look until someone judges it.
 *
 * What is under test is the hand-off between screens — the link made on one document page is
 * the one the new version carries, and the impact the database raises is the one the impacts
 * page lets a person close.
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

async function sessionToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => window.localStorage.getItem("mpc.session.token"));
  expect(token).not.toBeNull();
  return token as string;
}

async function uploadIds(page: Page): Promise<string[]> {
  const cells = page.locator('[data-testid^="upload-state-"]');
  const ids: string[] = [];
  for (const testId of await cells.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid") ?? ""),
  )) {
    ids.push(testId.replace("upload-state-", ""));
  }
  return ids;
}

/**
 * The scan is the scan service's act, never the uploader's. E2E calls the API with that
 * session, as the golden path does — the screen has no button for it on purpose.
 */
async function scanClean(page: Page, uploadId: string, version: number): Promise<void> {
  const token = await sessionToken(page);
  const response = await page.request.post(`/api/v1/uploads/${uploadId}/scan-result`, {
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": `e2e-doc-scan-${uploadId}-${version}`,
      "if-match": `"${version}"`,
    },
    data: { result: "clean" },
  });
  expect(response.ok()).toBe(true);
}

test.describe("document relations", () => {
  test.setTimeout(120_000);

  test("a replaced license flags the report resting on it until someone judges it", async ({
    page,
  }) => {
    const projectKey = `DOCS-${Date.now()}`;

    // --- Project (mpc_operator) ------------------------------------------
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Document relations mine");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    // --- Two documents (data_steward) --------------------------------------
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);

    await page.getByTestId("upload-input").setInputFiles({
      name: "license.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`license ${projectKey}`),
    });
    await expect(page.locator('[data-testid^="upload-state-"]')).toHaveCount(1);
    const [licenseId] = await uploadIds(page);

    await page.getByTestId("upload-input").setInputFiles({
      name: "drilling-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`drilling report ${projectKey}`),
    });
    await expect(page.locator('[data-testid^="upload-state-"]')).toHaveCount(2);
    const reportId = (await uploadIds(page)).find((uploadId) => uploadId !== licenseId)!;

    await connectAs(page, "Scan Service");
    await scanClean(page, licenseId!, 1);
    await scanClean(page, reportId, 1);

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    for (const uploadId of [licenseId!, reportId]) {
      await page.getByTestId(`promote-${uploadId}`).click();
      await expect(page.getByTestId(`upload-state-${uploadId}`)).toHaveText("promoted");
    }

    // --- The report rests on the license ----------------------------------
    await page.getByTestId(`relations-${reportId}`).click();
    await expect(page.getByTestId("document-title")).toHaveText("drilling-report.pdf");
    await page.getByTestId("link-target").selectOption(licenseId!);
    await page.getByRole("button", { name: "Add link" }).click();
    await expect(page.getByTestId("rests-on-list")).toContainText("license.pdf");

    // The license page previews what a change would touch — before anything changes.
    await page.goto(`/w/projects/${projectId}/documents/${licenseId}`);
    await expect(page.getByTestId("impact-preview")).toContainText("drilling-report.pdf");

    // --- A new version of the license -------------------------------------
    await page.getByTestId("new-version-input").setInputFiles({
      name: "license-renewed.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`renewed license ${projectKey}`),
    });
    await page.getByRole("button", { name: "Upload new version" }).click();
    await expect(page.getByTestId("new-version-created")).toContainText("waiting for the scan");
    const renewedId = (await page.getByTestId("new-version-id").textContent())!.trim();

    // Nothing is flagged yet: an unscanned file does not retire the version people rely on.
    await page.goto(`/w/projects/${projectId}/impacts`);
    await expect(page.getByTestId("impacts-empty")).toBeVisible();

    // Uploaded at version 1, marked as the new version at 2.
    await connectAs(page, "Scan Service");
    await scanClean(page, renewedId, 2);

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByTestId(`promote-${renewedId}`).click();
    await expect(page.getByTestId(`upload-state-${renewedId}`)).toHaveText("promoted");
    await expect(page.getByTestId(`upload-impacts-${reportId}`)).toHaveText("1");

    // --- The report needs a second look; the steward judges it ------------
    await page.getByTestId("impacts-link").click();
    await expect(page.getByTestId(`impact-group-${licenseId}`)).toContainText(
      "drilling-report.pdf",
    );
    await page.getByRole("checkbox", { name: /drilling-report\.pdf/ }).check();
    await page.getByLabel("Reason").fill("Hole locations are unchanged under the renewed license");
    await page.getByRole("button", { name: "Apply to 1 selected" }).click();

    await expect(page.getByTestId("impacts-empty")).toBeVisible();
    await expect(page.getByTestId("impacts-closed")).toContainText("No change needed");
    await expect(page.getByTestId("impacts-closed")).toContainText(
      "Hole locations are unchanged under the renewed license",
    );
  });
});
