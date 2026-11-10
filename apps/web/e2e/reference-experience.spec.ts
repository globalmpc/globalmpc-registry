import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import {
  registerSyntheticProject,
  publishAndAnchor,
} from "./evidence-ledger-journey";
import { reportScan } from "./scan-service";
import { connectAs } from "./connect-as";

test("workspace navigation, requirements and authentication layout follow the project journey", async ({
  page,
}) => {
  await page.goto("/connect");
  await expect(page.locator("main.auth-page")).toBeVisible();
  await connectAs(page, "Operator A");
  await page.goto("/w/projects/new");
  await page
    .getByRole("textbox", { name: "Project key", exact: true })
    .fill(`DESIGN-${Date.now()}`);
  await page
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Reference experience mine");
  await page
    .getByRole("combobox", { name: "Owning organization" })
    .selectOption("aaaaaaaa-0000-0000-0000-000000000001");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);
  await connectAs(page, "Steward A");
  await page.goto("/w/projects");
  await expect(
    page.getByRole("navigation", { name: "Workspace", exact: true }),
  ).toBeVisible();
  const projectLink = page
    .locator('[data-testid="project-list"] tbody a')
    .first();
  const href = await projectLink.getAttribute("href");
  expect(href).toBeTruthy();
  await page.goto(`${href}/requirements`);
  await expect(
    page.getByRole("heading", { name: "Requirements", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Requirements", exact: true }),
  ).toHaveAttribute("aria-current", "page");
  await expect(page.getByTestId("evidence-ledger")).toBeVisible();
  await page.screenshot({
    path: "test-results/reference-workspace-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "Add evidence →", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Register evidence" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();
  await page.getByLabel("Choose a file").setInputFiles({
    name: "reference-evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Synthetic design review evidence"),
  });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByLabel("Document type").fill("Design review fixture");
  await page
    .getByLabel("Valid until (optional)", { exact: true })
    .fill("2030-12-31");
  let scannedBeforeClassification = false;
  await page.route("**/api/v1/uploads/*/document-profile", async (route) => {
    if (!scannedBeforeClassification && route.request().method() === "PATCH") {
      scannedBeforeClassification = true;
      const uploadId = new URL(route.request().url()).pathname
        .split("/")
        .at(-2)!;
      await reportScan(page, uploadId, 1);
    }
    await route.continue();
  });
  await page
    .getByRole("button", { name: "Upload privately", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "File uploaded", exact: true }),
  ).toBeVisible();
  expect(scannedBeforeClassification).toBe(true);
  await page.unroute("**/api/v1/uploads/*/document-profile");
  await page
    .getByRole("link", { name: "View file status and versions →" })
    .click();
  await expect(page.getByLabel("Document type", { exact: true })).toHaveValue(
    "Design review fixture",
  );
  const storedUrl = page.url();
  let duplicateProfileWrites = 0;
  await page.route("**/api/v1/uploads/*/document-profile", async (route) => {
    if (route.request().method() === "PATCH") duplicateProfileWrites += 1;
    await route.continue();
  });
  await page.goto(`${href}/register`);
  await page
    .getByLabel("Choose a file")
    .setInputFiles({
      name: "same-content.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Synthetic design review evidence"),
    });
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page
    .getByRole("button", { name: "Upload privately", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "File already stored", exact: true }),
  ).toBeVisible();
  expect(duplicateProfileWrites).toBe(0);
  await page.getByRole("link", { name: "View existing document →" }).click();
  await expect(page).toHaveURL(storedUrl);
  await expect(page.getByLabel("Document type", { exact: true })).toHaveValue(
    "Design review fixture",
  );
  await expect(
    page.getByLabel("Valid until", { exact: true }),
  ).toHaveValue("2030-12-31");
  await page.unroute("**/api/v1/uploads/*/document-profile");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", { name: "Workspace navigation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Workspace navigation" }).click();
  await expect(
    page.getByRole("navigation", { name: "Selected project" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Requirements", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Workspace navigation" }),
  ).toHaveAttribute("aria-expanded", "false");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .exclude("nextjs-portal")
    .analyze();
  expect(result.violations).toEqual([]);
  await page.screenshot({
    path: "test-results/reference-workspace-mobile.png",
    fullPage: true,
  });
});

test("existing authenticated screens retain their journeys in the common desktop frame", async ({
  page,
}) => {
  test.setTimeout(120_000);
  await connectAs(page, "Operator A");
  await page.goto("/w/projects");
  const href = await page
    .locator('[data-testid="project-list"] tbody a')
    .first()
    .getAttribute("href");
  expect(href).toBeTruthy();
  for (const path of [
    "/w/work",
    "/w/notifications",
    "/w/settings",
    "/w/admin",
    "/w/authorities",
    "/w/integrations",
    "/w/governance",
    "/w/audit",
    href!,
    `${href}/data-room`,
    `${href}/verification`,
    `${href}/readiness`,
    `${href}/publication`,
    `${href}/impacts`,
    `${href}/documents`,
    `${href}/cre`,
    `${href}/team`,
    `${href}/audit`,
    "/w/help",
  ]) {
    await page.goto(path);
    await expect(page.locator(".workspace-content h1").first()).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Workspace navigation" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      path,
    ).toBe(true);
  }
  await page.goto("/w/work");
  await expect(page.locator(".work-summary")).toBeVisible();
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .exclude("nextjs-portal")
    .analyze();
  expect(results.violations).toEqual([]);
  await page.screenshot({
    path: "test-results/reference-dashboard-desktop.png",
    fullPage: true,
  });
});

test("visual disclosure preview becomes an anonymous public project without exposing private endpoints", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await connectAs(page, "Operator A");
  const key = `PUBLIC-DESIGN-${Date.now()}`;
  const name = "Synthetic public design review";
  const id = await registerSyntheticProject(page, key, name);
  await page.goto(`/w/projects/${id}/publication`);
  await expect(
    page.getByRole("region", { name: "Public disclosure preview" }),
  ).toContainText("Draft preview · not published");
  await publishAndAnchor(page, id, key);
  await page.context().clearCookies();
  const reads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/v1/"))
      reads.push(new URL(request.url()).pathname);
  });
  await page.goto("/");
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  await page.screenshot({
    path: "test-results/reference-public-desktop.png",
    fullPage: true,
  });
  await page.getByRole("link", { name, exact: true }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  await expect(page.getByTestId("evidence-ledger")).toBeVisible();
  await page.getByRole("link", { name: "Version history ↓" }).click();
  await expect(page.locator("#record-history")).toBeInViewport();
  expect(
    reads.every(
      (path) =>
        path.startsWith("/api/v1/public/") || path === "/api/v1/auth/session",
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "test-results/reference-public-mobile.png",
    fullPage: true,
  });
});
