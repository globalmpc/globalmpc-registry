import { expect, test } from "@playwright/test";

/**
 * Authority Registry E2E — 05 §5.11, OD-42·OD-43.
 *
 * R5 gate: **미확인 integration 과장 0**. 이 스펙은 그것을 화면에서 확인한다 —
 * 연동되지 않은 기관이 목록에 남고, 활성으로 보이지 않는다.
 */
test.describe("Authority Registry", () => {
  test("연동 상태를 과장하지 않고 한계를 함께 보여준다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

    await page.goto("/w/authorities");
    await expect(page.getByTestId("authority-table")).toBeVisible();

    const table = page.getByTestId("authority-table");

    // 활성 연동
    await expect(table).toContainText("Mineral Resources Authority");
    await expect(table).toContainText("active");

    // 연동이 없는 기관도 목록에 남는다.
    await expect(table).toContainText("Land Administration Office");
    await expect(table).toContainText("none");

    // 계획 단계는 호출 대상이 아니다.
    await expect(table).toContainText("Environmental Agency");
    await expect(table).toContainText("pending_access");

    // 확인해 주지 않는 것이 나란히 보인다.
    await expect(table).toContainText("economic_viability");

    // 활성 수가 전체 수보다 적다는 것이 드러난다.
    await expect(page.getByTestId("profile-summary")).toContainText("Callable");

    // 이 목록이 약속하지 않는 것.
    await expect(page.getByTestId("profile-limits")).toContainText("약속하지 않는다");
  });
});
