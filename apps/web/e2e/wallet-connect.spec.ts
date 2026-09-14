import { expect, test, type Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * 실지갑 연결.
 *
 * 다른 E2E는 데모 계정(알려진 키)으로 로그인한다. 그 경로는 지갑 확장을 거치지
 * 않으므로 **지갑마다 다른 응답**(체인 없음 코드, 거절, 여러 확장 동시 설치)을
 * 한 번도 지나지 않았다. 여기서는 EIP-6963으로 자기를 알리는 가짜 지갑을 페이지에
 * 넣고, 서명만 Node 쪽 키로 한다 — 앱 코드는 실제 지갑과 같은 경로를 탄다.
 *
 * 주소는 매번 새로 만든다. **어느 tenant에도 없는 지갑**이 로그인해 워크스페이스에
 * 닿는지가 이 파일의 핵심이다 — "누구든 연결하면 사용자가 된다".
 */

type Mode = "desktop" | "mobile-nested" | "reject-switch";

interface FakeWallet {
  readonly name: string;
  readonly rdns: string;
  readonly flags: Record<string, boolean>;
  readonly startChain: number;
  readonly mode: Mode;
}

const METAMASK: FakeWallet = {
  name: "MetaMask",
  rdns: "io.metamask",
  flags: { isMetaMask: true },
  startChain: 1,
  mode: "desktop",
};

async function installWallets(page: Page, wallets: readonly FakeWallet[]): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());
  await page.exposeFunction("__e2eWalletSign", (message: string) => account.signMessage({ message }));

  for (const wallet of wallets) {
    await page.addInitScript(
      ({ address, wallet }) => {
        const w = window as unknown as Record<string, unknown>;
        let chain = wallet.startChain;
        const known = new Set<number>([wallet.startChain]);
        const listeners: Record<string, ((value: unknown) => void)[]> = {};
        const calls = ((w["__walletCalls"] as string[] | undefined) ??= []);

        const fail = (message: string, extra: Record<string, unknown>) =>
          Object.assign(new Error(message), extra);

        const provider = {
          ...wallet.flags,
          async request({ method, params }: { method: string; params?: unknown[] }) {
            calls.push(`${wallet.rdns}:${method}`);
            const target = () => Number.parseInt((params?.[0] as { chainId: string }).chainId, 16);
            switch (method) {
              case "eth_requestAccounts":
              case "eth_accounts":
                return [address];
              case "eth_chainId":
                return `0x${chain.toString(16)}`;
              case "wallet_switchEthereumChain": {
                const next = target();
                if (wallet.mode === "reject-switch") throw fail("User rejected the request.", { code: 4001 });
                if (!known.has(next)) {
                  if (wallet.mode === "mobile-nested") {
                    throw fail("Internal JSON-RPC error.", {
                      code: -32603,
                      data: { originalError: { code: 4902 } },
                    });
                  }
                  throw fail("Unrecognized chain ID.", { code: 4902 });
                }
                chain = next;
                (listeners["chainChanged"] ?? []).forEach((handler) => handler(`0x${next.toString(16)}`));
                return null;
              }
              case "wallet_addEthereumChain":
                known.add(target());
                chain = target();
                return null;
              case "personal_sign":
                return (w["__e2eWalletSign"] as (message: string) => Promise<string>)(
                  params?.[0] as string,
                );
              default:
                throw fail(`unsupported ${method}`, { code: 4200 });
            }
          },
          on(event: string, handler: (value: unknown) => void) {
            (listeners[event] ??= []).push(handler);
          },
          removeListener(event: string, handler: (value: unknown) => void) {
            listeners[event] = (listeners[event] ?? []).filter((candidate) => candidate !== handler);
          },
        };

        w[`__walletEmit_${wallet.rdns}`] = (event: string, value: unknown) =>
          (listeners[event] ?? []).forEach((handler) => handler(value));

        const announce = () =>
          window.dispatchEvent(
            new CustomEvent("eip6963:announceProvider", {
              detail: Object.freeze({
                info: { uuid: wallet.rdns, name: wallet.name, icon: "", rdns: wallet.rdns },
                provider,
              }),
            }),
          );
        window.addEventListener("eip6963:requestProvider", announce);
        announce();
      },
      { address: account.address, wallet },
    );
  }

  return account.address.toLowerCase();
}

async function connectWith(page: Page, rdns: string): Promise<void> {
  await page.goto("/connect");
  await page.getByTestId(`connect-wallet-${rdns}`).click();
}

async function steps(page: Page): Promise<string> {
  await page.goto("/connect");
  return (await page.getByTestId("connection-steps").textContent()) ?? "";
}

