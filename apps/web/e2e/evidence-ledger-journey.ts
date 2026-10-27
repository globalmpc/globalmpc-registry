import { expect, type Page } from "@playwright/test";
import { connectAs } from "./connect-as";

/**
 * Steps shared by the evidence ledger journeys. Each step goes through the same screens and
 * authorized API routes a person uses, and asserts what that person would see before moving on.
 */

// CI runs these journeys both before the worker (pending proof) and with the real chain.
export const CHAIN_ENABLED = process.env["E2E_CHAIN"] === "1";

export async function sessionToken(page: Page): Promise<string | null> {
  return page.evaluate(() => localStorage.getItem("mpc.session.token"));
}

export async function command(
  page: Page,
  path: string,
  data: unknown,
  version?: number,
  method: "post" | "patch" = "post",
) {
  const token = await sessionToken(page);
  const response = await page.request[method](path, {
    headers: {
      authorization: `Bearer ${token}`,
      "idempotency-key": crypto.randomUUID(),
      ...(version === undefined ? {} : { "if-match": `"${version}"` }),
    },
    data,
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json();
}

/** An authenticated read with the current session. */
export async function read(page: Page, path: string) {
  const response = await page.request.get(path, {
    headers: { authorization: `Bearer ${await sessionToken(page)}` },
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return response.json();
}

/** Registers a synthetic MNG test project through the workspace form; returns its id. */
export async function registerSyntheticProject(
  page: Page,
  projectKey: string,
  name: string,
): Promise<string> {
  await page.goto("/w/projects/new");
  await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page
    .getByRole("textbox", { name: "Minerals (comma separated)" })
    .fill("copper");
  await page
    .getByRole("combobox", { name: "Owning organization" })
    .selectOption("aaaaaaaa-0000-0000-0000-000000000001");
  await page.getByRole("checkbox", { name: "Synthetic test project" }).check();
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
  return new URL(page.url()).pathname.split("/").pop()!;
}

/**
 * Steward A assigns a review of the selected claims (the first one when none are named) and
 * Reviewer A signs it. Ends signed in as Reviewer A.
 */
export async function signScopedReview(
  page: Page,
  projectId: string,
  claimTypes?: readonly string[],
): Promise<void> {
  await connectAs(page, "Steward A");
  await page.goto(`/w/projects/${projectId}/verification`);
  if (claimTypes === undefined) {
    await page.getByRole("checkbox").first().check();
  } else {
    for (const claimType of claimTypes) {
      await page
        .locator("label")
        .filter({ has: page.locator(".mono", { hasText: new RegExp(`^${claimType}$`) }) })
        .getByRole("checkbox")
        .check();
    }
  }
  await page.getByRole("button", { name: "Assign the review" }).click();
  await expect(page.getByTestId("selected-case")).toContainText("assigned");
  await connectAs(page, "Reviewer A");
  await page.goto(`/w/projects/${projectId}/verification`);
  await page.getByRole("button", { name: "Open this case" }).first().click();
  await page.getByRole("button", { name: "Create the draft" }).click();
  await page.getByRole("button", { name: "Create a signature request" }).click();
  await page.getByTestId("sign-attestation").click();
  await expect(page.getByTestId("signed-result")).toContainText("signed");
}

/**
 * Operator A drafts, Publisher A publishes and Operator A anchors the project record. With the
 * chain enabled, waits for the anchor confirmation. Ends signed in as Operator A.
 */
export async function publishAndAnchor(
  page: Page,
  projectId: string,
  projectKey: string,
): Promise<void> {
  await connectAs(page, "Operator A");
  await page.goto(`/w/projects/${projectId}/publication`);
  await page.getByTestId("draft").click();
  await expect(page.getByTestId("pending-draft")).toBeVisible();
  await connectAs(page, "Publisher A");
  await page.goto(`/w/projects/${projectId}/publication`);
  await page.getByTestId("irreversibility-ack").check();
  await page.getByTestId("publish").click();
  await expect(page.getByTestId("published-result")).toContainText(projectKey);
  await connectAs(page, "Operator A");
  await page.goto(`/w/projects/${projectId}/publication`);
  await page.getByTestId("anchor").click();
  await expect(page.getByTestId("anchor-result")).toContainText("created");
  if (CHAIN_ENABLED) {
    const batchId = (await page.getByTestId("anchor-result").innerText()).match(
      /0x[0-9a-f]{64}/,
    )![0];
    await page.goto("/w/anchors");
    await expect(
      page.getByTestId(`anchor-state-${batchId.slice(2, 10)}`),
    ).toHaveText("confirmed", { timeout: 120_000 });
  }
}

interface PublicLedgerItem {
  readonly claimType: string;
  readonly status: string;
  readonly limitations: readonly string[];
  readonly reviews: readonly { readonly limitations: string }[];
}
interface PublicLedgerStage {
  readonly gateId: string;
  readonly status: string;
  readonly ruleSetVersion: string;
  readonly reviewedItems: string;
  readonly requiredItems: string;
}
export interface PublicLedger {
  readonly items: readonly PublicLedgerItem[];
  readonly stages: readonly PublicLedgerStage[];
  readonly currentStage: string | null;
  readonly limitations: readonly string[];
}

/**
 * The approved Explorer panel shows the stage, reviewed coverage, stage coverage and
 * limitations frozen in the published projection — derived from that projection, not from
 * live state. `expected` pins what the approval established for the named items.
 */
export async function expectApprovedLedgerPanel(
  page: Page,
  ledger: PublicLedger,
  expected: { readonly stage: string; readonly reviewedClaimTypes: readonly string[] },
): Promise<void> {
  const panel = page.getByTestId("evidence-ledger");
  expect(ledger.currentStage).not.toBeNull();
  await expect(
    panel.locator("dt", { hasText: "Evidence stage at assessment" }).locator("xpath=following-sibling::dd[1]"),
  ).toHaveText(expected.stage);
  for (const claimType of expected.reviewedClaimTypes) {
    expect(ledger.items.find((item) => item.claimType === claimType)?.status).toBe("reviewed");
  }
  const reviewed = ledger.items.filter((item) => item.status === "reviewed").length;
  await expect(
    panel.locator("dt", { hasText: "Reviewed coverage" }).locator("xpath=following-sibling::dd[1]"),
  ).toHaveText(`${reviewed} / ${ledger.items.length} items`);
  const stage = ledger.stages.find((candidate) => candidate.gateId === ledger.currentStage)!;
  expect(stage.status).toBe("ok");
  await expect(panel).toContainText(
    `${expected.stage}: Requirements met · rule ${stage.ruleSetVersion} · Reviewed ${stage.reviewedItems} / ${stage.requiredItems} required items`,
  );
  for (const claimType of expected.reviewedClaimTypes) {
    const item = ledger.items.find((candidate) => candidate.claimType === claimType)!;
    expect(item.limitations.length).toBeGreaterThan(0);
    const entry = panel.locator("li").filter({ has: page.getByTestId(`ledger-status-${claimType}`) });
    await expect(entry).toContainText(`Limitations: ${item.limitations.join("; ")}`);
    for (const review of item.reviews) {
      await expect(entry).toContainText(review.limitations);
    }
  }
  expect(ledger.limitations.length).toBeGreaterThan(0);
  await expect(panel).toContainText(ledger.limitations.join("; "));
}

/**
 * The anonymous public record and its live overlay disclose none of the private basis behind
 * the approved items: claim, review, document and policy identities, private values and the
 * requirement identities or private structure of the policy.
 */
export function expectNoPrivateLedgerFields(
  publicBody: string,
  privateValues: readonly string[],
): void {
  for (const value of privateValues) {
    expect(value.length).toBeGreaterThan(0);
    expect(publicBody, `public body leaks ${value}`).not.toContain(value);
  }
  for (const key of [
    "claimIds",
    "attestationIds",
    "policySetId",
    "inputBasis",
    "applicableStageRequirements",
    "uploadIds",
    "documentUploadIds",
    "structuredValues",
  ]) {
    expect(publicBody, `public body exposes ${key}`).not.toContain(`"${key}"`);
  }
}
