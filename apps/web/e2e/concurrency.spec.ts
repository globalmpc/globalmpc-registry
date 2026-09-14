import { expect, test } from "@playwright/test";

/**
 * 동시 수정 E2E — 07 §7.1.
 *
 * 두 사람이 같은 claim을 열어 두고 각자 충돌을 기록하는 상황이다. 낙관적 동시성
 * 제어가 없으면 나중 요청이 앞의 판단을 흔적 없이 덮는다.
 *
 * 이 스펙이 보는 것은 "오류가 난다"가 아니라 **화면이 무엇이 일어났는지 말하는가**다.
 * "실패했습니다"로 뭉개면 사용자는 다시 읽어야 한다는 것을 모른다.
 */

test.describe("동시 수정", () => {
  test("먼저 바뀐 것을 모르는 요청이 거절되고 현재 버전을 알려준다", async ({ browser }) => {
    const projectKey = `RACE-${Date.now()}`;

    // --- 준비: 프로젝트와 claim ---------------------------------------------
    const operator = await browser.newContext();
    const operatorPage = await operator.newPage();
    await operatorPage.goto("/connect");
    await operatorPage.getByRole("button", { name: /Operator A/ }).click();
    // SIWE 서명·검증이 끝나야 토큰이 생긴다. 기다리지 않으면 다음 화면이 세션
    // 없이 렌더된다.
    await expect(operatorPage.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await operatorPage.goto("/w/projects/new");
    await operatorPage.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await operatorPage.getByRole("textbox", { name: "Name" }).fill("For the concurrent edit check");
    await operatorPage.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await operatorPage.getByRole("button", { name: "Register" }).click();
    await expect(operatorPage.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(operatorPage.url()).pathname.split("/").pop() as string;
    await operator.close();

    // --- 같은 사람이 두 창에서 같은 화면을 연다 -------------------------------
    // 브라우저 컨텍스트를 나누면 세션도 따로 만들어야 한다. 여기서 보려는 것은
    // 권한이 아니라 버전 충돌이므로 같은 역할로 두 창을 연다.
    const first = await browser.newContext();
    const firstPage = await first.newPage();
    await firstPage.goto("/connect");
    await firstPage.getByRole("button", { name: /Steward A/ }).click();
    await expect(firstPage.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await firstPage.goto(`/w/projects/${projectId}/data-room`);
    await firstPage.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(firstPage.getByText("mining_right_registration")).toBeVisible();

    const second = await browser.newContext();
    const secondPage = await second.newPage();
    await secondPage.goto("/connect");
    await secondPage.getByRole("button", { name: /Steward A/ }).click();
    await expect(secondPage.getByRole("button", { name: "Disconnect" })).toBeVisible();
    await secondPage.goto(`/w/projects/${projectId}/data-room`);
    // 두 창이 같은 v1을 보고 있다.
    await expect(secondPage.getByText("v1")).toBeVisible();

    // --- 첫 창이 먼저 기록한다 ------------------------------------------------
    await firstPage.getByRole("button", { name: "Record a conflict" }).click();
    await expect(firstPage.getByText("v2")).toBeVisible();

    // --- 둘째 창은 아직 v1을 들고 있다 ----------------------------------------
    await secondPage.getByRole("button", { name: "Record a conflict" }).click();

    const notice = secondPage.getByTestId("error-notice");
    await expect(notice).toBeVisible();
    // 실패가 아니라 "그 사이 바뀌었다"는 사실이다. 화면이 그것을 말한다.
    await expect(notice).toContainText("412");
    await expect(notice).toContainText("RESOURCE_VERSION_MISMATCH");
    await expect(notice).toContainText("You were looking at");
    await expect(notice).toContainText("v2");
    // 재시도로 풀리지 않는다는 것도 밝힌다.
    await expect(notice).toContainText("Retrying will produce the same result.");

    // --- 다시 읽으면 이어서 기록할 수 있다 ------------------------------------
    await secondPage.reload();
    await expect(secondPage.getByText("v2")).toBeVisible();
    await secondPage.getByRole("button", { name: "Record a conflict" }).click();
    await expect(secondPage.getByText("v3")).toBeVisible();
    await expect(secondPage.getByTestId("error-notice")).toHaveCount(0);

    await first.close();
    await second.close();
  });
});
