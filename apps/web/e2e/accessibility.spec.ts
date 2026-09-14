import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

/**
 * 접근성 자동 검사 — spec 11 §11.8, OD-31(WCAG 2.2 AA).
 *
 * 자동 검사가 잡는 것은 전체의 일부다. 대비·레이블·랜드마크·역할처럼 기계가
 * 판정할 수 있는 것만 본다 — "이 문구가 이해되는가"는 잡지 못한다. 그래서
 * `workspace.spec.ts`의 수동 검사(색 외의 표식, 키보드 조작)를 대체하지 않고
 * 함께 돌린다.
 *
 * **위반을 0으로 강제한다.** 경고로 두면 쌓이고, 쌓이면 아무도 보지 않는다.
 * 고칠 수 없는 항목이 생기면 이유와 함께 여기 명시적으로 적는다.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

/**
 * 검사 전에 페이지를 가라앉힌다.
 *
 * axe는 페이지 안에서 돈다. 하이드레이션이나 그때 시작된 요청이 아직 진행 중이면
 * 검사 도중 실행 컨텍스트가 사라지고 **접근성과 무관한 이유로** 테스트가 깨진다.
 * `goto`는 문서 로드까지만 기다리므로 클라이언트가 멈출 때까지 한 번 더 기다린다.
 */
async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
}

async function analyze(page: Page) {
  await settle(page);
  return new AxeBuilder({ page })
    .withTags(WCAG_TAGS)
    // Next.js 개발 오버레이는 우리 코드가 아니다. prod 번들에는 없다.
    .exclude("nextjs-portal")
    .analyze();
}

/** 위반을 사람이 읽을 수 있게 정리한다. id만 보면 무엇을 고쳐야 할지 모른다. */
function describe(violations: Awaited<ReturnType<typeof analyze>>["violations"]): string {
  return violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help}\n` +
        violation.nodes.map((node) => `    ${node.target.join(" ")}`).join("\n"),
    )
    .join("\n");
}

async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("접근성 (WCAG 2.2 AA)", () => {
  test("로그인 화면", async ({ page }) => {
    await page.goto("/connect");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  /**
   * 공개 표면 전부를 훑는다 — spec 11 §11.2의 7개.
   *
   * 로그인하지 않은 사람이 보는 화면이다. 여기가 막히면 공개의 의미가 없다.
   * 한 화면씩 적는 대신 목록으로 도는 이유는 §11.2에 화면이 추가될 때 검사가
   * 같이 늘어나야 하기 때문이다 — 손으로 적으면 새 화면만 조용히 빠진다.
   */
  for (const path of [
    "/",
    "/legal",
    "/explorer",
    "/explorer/projects",
    "/explorer/verifications",
    "/asset-registry",
    "/verify",
    "/governance",
    "/disclosures",
  ]) {
    test(`공개 표면 — ${path}`, async ({ page }) => {
      await page.goto(path);
      const result = await analyze(page);
      expect(describe(result.violations)).toBe("");
    });
  }

  test("프로젝트 목록", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/projects");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("프로젝트 등록 폼", async ({ page }) => {
    // 입력 폼은 레이블·오류 연결이 걸리기 쉬운 자리다.
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("Data Room — 표와 상태 배지", async ({ page }) => {
    // 표가 비어 있으면 검사할 것이 없다. 실제 행이 있는 상태를 만든다.
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(`A11Y-${Date.now()}`);
    await page.getByRole("textbox", { name: "Name" }).fill("For the accessibility check");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();
    // 이동을 기다리지 않으면 URL이 아직 `/new`다.
    await expect(page).toHaveURL(/\/w\/projects\/[0-9a-f-]{36}$/);
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByRole("button", { name: "Look up the official source" }).click();
    await page.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(page.getByText("mining_right_registration")).toBeVisible();

    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("오류 표시", async ({ page }) => {
    // 오류는 role=alert로 읽혀야 하고 색만으로 구분되면 안 된다.
    await connectAs(page, "Reader A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill("A11Y-DENIED");
    await page.getByRole("textbox", { name: "Name" }).fill("Should be denied");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByTestId("error-notice")).toBeVisible();

    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("권한 거절이 가리키는 화면 — 로그인 없이", async ({ page }) => {
    // 막힌 사람이 도착하는 자리다. 세션이 없어도 읽을 수 있어야 한다.
    await page.goto("/w/identity/upgrade");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("Anchor 상태 화면", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/anchors");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  /** 새로 생긴 워크스페이스 집계 화면. */
  for (const path of ["/w/work", "/w/notifications", "/w/registries", "/w/integrations"]) {
    test(`워크스페이스 — ${path}`, async ({ page }) => {
      await connectAs(page, "Operator A");
      await page.goto(path);
      const result = await analyze(page);
      expect(describe(result.violations)).toBe("");
    });
  }

  test("Administration 화면", async ({ page }) => {
    // 사람·지갑·역할을 다루는 화면이다. 여기가 막히면 복구 경로가 막힌다.
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });

  test("감사 화면", async ({ page }) => {
    // 감사 기록이 남는 행위를 먼저 만든다. 빈 화면은 표를 렌더하지 않는다.
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(`A11Y-AUDIT-${Date.now()}`);
    await page.getByRole("textbox", { name: "Name" }).fill("For the audit check");
    await page.getByRole("button", { name: "Register" }).click();

    await page.goto("/w/audit");
    await expect(page.getByTestId("audit-table")).toBeVisible();
    const result = await analyze(page);
    expect(describe(result.violations)).toBe("");
  });
});
