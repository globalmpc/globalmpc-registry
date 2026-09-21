import { expect, test, type Page } from "@playwright/test";

/**
 * Field uploads on a phone — spec 11 §11.9.
 *
 * Phones upload from the site; review and approval stay desktop-first. This checks the part a
 * phone is for: a steward attaches a file and a photo, both land in quarantine like any upload, and
 * neither the Data Room nor the document page scrolls sideways at a common phone width.
 */

// The narrowest common phone width. The device profile keeps touch and the mobile user agent.
test.use({ viewport: { width: 390, height: 844 } });

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

/** A page wider than the screen hides controls off to the side on a phone. */
async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

// The smallest valid PNG: a 1×1 pixel. The server checks the declared type, not the picture.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

test.describe("field uploads on a phone", () => {
  test.setTimeout(120_000);

  test("a steward attaches a file and a photo, and both wait in quarantine", async ({ page }) => {
    const projectKey = `FIELD-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Field upload mine");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(page.getByRole("heading", { name: "Data Room" })).toBeVisible();
    await expectNoSidewaysScroll(page);

    // The camera is offered only on the photo input; the general picker stays a file picker.
    await expect(page.getByTestId("upload-photo-input")).toHaveAttribute("capture", "environment");
    await expect(page.getByTestId("upload-input")).not.toHaveAttribute("capture", /.*/);

    await page.getByTestId("upload-input").setInputFiles({
      name: "site-report.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`site report ${projectKey}`),
    });
    await expect(page.locator('[data-testid^="upload-state-"]')).toHaveCount(1);

    await page.getByTestId("upload-photo-input").setInputFiles({
      name: "core-tray.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });
    const states = page.locator('[data-testid^="upload-state-"]');
    await expect(states).toHaveCount(2);
    // A photo is not evidence on arrival either — it waits for the scan like any file.
    await expect(states.nth(0)).toHaveText("quarantined");
    await expect(states.nth(1)).toHaveText("quarantined");
    await expectNoSidewaysScroll(page);

    await page.locator('[data-testid^="relations-"]').first().click();
    await expect(page.getByTestId("document-title")).toBeVisible();
    await expect(page.getByTestId("new-version-photo-input")).toHaveAttribute(
      "capture",
      "environment",
    );

    // Both inputs feed one pending version. Picking on one clears the other, so the page never
    // shows two files when only the last one will be uploaded.
    const versionFile = page.getByTestId("new-version-input");
    const versionPhoto = page.getByTestId("new-version-photo-input");
    await versionFile.setInputFiles({
      name: "renewed-permit.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`renewed permit ${projectKey}`),
    });
    await versionPhoto.setInputFiles({
      name: "renewed-permit.png",
      mimeType: "image/png",
      buffer: ONE_PIXEL_PNG,
    });
    await expect(versionFile).toHaveValue("");
    await expect(versionPhoto).not.toHaveValue("");
    await versionFile.setInputFiles({
      name: "renewed-permit.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`renewed permit ${projectKey}`),
    });
    await expect(versionPhoto).toHaveValue("");
    await expect(versionFile).not.toHaveValue("");
    await expectNoSidewaysScroll(page);
  });
});
