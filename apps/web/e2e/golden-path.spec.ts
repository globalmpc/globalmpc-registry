import { expect, test, type Page } from "@playwright/test";

/**
 * Golden path E2E — R1 Task 10.
 *
 * 한 시나리오가 등록부터 공개 조회까지 전 구간을 지난다.
 *
 *   프로젝트 등록 → source receipt → claim → 검토 서명 → 준비도 평가
 *   → gate 결정 → 공개 게시 → anchor → Explorer 조회 → 포함 증명
 *
 * 이 테스트가 확인하는 것은 "화면이 뜬다"가 아니라 **각 단계의 산출물이 다음
 * 단계의 입력이 되고, 마지막에 로그인하지 않은 조회자에게 도달하는가**다.
 * 역할이 단계마다 바뀌는 것도 그 자체가 검증 대상이다 — 한 계정이 전부 할 수
 * 있으면 분리가 성립하지 않는다.
 */

/** 계정 전환. 역할이 다르면 다른 사람이므로 매번 다시 연결한다. */
async function connectAs(page: Page, label: string): Promise<void> {
  await page.goto("/connect");
  const signOut = page.getByRole("button", { name: "Disconnect" });
  if (await signOut.isVisible().catch(() => false)) {
    await signOut.click();
  }
  await page.getByRole("button", { name: new RegExp(label) }).click();
  await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();
}

