import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import postgres from "postgres";
import { connectAs } from "./connect-as";

// Exercise the real upload-status API from the Data Room; a fresh heartbeat alone
// must not hide a daemon outage. The existing runner owns and isolates this database.
test("Data Room distinguishes scanner downtime from a missing worker and clears it on recovery", async ({ page }) => {
  const databaseUrl = process.env["E2E_DATABASE_URL"];
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL must identify the runner's seeded database");
  const sql = postgres(databaseUrl, { onnotice: () => {}, prepare: false });
  const [previous] = await sql<{ last_seen_at: string; detail: postgres.JSONValue }[]>`
    SELECT last_seen_at::text AS last_seen_at,detail FROM core.worker_heartbeats WHERE worker_kind='scan'
  `;
  try {
    await connectAs(page, "Operator A");
    const projectKey = `SCAN-${randomUUID().slice(0, 8)}`;
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Scanner availability fixture");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("combobox", { name: "Owning organization" }).selectOption(
      "aaaaaaaa-0000-0000-0000-000000000001",
    );
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop();
    expect(projectId).toBeTruthy();

    await sql`INSERT INTO core.worker_heartbeats(worker_kind,last_seen_at,detail)
      VALUES('scan',clock_timestamp(),'{"handled":false,"scannerAvailable":false}'::jsonb)
      ON CONFLICT(worker_kind) DO UPDATE SET last_seen_at=excluded.last_seen_at,detail=excluded.detail`;
    await page.goto(`/w/projects/${projectId}/data-room`);
    const notice = page.getByTestId("scanner-status");
    await expect(notice).toContainText("The malware scanner is unavailable");
    await expect(notice).toContainText("The scan worker is running");
    await expect(notice).toContainText("uploads remain in quarantine");
    await expect(notice).toContainText("cannot be promoted to evidence");

    await sql`UPDATE core.worker_heartbeats SET last_seen_at=clock_timestamp(),
      detail='{"handled":false,"scannerAvailable":true}'::jsonb WHERE worker_kind='scan'`;
    const [recovered] = await Promise.all([
      page.waitForResponse(response => response.request().method() === "GET"
        && new URL(response.url()).pathname === `/api/v1/projects/${projectId}/uploads`),
      page.reload(),
    ]);
    expect(recovered.ok()).toBe(true);
    expect((await recovered.json()).scanner.state).toBe("running");
    await expect(page.getByRole("heading", { name: "Data Room", exact: true })).toBeVisible();
    await expect(page.getByLabel("Source connection")).toBeVisible();
    await expect(notice).toHaveCount(0);
  } finally {
    if (previous) {
      await sql`INSERT INTO core.worker_heartbeats(worker_kind,last_seen_at,detail)
        VALUES('scan',${previous.last_seen_at}::text::timestamptz,${previous.detail === null ? null : sql.json(previous.detail)})
        ON CONFLICT(worker_kind) DO UPDATE SET last_seen_at=excluded.last_seen_at,detail=excluded.detail`;
    } else {
      await sql`DELETE FROM core.worker_heartbeats WHERE worker_kind='scan'`;
    }
    await sql.end();
  }
});
