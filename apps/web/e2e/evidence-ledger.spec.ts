import { expect, test } from "@playwright/test";
import { connectAs } from "./connect-as";
import {
  CHAIN_ENABLED,
  command,
  expectApprovedLedgerPanel,
  expectNoPrivateLedgerFields,
  publishAndAnchor,
  read,
  registerSyntheticProject,
  signScopedReview,
} from "./evidence-ledger-journey";

test.describe("evidence ledger complete journey", () => {
  test.setTimeout(240_000);
  test("catalog input, scoped review, approval and proof survive an evidence expiry warning", async ({
    page,
  }) => {
    const projectKey = `LEDGER-${Date.now()}`;
    await connectAs(page, "Operator A");
    // Synthetic definitions are proposed and independently approved through the real API.
    // They are test fixtures, not mining standards or a production bootstrap.
    const catalogProposal = await command(
      page,
      "/api/v1/review-registry/claim-types/proposals",
      {
        claimType: "mining_right_registration",
        displayName: "Synthetic mining licence",
        description: "Test fixture only",
        definition: {
          fields: [
            {
              key: "licence_number",
              label: "Licence number",
              type: "string",
              required: true,
            },
          ],
        },
        effectiveFrom: "2026-01-01T00:00:00Z",
        rationale: "Synthetic end-to-end fixture",
      },
    );
    const ruleSetId = `synthetic-stage-${Date.now()}`;
    const policyProposal = await command(
      page,
      "/api/v1/review-registry/policy-sets/proposals",
      {
        definition: {
          ruleSetId,
          version: "1.0.0",
          effectiveFrom: "2026-01-01T00:00:00Z",
          supersededBy: null,
          jurisdictionProfile: "MNG",
          gateId: "stage.exploration",
          retroactive: false,
          requirements: [
            {
              requirementId: "synthetic-licence",
              label: "Synthetic licence",
              appliesWhen: {
                op: "eq",
                path: "referenceStatus",
                value: "synthetic_test_project",
              },
              requiredClaimTypes: ["mining_right_registration"],
              minimumGrade: "partially_verified",
              freshnessThresholdDays: "180",
              requiredAttestations: ["professional_signoff"],
              blockingConflictTypes: [],
              notEvaluableWhen: { op: "never" },
              watchWhen: null,
            },
          ],
        },
        rationale: "Synthetic end-to-end stage fixture",
      },
    );
    await connectAs(page, "Reviewer A");
    const approved = await command(
      page,
      `/api/v1/review-registry/claim-types/proposals/${catalogProposal.id}/decision`,
      { decision: "approve", reason: "Synthetic fixture checked" },
      catalogProposal.version,
    );
    await command(
      page,
      `/api/v1/review-registry/policy-sets/proposals/${policyProposal.id}/decision`,
      { decision: "approve", reason: "Synthetic stage fixture checked" },
      policyProposal.version,
    );
    await connectAs(page, "Operator A");
    const projectId = await registerSyntheticProject(
      page,
      projectKey,
      "Synthetic evidence lifecycle",
    );

    // Catalog exclusions use the existing authorized, versioned confirmation UI.
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}`);
    const matrix = page.getByTestId("fact-matrix");
    await matrix.getByText("Record a matrix row", { exact: true }).click();
    await matrix.getByLabel("Item", { exact: true }).selectOption("mining_right_registration");
    await matrix.getByLabel("Status", { exact: true }).selectOption("not_applicable");
    await matrix.getByLabel("Reason", { exact: true }).fill("Synthetic catalog exclusion");
    await matrix.getByRole("button", { name: "Record version", exact: true }).click();
    await expect(matrix.locator('[data-fact="mining_right_registration"] [data-status="not_applicable"]')).toBeVisible();
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(page.getByTestId("ledger-status-mining_right_registration")).toHaveText("Not applicable");
    await page.goto(`/w/projects/${projectId}`);
    await matrix.getByText("Record a matrix row", { exact: true }).click();
    await matrix.getByLabel("Item", { exact: true }).selectOption("mining_right_registration");
    await matrix.getByLabel("Status", { exact: true }).selectOption("pending");
    await matrix.getByLabel("Reason", { exact: true }).fill("Synthetic exclusion withdrawn");
    await matrix.getByRole("button", { name: "Record version", exact: true }).click();
    await expect(matrix.locator('[data-fact="mining_right_registration"] [data-status="pending"]')).toBeVisible();
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(page.getByTestId("ledger-status-mining_right_registration")).toHaveText("Missing evidence");

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByTestId("upload-input").setInputFiles({
      name: "synthetic-licence.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`Synthetic evidence ${projectKey}`),
    });
    const uploadState = page.locator('[data-testid^="upload-state-"]').first();
    await expect(uploadState).toHaveText("quarantined");
    const uploadId = (await uploadState.getAttribute("data-testid"))!.replace(
      "upload-state-",
      "",
    );
    await connectAs(page, "Scan Service");
    await command(
      page,
      `/api/v1/uploads/${uploadId}/scan-result`,
      { result: "clean" },
      1,
    );
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByTestId(`promote-${uploadId}`).click();
    await expect(page.getByTestId(`upload-state-${uploadId}`)).toHaveText(
      "promoted",
    );
    await page
      .getByLabel("Claim definition")
      .selectOption(approved.materializedId);
    await page
      .getByLabel("Licence number (required)")
      .fill(`SYNTH-${projectKey}`);
    await page.getByLabel("Claim supporting document").selectOption(uploadId);
    await page.getByLabel("Claim evidence tier").selectOption("P1");
    await page
      .getByLabel("Claim as-of date (optional)")
      .fill(new Date().toISOString().slice(0, 10));
    await page
      .getByLabel("Claim source reference")
      .fill("Synthetic licence page 1");
    await page.getByRole("button", { name: "Save catalog claim" }).click();
    await expect(
      page.getByText(`Licence number: SYNTH-${projectKey}`),
    ).toBeVisible();
    await expect(
      page.getByTestId("ledger-status-mining_right_registration"),
    ).toHaveText("Unreviewed");

    await signScopedReview(page, projectId);
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(
      page.getByTestId("ledger-status-mining_right_registration"),
    ).toHaveText("Reviewed");
    await expect(page.getByTestId("evidence-ledger")).toContainText(
      "Exploration",
    );

    await publishAndAnchor(page, projectId, projectKey);
    // Private basis of the approved item, read with Operator A's workspace access.
    const privateLedger = (
      await read(page, `/api/v1/projects/${projectId}/evidence-ledger`)
    ).snapshot;
    await page.goto(`/explorer/projects/${projectKey}`);
    await expect(
      page.getByTestId("ledger-status-mining_right_registration"),
    ).toHaveText("Reviewed");
    await expect(page.getByTestId("proof-panel")).toBeVisible();
    await expect(page.getByText("Path matches")).toBeVisible();
    await expect(page.getByTestId("proof-included")).toContainText(
      CHAIN_ENABLED ? "Confirmed" : "Not confirmed yet",
    );
    await page.screenshot({
      path: test.info().outputPath("ledger-approved.png"),
      fullPage: true,
    });
    const beforeResponse = await page.request.get(
      `/api/v1/public/registries/project/${projectKey}`,
    );
    const before = await beforeResponse.json();
    await expectApprovedLedgerPanel(page, before.evidenceLedger, {
      stage: "Exploration",
      reviewedClaimTypes: ["mining_right_registration"],
    });
    const privateItem = privateLedger.items.find(
      (item: { claimType: string }) => item.claimType === "mining_right_registration",
    );
    expect(privateItem.claimIds).toHaveLength(1);
    expect(privateItem.attestationIds).toHaveLength(1);
    expectNoPrivateLedgerFields(await beforeResponse.text(), [
      ...privateItem.claimIds,
      ...privateItem.attestationIds,
      ...privateLedger.stages.map((stage: { policySetId: string }) => stage.policySetId),
      ruleSetId,
      "synthetic-licence\"",
      uploadId,
      `SYNTH-${projectKey}`,
    ]);
    const proofBefore = await (
      await page.request.get(`/api/v1/public/proofs/${before.entryVersionId}`)
    ).json();
    // Real hashes, so the unchanged-proof comparisons below cannot pass on missing values.
    expect(proofBefore.leafHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proofBefore.root).toMatch(/^0x[0-9a-f]{64}$/);

    // Recompute the actual path in the independent browser verifier, then simulate a
    // tampered proof response. A server's true merkleVerified flag must not mask it.
    await page.goto("/verify");
    await page.getByLabel("Public key").fill(projectKey);
    await page.getByRole("button", { name: "Check proof" }).click();
    await expect(page.getByTestId("verify-merkle")).toContainText(
      "Leads to the root",
    );
    await page
      .getByLabel("Expected leaf hash (optional)")
      .fill(`0x${"00".repeat(32)}`);
    await page.getByRole("button", { name: "Check proof" }).click();
    await expect(page.getByTestId("verify-expected")).toContainText(
      "Different from the leaf",
    );
    const proofPath = `/api/v1/public/proofs/${before.entryVersionId}`;
    await page.route(`**${proofPath}`, async (route) => {
      const actual = await route.fetch();
      const body = await actual.json();
      await route.fulfill({
        response: actual,
        json: { ...body, root: `0x${"00".repeat(32)}`, merkleVerified: true },
      });
    });
    await page.getByRole("button", { name: "Check proof" }).click();
    await expect(page.getByTestId("verify-merkle")).toContainText(
      "Does not lead to the root",
    );
    await page.unroute(`**${proofPath}`);

    await connectAs(page, "Steward A");
    const token = await page.evaluate(() =>
      localStorage.getItem("mpc.session.token"),
    );
    const uploads = await (
      await page.request.get(`/api/v1/projects/${projectId}/uploads`, {
        headers: { authorization: `Bearer ${token}` },
      })
    ).json();
    const upload = uploads.items.find(
      (item: { id: string }) => item.id === uploadId,
    );
    await command(
      page,
      `/api/v1/uploads/${uploadId}/document-profile`,
      { documentType: "synthetic_licence", validUntil: "2020-01-01" },
      upload.version,
      "patch",
    );
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(
      page.getByTestId("ledger-status-mining_right_registration"),
    ).toHaveText("Needs another review");
    await page.goto("/connect");
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.goto(`/explorer/projects/${projectKey}`);
    await expect(
      page.getByTestId("ledger-status-mining_right_registration"),
    ).toHaveText("Reviewed");
    await expect(page.getByTestId("evidence-ledger-current")).toContainText(
      "Needs another review",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: test.info().outputPath("ledger-expired-mobile.png"),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const after = await (
      await page.request.get(`/api/v1/public/registries/project/${projectKey}`)
    ).json();
    expect(after.entryVersionId).toBe(before.entryVersionId);
    expect(after.evidenceLedger).toEqual(before.evidenceLedger);
    const proofAfter = await (
      await page.request.get(`/api/v1/public/proofs/${after.entryVersionId}`)
    ).json();
    expect(proofAfter.leafHash).toBe(proofBefore.leafHash);
    expect(proofAfter.root).toBe(proofBefore.root);

    // Revocation leaves the upload promoted but removes it from claim evidence choices.
    await connectAs(page, "Steward A");
    const currentUploads = await (
      await page.request.get(`/api/v1/projects/${projectId}/uploads`, {
        headers: { authorization: `Bearer ${await page.evaluate(() => localStorage.getItem("mpc.session.token"))}` },
      })
    ).json();
    const currentUpload = currentUploads.items.find((item: { id: string }) => item.id === uploadId);
    await command(page, `/api/v1/uploads/${uploadId}/revoke`, { reason: "Synthetic revocation regression" }, currentUpload.version);
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByLabel("Claim definition").selectOption(approved.materializedId);
    await expect(page.getByLabel("Claim supporting document").locator(`option[value="${uploadId}"]`)).toHaveCount(0);
    await expect(page.getByLabel("Claim supporting document").locator('option[value=""]')).toHaveText("No document linked");
  });
});
