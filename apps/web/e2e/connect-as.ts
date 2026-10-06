import { expect, type Page } from "@playwright/test";

/**
 * Signs in as one of the demo accounts on `/connect`.
 *
 * The exit condition checks the wallet address shown in the top bar, not just the
 * "Disconnect" button. A stale session also shows "Disconnect", so a lost click on the
 * account card used to pass silently and later steps failed with 403 or empty lists.
 * Waiting until the top bar shows the address of the chosen card proves the switch
 * actually happened.
 */
export async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");

  const disconnect = page.getByRole("button", { name: "Disconnect" });
  if (await disconnect.isVisible().catch(() => false)) {
    await disconnect.click();
    await expect(disconnect).toBeHidden();
  }

  // Exact match on the card name: "Operator A" must not match any other card.
  const card = page
    .locator("button.account-card")
    .filter({ has: page.locator(".name", { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) });
  await expect(card).toHaveCount(1);
  const address = (await card.locator(".mono.meta").innerText()).trim();

  await card.click();

  // The top bar is the only place that reflects the active session. Other screens may also
  // render a wallet address, so the check is scoped to the header.
  const topBar = page.locator("header.topbar");
  await expect(topBar.getByTestId("wallet-address")).toHaveText(address, { ignoreCase: true });
  await expect(topBar.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
