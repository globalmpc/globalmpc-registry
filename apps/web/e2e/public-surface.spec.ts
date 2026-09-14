import { expect, test } from "@playwright/test";

/**
 * 공개 표면 E2E — spec 11 §11.2·§11.3.
 *
 * 공개 화면이 **로그인 없이** 무엇을 말하는지 본다. 화면이 렌더되는 것만
 * 확인하면 목업과 구분되지 않으므로, 서버가 판정한 경계가 화면에 도달하는지를
 * 본다 — 게시된 것만 나오는가, 무엇을 확인해 주지 않는지 적혀 있는가.
 */

test.describe("공개 진입점", () => {
  test("비로그인 `/`가 계정 연결 화면이 아니다", async ({ page }) => {
    await page.goto("/");

    // 예전에는 여기가 로그인 화면이었다. 그 회귀를 막는다.
    await expect(page.getByRole("heading", { name: "Connect account" })).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: /Mining Compliance Evidence/ }),
    ).toBeVisible();
  });

  test("제품이 무엇을 확인해 주지 않는지 로그인 전에 적혀 있다", async ({ page }) => {
    await page.goto("/");

    const boundaries = page.getByTestId("landing-boundaries");
    await expect(boundaries).toContainText("Verification is not a guarantee.");
    await expect(boundaries).toContainText("Readiness is not a decision.");
    await expect(boundaries).toContainText("API success is not verification.");
  });

  test("무결성 증명과 사실성을 나란히 갈라 놓는다", async ({ page }) => {
    await page.goto("/");

    const separations = page.getByTestId("landing-separations");
    await expect(separations).toContainText("Integrity proof");
    await expect(separations).toContainText("Factual truth");
    await expect(separations).toContainText("Data readiness");
    await expect(separations).toContainText("Human decision");
  });

  test("계정 연결은 링크로 남아 있다", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("main").getByRole("link", { name: /Connect account/ }).click();

    await expect(page).toHaveURL(/\/connect$/);
    await expect(page.getByRole("heading", { name: "Connect account" })).toBeVisible();
  });

  test("헤더에서도 계정 연결로 간다", async ({ page }) => {
    await page.goto("/explorer");
    await page.getByRole("banner").getByRole("link", { name: /Connect account/ }).click();

    await expect(page).toHaveURL(/\/connect$/);
  });
});