test.describe("golden path", () => {
  // 단계가 서로의 산출물에 의존하므로 하나의 테스트로 묶는다. 쪼개면 순서
  // 의존을 숨기게 되고, 실패했을 때 어느 단계가 끊겼는지 보이지 않는다.
  test.setTimeout(120_000);

  test("등록에서 공개 포함 증명까지 한 흐름으로 이어진다", async ({ page }) => {
    const projectKey = `GOLD-${Date.now()}`;

    // --- 1. 등록 (mpc_operator) -------------------------------------------
    await connectAs(page, "Operator A");
    await page.goto("/w/projects/new");
    await page.getByRole("textbox", { name: "Project key" }).fill(projectKey);
    await page.getByRole("textbox", { name: "Name" }).fill("Golden Path mine");
    await page.getByRole("textbox", { name: "Minerals (comma separated)" }).fill("copper");
    await page.getByRole("button", { name: "Register" }).click();

    await expect(page.getByRole("heading", { name: projectKey })).toBeVisible();
    const projectId = new URL(page.url()).pathname.split("/").pop() as string;
    expect(projectId).toMatch(/^[0-9a-f-]{36}$/);

    // 자산·청약 자리에 비활성 버튼이나 빈 공간을 두지 않는다(OD-07). 왜 없는지와
    // 누가 무엇을 해야 하는지를 보여준다.
    await expect(page.getByTestId("offering-gate")).toContainText("숨겨 두지도");
    await expect(page.getByTestId("offering-preconditions")).toContainText("법적 발행 결정");
    await expect(
      page.getByRole("button", { name: /subscribe|buy|purchase|transfer/i }),
    ).toHaveCount(0);

    // --- 2. 증빙과 claim (data_steward) -----------------------------------
    // 등록한 계정이 곧바로 증빙까지 다룰 수 없다. 역할이 다르다.
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);

    // 파일은 곧바로 증빙이 되지 않는다. 격리 → 검사 → 승격을 지난다.
    await page.getByTestId("upload-input").setInputFiles({
      name: "mining-license.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from(`license extract ${projectKey}`),
    });
    await expect(page.getByTestId("upload-table")).toContainText("quarantined");

    const uploadRow = page.locator('[data-testid^="upload-state-"]').first();
    const uploadId = (await uploadRow.getAttribute("data-testid"))!.replace("upload-state-", "");

    // 검사는 별도 worker가 한다. 화면에 그 버튼이 없는 것이 통제이므로, E2E는
    // **검사 서비스의 세션으로** API를 부른다. steward 세션으로는 거절된다 —
    // 파일을 올린 사람이 자기 파일을 통과시킬 수 없다.
    const stewardToken = await page.evaluate(() =>
      window.localStorage.getItem("mpc.session.token"),
    );
    const denied = await page.request.post(`/api/v1/uploads/${uploadId}/scan-result`, {
      headers: {
        authorization: `Bearer ${stewardToken}`,
        "idempotency-key": `e2e-denied-${uploadId}`,
        "if-match": '"1"',
      },
      data: { result: "clean" },
    });
    expect(denied.status()).toBe(403);

    await connectAs(page, "Scan Service");
    const scanToken = await page.evaluate(() =>
      window.localStorage.getItem("mpc.session.token"),
    );
    const scanned = await page.request.post(`/api/v1/uploads/${uploadId}/scan-result`, {
      headers: {
        authorization: `Bearer ${scanToken}`,
        "idempotency-key": `e2e-scan-${uploadId}`,
        "if-match": '"1"',
      },
      data: { result: "clean" },
    });
    expect(scanned.ok()).toBe(true);

    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/data-room`);
    await expect(page.getByTestId(`upload-state-${uploadId}`)).toHaveText("scanned_clean");

    await page.getByTestId(`promote-${uploadId}`).click();
    await expect(page.getByTestId(`upload-state-${uploadId}`)).toHaveText("promoted");

    /**
     * 확정은 화면에서 적어 넣는 것이 아니다 — 2026-09-10 실사 A1.
     *
     * 예전에는 이 자리에 `Record "confirmed"` 버튼이 있었고, 그것을 누르면
     * `confirmed_from_source`가 그대로 저장됐다. 지금은 **서버가 출처를 부른다.**
     *
     * 이 seed의 endpoint는 `registry.example.test`이며 예약 TLD라 해석되지
     * 않는다(`e2e/seed.ts`) — 실제 기관 연동은 아직 열려 있다. 그래서
     * 여기서 나오는 답은 "확인"이 아니라 **"사람이 확인해야 한다"**이고,
     * 그것이 지금 이 배포의 사실이다. 확인을 만들어 내지 않는 것이 요점이다.
     */
    await page.getByRole("button", { name: "Look up the official source" }).click();
    await expect(page.getByText("Manual review required")).toBeVisible();

    // 12개 결과가 서로 다른 사실임을 화면이 구분한다(AC-18). "기록 없음"과
    // "확인 불가"가 같은 문구로 보이면 없는 기록을 계속 재시도하게 된다.
    await page.getByRole("button", { name: "Record “no record”" }).click();
    await expect(page.getByText("No record found for this query")).toBeVisible();

    await page.getByRole("button", { name: "Record “source unavailable”" }).click();
    await expect(page.getByText("Source currently unavailable")).toBeVisible();

    await page.getByRole("button", { name: "Add a mining right claim" }).click();
    await expect(page.getByText("mining_right_registration")).toBeVisible();

    // 충돌을 기록하면 등급이 즉시 재계산되고 버전이 올라간다.
    await expect(page.getByText("v1")).toBeVisible();
    await page.getByRole("button", { name: "Record a conflict" }).click();
    await expect(page.getByText("v2")).toBeVisible();

    // --- 3. 검토 배정 (data_steward) ---------------------------------------
    await page.goto(`/w/projects/${projectId}/verification`);
    await page.getByRole("checkbox").first().check();
    await page.getByRole("button", { name: "Assign the review" }).click();
    await expect(page.getByTestId("selected-case")).toContainText("assigned");

    // --- 4. 서명 (reviewer_cp_qp) -----------------------------------------
    // 배정한 사람은 서명하지 못한다. 검토자가 목록에서 자기 배정을 찾는다.
    await connectAs(page, "Reviewer A");
    await page.goto(`/w/projects/${projectId}/verification`);

    // 상단에 지금 연결된 사람의 역할이 보인다. 서명은 자격이 있는 사람의 행위다.
    await expect(page.getByText(/reviewer_cp_qp/)).toBeVisible();

    await expect(page.getByTestId("case-list")).toBeVisible();
    await page.getByRole("button", { name: "Open this case" }).first().click();
    await expect(page.getByTestId("selected-case")).toContainText("assigned");

    await page.getByRole("button", { name: "Create the draft" }).click();
    // 화면의 다른 "draft"(제목·버튼 문구)가 아니라 attestation 상태값을 본다.
    await expect(page.getByText("draft", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Create a signature request" }).click();
    // 무엇에 서명하는지 사람이 읽을 수 있는 형태로 먼저 보인다(§11.4).
    await expect(page.getByTestId("signing-payload")).toContainText(projectKey);
    await expect(page.getByTestId("signing-payload")).toContainText("site due diligence");

    await page.getByTestId("sign-attestation").click();
    await expect(page.getByTestId("signed-result")).toContainText("signed");

    // --- 5. 준비도 평가 (data_steward) -------------------------------------
    await connectAs(page, "Steward A");
    await page.goto(`/w/projects/${projectId}/readiness`);
    await page.getByRole("button", { name: "Recompute" }).click();
    await expect(page.getByText("Result hash", { exact: true })).toBeVisible();

    // 준비도 화면에는 값을 고치는 경로가 없다(REQ-DAPP-017).
    await expect(page.getByRole("button", { name: /override|force|ignore/i })).toHaveCount(0);

    // --- 6. gate 결정 (gate_approver) -------------------------------------
    await connectAs(page, "Approver A");
    await page.goto(`/w/projects/${projectId}/gates/registry_publication`);
    await page.getByRole("button", { name: "Load current readiness" }).click();
    // 안내 문장에도 "There is no deciding without one"이 있어 느슨한 OR 정규식은
    // 두 요소를 잡는다. 로드 결과의 제목만 정확히 기다린다.
    await expect(page.getByText(/^\d+ requirements block go$/)).toBeVisible();

    await page.getByLabel("Rationale (required)").fill("The basis is insufficient; not advancing to the next stage");

    // gap이 있으면 go는 막히지만 hold는 언제나 기록할 수 있다. 나쁜 소식을
    // 기록하지 못하면 상태가 조용히 낡는다.
    await expect(page.getByRole("button", { name: "go (blocked)" })).toBeDisabled();
    await page.getByRole("button", { name: "hold", exact: true }).click();
    await expect(page.getByText("Recorded decision")).toBeVisible();

    // --- 7. 공개 게시와 anchor (mpc_operator) ------------------------------
    await connectAs(page, "Operator A");
    await page.goto(`/w/projects/${projectId}/publication`);

    // 되돌릴 수 없다는 확인 없이는 게시 버튼이 눌리지 않는다.
    await expect(page.getByTestId("publish")).toBeDisabled();
    await page.getByTestId("irreversibility-ack").check();
    await page.getByTestId("publish").click();
    await expect(page.getByTestId("published-result")).toContainText(projectKey);

    await page.getByTestId("anchor").click();
    // batch가 만들어졌다고 체인에 올라간 것은 아니다.
    await expect(page.getByTestId("anchor-result")).toContainText("created");

    // --- 8. 로그인 없이 조회 -----------------------------------------------
    await page.goto("/connect");
    await page.getByRole("button", { name: "Disconnect" }).click();

    // 링크로 넘어오면 화면이 스스로 조회한다. 그래도 한 번 더 눌러
    // 직접 조회 경로가 살아 있는지 함께 본다 — 목록 검색과 다른 버튼이다.
    await page.goto(`/explorer?registryType=project&publicKey=${projectKey}`);
    await page.getByRole("button", { name: "Look up" }).click();

    await expect(page.getByRole("heading", { name: "Published record" })).toBeVisible();
    await expect(page.getByTestId("shared-status")).toHaveText("published");

    /**
     * --- 8-1. 3깊이 레코드 뷰 — §11.10 / AC-26 ------------------------------
     *
     * 깊이를 바꿔도 status·version·as-of·limitations·authority scope는 같아야
     * 한다. 다르면 "간단히 보기"와 "자세히 보기"가 서로 다른 기록이 된다.
     */
    const sharedFacts = async () => ({
      status: await page.getByTestId("shared-status").textContent(),
      version: await page.getByTestId("shared-version").textContent(),
      asOf: await page.getByTestId("shared-as-of").textContent(),
      limitations: await page.getByTestId("shared-limitations").textContent(),
      scope: await page.getByTestId("shared-authority-scope").textContent(),
    });

    const atBasic = await sharedFacts();
    await expect(page.getByTestId("explanation-layer")).toHaveCount(0);
    await expect(page.getByTestId("expert-layer")).toHaveCount(0);

    await page.getByTestId("depth-explanation").click();
    await expect(page.getByTestId("explanation-layer")).toBeVisible();
    expect(await sharedFacts()).toEqual(atBasic);

    await page.getByTestId("depth-expert").click();
    await expect(page.getByTestId("expert-layer")).toBeVisible();
    // Expert는 receipt·hash·merkle path를 더할 뿐 공유 사실을 바꾸지 않는다.
    expect(await sharedFacts()).toEqual(atBasic);

    /**
     * --- 9. 포함 증명 -------------------------------------------------------
     *
     * AC-09: valid inclusion proof는 integrity inclusion만 반환하며 factual
     * truth나 legal validity를 참으로 만들지 않는다. AC-28: 이 흐름 전체가
     * DID method와 ZK prover 없이 통과한다.
     */
    await expect(page.getByTestId("proof-panel")).toBeVisible();
    // Merkle 경로는 맞지만 체인 확정 전이므로 included는 아직 참이 아니다(AC-23).
    await expect(page.getByText("Path matches")).toBeVisible();
    await expect(page.getByTestId("proof-included")).toContainText("Not confirmed yet");

    // 증명이 확인하지 않는 것을 같은 화면에서 밝힌다.
    await expect(page.getByTestId("proof-disclaimer")).toBeVisible();
    await expect(
      page.getByText("Integrity and authority are different questions"),
    ).toBeVisible();
  });
});
