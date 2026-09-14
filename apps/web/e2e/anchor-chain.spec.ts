import { expect, test, type Page } from "@playwright/test";

/**
 * 체인 확정 E2E.
 *
 * golden path는 batch를 만드는 데서 끝난다 — 그 시점의 `included`는 false다.
 * 이 스펙은 그 뒤를 본다: worker가 실제로 제출하고, 확정 깊이를 채우면 공개
 * 증명의 `included`가 참이 되는가.
 *
 * **anvil과 anchor worker가 떠 있을 때만 돈다.** 없으면 skip한다 — 있는 척하는
 * 초록 테스트보다 없는 것이 낫다. `E2E_CHAIN=1`로 켠다.
 */

const CHAIN_ENABLED = process.env["E2E_CHAIN"] === "1";

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("체인 확정", () => {
  test.skip(!CHAIN_ENABLED, "anvil과 anchor worker가 필요하다 (E2E_CHAIN=1)");
  test.setTimeout(180_000);

  test("게시한 기록이 체인 확정 뒤 included=true가 된다", async ({ page }) => {
    const projectKey = `CHAIN-${Date.now()}`;

    await connectAs(page, "Operator A");

    // dev 서버는 route를 **처음 접근할 때** 컴파일한다. 등록 직후의 이동이 그 첫
    // 접근이면 아래 15초 assertion이 앱이 아니라 컴파일 시간을 재게 되고, 느린
    // 것과 깨진 것을 구분할 수 없다 — 이 스펙만 따로 돌리면(`playwright test
    // anchor-chain`) 앞선 스펙이 route를 데워 주지 않아 매번 그 상태가 된다.
    // 없는 id로 한 번 지나가 컴파일만 끝낸다. 재시도로 덮지 않는 이유는
    // `playwright.config.ts`의 expect 타임아웃 주석과 같다.
    await page.goto("/w/projects/00000000-0000-4000-8000-000000000000");

    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("For the chain confirmation check");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();

    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await page.goto(`/w/projects/${projectId}/publication`);
    await page.getByTestId("irreversibility-ack").check();
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("published-result")).toContainText(projectKey);

    await page.getByTestId("anchor").click();
    // 만든 직후에는 체인에 올라가지 않았다.
    await expect(page.getByTestId("anchor-result")).toContainText("created");

    // 이 테스트가 만든 batch만 본다. 이전 실행이 남긴 batch의 confirmed를
    // 자기 것으로 착각하면 아무것도 검증하지 않는 테스트가 된다.
    const batchId = (await page.getByTestId("anchor-result").innerText()).match(
      /0x[0-9a-f]{64}/,
    )?.[0] as string;
    expect(batchId).toBeTruthy();

    // --- 운영 화면에서 확정을 기다린다 ---------------------------------------
    await page.goto("/w/anchors");
    await expect(page.getByTestId("anchor-table")).toBeVisible();

    // worker가 제출 → 포함 → 확정까지 진행한다. 화면은 5초마다 다시 읽는다.
    await expect(page.getByTestId(`anchor-state-${batchId.slice(2, 10)}`)).toHaveText(
      "confirmed",
      { timeout: 120_000 },
    );

    // --- 로그인 없이 증명을 확인한다 -----------------------------------------
    await page.getByRole("button", { name: "Disconnect" }).click();
    await page.goto(`/explorer?registryType=project&publicKey=${projectKey}`);
    await page.getByRole("button", { name: "Search" }).click();

    await expect(page.getByTestId("proof-panel")).toBeVisible();
    await expect(page.getByText("Path matches")).toBeVisible();
    // 확정된 뒤에야 included가 참이다(AC-23).
    await expect(page.getByTestId("proof-included")).toContainText("Confirmed");

    // 확정돼도 증명이 무엇을 확인하지 않는지는 그대로 남는다.
    await expect(page.getByTestId("proof-disclaimer")).toBeVisible();
    await expect(
      page.getByText("Integrity and authority are different questions"),
    ).toBeVisible();
  });
});
