import { expect, test, type Page } from "@playwright/test";

/**
 * Governance E2E — 04 §4.5, OD-06.
 *
 * 이 스펙이 확인하는 것은 투표가 되는가가 아니라 **투표가 무엇을 만들지
 * 않는가를 화면이 말하는가**다. 통과한 제안을 "승인됐다"로 읽게 만드는 것이
 * 이 화면의 가장 큰 위험이다.
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

test.describe("Governance", () => {
  test.setTimeout(120_000);

  test("제안에서 마감까지 이어지고 한계가 계속 보인다", async ({ page }) => {
    const title = `제안 ${Date.now()}`;

    await connectAs(page, "Proposer A");
    await page.goto("/w/governance");

    // 경계 문구가 목록 위에 항상 있다.
    await expect(page.getByTestId("governance-boundary")).toContainText("no legal fact");

    // 이유 없이는 제안할 수 없다.
    await page.getByLabel("Title").fill(title);
    await expect(page.getByTestId("create-proposal")).toBeDisabled();

    await page.getByLabel("Rationale (required)").fill("The current schema cannot carry limitations");

    /**
     * 정족수의 분모 — 09 §9.6.
     *
     * 토큰이 배포되기 전에는 사람이 넣는다. 이 값 없이는 투표를 열 수 없다 —
     * 던진 표의 합을 분모로 쓰면 `참여 × D >= 참여 × N`이 항상 참이라
     * `no_quorum`이 구조적으로 나오지 않는다.
     */
    await expect(page.getByTestId("create-proposal")).toBeDisabled();
    await page.getByLabel("Eligible weight (required)").fill("100");

    await page.getByTestId("create-proposal").click();

    const table = page.getByTestId("proposal-table");
    await expect(table).toContainText(title);

    const stateCell = page.locator('[data-testid^="proposal-state-"]').first();
    const proposalId = (await stateCell.getAttribute("data-testid"))!.replace(
      "proposal-state-",
      "",
    );
    await expect(stateCell).toHaveText("draft");

    // 상태 변경에도 이유가 필요하다.
    await expect(page.getByTestId(`advance-review-${proposalId}`)).toBeDisabled();
    await page.getByLabel("Reason for the state change (required)").fill("Starting the review");

    for (const next of ["review", "announced", "voting"]) {
      await page.getByTestId(`advance-${next}-${proposalId}`).click();
      await expect(stateCell).toHaveText(next);
    }

    /**
     * 무게가 어디서 왔는지를 집계 옆에서 밝힌다 — 04 §4.5.
     *
     * 토큰이 배포되기 전에는 사람이 넣은 값으로 집계된다. 화면이 그 사실을
     * 말하지 않으면 수동 집계 결과를 온체인 근거로 읽는다.
     */
    await expect(page.getByTestId(`weight-source-${proposalId}`)).toContainText("Entered manually");

    // 정족수의 분모도 같이 밝힌다. 비율만으로는 무엇의 비율인지 알 수 없다.
    await expect(page.getByTestId(`quorum-${proposalId}`)).toContainText("of 100");
    await expect(page.getByTestId(`quorum-${proposalId}`)).toContainText("entered manually");

    // --- 투표 (protocol_voter) ------------------------------------------------
    await connectAs(page, "Voter A");
    await page.goto("/w/governance");
    await page.getByLabel("Vote weight").fill("100");
    await page.getByTestId(`vote-for-${proposalId}`).click();
    await expect(page.getByTestId("proposal-table")).toContainText("For 100");

    // --- 마감 (proposer) ------------------------------------------------------
    await connectAs(page, "Proposer A");
    await page.goto("/w/governance");
    await page.getByLabel("Reason for the state change (required)").fill("The for votes prevail");

    // 집계가 말하는 결과 하나만 제시된다. 셋을 다 보여주면 표를 무시하고
    // 고르는 것처럼 읽힌다.
    await expect(page.getByTestId(`advance-defeated-${proposalId}`)).toHaveCount(0);
    await page.getByTestId(`advance-succeeded-${proposalId}`).click();

    await expect(page.locator(`[data-testid="proposal-state-${proposalId}"]`)).toHaveText(
      "succeeded",
    );

    // 통과해도 한계 문구는 그대로다. 통과가 승인이 아니다.
    await expect(page.getByTestId("governance-boundary")).toContainText(
      "does not happen automatically",
    );
  });

  test("투표자는 제안할 수 없고 제안자는 투표할 수 없다", async ({ page }) => {
    await connectAs(page, "Voter A");
    await page.goto("/w/governance");
    // 제안 폼 자체가 보이지 않는다.
    await expect(page.getByTestId("create-proposal")).toHaveCount(0);

    await connectAs(page, "Proposer A");
    await page.goto("/w/governance");
    await expect(page.getByLabel("Vote weight")).toHaveCount(0);
  });
});
