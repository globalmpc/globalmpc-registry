import { expect, test, type Page } from "@playwright/test";

/**
 * Document status E2E.
 *
 * One scenario: a project declares a required type, sees it missing, receives a document of
 * that type which has already expired, and sees the requirement move to "only expired copies".
 *
 * What is under test is that the declaration made on this screen and the profile set on the
 * document meet in the same count — the type matches regardless of case.
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

async function api(
  page: Page,
  method: "post" | "patch",
  path: string,
  data: Record<string, unknown>,
  extra: Record<string, string> = {},
) {
  const token = await sessionToken(page);
  const response = await page.request[method](path, {
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": `e2e-docstatus-${path}-${Date.now()}`,
      ...extra,
    },
    data,
  });
  expect(response.ok()).toBe(true);
  return (await response.json()) as { id: string; version: number };
}

test.describe("document status", () => {
  test.setTimeout(120_000);

  test("a declared required type goes from missing to expired as its document arrives", async ({
    page,
  }) => {
    const projectKey = `DOCSTAT-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Document status mine");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    // Tenant A also has the reviewer's own firm (02 §2.4 rule 2), so the owner is chosen.
    await page.getByRole("combobox", { name: "Owning organization" }).selectOption(
      "aaaaaaaa-0000-0000-0000-000000000001",
    );
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    // --- Declare the type (data_steward) -----------------------------------
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}`);
    await page.getByRole("button", { name: "Document status" }).click();
    await expect(page.getByRole("heading", { name: "Document status" })).toBeVisible();

    await page.getByRole("textbox", { name: "Document type" }).fill("Exploration licence");
    await page.getByRole("combobox", { name: "Tier", exact: true }).selectOption("required");
    await page.getByRole("button", { name: "Declare type" }).click();

    const row = page.getByRole("row", { name: /Exploration licence/ });
    await expect(row).toContainText("Missing");
    await expect(page.getByText("! Incomplete")).toBeVisible();

    // --- A document of that type arrives, already expired -----------------
    const upload = await api(page, "post", `/api/v1/projects/${projectId}/uploads`, {
      contentBase64: Buffer.from(`licence ${projectKey}`).toString("base64"),
      contentType: "application/pdf",
      originalFilename: "licence.pdf",
    });
    await connectAs(page, "Scan Service");
    const scanned = await api(
      page,
      "post",
      `/api/v1/uploads/${upload.id}/scan-result`,
      { result: "clean" },
      { "if-match": `"${upload.version}"` },
    );
    await connectAs(page, "Steward A");
    const promoted = await api(
      page,
      "post",
      `/api/v1/uploads/${upload.id}/promote`,
      {},
      { "if-match": `"${scanned.version}"` },
    );
    // Lower case on purpose: the declaration matches regardless of case.
    await api(
      page,
      "patch",
      `/api/v1/uploads/${upload.id}/document-profile`,
      { documentType: "exploration licence", validUntil: "2020-01-31" },
      { "if-match": `"${promoted.version}"` },
    );

    await page.goto(`/w/projects/${projectId}/documents`);
    await expect(page.getByRole("row", { name: /Exploration licence/ })).toContainText(
      "Only expired copies",
    );

    // The expired tile filters the list to that document.
    await page.getByRole("button", { name: /^Expired/ }).click();
    await expect(page.getByRole("link", { name: "licence.pdf" })).toBeVisible();
    await expect(page.getByText("End of list · 1 shown.")).toBeVisible();
  });
});