test.describe("실지갑 연결 — 어느 지갑이든 사용자가 된다", () => {
  test("MetaMask 데스크톱 — 이더리움(1)에서 시작해도 체인을 추가하고 로그인한다", async ({ page }) => {
    await installWallets(page, [METAMASK]);
    await connectWith(page, "io.metamask");

    // 등록되지 않은 새 지갑이 워크스페이스에 닿는다. 역할은 없고 그 사실이 보인다.
    await expect(page).toHaveURL(/\/w\/projects/);
    await expect(page.getByText("No roles").first()).toBeVisible();
    // 묶이지 않은 지갑은 오류(401)가 아니라 연결 대기 안내를 본다.
    await expect(page.getByTestId("enrollment-panel")).toBeVisible();
    await expect(page.getByTestId("error-notice")).toHaveCount(0);

    const calls = (await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls));
    expect(calls).toContain("io.metamask:wallet_addEthereumChain");
    expect(await steps(page)).toMatch(/switched 1 → 97/);
  });

  test("MetaMask 모바일 — 4902를 -32603 안에 싸서 줘도 체인 추가를 제안한다", async ({ page }) => {
    await installWallets(page, [{ ...METAMASK, mode: "mobile-nested" }]);
    await connectWith(page, "io.metamask");

    await expect(page).toHaveURL(/\/w\/projects/);
    const calls = (await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls));
    expect(calls).toContain("io.metamask:wallet_addEthereumChain");
  });

  test("Trust Wallet — 체인 전환을 거절해도 로그인은 된다", async ({ page }) => {
    await installWallets(page, [
      {
        name: "Trust Wallet",
        rdns: "com.trustwallet.app",
        flags: { isTrust: true, isTrustWallet: true },
        startChain: 56,
        mode: "reject-switch",
      },
    ]);
    await connectWith(page, "com.trustwallet.app");

    // SIWE 서명은 체인과 무관하다. 전환을 로그인의 조건으로 두지 않는다.
    await expect(page).toHaveURL(/\/w\/projects/);
    const recorded = await steps(page);
    expect(recorded).toMatch(/Trust Wallet \(com\.trustwallet\.app\)/);
    expect(recorded).toMatch(/not switched \(4001/);
  });

  test("Brave와 MetaMask가 같이 깔려 있으면 고른 지갑으로 연결한다", async ({ page }) => {
    await installWallets(page, [
      { name: "Brave Wallet", rdns: "com.brave.wallet", flags: { isBraveWallet: true }, startChain: 1, mode: "desktop" },
      METAMASK,
    ]);

    await page.goto("/connect");
    await expect(page.getByTestId("connect-wallet-com.brave.wallet")).toBeVisible();
    await expect(page.getByTestId("connect-wallet-io.metamask")).toBeVisible();

    await page.getByTestId("connect-wallet-com.brave.wallet").click();
    await expect(page).toHaveURL(/\/w\/projects/);

    const calls = (await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls));
    // 고른 쪽만 요청을 받는다. `window.ethereum`을 먼저 잡은 쪽이 아니다.
    expect(calls.some((call) => call.startsWith("com.brave.wallet:personal_sign"))).toBe(true);
    expect(calls.some((call) => call.startsWith("io.metamask:personal_sign"))).toBe(false);
    expect(await steps(page)).toMatch(/Brave Wallet \(com\.brave\.wallet\)/);
  });

  test("서명 메시지의 체인은 서버가 준 값이다 — 웹에 박힌 값이 아니다", async ({ page }) => {
    await installWallets(page, [METAMASK]);

    // 서버가 56을 말한다고 가정한다(stg·prod). 예전 웹은 97을 박아 두었다.
    await page.route("**/api/v1/auth/siwe/nonce", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, chainId: 56 } });
    });
    const verifyBody = page.waitForRequest("**/api/v1/auth/siwe/verify");

    await connectWith(page, "io.metamask");

    const request = await verifyBody;
    const message = (request.postDataJSON() as { message: string }).message;
    expect(message).toContain("Chain ID: 56");
  });

  test("지갑에서 다른 계정으로 바꾸면 연결을 끊고 다시 연결하라고 말한다", async ({ page }) => {
    await installWallets(page, [METAMASK]);
    await connectWith(page, "io.metamask");
    await expect(page).toHaveURL(/\/w\/projects/);
    await expect(page.getByRole("button", { name: "Disconnect" })).toBeVisible();

    await page.evaluate(() =>
      (window as unknown as Record<string, (event: string, value: unknown) => void>)[
        "__walletEmit_io.metamask"
      ]!("accountsChanged", ["0x000000000000000000000000000000000000dead"]),
    );

    await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  });
});
