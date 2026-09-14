import { expect, test, type Page } from "@playwright/test";

/**
 * 검토 수명주기 E2E — 04 §4.2·§4.4.
 *
 * golden path는 "배정 → 서명"이라는 한 방향만 지난다. 실제 검토에는 그 사이가
 * 있다 — 근거가 부족해 보완을 요청하고, 서명 뒤에 문제를 발견해 이의를 제기한다.
 *
 * 이 스펙이 확인하는 것:
 *
 * - 이유 없이 상태를 바꿀 수 없다.
 * - 지나온 경로가 화면에 남는다. 되돌아가도 지워지지 않는다.
 * - 이의를 제기해도 서명은 지워지지 않는다.
 */

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("검토 수명주기", () => {
  test.setTimeout(120_000);

  test("보완 요청과 이의 제기가 기록으로 남는다", async ({ page }) => {
    const projectKey = `LIFE-${Date.now()}`;

    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("For the review lifecycle check");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    // --- claim과 배정 (data_steward) ----------------------------------------
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(page.getByText("mining_right_registration")).toBeVisible();

    await page.goto(`/w/projects/${projectId}/verification`);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Assign the review" }).click();
    await expect(page.getByTestId("selected-case")).toContainText("assigned");

    // --- 이유 없이는 상태를 바꿀 수 없다 --------------------------------------
    await expect(page.getByTestId("transition-in_review")).toBeDisabled();

    await page.getByLabel("Reason (required)").fill("Starting the review");
    await expect(page.getByTestId("transition-in_review")).toBeEnabled();
    await page.getByTestId("transition-in_review").click();
    await expect(page.getByTestId("selected-case")).toContainText("in_review");

    // --- 보완 요청 -----------------------------------------------------------
    await page.getByLabel("Reason (required)").fill("The registry lookup has no as-of date");
    await page.getByTestId("transition-changes_requested").click();
    await expect(page.getByTestId("selected-case")).toContainText("changes_requested");

    // 지나온 경로가 남는다. 현재 상태만으로는 반려 후 재배정된 case와
    // 처음부터 진행된 case가 같아 보인다.
    const history = page.getByTestId("transition-history");
    await expect(history).toBeVisible();
    await expect(history).toContainText("assigned → in_review");
    await expect(history).toContainText("The registry lookup has no as-of date");

    // --- 보완 후 다시 검토로 (data_steward) ----------------------------------
    // 상태를 되돌리는 것은 근거를 다루는 사람의 일이다. 검토자에게는
    // claim.curate 권한이 없다(02 §2.3).
    await page.getByLabel("Reason (required)").fill("The as-of date has been supplied");
    await page.getByTestId("transition-in_review").click();
    await expect(page.getByTestId("selected-case")).toContainText("in_review");

    // --- 검토자가 서명한다 (reviewer_cp_qp) -----------------------------------
    await connectAs(page, "Reviewer A");
    await page.goto(`/w/projects/${projectId}/verification`);
    await page.getByRole("button", { name: "Open this case" }).first().click();

    // 검토자는 상태를 바꿀 수 없다. 서명이 그의 행위다.
    await page.getByLabel("Reason (required)").fill("Attempting it without the role");
    await page.getByTestId("transition-cancelled").click();
    await expect(page.getByTestId("error-notice")).toContainText("AUTHORIZATION_DENIED");

    await page.getByRole("button", { name: "Create the draft" }).click();
    await page.getByRole("button", { name: "Create a signature request" }).click();
    await page.getByTestId("sign-attestation").click();
    await expect(page.getByTestId("signed-result")).toContainText("signed");

    // --- 이의 제기 -----------------------------------------------------------
    await page.getByTestId("dispute-attestation").click();
    await expect(page.getByTestId("signed-result")).toContainText("disputed");

    // 서명자 주소는 그대로 남는다. 서명을 지우면 "누가 무엇을 언제 판단했는가"를
    // 잃고, 그것은 잘못된 검토를 감추는 것과 구분되지 않는다.
    await expect(page.getByTestId("signed-result")).toContainText("0x");

    // --- 이의 해소 -----------------------------------------------------------
    const disputes = page.getByTestId("dispute-table");
    await expect(disputes).toBeVisible();
    await expect(disputes).toContainText("unresolved");

    // 근거 없이 해소할 수 없다.
    const resolveButton = page.locator('[data-testid^="resolve-dismissed-"]').first();
    await expect(resolveButton).toBeDisabled();

    await page.getByLabel("Basis for resolution (required)").fill("The as-of date was checked and is sound");
    await resolveButton.click();

    // 기각하면 검토가 다시 유효해지고, 이의 기록은 남는다.
    await expect(page.getByTestId("signed-result")).toContainText("active");
    await expect(disputes).toContainText("dismissed");
    await expect(disputes).toContainText("The as-of date was checked and is sound");
  });

  test("감사 화면이 행위를 보여주고 상세는 감춘다", async ({ page }) => {
    // 감사 조회에는 audit.read가 필요하다. steward에게는 없다.
    await connectAs(page, "Steward A");
    await page.goto("/w/audit");
    await expect(page.getByTestId("error-notice")).toContainText("AUTHORIZATION_DENIED");

    await connectAs(page, "Operator A");
    await page.goto("/w/audit");

    await expect(page.getByTestId("audit-table")).toBeVisible();
    // 이벤트 발행이 지연되고 있는지도 같은 화면에서 본다.
    await expect(page.getByTestId("outbox-backlog")).toBeVisible();
    await expect(page.getByText("What this screen does not show")).toBeVisible();
  });
});
