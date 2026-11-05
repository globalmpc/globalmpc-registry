import { expect, test } from "@playwright/test";
import { connectAs, prepareSignIn } from "./connect-as";
import { demoEmail } from "./demo-people";
import { mailedCode } from "./mailbox";

/**
 * Workspace E2E.
 *
 * Runs through browser → web → API → PostgreSQL. Checking only that screens render
 * would not distinguish this from a mockup, so it checks **whether results decided by
 * the server reach the screen** — tenant isolation, permission-denial reasons, state labels.
 */

test.describe("account connection", () => {
  test("sign-in asks for an email address, never a wallet, and shows the boundary notice", async ({ page }) => {
    await page.goto("/connect");

    await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
    await expect(page.getByLabel("Email address")).toBeVisible();
    // WP7 removed the wallet sign-in: no demo account cards and no wallet button, whatever the
    // browser has installed.
    await expect(page.locator("button.account-card")).toHaveCount(0);
    await expect(page.getByTestId("legacy-wallet-sign-in")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /wallet/i })).toHaveCount(0);

    // The verification≠guarantee notice is visible before sign-in (§11.6).
    await expect(page.getByText("Verification is not a guarantee.")).toBeVisible();
    await expect(page.getByText("Readiness is not a decision.")).toBeVisible();
  });
});

test.describe("tenant isolation", () => {
  test("Operator A sees only its own tenant's projects", async ({ page }) => {
    await connectAs(page, "Operator A");

    await expect(page).toHaveURL(/\/w\/projects$/);
    // The project the seed created only in tenant B must not be visible.
    await expect(page.getByText("TENANT-B-ONLY")).toHaveCount(0);
  });

  test("Operator B sees its own project", async ({ page }) => {
    await connectAs(page, "Operator B");
    await expect(page).toHaveURL(/\/w\/projects$/);

    await expect(page.getByRole("link", { name: "TENANT-B-ONLY" })).toBeVisible();
  });

  test("distinguishes an empty list from no permission", async ({ page }) => {
    // Tenant C has no projects and never will. If data created by other tests could sway
    // this check, it would no longer verify the "empty state".
    await connectAs(page, "Operator C");

    // Permission exists but there is no data. The screen states "not a permission problem" (§11.7).
    await expect(page.getByText(/this is not a permission problem/)).toBeVisible();
  });
});

test.describe("project registration", () => {
  test("registering navigates to the detail screen and shows the actual values", async ({ page }) => {
    const key = `E2E-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.getByRole("button", { name: "New project" }).click();

    await page.getByRole("textbox", { name: "Project key" }).fill(key);
    await page.getByRole("textbox", { name: "Name" }).fill("Created by E2E");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper, gold");
    // Tenant A also has the reviewer's own firm (02 §2.4 rule 2), so the owner is chosen.
    await page.getByRole("combobox", { name: "Owning organization" }).selectOption(
      "aaaaaaaa-0000-0000-0000-000000000001",
    );
    await page.getByRole("button", { name: "Register" }).click();

    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: "Created by E2E", exact: true })).toBeVisible();
    await expect(page.locator(".page-head").first()).toContainText(key);
    await page.getByText("Project details, parties and history", { exact: true }).click();
    await expect(page.getByText("copper, gold", { exact: true })).toBeVisible();

    // The lifecycle starts at draft. Registration is not approval.
    await expect(page.getByText("draft")).toBeVisible();

    // Distinguishes no assessment from a pass.
    await expect(page.getByText("Not assessed")).toBeVisible();
    await expect(page.getByText(/No assessment has run yet. This is not a pass./)).toBeVisible();
  });

  test("a registered project appears in the list", async ({ page }) => {
    const key = `E2E-LIST-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("textbox", { name: "Project key" }).fill(key);
    await page.getByRole("textbox", { name: "Name" }).fill("For the list check");
    // Tenant A also has the reviewer's own firm (02 §2.4 rule 2), so the owner is chosen.
    await page.getByRole("combobox", { name: "Owning organization" }).selectOption(
      "aaaaaaaa-0000-0000-0000-000000000001",
    );
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);

    await page.getByRole("link", { name: "← All projects" }).click();
    await expect(page.getByRole("link", { name: key })).toBeVisible();
  });
});

