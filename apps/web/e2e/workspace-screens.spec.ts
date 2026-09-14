import { expect, test, type Page } from "@playwright/test";

/**
 * 워크스페이스 집계 화면.
 *
 * 넷 다 데이터가 없어서가 아니라 **프로젝트 하나를 열어야만 보이는 구조** 때문에
 * 없던 화면이다. 여기서 보는 것은 그 구조가 실제로 풀렸는가다.
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

test.describe("워크스페이스 navigation", () => {
  test("스펙의 전역 항목이 전부 링크로 있다", async ({ page }) => {
    await connectAs(page, "Operator A");
    const nav = page.getByRole("banner").getByRole("navigation");

    for (const label of [
      "My Work",
      "Notifications",
      "Projects",
      "Registries",
      "Anchor",
      "Integrations",
      "Governance",
      "Audit",
      "Admin",
    ]) {
      await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    }
  });

  test("역할에 없는 메뉴는 보이지 않는다", async ({ page }) => {
    await connectAs(page, "Steward A");
    const nav = page.getByRole("banner").getByRole("navigation");

    await expect(nav.getByRole("link", { name: "Projects", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "My Activity", exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Audit", exact: true })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Admin", exact: true })).toHaveCount(0);
  });

  test("로그인해도 공개 메뉴에 갈 수 있다", async ({ page }) => {
    await connectAs(page, "Steward A");
    const nav = page.getByRole("banner").getByRole("navigation");

    await nav.getByText("Public registry").click();
    await nav.getByRole("link", { name: "Proof Verifier", exact: true }).click();
    await expect(page).toHaveURL(/\/verify$/);
  });
});

test.describe("지갑 주소는 전체로 보이고 복사된다", () => {
  test("상단 바와 관리 화면이 42자 주소를 그대로 보이고 복사 버튼이 동작한다", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await connectAs(page, "Operator A");

    const header = page.getByRole("banner");
    const headerAddress = header.getByTestId("wallet-address");
    await expect(headerAddress).toHaveText(/^0x[0-9a-f]{40}$/);

    await header.getByRole("button", { name: "Copy wallet address" }).click();
    await expect(header.getByRole("button", { name: "Copy wallet address" })).toHaveText("Copied");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await headerAddress.textContent());

    await page.goto("/w/admin");
    const cells = page.getByTestId("admin-subjects").getByTestId("wallet-address");
    await expect(cells.first()).toHaveText(/^0x[0-9a-f]{40}$/);
  });
});

test.describe("My Activity", () => {
  test("내가 한 일만 본인에게 보인다", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/activity");

    await expect(page.getByRole("heading", { name: "My Activity" })).toBeVisible();
    // seed가 Operator A로 게시·생성을 했으므로 표가 있어야 한다. 비었으면 안내가 나온다.
    await expect(
      page.getByTestId("my-activity").locator("table, [data-testid=my-activity-empty]"),
    ).not.toHaveCount(0);
  });
});

test.describe("My Work", () => {
  test("할 일과 기다리는 것을 다른 자리에 둔다", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/work");

    // 셋을 한 목록에 섞으면 다음 행동이 정반대인 것들이 같아 보인다.
    await expect(page.getByTestId("work-assigned")).toBeVisible();
    await expect(page.getByTestId("work-waiting")).toBeVisible();
    await expect(page.getByTestId("work-unassigned")).toBeVisible();
    await expect(page.getByTestId("work-unassigned")).toContainText(/nobody has picked/i);
  });
});

test.describe("Registries", () => {
  test("프로젝트를 열지 않고 게시 상태를 본다", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/registries");

    await expect(page.getByRole("heading", { name: "Registries" })).toBeVisible();
    // 게시와 anchor를 한 칸에 합치면 "게시됐으니 체인에 있다"로 읽힌다.
    await expect(page.getByText(/Publishing and anchoring are separate events/)).toBeVisible();
  });
});

test.describe("Integrations", () => {
  test("부를 수 있는 것과 없는 것을 사유와 함께 가른다", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/integrations");

    await expect(page.getByTestId("integrations-accepted")).toBeVisible();
    await expect(page.getByTestId("integrations-pending")).toBeVisible();
    // 연결 성공이 검증이 아니다.
    await expect(page.getByText(/it means the source answered, not that the answer is right/)).toBeVisible();
    // 실제 정부 출처가 아직 없다는 것을 화면이 말한다(OD-42).
    await expect(page.getByText(/No real government source is connected yet/)).toBeVisible();
  });
});

test.describe("Claim Detail", () => {
  test("claim 하나가 자기 주소를 갖는다", async ({ page }) => {
    // 등록은 mpc_operator, claim은 data_steward다 — 역할이 다르다(02 §2.3).
    // claim이 없는 실행에서 skip하면 이 테스트는 아무것도 지키지 않으므로
    // 필요한 것을 여기서 만든다.
    const projectKey = `CLAIM-${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Claim detail check");
    await page.getByRole("button", { name: "Register" }).click();
    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await page.getByRole("button", { name: "Add a mining right claim" }).click();

    const claimLink = page.getByRole("link", { name: "mining_right_registration" }).first();
    await expect(claimLink).toBeVisible();
    await claimLink.click();

    await expect(page).toHaveURL(/\/w\/projects\/[^/]+\/claims\/[^/]+$/);
    await expect(page.getByTestId("claim-detail")).toBeVisible();
    // grade와 review는 다른 사실이다.
    await expect(page.getByText("Grade is not review")).toBeVisible();
  });
});

test.describe("알림", () => {
  test("보내는 경로가 없다는 것을 화면이 숨기지 않는다", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/notifications");

    // 앱을 열지 않으면 여전히 모른다. 그것을 감추면 알림이 있다고 믿게 된다.
    await expect(page.getByTestId("notifications-limits")).toContainText(
      /Nothing is sent anywhere yet/,
    );
    // 역할 알림은 한 사람이 읽어도 남에게 남는다.
    await expect(page.getByTestId("notifications-limits")).toContainText(
      /stays unread for everyone else/,
    );
  });
});

test.describe("알림 수신처", () => {
  test("메일이 아니라 webhook인 이유를 화면이 말한다", async ({ page }) => {
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    const sinks = page.getByTestId("admin-sinks");
    // 주소를 저장하는 순간 지금 422로 거절하는 등급을 보관하게 된다(OD-18).
    await expect(sinks).toContainText(/Email is deliberately not offered/);
    // 값을 붙여넣게 하면 그것이 DB에 남는다.
    await expect(sinks).toContainText(/A reference, not the secret itself/);
  });

  test("수신처를 등록하면 배달 상태와 함께 보인다", async ({ page }) => {
    const url = `https://hooks.example.test/${Date.now()}`;
    await connectAs(page, "Operator A");
    await page.goto("/w/admin");

    await page.getByRole("textbox", { name: "Webhook URL" }).fill(url);
    await page
      .getByRole("textbox", { name: "Signing secret reference" })
      .fill("env:NOTIFY_E2E_SECRET");
    await page.getByRole("button", { name: "Add sink" }).click();

    const row = page.getByTestId("admin-sinks").locator("tr", { hasText: url });
    await expect(row).toBeVisible();
    // 등록돼 있다와 실제로 가고 있다를 구분해 보인다.
    await expect(row).toContainText("active");
    await expect(row.getByRole("button", { name: "Pause" })).toBeVisible();
  });
});

test.describe("약관·데이터 처리", () => {
  test("정식 약관이 아직 없다는 것을 가장 먼저 말한다", async ({ page }) => {
    await page.goto("/legal");

    await expect(page.getByTestId("legal-status")).toContainText(
      /no issued Terms of Service or Privacy Policy yet/,
    );
    // 지키지 못할 약속을 하는 것이 없는 것보다 나쁘다.
    await expect(page.getByTestId("legal-status")).toContainText(/not open to members of the public/);
  });

  test("시스템이 실제로 강제하는 것을 근거와 함께 낸다", async ({ page }) => {
    await page.goto("/legal");

    const enforced = page.getByTestId("legal-enforced");
    await expect(enforced).toContainText("OD-18");
    await expect(enforced).toContainText("AC-32");
    await expect(page.getByTestId("legal-support")).toBeVisible();
  });

  test("어느 화면에서든 닿는다", async ({ page }) => {
    await page.goto("/explorer");
    await page.getByRole("link", { name: /Terms, data handling, and support/ }).click();

    await expect(page).toHaveURL(/\/legal$/);
  });
});
