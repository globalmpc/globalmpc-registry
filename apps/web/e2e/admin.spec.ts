import { expect, test, type Page } from "@playwright/test";

/**
 * Administration E2E.
 *
 * 이 화면이 있기 전에는 배포된 시스템에 사람을 추가하는 유일한 방법이 서버에서
 * CLI를 돌리는 것이었다. 여기서 보는 것은 "화면이 뜬다"가 아니라 **브라우저에서
 * 시작한 변경이 DB까지 가서 다시 화면으로 돌아오는가**다.
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

test.describe("Administration", () => {
  test("CLI 없이 사람을 추가하고 목록에서 본다", async ({ page }) => {
    const name = `Added in browser ${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByRole("button", { name: "Add person" }).click();

    await expect(page.getByTestId("admin-subjects")).toContainText(name);
    // 지갑도 역할도 없는 상태로 만들어진다. 둘은 별개의 의도적인 단계다.
    await expect(page.getByTestId("admin-locked")).toContainText(name);
  });

  test("제안한 사람에게는 결정 버튼이 없다", async ({ page }) => {
    const name = `Grant target ${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    await page.getByRole("textbox", { name: "Name" }).fill(name);
    await page.getByRole("button", { name: "Add person" }).click();
    await expect(page.getByTestId("admin-subjects")).toContainText(name);

    const row = page.getByTestId("admin-subjects").locator("tr", { hasText: name });
    await row.getByRole("button", { name: "Propose role" }).click();
    await page.getByRole("textbox", { name: "Role" }).fill("data_steward");
    await page.getByRole("textbox", { name: "Why" }).fill("증빙 등록을 맡는다");
    await page.getByRole("button", { name: "Propose", exact: true }).click();

    // 02 §2.8 — 제안과 승인은 다른 사람이 한다. 서버가 막지만, 누를 수 있는
    // 버튼이 항상 거절되면 화면이 고장난 것처럼 보인다.
    const grants = page.getByTestId("admin-role-grants");
    await expect(grants).toContainText(name);
    await expect(grants.locator("tr", { hasText: name })).toContainText(
      "You proposed this — someone else decides.",
    );
    await expect(
      grants.locator("tr", { hasText: name }).getByRole("button", { name: "Approve" }),
    ).toHaveCount(0);
  });

  test("admin 권한이 없으면 이유와 함께 막힌다", async ({ page }) => {
    await connectAs(page, "Steward A");
    await page.goto("/w/admin");

    await expect(page.getByTestId("error-notice")).toContainText("AUTHORIZATION_DENIED");
  });
});
