import { expect, test, type Page } from "@playwright/test";

/**
 * Golden path E2E — R1 Task 10.
 *
 * One scenario runs the whole span from registration to public lookup.
 *
 *   project registration → source receipt → claim → review signature → readiness assessment
 *   → gate decision → public publication → anchor → Explorer lookup → inclusion proof
 *
 * What this test checks is not "the screen renders" but **whether each step's output
 * becomes the next step's input and finally reaches a viewer who is not signed in**.
 * The role changing at each step is itself under test — if one account could do
 * everything, the separation would not hold.
 */

/** Account switch. A different role is a different person, so reconnect every time. */
async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("golden path", () => {
  // The steps depend on each other's outputs, so they form one test. Splitting them
  // would hide the ordering dependency, and a failure would not show which step broke.
  test.setTimeout(120_000);

  test("registration flows through to a public inclusion proof", async ({ page }) => {
    const projectKey = `GOLD-${Date.now()}`;

    // --- 1. Registration (mpc_operator) -----------------------------------
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Golden Path mine");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();

    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    // No disabled button or blank space where assets/subscription would be (OD-07). The
    // screen shows why it is absent and who must do what.
    await expect(page.getByTestId("offering-gate")).toContainText("not hidden behind a flag");
    await expect(page.getByTestId("offering-preconditions")).toContainText("Legal issuance decision");
    await expect(
      page.getByRole("button", { name: /subscribe|buy|purchase|transfer/i }),
    ).toHaveCount(0);

    // --- 2. Evidence and claim (data_steward) -----------------------------
    // The registering account cannot go on to handle evidence. The role differs.
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);

    // A file does not become evidence directly. It goes through quarantine → scan → promotion.
    await page.getByTestId("upload-input").setInputFiles({
      name: "mining-license.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`license extract ${projectKey}`),
    });
    await expect(page.getByTestId("upload-table")).toContainText("quarantined");

    const uploadRow = page.locator('[data-testid^="upload-state-"]').first();
    const uploadId = (await uploadRow.getAttribute("data-testid"))!.replace("upload-state-", "");

    // Scanning is done by a separate worker. The absence of that button on screen is the
    // control, so E2E calls the API **with the scan service's session**. A steward session
    // is rejected — the person who uploads a file cannot pass their own file.
    const stewardToken = await page.evaluate(() =>
      window.localStorage.getItem("mpc.session.token"),
    );
    const denied = await page.request.post(`/api/v1/uploads/${uploadId}/scan-result`, {
      headers: {
        authorization: `Bearer ${stewardToken}`,
        "idempotency-key": `e2e-denied-${uploadId}`,
        "if-match": '"1"',
      },
      data: { result: "clean" },
    });
    expect(denied.status()).toBe(403);

    await connectAs(page, "Scan Service");
    const scanToken = await page.evaluate(() =>
      window.localStorage.getItem("mpc.session.token"),
    );
    const scanned = await page.request.post(`/api/v1/uploads/${uploadId}/scan-result`, {
      headers: {
        authorization: `Bearer ${scanToken}`,
        "idempotency-key": `e2e-scan-${uploadId}`,
        "if-match": '"1"',
      },
      data: { result: "clean" },
    });
    expect(scanned.ok()).toBe(true);

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(page.getByTestId(`upload-state-${uploadId}`)).toHaveText("scanned_clean");

    await page.getByTestId(`promote-${uploadId}`).click();
    await expect(page.getByTestId(`upload-state-${uploadId}`)).toHaveText("promoted");

    /**
     * Confirmation is not typed in on screen — 2026-09-10 audit A1.
     *
     * This spot used to hold a `Record "confirmed"` button, and pressing it stored
     * `confirmed_from_source` as is. Now **the server calls the source.**
     *
     * This seed's endpoint is `registry.example.test`, a reserved TLD that does not
     * resolve (`e2e/seed.ts`) — the real authority integration is still open. So the
     * answer here is not "confirmed" but **"a person must check"**, and that is the
     * fact of this deployment today. The point is not to fabricate a confirmation.
     */
    await page.getByRole("button", { name: "Look up the official source" }).click();
    await expect(page.getByText("Manual review required")).toBeVisible();

    // The screen distinguishes the 12 outcomes as different facts (AC-18). If "no record"
    // and "cannot confirm" read the same, users keep retrying a record that does not exist.
    await page.getByRole("button", { name: "Record “no record”" }).click();
    await expect(page.getByText("No record found for this query")).toBeVisible();

    await page.getByRole("button", { name: "Record “source unavailable”" }).click();
    await expect(page.getByText("Source currently unavailable")).toBeVisible();

    await page.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(page.getByText("mining_right_registration")).toBeVisible();

    // Recording a conflict recomputes the grade immediately and bumps the version.
    await expect(page.getByText("v1")).toBeVisible();
    await page.getByRole("button", { name: "Record a conflict" }).click();
    await expect(page.getByText("v2")).toBeVisible();

    // --- 3. Review assignment (data_steward) ------------------------------
    await page.goto(`/w/projects/${projectId}/verification`);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Assign the review" }).click();
    await expect(page.getByTestId("selected-case")).toContainText("assigned");

    // --- 4. Signature (reviewer_cp_qp) ------------------------------------
    // The assigner cannot sign. The reviewer finds their assignment in the list.
    await connectAs(page, "Reviewer A");
    await page.goto(`/w/projects/${projectId}/verification`);

    // The header shows the connected person's role. Signing is an act of a qualified person.
    await expect(page.getByText(/reviewer_cp_qp/)).toBeVisible();

    await expect(page.getByTestId("case-list")).toBeVisible();
    await page.getByRole("button", { name: "Open this case" }).first().click();
    await expect(page.getByTestId("selected-case")).toContainText("assigned");

    await page.getByRole("button", { name: "Create the draft" }).click();
    // Checks the attestation state value, not other "draft" text on screen (headings, button labels).
    await expect(page.getByText("draft", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Create a signature request" }).click();
    // What is being signed is shown first in human-readable form (§11.4).
    await expect(page.getByTestId("signing-payload")).toContainText(projectKey);
    await expect(page.getByTestId("signing-payload")).toContainText("site due diligence");

    await page.getByTestId("sign-attestation").click();
    await expect(page.getByTestId("signed-result")).toContainText("signed");

    // --- 5. Readiness assessment (data_steward) ---------------------------
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/readiness`);
    await page.getByRole("button", { name: "Recompute" }).click();
    await expect(page.getByText("Result hash", { exact: true })).toBeVisible();

    // The readiness screen has no path to alter values (REQ-DAPP-017).
    await expect(page.getByRole("button", { name: /override|force|ignore/i })).toHaveCount(0);

    // --- 6. Gate decision (gate_approver) ---------------------------------
    await connectAs(page, "Approver A");
    await page.goto(`/w/projects/${projectId}/gates/registry_publication`);
    await page.getByRole("button", { name: "Load current readiness" }).click();
    // The guidance sentence also contains "There is no deciding without one", so a loose OR
    // regex matches two elements. Wait exactly for the heading of the loaded result.
    await expect(page.getByText(/^\d+ requirements block go$/)).toBeVisible();

    await page.getByLabel("Rationale (required)").fill("The basis is insufficient; not advancing to the next stage");

    // With a gap, go is blocked but hold can always be recorded. If bad news cannot be
    // recorded, the state quietly goes stale.
    await expect(page.getByRole("button", { name: "go (blocked)" })).toBeDisabled();
    await page.getByRole("button", { name: "hold", exact: true }).click();
    await expect(page.getByText("Recorded decision")).toBeVisible();

    // --- 7. Public publication and anchor (mpc_operator) -----------------
    await connectAs(page, "Operator A");
    await page.goto(`/w/projects/${projectId}/publication`);

    // The publish button cannot be pressed without acknowledging irreversibility.
    await expect(page.getByTestId("publish")).toBeDisabled();
    await page.getByTestId("irreversibility-ack").check();
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("published-result")).toContainText(projectKey);

    await page.getByTestId("anchor").click();
    // A created batch is not yet on chain.
    await expect(page.getByTestId("anchor-result")).toContainText("created");

    // --- 8. Lookup without sign-in ---------------------------------------
    await page.goto("/connect");
    await page.getByRole("button", { name: "Disconnect" }).click();

    // Arriving via a link, the screen looks up on its own. Pressing once more also checks
    // that the direct lookup path works — it is a different button from list search.
    await page.goto(`/explorer?registryType=project&publicKey=${projectKey}`);
    await page.getByRole("button", { name: "Look up" }).click();

    await expect(page.getByRole("heading", { name: "Published record" })).toBeVisible();
    await expect(page.getByTestId("shared-status")).toHaveText("published");

    /**
     * --- 8-1. Three-depth record view — §11.10 / AC-26 -----------------------
     *
     * Changing depth must keep status, version, as-of, limitations and authority scope
     * the same. Otherwise the "simple view" and the "detailed view" become different records.
     */
    const sharedFacts = async () => ({
      status: await page.getByTestId("shared-status").textContent(),
      version: await page.getByTestId("shared-version").textContent(),
      asOf: await page.getByTestId("shared-as-of").textContent(),
      limitations: await page.getByTestId("shared-limitations").textContent(),
      scope: await page.getByTestId("shared-authority-scope").textContent(),
    });

    const atBasic = await sharedFacts();
    await expect(page.getByTestId("explanation-layer")).toHaveCount(0);
    await expect(page.getByTestId("expert-layer")).toHaveCount(0);

    await page.getByTestId("depth-explanation").click();
    await expect(page.getByTestId("explanation-layer")).toBeVisible();
    expect(await sharedFacts()).toEqual(atBasic);

    await page.getByTestId("depth-expert").click();
    await expect(page.getByTestId("expert-layer")).toBeVisible();
    // Expert only adds receipt, hash and merkle path; it does not change the shared facts.
    expect(await sharedFacts()).toEqual(atBasic);

    /**
     * --- 9. Inclusion proof -------------------------------------------------
     *
     * AC-09: a valid inclusion proof returns integrity inclusion only and does not make
     * factual truth or legal validity true. AC-28: this whole flow passes without a
     * DID method or a ZK prover.
     */
    await expect(page.getByTestId("proof-panel")).toBeVisible();
    // The Merkle path matches, but before chain confirmation included is not yet true (AC-23).
    await expect(page.getByText("Path matches")).toBeVisible();
    await expect(page.getByTestId("proof-included")).toContainText("Not confirmed yet");

    // The same screen states what the proof does not confirm.
    await expect(page.getByTestId("proof-disclaimer")).toBeVisible();
    await expect(
      page.getByText("Integrity and authority are different questions"),
    ).toBeVisible();
  });
});
