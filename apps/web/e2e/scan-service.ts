import { expect, type Page } from "@playwright/test";
import { e2eScanServiceToken } from "./scan-service-token";

/**
 * Reports a scan result as the scan service — with its service token, as the scan worker does.
 *
 * The scan service is not a person: it has no wallet and no sign-in card, and its token reaches
 * only the scan-result route (decision D7). The token is derived from the run's demo keys
 * (`scan-service-token.ts`) and the seed stores only its hash, so no usable token is committed.
 */
export async function reportScan(
  page: Page,
  uploadId: string,
  version: number,
  result: "clean" | "infected" = "clean",
): Promise<{ id: string; version: number }> {
  const token = e2eScanServiceToken();
  const response = await page.request.post(`/api/v1/uploads/${uploadId}/scan-result`, {
    headers: {
      authorization: `Bearer ${token}`,
      // One report per upload version, as the worker keys it.
      "idempotency-key": `scan-${uploadId}-v${version}`,
      "if-match": `"${version}"`,
    },
    data: { result },
  });
  expect(response.ok(), `scan-result ${uploadId}: ${await response.text()}`).toBe(true);
  return (await response.json()) as { id: string; version: number };
}
