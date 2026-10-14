import { expect, test, type Page } from "@playwright/test";

/**
 * Project Registry screens — spec 11 §11.2/§11.3/§11.5, 04 §4.2, 05 §5.10.
 *
 * Project List filters, Project Overview (identity, matrix, parties, three registries,
 * readiness apart from decisions), the global project pickers and Claim Detail.
 *
 * Every project here is created with the synthetic label. The seed holds no real-world facts,
 * and nothing in this file records one.
 */

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  // Wait for the sign-in to land in the workspace. The Disconnect button alone can still be the
  // previous account's, and navigating away mid sign-in leaves no session.
  await expect(page).toHaveURL(/\/w\/projects$/);
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

async function registerSynthetic(page: Page, projectKey: string): Promise<string> {
  await connectAs(page, "Operator A");
  await page.goto("/w/projects/new");
  await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
  await page.getByRole("textbox", { name: "Name" }).fill("Synthetic registry screens");
  await page.getByRole("checkbox", { name: "Synthetic test project" }).check();
  // Tenant A also has the reviewer's own firm (02 §2.4 rule 2), so the owner is chosen.
  await page.getByRole("combobox", { name: "Owning organization" }).selectOption(
    "aaaaaaaa-0000-0000-0000-000000000001",
  );
  await page.getByRole("button", { name: "Register" }).click();
  await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop() as string;
}

test.describe("Project Overview", () => {
  test("shows the synthetic label without confirming anything, and keeps readiness apart from decisions", async ({ page }) => {
    await registerSynthetic(page, `PRJ-OV-${Date.now()}`);

    await expect(page.getByTestId("reference-standing")).toContainText("Synthetic test project");
    await expect(page.getByTestId("reference-standing")).toContainText(
      "does not confirm rights, consent, issuer, or SPV status",
    );

    // Every matrix row is pending until someone records it with evidence (§11.5).
    const matrix = page.getByTestId("fact-matrix");
    for (const item of ["Rights", "Issuer", "SPV", "Legal structure", "Source data"]) {
      await expect(matrix.getByRole("row", { name: new RegExp(item) })).toContainText(
        "Pending — not confirmed",
      );
    }

    const registries = page.getByTestId("registry-states");
    for (const registry of ["Project Registry", "Verification Registry", "Asset Registry"]) {
      await expect(registries.getByRole("row", { name: new RegExp(registry) })).toContainText("No record");
    }
    await expect(page.getByTestId("readiness-card")).toBeVisible();
    await expect(page.getByTestId("decision-card")).toBeVisible();
    await expect(page.getByTestId("gaps-and-limitations")).toContainText(
      "No readiness assessment has run",
    );
  });

  test("a steward records a matrix row; confirmed without evidence in the project is refused", async ({ page }) => {
    const projectId = await registerSynthetic(page, `PRJ-FACT-${Date.now()}`);

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}`);
    const matrix = page.getByTestId("fact-matrix");
    await matrix.getByText("Record a matrix row").click();

    await matrix.getByRole("combobox", { name: "Item" }).selectOption("rights");
    await matrix.getByRole("combobox", { name: "Status" }).selectOption("confirmed");
    // An id that exists nowhere in this project.
    await matrix.getByRole("textbox", { name: "Evidence id" }).fill("00000000-0000-4000-8000-000000000000");
    await matrix.getByRole("textbox", { name: "Reason" }).fill("synthetic check");
    await matrix.getByRole("button", { name: "Record version" }).click();
    await expect(matrix.getByTestId("error-notice")).toContainText("EVIDENCE_NOT_IN_PROJECT");
    await expect(matrix.getByRole("row", { name: /Rights/ })).toContainText("Pending — not confirmed");

    await matrix.getByRole("combobox", { name: "Status" }).selectOption("not_applicable");
    await matrix.getByRole("textbox", { name: "Evidence id" }).fill("");
    await matrix.getByRole("textbox", { name: "Reason" }).fill("not part of the synthetic scenario");
    await matrix.getByRole("button", { name: "Record version" }).click();
    await expect(matrix.getByRole("row", { name: /Rights/ })).toContainText("Not applicable");
    await expect(matrix.getByRole("row", { name: /Rights/ })).toContainText("v1");
  });

  test("a submitted party starts pending", async ({ page }) => {
    const projectId = await registerSynthetic(page, `PRJ-PARTY-${Date.now()}`);

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}`);
    const parties = page.getByTestId("project-parties");
    await parties.getByText("Submit a party").click();
    await parties.getByRole("combobox", { name: "Party role" }).selectOption("issuer");
    await parties.getByRole("textbox", { name: "Legal name" }).fill("Synthetic Issuer LLC");
    await parties.getByRole("button", { name: "Submit party" }).click();

    await expect(parties.getByRole("row", { name: /Synthetic Issuer LLC/ })).toContainText(
      "Pending — not confirmed",
    );
  });
});

test.describe("Project List", () => {
  test("filters narrow on the server and an empty result says it is filtered", async ({ page }) => {
    const projectKey = `PRJ-LIST-${Date.now()}`;
    await registerSynthetic(page, projectKey);
    await page.goto("/w/projects");

    await page.getByRole("combobox", { name: "Reference label" }).selectOption("synthetic_test_project");
    await expect(page.getByRole("link", { name: projectKey })).toBeVisible();
    await expect(page.getByTestId("project-list")).toContainText("Synthetic test");

    await page.getByRole("combobox", { name: "Stage" }).selectOption("retired");
    await expect(page.getByRole("link", { name: projectKey })).toHaveCount(0);
    await expect(page.getByText(/No project matches these filters/)).toBeVisible();
  });
});

test.describe("global workspace entries", () => {
  test("Data Room, Verification, Readiness & Gates and Authorities are in the nav", async ({ page }) => {
    await connectAs(page, "Steward A");
    const nav = page.getByRole("banner").getByRole("navigation");
    for (const label of ["Data Room", "Verification", "Readiness & Gates", "Authorities"]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });

  test("the Data Room entry asks which project and opens that project's Data Room", async ({ page }) => {
    const projectKey = `PRJ-PICK-${Date.now()}`;
    const projectId = await registerSynthetic(page, projectKey);

    await connectAs(page, "Steward A");
    await page.getByRole("banner").getByRole("navigation").getByRole("link", { name: "Data Room", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Data Room" })).toBeVisible();
    await page.getByRole("link", { name: `Open Data Room — ${projectKey}` }).click();
    await expect(page).toHaveURL(new RegExp(`/w/projects/${projectId}/data-room$`));
  });
});

test.describe("Claim Detail", () => {
  test("shows the source coordinate and each section, with anchors stated as inclusion only", async ({ page }) => {
    const projectId = await registerSynthetic(page, `PRJ-CLAIM-${Date.now()}`);

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByRole("button", { name: "Add a mining right claim" }).click();
    await page.getByRole("link", { name: "mining_right_registration" }).first().click();

    await expect(page.getByTestId("claim-detail")).toBeVisible();
    await expect(page.getByTestId("source-coordinate")).not.toHaveText("—");
    await expect(page.getByTestId("claim-attestations")).toContainText("No attestation covers this claim");
    await expect(page.getByTestId("claim-derivation")).toBeVisible();
    await expect(page.getByTestId("claim-history")).toBeVisible();
    await expect(page.getByTestId("claim-anchor")).toContainText(
      "does not prove that the value is true or legally effective",
    );
  });
});
