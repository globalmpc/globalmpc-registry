import { expect, test } from "@playwright/test";

/**
 * 거절이 가리키는 경로에 화면이 있는지 확인한다 — 11 §11.7.
 *
 * `authorize()`가 거절할 때 `accessRequestPath`를 주고 `ErrorNotice`가 그것을
 * 링크로 건다. 그 경로에 화면이 없으면 안내를 따라간 사용자가 404를 만난다.
 * 이 검사는 그 링크가 끊기지 않았는지만 본다.
 *
 * 경로 정본은 `packages/api-contract`의 `ACCESS_REQUEST_PATHS`다. 웹은 그 패키지를
 * 의존하지 않으므로 여기서는 같은 값을 적고, 계약 쪽 테스트가 목록이 바뀌면
 * 깨지도록 잠가 둔다.
 *
 * **로그인하지 않고 연다.** 권한이 없어 막힌 사람이 도착하는 자리이므로, 세션이
 * 없어도 무엇이 부족한지 읽을 수 있어야 한다.
 */

const PATHS = [
  { path: "/w/identity/upgrade", heading: "Identity assurance is not high enough" },
  { path: "/w/access-requests", heading: "No role allows this action" },
  {
    path: "/w/projects/00000000-0000-0000-0000-000000000001/access-requests",
    heading: "Not assigned to this project",
  },
] as const;

test.describe("§11.7 — access request 경로에 화면이 있다", () => {
  for (const { path, heading } of PATHS) {
    test(path, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();

      // 없는 기능을 있는 것처럼 보이지 않는다. 접수 API가 없다는 사실이 화면에
      // 있어야 누른 사람이 기다리지 않는다.
      await expect(page.getByText("This screen does not file a request")).toBeVisible();
    });
  }
});