test.describe("공개 navigation (11 §11.2)", () => {
  test("여섯 항목이 로그인 없이 보인다 — Projects는 Explorer에 합쳤다", async ({ page }) => {
    await page.goto("/");
    const nav = page.getByRole("banner").getByRole("navigation");
    await expect(nav.getByRole("link", { name: "Projects", exact: true })).toHaveCount(0);

    for (const label of [
      "Explorer",
      "Verification Records",
      "Asset Registry",
      "Proof Verifier",
      "Governance",
      "Disclosures & Incidents",
    ]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });
});

test.describe("공개 통합 검색", () => {
  test("모르는 hash는 권한 문제가 아니라 빈 결과로 말한다", async ({ page }) => {
    await page.goto("/explorer");
    await page.getByLabel("Find a record").fill(`0x${"ab".repeat(32)}`);
    await page.getByTestId("global-search-submit").click();

    await expect(page).toHaveURL(/\/explorer\/search\?q=0x/);
    await expect(page.getByTestId("search-empty")).toContainText(/not a permission problem/);
  });

  test("지갑 주소로는 찾을 수 없다고 이유와 함께 말한다", async ({ page }) => {
    await page.goto(`/explorer/search?q=0x${"12".repeat(20)}`);
    await expect(page.getByTestId("search-address-notice")).toBeVisible();
  });
});

test.describe("Explorer 목록", () => {
  test("publicKey를 모르고도 게시된 기록이 나온다", async ({ page }) => {
    await page.goto("/explorer");

    const list = page.getByTestId("public-registry-list");
    await expect(list).toBeVisible();
    // seed가 게시한 기록이 있으면 표가, 없으면 빈 상태 안내가 나온다. 어느
    // 쪽이든 "검색어를 먼저 넣어라"는 상태가 아니어야 한다.
    await expect(list.locator("table, [data-testid=public-registry-empty]")).not.toHaveCount(0);
  });

  test("빈 결과를 권한 문제와 구분해 말한다", async ({ page }) => {
    await page.goto("/explorer");
    await page.getByLabel("Search").fill("ZZZ-NOTHING-MATCHES-THIS-ZZZ");
    await page.getByTestId("public-search-submit").click();

    await expect(page.getByTestId("public-registry-empty")).toContainText(
      /Nothing published matches/,
    );
  });
});

test.describe("Proof Verifier", () => {
  test("독립 화면으로 존재하고 브라우저가 다시 계산한다고 밝힌다", async ({ page }) => {
    await page.goto("/verify");

    await expect(page.getByRole("heading", { name: "Proof Verifier" })).toBeVisible();
    await expect(page.getByText(/recomputed in your browser/)).toBeVisible();
  });

  test("anchor 전인 것을 증명 실패와 구분한다", async ({ page }) => {
    await page.goto("/verify");
    await page.getByRole("button", { name: "By version id" }).click();
    // 존재하지 않는 version id다. 서버가 404를 주고 화면은 그것을 "아직 없음"
    // 으로 말해야 한다 — 빨간 실패로 그리면 "증명이 깨졌다"로 읽힌다.
    await page
      .getByLabel("Entry version id")
      .fill("00000000-0000-4000-8000-000000000000");
    await page.getByRole("button", { name: "Check proof" }).click();

    await expect(page.getByTestId("verify-not-anchored")).toBeVisible();
  });
});

test.describe("Asset Registry", () => {
  test("비활성 사유와 남은 gate를 말한다", async ({ page }) => {
    await page.goto("/asset-registry");

    await expect(page.getByTestId("asset-registry-status")).toContainText(
      /Inactive by decision, not by omission/,
    );
    // 거래 경로를 만들지 않는다(OD-07). 그 방향의 CTA가 없어야 한다.
    await expect(page.getByRole("button", { name: /Subscribe|Buy|Order|Transfer/ })).toHaveCount(0);
    // 근거 열에 결정 번호가 붙어 있어야 한다. 근거 없는 gate 목록은 로드맵이다.
    await expect(page.getByRole("cell", { name: /^OD-17 ·/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /^OD-18 ·/ })).toBeVisible();
  });
});

test.describe("Disclosures & Incidents", () => {
  test("덮지 않는 사건 종류를 화면이 밝힌다", async ({ page }) => {
    await page.goto("/disclosures");

    // 빈 목록을 "그런 일이 없었다"로 읽지 않게 한다.
    //
    // 2026-09-09 결정 뒤로 남는 것은 credential 철회 하나다 — 그 "기록"이
    // **사람**이라 "일어났다 + 언제 + 어느 기록" 규칙으로 표현되지 않는다.
    const scope = page.getByTestId("disclosure-not-covered");
    await expect(scope).toContainText("credential_revocation");

    // 셋은 이제 덮는다. 여기 남아 있으면 화면이 옛 범위를 계속 말하는 것이다.
    for (const covered of ["suspension", "pause", "dispute"]) {
      await expect(scope).not.toContainText(covered);
    }
  });
});

test.describe("Governance", () => {
  test("로그인 없이 열리고 투표자 명단을 담지 않는다", async ({ page }) => {
    await page.goto("/governance");

    await expect(page.getByRole("heading", { name: "Governance", exact: true })).toBeVisible();
    await expect(page.getByTestId("public-governance-list")).toBeVisible();
    // 집계는 판정 근거이지만 명단은 아니다(AC-32).
    await expect(page.getByText(/Voter A|voter_subject/)).toHaveCount(0);
  });
});
