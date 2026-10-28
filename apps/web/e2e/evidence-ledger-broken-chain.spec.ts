import { expect, test, type Page } from "@playwright/test";
import { catalogFixtureKey } from "./catalog-fixtures";
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

interface Upload {
  readonly id: string;
  readonly version: number;
}

const REASON = "Supporting evidence or its review is no longer current.";

async function disconnect(page: Page) {
  await page.goto("/connect");
  const button = page.getByRole("button", { name: "Disconnect" });
  if (await button.isVisible().catch(() => false)) {
    await button.click();
    await expect(button).toBeHidden();
  }
}

/**
 * A broken evidence chain: after approval and publication, a document a published item rests
 * on is replaced (through a document it depends on) or revoked (its own document). Only the
 * live overlay and the workspace change; the approved record, its hash and proof stay as they
 * were, and a document no item rests on changes nothing.
 */
test.describe("evidence ledger broken chain journey", () => {
  test.setTimeout(300_000);
  test("revoked and replaced supporting documents warn only the items resting on them", async ({
    page,
  }) => {
    const stamp = Date.now();
    // Per-attempt keys the seeded reviewer credential and its issuer recognize; a retry gets
    // fresh catalog items at version 1 rather than the failed attempt's leftovers.
    const licence = catalogFixtureKey("synthetic_chain_licence", test.info().retry);
    const permit = catalogFixtureKey("synthetic_chain_permit", test.info().retry);
    const projectKey = `CHAIN-${stamp}`;
    const ruleSetId = `synthetic-chain-${stamp}`;
    const requirementIds = [`chain-licence-${stamp}`, `chain-permit-${stamp}`];
    const fields: Record<string, string> = { [licence]: "Licence number", [permit]: "Permit number" };

    // Synthetic definitions through the real proposal and independent approval routes.
    await connectAs(page, "Operator A");
    const catalogProposals = [];
    for (const claimType of [licence, permit]) {
      catalogProposals.push(
        await command(page, "/api/v1/review-registry/claim-types/proposals", {
          claimType,
          displayName: `Synthetic ${fields[claimType]!.toLowerCase()}`,
          description: "Test fixture only",
          definition: {
            fields: [{ key: "number", label: fields[claimType], type: "string", required: true }],
          },
          effectiveFrom: "2026-01-01T00:00:00Z",
          rationale: "Synthetic broken-chain fixture",
        }),
      );
    }
    const policyProposal = await command(page, "/api/v1/review-registry/policy-sets/proposals", {
      definition: {
        ruleSetId,
        version: "1.0.0",
        effectiveFrom: "2026-01-01T00:00:00Z",
        supersededBy: null,
        jurisdictionProfile: "MNG",
        gateId: "stage.exploration",
        retroactive: false,
        requirements: [licence, permit].map((claimType, index) => ({
          requirementId: requirementIds[index],
          label: `Synthetic ${fields[claimType]!.toLowerCase()}`,
          appliesWhen: { op: "eq", path: "referenceStatus", value: "synthetic_test_project" },
          requiredClaimTypes: [claimType],
          minimumGrade: "partially_verified",
          freshnessThresholdDays: "180",
          requiredAttestations: ["professional_signoff"],
          blockingConflictTypes: [],
          notEvaluableWhen: { op: "never" },
          watchWhen: null,
        })),
      },
      rationale: "Synthetic broken-chain stage fixture",
    });
    await connectAs(page, "Reviewer A");
    const catalog: Record<string, string> = {};
    for (const [index, claimType] of [licence, permit].entries()) {
      const proposal = catalogProposals[index];
      const approved = await command(
        page,
        `/api/v1/review-registry/claim-types/proposals/${proposal.id}/decision`,
        { decision: "approve", reason: "Synthetic fixture checked" },
        proposal.version,
      );
      catalog[claimType] = approved.materializedId;
    }
    await command(
      page,
      `/api/v1/review-registry/policy-sets/proposals/${policyProposal.id}/decision`,
      { decision: "approve", reason: "Synthetic stage fixture checked" },
      policyProposal.version,
    );

    await connectAs(page, "Operator A");
    const projectId = await registerSyntheticProject(page, projectKey, "Synthetic broken chain");

    // Documents: each claim's own document, an upstream document the permit document depends
    // on, and a document nothing rests on.
    await connectAs(page, "Steward A");
    const upload = (name: string): Promise<Upload> =>
      command(page, `/api/v1/projects/${projectId}/uploads`, {
        contentBase64: Buffer.from(`Synthetic ${name} ${projectKey}`).toString("base64"),
        contentType: "application/pdf",
        originalFilename: name,
      });
    const currentVersion = async (uploadId: string): Promise<number> => {
      const uploads = await read(page, `/api/v1/projects/${projectId}/uploads`);
      return uploads.items.find((item: { id: string }) => item.id === uploadId).version;
    };
    const promote = async (documents: Upload[]) => {
      await connectAs(page, "Scan Service");
      const scanned: Upload[] = [];
      for (const document of documents) {
        scanned.push(
          await command(page, `/api/v1/uploads/${document.id}/scan-result`, { result: "clean" }, document.version),
        );
      }
      await connectAs(page, "Steward A");
      for (const document of scanned) {
        await command(page, `/api/v1/uploads/${document.id}/promote`, {}, document.version);
      }
    };
    const licenceDocument = await upload("chain-licence.pdf");
    const permitDocument = await upload("chain-permit.pdf");
    const permitBasis = await upload("chain-permit-basis.pdf");
    const unrelated = await upload("chain-unrelated.pdf");
    const documents = [licenceDocument, permitDocument, permitBasis, unrelated];
    await promote(documents);
    await command(page, `/api/v1/projects/${projectId}/document-links`, {
      upstreamUploadId: permitBasis.id,
      downstreamUploadId: permitDocument.id,
      kind: "depends_on",
    });

    const values: Record<string, string> = { [licence]: `SYNTH-L-${stamp}`, [permit]: `SYNTH-P-${stamp}` };
    const claimDocuments: Record<string, string> = { [licence]: licenceDocument.id, [permit]: permitDocument.id };
    await page.goto(`/w/projects/${projectId}/data-room`);
    for (const claimType of [licence, permit]) {
      await page.getByLabel("Claim definition").selectOption(catalog[claimType]!);
      await page.getByLabel(`${fields[claimType]} (required)`).fill(values[claimType]!);
      await page.getByLabel("Claim supporting document").selectOption(claimDocuments[claimType]!);
      await page.getByLabel("Claim evidence tier").selectOption("P1");
      await page
        .getByLabel("Claim as-of date (optional)")
        .fill(new Date().toISOString().slice(0, 10));
      await page.getByLabel("Claim source reference").fill(`Synthetic ${claimType} page 1`);
      await page.getByRole("button", { name: "Save catalog claim" }).click();
      await expect(page.getByText(`${fields[claimType]}: ${values[claimType]}`)).toBeVisible();
      await expect(page.getByTestId(`ledger-status-${claimType}`)).toHaveText("Unreviewed");
    }

    await signScopedReview(page, projectId, [licence, permit]);
    const expectWorkspace = async (statuses: Record<string, string>) => {
      await page.goto(`/w/projects/${projectId}/data-room`);
      for (const [claimType, status] of Object.entries(statuses)) {
        await expect(page.getByTestId(`ledger-status-${claimType}`)).toHaveText(status);
      }
    };
    await expectWorkspace({ [licence]: "Reviewed", [permit]: "Reviewed" });
    await expect(page.getByTestId("evidence-ledger")).toContainText("Exploration");

    await publishAndAnchor(page, projectId, projectKey);
    const privateLedger = (await read(page, `/api/v1/projects/${projectId}/evidence-ledger`)).snapshot;
    const privateItems = privateLedger.items.filter((item: { claimType: string }) =>
      [licence, permit].includes(item.claimType),
    );
    expect(privateItems).toHaveLength(2);
    const privateValues: string[] = [
      ...privateItems.flatMap((item: { claimIds: string[]; attestationIds: string[] }) => {
        expect(item.claimIds).toHaveLength(1);
        expect(item.attestationIds).toHaveLength(1);
        return [...item.claimIds, ...item.attestationIds];
      }),
      ...privateLedger.stages.map((stage: { policySetId: string }) => stage.policySetId),
      ruleSetId,
      ...requirementIds,
      ...documents.map((document) => document.id),
      ...Object.values(values),
    ];

    // Approved public view, read anonymously.
    await disconnect(page);
    const publicPath = `/api/v1/public/registries/project/${projectKey}`;
    await page.goto(`/explorer/projects/${projectKey}`);
    for (const claimType of [licence, permit]) {
      await expect(page.getByTestId(`ledger-status-${claimType}`)).toHaveText("Reviewed");
    }
    await expect(page.getByTestId("proof-panel")).toBeVisible();
    await expect(page.getByTestId("proof-included")).toContainText(
      CHAIN_ENABLED ? "Confirmed" : "Not confirmed yet",
    );
    const beforeResponse = await page.request.get(publicPath);
    expect(beforeResponse.ok()).toBe(true);
    // requestId and asOf describe this response, not the record.
    const {
      evidenceLedgerCurrent: currentBefore,
      requestId: _beforeRequest,
      asOf: _beforeAsOf,
      ...frozenBefore
    } = await beforeResponse.json();
    expect(currentBefore.warnings).toEqual([]);
    await expectApprovedLedgerPanel(page, frozenBefore.evidenceLedger, {
      stage: "Exploration",
      reviewedClaimTypes: [licence, permit],
    });
    await expect(page.getByTestId("evidence-ledger-current")).toContainText(
      "No current warnings reported for published items.",
    );
    expectNoPrivateLedgerFields(await beforeResponse.text(), privateValues);
    const proofPath = `/api/v1/public/proofs/${frozenBefore.entryVersionId}`;
    const proofBefore = await (await page.request.get(proofPath)).json();
    // Real hashes, so the unchanged-proof comparisons below cannot pass on missing values.
    expect(proofBefore.leafHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(proofBefore.root).toMatch(/^0x[0-9a-f]{64}$/);

    const expectPublic = async (warned: string[]) => {
      await disconnect(page);
      await page.goto(`/explorer/projects/${projectKey}`);
      for (const claimType of [licence, permit]) {
        await expect(page.getByTestId(`ledger-status-${claimType}`)).toHaveText("Reviewed");
      }
      const overlay = page.getByTestId("evidence-ledger-current");
      await expect(overlay).toBeVisible();
      if (warned.length === 0) {
        await expect(overlay).toContainText("No current warnings reported for published items.");
      }
      for (const claimType of [licence, permit]) {
        if (warned.includes(claimType)) {
          await expect(overlay).toContainText(
            `${claimType} · catalog v1: Needs another review — ${REASON}`,
          );
        } else {
          await expect(overlay).not.toContainText(claimType);
        }
      }
      await expect(page.getByTestId("proof-included")).toContainText(
        CHAIN_ENABLED ? "Confirmed" : "Not confirmed yet",
      );
      const response = await page.request.get(publicPath);
      expect(response.ok()).toBe(true);
      const { evidenceLedgerCurrent, requestId: _request, asOf: _asOf, ...frozen } =
        await response.json();
      // The approved projection, version and history are the same as before the break; the
      // proof below pins the anchored leaf hash of the projection itself.
      expect(frozen).toEqual(frozenBefore);
      expect(evidenceLedgerCurrent.warnings).toEqual(
        [...warned].sort().map((claimType) => ({
          claimType,
          catalogVersion: "1",
          status: "needs_re_review",
          reasons: ["EVIDENCE_OR_REVIEW_NO_LONGER_CURRENT"],
        })),
      );
      expectNoPrivateLedgerFields(await response.text(), privateValues);
      const proof = await (await page.request.get(proofPath)).json();
      expect(proof.leafHash).toBe(proofBefore.leafHash);
      expect(proof.root).toBe(proofBefore.root);
    };

    // Negative control: revoking a document no item rests on changes nothing.
    await connectAs(page, "Steward A");
    await command(
      page,
      `/api/v1/uploads/${unrelated.id}/revoke`,
      { reason: "Synthetic unrelated revocation" },
      await currentVersion(unrelated.id),
    );
    await expectWorkspace({ [licence]: "Reviewed", [permit]: "Reviewed" });
    await expectPublic([]);

    // Transitive break: the permit document depends on a document that is replaced.
    await connectAs(page, "Steward A");
    const replacement = await upload("chain-permit-basis-v2.pdf");
    privateValues.push(replacement.id);
    const marked: Upload = await command(
      page,
      `/api/v1/uploads/${replacement.id}/document-profile`,
      { supersedesUploadId: permitBasis.id },
      replacement.version,
      "patch",
    );
    await promote([marked]);
    await expectWorkspace({ [licence]: "Reviewed", [permit]: "Needs another review" });
    await page.screenshot({
      path: test.info().outputPath("ledger-broken-chain-workspace.png"),
      fullPage: true,
    });
    await expectPublic([permit]);

    // Direct break: the licence claim's own document is revoked.
    await connectAs(page, "Steward A");
    await command(
      page,
      `/api/v1/uploads/${licenceDocument.id}/revoke`,
      { reason: "Synthetic broken evidence chain" },
      await currentVersion(licenceDocument.id),
    );
    await expectWorkspace({ [licence]: "Needs another review", [permit]: "Needs another review" });
    await expectPublic([licence, permit]);
    await page.screenshot({
      path: test.info().outputPath("ledger-broken-chain-explorer.png"),
      fullPage: true,
    });
  });
});
