import { expect, type Locator, type Page } from "@playwright/test";

/** Follow the same visible interaction as a user; repeated calls must not close a menu. */
export async function openDisclosure(menu: Locator) {
  const summary = menu.locator(":scope > summary");
  await expect(summary).toBeVisible();
  if (!(await menu.evaluate((element) => (element as HTMLDetailsElement).open))) await summary.click();
}

export async function openFooterMenu(page: Page) {
  await openDisclosure(page.getByRole("contentinfo").locator("details.footer-navigation"));
}

export async function openPublicLookup(page: Page) {
  const summary = page.getByRole("main").locator("summary").filter({ hasText: /^Find a record or proof$/ });
  await openDisclosure(summary.locator(".."));
}
