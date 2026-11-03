import { expect, test } from "@playwright/test";
import { connectAs } from "./connect-as";

/**
 * A large evidence file through the web origin (WP6).
 *
 * Since WP6 the session is an HttpOnly cookie on the web origin, so the streaming upload can only
 * go through this origin's `/api` — the browser has no token to send to the API host. The general
 * `/api` proxy is not fit for that: Next.js buffers the body of every request a proxy rewrites and
 * cuts it at `proxyClientMaxBodySize` (10 MiB), so a larger file reached the API truncated and
 * the API refused it as malformed multipart. This file is over that cap, so it fails unless the
 * upload is streamed past the proxy (`app/api/v1/projects/[projectId]/uploads/stream/route.ts`).
 */

const LARGE_FILE_BYTES = 12 * 1024 * 1024;

function fileBytes(seed: string): Buffer {
  const buffer = Buffer.alloc(LARGE_FILE_BYTES);
  buffer.write(seed);
  for (let index = seed.length; index < buffer.length; index += 1) {
    buffer[index] = (index * 13 + seed.length) % 256;
  }
  return buffer;
}

test.describe("large uploads", () => {
  test.setTimeout(120_000);

  test("a file over the proxy's body cap arrives whole and waits in quarantine", async ({ page }) => {
    const projectKey = `LARGE-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Large upload mine");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("combobox", { name: "Owning organization" }).selectOption(
      "aaaaaaaa-0000-0000-0000-000000000001",
    );
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(page.getByRole("heading", { name: "Data Room" })).toBeVisible();

    const sent = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/v1/projects/${projectId}/uploads/stream`) &&
        response.request().method() === "POST",
    );
    await page.getByTestId("upload-input").setInputFiles({
      name: "drill-core-logs.pdf",
      mimeType: "application/pdf",
      buffer: fileBytes(`drill core logs ${projectKey}`),
    });

    // Same origin: the cookie is the only credential the page has.
    const response = await sent;
    expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
    expect(response.status()).toBe(200);
    expect((await response.json()).byteSize).toBe(LARGE_FILE_BYTES);

    const states = page.locator('[data-testid^="upload-state-"]');
    await expect(states).toHaveCount(1);
    await expect(states.nth(0)).toHaveText("quarantined");
    // Every byte arrived. A truncated file would store as evidence with different content.
    await expect(page.getByText(`${LARGE_FILE_BYTES / 1024} KB`)).toBeVisible();
  });
});