test.describe("owner organization", () => {
  test("is picked from the organizations this account may register for", async ({ page }) => {
    // The form used to find the organization in a table of demo tenant ids. It now
    // reads the organizations the server would accept for this account.
    await connectAs(page, "Operator A");
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.goto("/w/projects/new");

    const picker = page.getByRole("combobox", { name: "Owning organization" });
    // Tenant A has two organizations — the operator's and the reviewer's firm — so nothing is
    // preselected: registering under the wrong one makes another company a party.
    await expect(picker).toHaveValue("");
    await expect(picker).toContainText("MPC Operations tenant-a");
    await expect(picker).toContainText("Independent Review Firm");
    // Tenant B's organization is never offered.
    await expect(picker).not.toContainText("tenant-b");
    await expect(page.getByRole("button", { name: "Register" })).toBeDisabled();

    await picker.selectOption("aaaaaaaa-0000-0000-0000-000000000001");
    await expect(page.getByRole("button", { name: "Register" })).toBeEnabled();
  });
});

test.describe("permission denial", () => {
  test("an account without a role lands on access pending, not on a refusal", async ({ page }) => {
    await connectAs(page, "Reader A");
    // Navigation to the workspace happens only after the emailed code and the passkey.
    await expect(page).toHaveURL(/\/w\/access-pending$/);
    const pending = page.getByTestId("access-pending");
    await expect(pending.getByRole("heading", { name: "Access pending" })).toBeVisible();
    await expect(pending.getByRole("link", { name: /Request access/ })).toHaveAttribute("href", "/w/access-requests");
    await expect(pending.getByRole("link", { name: /Account settings/ })).toHaveAttribute("href", "/w/settings");
    // Every role screen says the same, with no refusal box and no list of roles.
    for (const path of ["/w/projects", "/w/projects/new", "/w/governance", "/w/audit", "/w/work"]) {
      await page.goto(path);
      await expect(pending).toBeVisible();
      await expect(page.getByTestId("error-notice")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
    }
    // The person's own settings stay open.
    await page.goto("/w/settings");
    await expect(page.getByTestId("settings-sessions")).toBeVisible();
    // The server still refuses directly: the screen is guidance, not the control.
    const direct = await page.request.get("/api/v1/my-work");
    expect(direct.status()).toBe(403);
    await page.goto("/w/access-pending");
    await pending.getByTestId("access-pending-sign-out").click();
    await expect(page.getByRole("banner").getByRole("link", { name: "Sign in →" })).toBeVisible();
  });

  test("an account whose role cannot do this sees 403 and the required role on screen", async ({ page }) => {
    await connectAs(page, "Steward A");
    await expect(page).toHaveURL(/\/w\/projects$/);
    // A data steward cannot create a project, so the list does not offer it.
    await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();
    await expect(page.getByRole("button", { name: "New project" })).toHaveCount(0);
    await page.goto("/w/projects/new");

    // The owner organization lookup is authorized with `project.create`, so the denial
    // arrives when the form opens — before anything is typed — and Register stays disabled.
    const alert = page.getByTestId("error-notice");
    await expect(page.getByRole("button", { name: "Register" })).toBeDisabled();
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
    await connectAs(page, "Operator A");
    await expect(page.getByText("DENIED-E2E")).toHaveCount(0);
  });
});

test.describe("accessibility", () => {
  test("state badges carry a marker other than color", async ({ page }) => {
    await connectAs(page, "Operator B");
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.getByRole("link", { name: "TENANT-B-ONLY" }).click();

    await page.getByText("Project details, parties and history", { exact: true }).click();
    // The lifecycle badge has both a glyph and text (§11.8).
    const badge = page.locator(".badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/draft/);
    await expect(badge.locator(".glyph")).toHaveCount(1);
  });

  test("an account can sign in with the keyboard alone", async ({ page }) => {
    const email = demoEmail("Operator A");
    await prepareSignIn(page, "Operator A");
    await page.goto("/connect");
    await page.getByLabel("Email address").focus();
    await page.keyboard.type(email);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("code-sent")).toBeVisible();
    await page.getByLabel(/-digit code$/).focus();
    await page.keyboard.type(await mailedCode(email, "sign_in_code"));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/auth\/mfa/);
    await page.getByTestId("passkey-prove").focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/w\/projects$/);
  });
});

test.describe("session", () => {
  test("after disconnecting, the workspace is not accessible", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.getByRole("button", { name: "Sign out" }).click();

    await page.goto("/w/projects");
    await expect(page.getByTestId("workspace-signed-out")).toBeVisible();
  });

  test("the connection state is shown in the header with the role", async ({ page }) => {
    await connectAs(page, "Operator A");

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
    await connectAs(page, "Operator B");
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.getByRole("link", { name: "TENANT-B-ONLY" }).click();

    await page.getByText("Project details, parties and history", { exact: true }).click();
    await expect(page.locator(".badge").first()).toContainText(/draft/i);
  });
});
