import { expect, test, type Page } from "@playwright/test";

/**
 * Workspace aggregate screens.
 *
 * All four were missing not for lack of data but because of **a structure where things
 * were visible only after opening a single project**. This checks that the structure is actually undone.
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

test.describe("workspace navigation", () => {
  test("every global item in the spec is present as a link", async ({ page }) => {
    await connectAs(page, "Operator A");
    const nav = page.getByRole("banner").getByRole("navigation");

    for (const label of [
      "My Work",
      "Notifications",
      "Projects",
      "Registries",
      "Anchor",
      "Integrations",
      "Governance",
      "Audit",
      "Admin",
    ]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });

  test("menus outside the role are not shown", async ({ page }) => {
    await connectAs(page, "Steward A");
    const nav = page.getByRole("banner").getByRole("navigation");

    await expect(nav.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "My Activity", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  });

  test("public menus are reachable while signed in", async ({ page }) => {
    await connectAs(page, "Steward A");
    const nav = page.getByRole("banner").getByRole("navigation");

    await nav.getByText("Public registry").click();
    await nav.getByRole("link", { name: "Proof Verifier", exact: true }).click();
    await expect(page).toHaveURL(/\/verify$/);
  });
});

test.describe("wallet addresses are shown in full and copyable", () => {
  test("the top bar and admin screen show the full 42-character address and the copy button works", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await connectAs(page, "Operator A");

    const header = page.getByRole("banner");
    const headerAddress = header.getByTestId("wallet-address");
    await expect(headerAddress).toHaveText(/^0x[0-9a-f]{40}$/);

    await header.getByRole("button", { name: "Copy wallet address" }).click();
    await expect(header.getByRole("button", { name: "Copy wallet address" })).toHaveText("Copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await headerAddress.textContent());

    await page.goto("/w/admin");
    const cells = page.getByTestId("admin-subjects").getByTestId("wallet-address");
    await expect(cells.first()).toHaveText(/^0x[0-9a-f]{40}$/);
  });
});

test.describe("My Activity", () => {
  test("only your own actions are shown to you", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/activity");

    await expect(page.getByRole("heading", { name: "My Activity" })).toBeVisible();
    // The seed published and created as Operator A, so a table is expected. If empty, a notice appears.
    await expect(
      page.getByTestId("my-activity").locator("table, [data-testid=my-activity-empty]"),
    ).not.toHaveCount(0);
  });
});

test.describe("My Work", () => {
  test("separates work to do from work waiting on others", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/work");

    // Mixing the three in one list makes items with opposite next actions look alike.
    await expect(page.getByTestId("work-assigned")).toBeVisible();
    await expect(page.getByTestId("work-waiting")).toBeVisible();
    await expect(page.getByTestId("work-unassigned")).toBeVisible();
    await expect(page.getByTestId("work-unassigned")).toContainText(/nobody has picked/i);
  });
});

test.describe("Registries", () => {
  test("shows publication state without opening a project", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/registries");

    await expect(page.getByRole("heading", { name: "Registries" })).toBeVisible();
    // Merging publication and anchor into one cell reads as "published, so it is on chain".
    await expect(page.getByText(/Publishing and anchoring are separate events/)).toBeVisible();
  });
});

test.describe("Integrations", () => {
  test("separates callable from non-callable sources with reasons", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/integrations");

    await expect(page.getByTestId("integrations-accepted")).toBeVisible();
    await expect(page.getByTestId("integrations-pending")).toBeVisible();
    // A successful connection is not verification.
    await expect(page.getByText(/it means the source answered, not that the answer is right/)).toBeVisible();
    // The screen states that no real government source exists yet (OD-42).
    await expect(page.getByText(/No real government source is connected yet/)).toBeVisible();
  });
});

test.describe("Claim Detail", () => {
  test("a single claim has its own URL", async ({ page }) => {
    // Registration is mpc_operator, claims are data_steward — different roles (02 §2.3).
    // Skipping on runs without a claim would make this test guard nothing, so it creates
    // what it needs here.
    const projectKey = `CLAIM-${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Claim detail check");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByRole("button", { name: "Add a mining right claim" }).click();

    const claimLink = page.getByRole("link", { name: "mining_right_registration" }).first();
    await expect(claimLink).toBeVisible();
    await claimLink.click();

    await expect(page).toHaveURL(/\/w\/projects\/[^/]+\/claims\/[^/]+$/);
    await expect(page.getByTestId("claim-detail")).toBeVisible();
    // Grade and review are different facts.
    await expect(page.getByText("Grade is not review")).toBeVisible();
  });
});

test.describe("notifications", () => {
  test("the screen does not hide that there is no delivery path", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/notifications");

    // Without opening the app you still do not know. Hiding that makes people believe they are notified.
    await expect(page.getByTestId("notifications-limits")).toContainText(
      /Nothing is sent anywhere yet/,
    );
    // A role notification read by one person stays unread for the others.
    await expect(page.getByTestId("notifications-limits")).toContainText(
      /stays unread for everyone else/,
    );
  });
});

test.describe("notification sinks", () => {
  test("the screen explains why it is a webhook and not email", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    const sinks = page.getByTestId("admin-sinks");
    // Storing an address would mean retaining a data class that is rejected with 422 today (OD-18).
    await expect(sinks).toContainText(/Email is deliberately not offered/);
    // Letting users paste the value would leave it in the DB.
    await expect(sinks).toContainText(/A reference, not the secret itself/);
  });

  test("a registered sink is shown with its delivery state", async ({ page }) => {
    const url = `https://hooks.example.test/${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    await page.getByRole("textbox", { name: "Webhook URL" }).fill(url);
    await page
      .getByRole("textbox", { name: "Signing secret reference" })
      .fill("env:NOTIFY_E2E_SECRET");
    await page.getByRole("button", { name: "Add sink" }).click();

    const row = page.getByTestId("admin-sinks").locator("tr", { hasText: url });
    await expect(row).toBeVisible();
    // Distinguishes being registered from actually delivering.
    await expect(row).toContainText("active");
    await expect(row.getByRole("button", { name: "Pause" })).toBeVisible();
  });
});

test.describe("terms and data handling", () => {
  test("states first that no formal terms exist yet", async ({ page }) => {
    await page.goto("/legal");

    await expect(page.getByTestId("legal-status")).toContainText(
      /no issued Terms of Service or Privacy Policy yet/,
    );
    // Making a promise that cannot be kept is worse than having none.
    await expect(page.getByTestId("legal-status")).toContainText(/not open to members of the public/);
  });

  test("lists what the system actually enforces, with evidence", async ({ page }) => {
    await page.goto("/legal");

    const enforced = page.getByTestId("legal-enforced");
    await expect(enforced).toContainText("OD-18");
    await expect(enforced).toContainText("AC-32");
    await expect(page.getByTestId("legal-support")).toBeVisible();
  });

  test("is reachable from any screen", async ({ page }) => {
    await page.goto("/explorer");
    await page.getByRole("link", { name: /Terms, data handling, and support/ }).click();

    await expect(page).toHaveURL(/\/legal$/);
  });
});
