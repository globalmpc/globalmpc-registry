import { expect, test, type Page } from "@playwright/test";

/**
 * Chain confirmation E2E.
 *
 * The golden path ends at creating a batch — `included` is false at that point. This
 * spec covers what follows: once the worker actually submits and the confirmation depth
 * is reached, does the public proof's `included` become true.
 *
 * **Runs only when anvil and the anchor worker are up.** Otherwise it skips — a missing
 * test is better than a green one that pretends. Enable with `E2E_CHAIN=1`.
 */

const CHAIN_ENABLED = process.env["E2E_CHAIN"] === "1";

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("chain confirmation", () => {
  test.skip(!CHAIN_ENABLED, "requires anvil and the anchor worker (E2E_CHAIN=1)");
  test.setTimeout(180_000);

  test("a published record becomes included=true after chain confirmation", async ({ page }) => {
    const projectKey = `CHAIN-${Date.now()}`;

    await connectAs(page, "Operator A");

    // The dev server compiles a route **on first access**. If the navigation right after
    // registration is that first access, the 15-second assertion below measures compile
    // time rather than the app, and slow cannot be told from broken — running this spec
    // alone (`playwright test anchor-chain`) hits that state every time because no earlier
    // spec has warmed the route. Visit once with a nonexistent id just to finish compiling.
    // Why this is not papered over with retries: see the expect timeout comment in
    // `playwright.config.ts`.
    await page.goto("/w/projects/00000000-0000-4000-8000-000000000000");

    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("For the chain confirmation check");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();

    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await page.goto(`/w/projects/${projectId}/publication`);
    await page.getByTestId("irreversibility-ack").check();
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("published-result")).toContainText(projectKey);

    await page.getByTestId("anchor").click();
    // Right after creation it is not on chain.
    await expect(page.getByTestId("anchor-result")).toContainText("created");

    // Looks only at the batch this test created. Mistaking a confirmed batch left by an
    // earlier run for its own would make the test verify nothing.
    const batchId = (await page.getByTestId("anchor-result").innerText()).match(
      /0x[0-9a-f]{64}/,
    )?.[0] as string;
    expect(batchId).toBeTruthy();

    // --- Wait for confirmation on the operations screen ------------------
    await page.goto("/w/anchors");
    await expect(page.getByTestId("anchor-table")).toBeVisible();

    // The worker proceeds submit → include → confirm. The screen re-reads every 5 seconds.
    await expect(page.getByTestId(`anchor-state-${batchId.slice(2, 10)}`)).toHaveText(
      "confirmed",
      { timeout: 120_000 },
    );

    // --- Check the proof without sign-in ---------------------------------
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.goto(`/explorer?registryType=project&publicKey=${projectKey}`);
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page.getByTestId("proof-panel")).toBeVisible();
    await expect(page.getByText("Path matches")).toBeVisible();
    // included is true only after confirmation (AC-23).
    await expect(page.getByTestId("proof-included")).toContainText("Confirmed");

    // Even when confirmed, what the proof does not confirm is still stated.
    await expect(page.getByTestId("proof-disclaimer")).toBeVisible();
    await expect(
      page.getByText("Integrity and authority are different questions"),
    ).toBeVisible();
  });
});
