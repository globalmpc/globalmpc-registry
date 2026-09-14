import { expect, test, type Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

/**
 * Real wallet connection.
 *
 * Other E2E specs sign in with demo accounts (known keys). That path bypasses wallet
 * extensions, so it never exercised **responses that differ per wallet** (unknown-chain
 * codes, rejections, multiple extensions installed at once). Here a fake wallet that
 * announces itself via EIP-6963 is injected into the page, and only signing uses a key on
 * the Node side — the app code takes the same path as with a real wallet.
 *
 * The address is new every time. The core of this file is whether **a wallet not in any
 * tenant** can sign in and reach the workspace — "anyone who connects becomes a user".
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

test.describe("real wallet connection — any wallet becomes a user", () => {
  test("MetaMask desktop — starting on Ethereum (1), adds the chain and signs in", async ({ page }) => {
    await installWallets(page, [METAMASK]);
    await connectWith(page, "io.metamask");

    // A new, unregistered wallet reaches the workspace. It has no roles, and that is shown.
    await expect(page).toHaveURL(/\/w\/projects/);
    await expect(page.getByText("No roles").first()).toBeVisible();
    // An unbound wallet sees an enrollment-pending notice, not an error (401).
    await expect(page.getByTestId("enrollment-panel")).toBeVisible();
    await expect(page.getByTestId("error-notice")).toHaveCount(0);

    const calls = (await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls));
    expect(calls).toContain("io.metamask:wallet_addEthereumChain");
    expect(await steps(page)).toMatch(/switched 1 → 97/);
  });

  test("MetaMask mobile — offers to add the chain even when 4902 is wrapped in -32603", async ({ page }) => {
    await installWallets(page, [{ ...METAMASK, mode: "mobile-nested" }]);
    await connectWith(page, "io.metamask");

    await expect(page).toHaveURL(/\/w\/projects/);
    const calls = (await page.evaluate(() => (window as unknown as { __walletCalls: string[] }).__walletCalls));
    expect(calls).toContain("io.metamask:wallet_addEthereumChain");
  });

  test("Trust Wallet — sign-in succeeds even when the chain switch is rejected", async ({ page }) => {
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

    // A SIWE signature is chain-independent. Switching is not a precondition for sign-in.
    await expect(page).toHaveURL(/\/w\/projects/);
    const recorded = await steps(page);
    expect(recorded).toMatch(/Trust Wallet \(com\.trustwallet\.app\)/);
    expect(recorded).toMatch(/not switched \(4001/);
  });

  test("with Brave and MetaMask both installed, connects with the chosen wallet", async ({ page }) => {
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
    // Only the chosen wallet receives requests, not whichever grabbed `window.ethereum` first.
    expect(calls.some((call) => call.startsWith("com.brave.wallet:personal_sign"))).toBe(true);
    expect(calls.some((call) => call.startsWith("io.metamask:personal_sign"))).toBe(false);
    expect(await steps(page)).toMatch(/Brave Wallet \(com\.brave\.wallet\)/);
  });

  test("the chain in the signing message comes from the server — not hardcoded in the web", async ({ page }) => {
    await installWallets(page, [METAMASK]);

    // Assume the server says 56 (stg, prod). The old web hardcoded 97.
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

  test("switching to another account in the wallet disconnects and asks to reconnect", async ({ page }) => {
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
