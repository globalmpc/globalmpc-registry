import { expect, test } from "@playwright/test";

/**
 * 워크스페이스 E2E.
 *
 * 브라우저 → 웹 → API → PostgreSQL 전 구간을 관통한다. 화면이 렌더되는 것만
 * 확인하면 목업과 구분되지 않으므로, **서버가 판정한 결과가 화면에 도달하는지**를
 * 본다 — tenant 격리, 권한 거절 사유, 상태 표기.
 */

test.describe("계정 연결", () => {
  test("데모 계정과 경계 문구가 함께 표시된다", async ({ page }) => {
    await page.goto("/connect");

    await expect(page.getByRole("heading", { name: "Connect account" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Operator A/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Operator B/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Reader A/ })).toBeVisible();

    // R1: 실제 SIWE 서명으로 로그인한다는 것을 화면이 밝힌다.
    await expect(page.getByText(/they sign in through real SIWE/)).toBeVisible();

    // 검증≠보증 고지가 로그인 전부터 보인다(§11.6).
    await expect(page.getByText("Verification is not a guarantee.")).toBeVisible();
    await expect(page.getByText("Readiness is not a decision.")).toBeVisible();
  });
});

test.describe("tenant 격리", () => {
  test("Operator A는 자기 tenant의 프로젝트만 본다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();

    await expect(page).toHaveURL(/\/w\/projects$/);
    // seed가 tenant B에만 만들어 둔 프로젝트는 보이면 안 된다.
    await expect(page.getByText("TENANT-B-ONLY")).toHaveCount(0);
  });

  test("Operator B는 자기 프로젝트를 본다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator B/ }).click();
    await expect(page).toHaveURL(/\/w\/projects$/);

    await expect(page.getByRole("link", { name: "TENANT-B-ONLY" })).toBeVisible();
  });

  test("빈 목록과 권한 없음을 구분해 표시한다", async ({ page }) => {
    await page.goto("/connect");
    // tenant C에는 프로젝트가 없고 앞으로도 생기지 않는다. 다른 테스트가 만든
    // 데이터에 이 판정이 흔들리면 "빈 상태"를 검증한 것이 아니게 된다.
    await page.getByRole("button", { name: /Operator C/ }).click();

    // 권한은 있는데 데이터가 없는 것이다. "권한 문제가 아니다"를 명시한다(§11.7).
    await expect(page.getByText(/this is not a permission problem/)).toBeVisible();
  });
});

test.describe("프로젝트 등록", () => {
  test("등록하면 상세 화면으로 이동하고 실제 값이 표시된다", async ({ page }) => {
    const key = `E2E-${Date.now()}`;

    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await page.getByRole("button", { name: "New project" }).click();

    await page.getByRole("textbox", { name: "Project key" }).fill(key);
    await page.getByRole("textbox", { name: "Name" }).fill("Created by E2E");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper, gold");
    await page.getByRole("button", { name: "Register" }).click();

    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);
    await expect(page.getByRole("heading", { name: key })).toBeVisible();
    await expect(page.getByText("copper, gold")).toBeVisible();

    // lifecycle은 draft로 시작한다. 등록이 곧 승인이 아니다.
    await expect(page.getByText("draft")).toBeVisible();

    // 평가가 없는 것과 통과한 것을 구분한다.
    await expect(page.getByText("Not assessed")).toBeVisible();
    await expect(page.getByText(/No assessment has run yet. This is not a pass./)).toBeVisible();
  });

  test("등록한 프로젝트가 목록에 나타난다", async ({ page }) => {
    const key = `E2E-LIST-${Date.now()}`;

    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await page.getByRole("button", { name: "New project" }).click();
    await page.getByRole("textbox", { name: "Project key" }).fill(key);
    await page.getByRole("textbox", { name: "Name" }).fill("For the list check");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);

    await page.getByRole("link", { name: "← All projects" }).click();
    await expect(page.getByRole("link", { name: key })).toBeVisible();
  });
});

