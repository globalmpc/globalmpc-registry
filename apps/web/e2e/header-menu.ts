import { openDisclosure } from "./disclosures";
import { type Page } from "@playwright/test";

export async function openHeaderMenu(page: Page, label: "Account" | "Workspace" | "Public registry") {
  const summary = page.getByRole("banner").locator("summary").filter({ hasText: new RegExp(`^${label}$`) });
  const menu = summary.locator("..");
  await openDisclosure(menu);
}
