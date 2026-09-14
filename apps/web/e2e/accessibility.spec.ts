import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * Automated accessibility checks — spec 11 §11.8, OD-31 (WCAG 2.2 AA).
 *
 * Automated checks catch only part of the whole. They see only what a machine can
 * judge, such as contrast, labels, landmarks and roles — not "is this wording
 * understandable". So they run alongside, not instead of, the manual checks in
 * `workspace.spec.ts` (markers other than color, keyboard operation).
 *
 * **Violations are forced to zero.** Left as warnings they pile up, and once they pile
 * up nobody looks. If an item cannot be fixed, record it here explicitly with the reason.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * Lets the page settle before checking.
 *
 * axe runs inside the page. If hydration or requests started by it are still in flight,
 * the execution context disappears mid-check and the test breaks **for reasons unrelated
 * to accessibility**. `goto` waits only for document load, so wait once more until the client is idle.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

async function analyze(page: Page) {
  await settle(page);
  return new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // The Next.js dev overlay is not our code. It is absent from the prod bundle.
    .exclude("nextjs-portal")
    .analyze();
}

/** Formats violations for humans. The id alone does not say what to fix. */
function describe(violations: Awaited<ReturnType<typeof analyze>>["violations"]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help}\n` +
        violation.nodes.map((node) => `    ${node.target.join(" ")}`).join("\n"),
    )
    .join("\n");
}

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("accessibility (WCAG 2.2 AA)", () => {
  test("sign-in screen", async ({ page }) => {
    await page.goto("/connect");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  /**
   * Sweeps the whole public surface — the 7 screens of spec 11 §11.2.
   *
   * These are the screens seen by people who are not signed in. If they are blocked,
   * being public means nothing. A loop over a list is used instead of one test per screen
   * so the checks grow when §11.2 adds a screen — written by hand, new screens silently drop out.
   */
  for (const path of [
    "/",
    "/legal",
    "/explorer",
    "/explorer/projects",
    "/explorer/verifications",
    "/asset-registry",
    "/verify",
    "/governance",
    "/disclosures",
  ]) {
    test(`public surface — ${path}`, async ({ page }) => {
      await page.goto(path);
      const result = await analyze(page);
      expect(describe(result.violations)).toBe("");
    });
  }

  test("project list", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/projects");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("project registration form", async ({ page }) => {
    // Input forms are where label and error associations tend to break.
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("Data Room — table and state badges", async ({ page }) => {
    // An empty table has nothing to check. Create a state with real rows.
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(`A11Y-${Date.now()}`);
    await page.getByRole("textbox", { name: "Name" }).fill("For the accessibility check");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    // Without waiting for navigation, the URL is still `/new`.
    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByRole("button", { name: "Look up the official source" }).click();
    await page.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(page.getByText("mining_right_registration")).toBeVisible();

    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("error display", async ({ page }) => {
    // Errors must be read as role=alert and must not be distinguished by color alone.
    await connectAs(page, "Reader A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill("A11Y-DENIED");
    await page.getByRole("textbox", { name: "Name" }).fill("Should be denied");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByTestId("error-notice")).toBeVisible();

    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("screen a permission denial points to — without sign-in", async ({ page }) => {
    // This is where a blocked person lands. It must be readable without a session.
    await page.goto("/w/identity/upgrade");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("Anchor state screen", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/anchors");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  /** The new workspace aggregate screens. */
  for (const path of ["/w/work", "/w/notifications", "/w/registries", "/w/integrations"]) {
    test(`workspace — ${path}`, async ({ page }) => {
      await connectAs(page, "Operator A");
      await page.goto(path);
      const result = await analyze(page);
      expect(describe(result.violations)).toBe("");
    });
  }

  test("Administration screen", async ({ page }) => {
    // This screen manages people, wallets and roles. If it is blocked, the recovery path is blocked.
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("audit screen", async ({ page }) => {
    // First perform an action that leaves an audit record. An empty screen does not render the table.
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(`A11Y-AUDIT-${Date.now()}`);
    await page.getByRole("textbox", { name: "Name" }).fill("For the audit check");
    await page.getByRole("button", { name: "Register" }).click();

    await page.goto("/w/audit");
    await expect(page.getByTestId("audit-table")).toBeVisible();
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });
});