test.describe("권한 거절", () => {
  test("역할 없는 계정은 403과 필요한 역할을 화면에서 본다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Reader A/ }).click();
    // SIWE 서명 → 검증 → 토큰 발급이 끝나야 워크스페이스로 이동한다.
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.goto("/w/projects/new");

    await page.getByRole("textbox", { name: "Project key" }).fill("DENIED-E2E");
    await page.getByRole("textbox", { name: "Name" }).fill("Should be denied");
    await page.getByRole("button", { name: "Register" }).click();

    const alert = page.getByTestId("error-notice");
    await expect(alert).toBeVisible();
    // 서버 envelope가 그대로 화면에 도달하는지 확인한다.
    await expect(alert).toContainText("403");
    await expect(alert).toContainText("AUTHORIZATION_DENIED");
    await expect(alert).toContainText("ROLE_ACTION_NOT_ALLOWED");
    await expect(alert).toContainText("mpc_operator");
    // 다음 행동 경로를 제공한다(§11.7).
    await expect(alert.getByRole("link", { name: /Request access/ })).toBeVisible();
    // 재시도 여부를 알려준다.
    await expect(alert).toContainText("Retrying will produce the same result.");
  });

  test("거절된 등록은 목록에 나타나지 않는다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await expect(page.getByText("DENIED-E2E")).toHaveCount(0);
  });
});

test.describe("접근성", () => {
  test("상태 배지가 색 외의 표식을 갖는다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator B/ }).click();
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.getByRole("link", { name: "TENANT-B-ONLY" }).click();

    // lifecycle 배지에 글리프와 텍스트가 함께 있다(§11.8).
    const badge = page.locator(".badge").first();
    await expect(badge).toBeVisible();
    await expect(badge).toContainText(/draft/);
    await expect(badge.locator(".glyph")).toHaveCount(1);
  });

  test("키보드만으로 계정을 연결할 수 있다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/w\/projects$/);
  });
});

test.describe("세션", () => {
  test("연결 해제하면 워크스페이스에 접근할 수 없다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();
    await page.getByRole("button", { name: "Disconnect" }).click();

    await page.goto("/w/projects");
    await expect(page.getByText(/No account is connected/)).toBeVisible();
  });

  test("연결 상태가 상단에 역할과 함께 표시된다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator A/ }).click();

    const header = page.getByRole("banner");
    await expect(header).toContainText("mpc_operator");
    await expect(header).toContainText("high_assurance");
  });
});

test.describe("언어 (OD-30) — 영어 단일 언어", () => {
  test("경계 문구가 영문으로 로그인 전부터 보인다", async ({ page }) => {
    // 로그인 전 첫 화면은 공개 진입점이다. 경계 문구는 계정 연결이
    // 아니라 여기에서 이미 보여야 한다.
    await page.goto("/");

    // 문구는 언어 선택에 걸려 있지 않다. 지울 수 있는 경고는 경고가 아니다.
    await expect(page.getByText("Verification is not a guarantee.")).toBeVisible();
    await expect(page.getByText("Readiness is not a decision.")).toBeVisible();
  });

  test("문서 언어 속성이 en이다", async ({ page }) => {
    await page.goto("/");
    // 스크린 리더와 브라우저 번역기가 문서 언어를 알아야 한다.
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("언어 전환 장치가 없다", async ({ page }) => {
    await page.goto("/");
    // 서비스는 영어로만 돈다. 눌러도 아무것도 바뀌지 않는 토글을 두지 않는다.
    await expect(page.getByTestId("locale-toggle")).toHaveCount(0);
  });

  test("상태 배지가 영문 라벨을 쓴다", async ({ page }) => {
    await page.goto("/connect");
    await page.getByRole("button", { name: /Operator B/ }).click();
    await expect(page).toHaveURL(/\/w\/projects$/);
    await page.getByRole("link", { name: "TENANT-B-ONLY" }).click();

    await expect(page.locator(".badge").first()).toContainText(/draft/i);
  });
});
