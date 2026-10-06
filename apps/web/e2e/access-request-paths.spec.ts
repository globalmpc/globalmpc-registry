import { expect, test } from "@playwright/test";

/**
 * Checks that a screen exists at the path a denial points to — 11 §11.7.
 *
 * When `authorize()` denies, it returns an `accessRequestPath`, and `ErrorNotice` links
 * to it. If no screen exists at that path, a user following the guidance hits a 404.
 * This check only verifies that the link is not broken.
 *
 * The canonical paths are `ACCESS_REQUEST_PATHS` in `packages/api-contract`. The web does
 * not depend on that package, so the same values are written here, and a contract-side
 * test is locked to break if the list changes.
 *
 * **Opened without sign-in.** This is where a person blocked for lack of permission lands,
 * so what is missing must be readable without a session.
 */

const PATHS = [
  { path: "/w/identity/upgrade", heading: "Identity assurance is not high enough" },
  { path: "/w/access-requests", heading: "No role allows this action" },
  {
    path: "/w/projects/00000000-0000-0000-0000-000000000001/access-requests",
    heading: "Not assigned to this project",
  },
] as const;

test.describe("§11.7 — access request paths have screens", () => {
  for (const { path, heading } of PATHS) {
    test(path, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();

      // A missing feature must not look present. The screen must state that there is no
      // filing API so the person who pressed it does not wait.
      await expect(page.getByText("This screen does not file a request")).toBeVisible();
    });
  }
});
