import { openDisclosure } from "./disclosures";
import { type Page } from "@playwright/test";

export async function openHeaderMenu(page: Page, label: "Account" | "Workspace" | "Public registry") {
  const sidebar = page.getByRole("complementary", { name: "Workspace navigation" });
  if (label === "Workspace" && await sidebar.count()) {
    const toggle = page.getByRole("button", { name: "Workspace navigation", exact: true });
    if (await toggle.isVisible()) await toggle.click();
    await openDisclosure(sidebar.locator("details.workspace-tools"));
    return;
  }
  const summary = page.getByRole("banner").locator("summary").filter({ hasText: new RegExp(`^${label}$`) });
  const menu = summary.locator("..");
  await openDisclosure(menu);
}
