import { expect, test } from "@playwright/test";

/**
 * Workspace E2E.
 *
 * Runs through browser → web → API → PostgreSQL. Checking only that screens render
 * would not distinguish this from a mockup, so it checks **whether results decided by
 * the server reach the screen** — tenant isolation, permission-denial reasons, state labels.
 */

test.describe("account connection", () => {
  test("demo accounts are shown together with the boundary notice", async ({ page }) => {
    await page.goto("/connect");

    await expect(page.getByRole("heading", { name: "Connect account" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Operator A/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Operator B/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reader A/ })).toBeVisible();

    // R1: the screen states that sign-in uses a real SIWE signature.
    await expect(page.getByText(/they sign in through real SIWE/)).toBeVisible();

    // The verification≠guarantee notice is visible before sign-in (§11.6).
    await expect(page.getByText("Verification is not a guarantee.")).toBeVisible();
    await expect(page.getByText("Readiness is not a decision.")).toBeVisible();
  });
});

test.describe("tenant isolation", () => {
  test("Operator A sees only its own tenant's projects", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();

    await expect(page).toHaveURL(/\/w\/projects$/);
    // The project the seed created only in tenant B must not be visible.
    await expect(page.getByText("TENANT-B-ONLY")).toHaveCount(0);
  });

  test("Operator B sees its own project", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator B/ }).click();
    await expect(page).toHaveURL(/\/w\/projects$/);

    await expect(page.getByRole("link", { name: "TENANT-B-ONLY" })).toBeVisible();
  });

  test("distinguishes an empty list from no permission", async ({ page }) => {
    await page.goto("/connect");
    // Tenant C has no projects and never will. If data created by other tests could sway
    // this check, it would no longer verify the "empty state".
    await page.getByRole("button", { name: /Operator C/ }).click();

    // Permission exists but there is no data. The screen states "not a permission problem" (§11.7).
    await expect(page.getByText(/this is not a permission problem/)).toBeVisible();
  });
});

test.describe("project registration", () => {
  test("registering navigates to the detail screen and shows the actual values", async ({ page }) => {
    const key = `E2E-${Date.now()}`;

    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await page.getByRole("button", { name: "New project" }).click();

    await page.getByRole("textbox", { name: "Project key" }).fill(key);
    await page.getByRole("textbox", { name: "Name" }).fill("Created by E2E");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper, gold");
    await page.getByRole("button", { name: "Register" }).click();

    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: key })).toBeVisible();
    await expect(page.getByText("copper, gold")).toBeVisible();

    // The lifecycle starts at draft. Registration is not approval.
    await expect(page.getByText("draft")).toBeVisible();

    // Distinguishes no assessment from a pass.
    await expect(page.getByText("Not assessed")).toBeVisible();
    await expect(page.getByText(/No assessment has run yet. This is not a pass./)).toBeVisible();
  });

  test("a registered project appears in the list", async ({ page }) => {
    const key = `E2E-LIST-${Date.now()}`;

    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("textbox", { name: "Project key" }).fill(key);
    await page.getByRole("textbox", { name: "Name" }).fill("For the list check");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);

    await page.getByRole("link", { name: "← All projects" }).click();
    await expect(page.getByRole("link", { name: key })).toBeVisible();
  });
});

test.describe("permission denial", () => {
  test("an account without a role sees 403 and the required role on screen", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Reader A/ }).click();
    // Navigation to the workspace happens only after SIWE signature → verification → token issuance.
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.goto("/w/projects/new");

    await page.getByRole("textbox", { name: "Project key" }).fill("DENIED-E2E");
    await page.getByRole("textbox", { name: "Name" }).fill("Should be denied");
    await page.getByRole("button", { name: "Register" }).click();

    const alert = page.getByTestId("error-notice");
    await expect(alert).toBeVisible();
    // Checks that the server envelope reaches the screen intact.
    await expect(alert).toContainText("403");
    await expect(alert).toContainText("AUTHORIZATION_DENIED");
    await expect(alert).toContainText("ROLE_ACTION_NOT_ALLOWED");
    await expect(alert).toContainText("mpc_operator");
    // Offers a path to the next action (§11.7).
    await expect(alert.getByRole("link", { name: /Request access/ })).toBeVisible();
    // States whether retrying helps.
    await expect(alert).toContainText("Retrying will produce the same result.");
  });

  test("a rejected registration does not appear in the list", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await expect(page.getByText("DENIED-E2E")).toHaveCount(0);
  });
});

test.describe("accessibility", () => {
  test("state badges carry a marker other than color", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator B/ }).click();
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.getByRole("link", { name: "TENANT-B-ONLY" }).click();

    // The lifecycle badge has both a glyph and text (§11.8).
    const badge = page.locator(".badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/draft/);
    await expect(badge.locator(".glyph")).toHaveCount(1);
  });

  test("an account can be connected with the keyboard alone", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/w\/projects$/);
  });
});

test.describe("session", () => {
  test("after disconnecting, the workspace is not accessible", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await page.getByRole("button", { name: "Disconnect" }).click();

    await page.goto("/w/projects");
    await expect(page.getByText(/No account is connected/)).toBeVisible();
  });

  test("the connection state is shown in the header with the role", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();

    const header = page.getByRole("banner");
    await expect(header).toContainText("mpc_operator");
    await expect(header).toContainText("high_assurance");
  });
});

test.describe("language (OD-30) — English only", () => {
  test("the boundary notice is visible in English before sign-in", async ({ page }) => {
    // The first screen before sign-in is the public entry point. The boundary notice must
    // already be visible here, not only on account connection.
    await page.goto("/");

    // The notice does not depend on a language choice. A warning that can be removed is not a warning.
    await expect(page.getByText("Verification is not a guarantee.")).toBeVisible();
    await expect(page.getByText("Readiness is not a decision.")).toBeVisible();
  });

  test("the document language attribute is en", async ({ page }) => {
    await page.goto("/");
    // Screen readers and browser translators need to know the document language.
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("there is no language switch", async ({ page }) => {
    await page.goto("/");
    // The service runs in English only. No toggle that changes nothing when pressed.
    await expect(page.getByTestId("locale-toggle")).toHaveCount(0);
  });

  test("state badges use English labels", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator B/ }).click();
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.getByRole("link", { name: "TENANT-B-ONLY" }).click();

    await expect(page.locator(".badge").first()).toContainText(/draft/i);
  });
});
