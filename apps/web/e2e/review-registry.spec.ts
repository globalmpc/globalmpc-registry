import { expect, test, type Page } from "@playwright/test";

/**
 * Review registry proposals E2E — spec 02 §2.8, W-066.
 *
 * Credentials, attestation schemas and policy sets used to be created only by a CLI. What this
 * checks is that a proposal started in the browser reaches the server, comes back as pending, and
 * that the person who proposed it gets no way to approve it.
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

function ruleSet(ruleSetId: string, version = "1.0.0") {
  return {
    definition: {
      ruleSetId,
      version,
      effectiveFrom: "2026-01-01T00:00:00Z",
      supersededBy: null,
      jurisdictionProfile: "MNG",
      gateId: "registry_publication",
      retroactive: false,
      requirements: [
        {
          requirementId: "project-identity",
          label: "Project identity",
          appliesWhen: { op: "always" },
          requiredClaimTypes: ["project_identity"],
          minimumGrade: "self_reported",
          freshnessThresholdDays: null,
          requiredAttestations: [],
          blockingConflictTypes: [],
          notEvaluableWhen: { op: "never" },
          watchWhen: null,
        },
      ],
    },
  };
}

async function propose(page: Page, payload: unknown, rationale: string): Promise<void> {
  const panel = page.getByTestId("review-registry");
  await panel.getByRole("button", { name: "Policy sets" }).click();
  await panel.getByRole("textbox", { name: "Payload (JSON)" }).fill(JSON.stringify(payload));
  await panel.getByRole("textbox", { name: "Rationale" }).fill(rationale);
  await panel.getByRole("button", { name: "Propose", exact: true }).click();
}

test.describe("Review registry proposals", () => {
  test("an operator proposes a policy set and gets no decision button", async ({ page }) => {
    const ruleSetId = `e2e-rules-${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/registries");

    await propose(page, ruleSet(ruleSetId), "Pilot registry publication gate");

    const row = page
      .getByTestId("review-registry-proposals")
      .locator("tr", { hasText: ruleSetId });
    await expect(row).toContainText("You proposed this — someone else decides.");
    await expect(row.getByRole("button", { name: "Approve" })).toHaveCount(0);
  });

  test("shows the server's reason when a rule set fails validation", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/registries");

    await propose(page, ruleSet(`e2e-invalid-${Date.now()}`, "1"), "Not semver on purpose");

    await expect(page.getByTestId("review-registry").getByTestId("error-notice")).toContainText(
      "POLICY_SET_INVALID",
    );
  });

  test("a role without review registry access does not see the panel", async ({ page }) => {
    await connectAs(page, "Steward A");
    await page.goto("/w/registries");

    await expect(page.getByRole("heading", { name: "Registries" })).toBeVisible();
    await expect(page.getByTestId("review-registry")).toHaveCount(0);
  });
});
