import { expect, test, type Page } from "@playwright/test";
import type { TypedDataDefinition } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { connectAs } from "./connect-as";

/**
 * Real wallet connection — at the moment of signing, never to sign in (WP7).
 *
 * A wallet is a signing key. The account signs in by email and a second factor; a wallet is
 * asked for only when something is signed — here, the proof that binds a new wallet to the
 * account in settings, the one signature every person makes first.
 *
 * Fake wallets that announce themselves via EIP-6963 are injected into the page, each answering
 * as that wallet does (unknown-chain codes, wrapped codes, rejections, several installed at once).
 * Signing uses a fresh key on the Node side; the app takes the same path as with a real wallet.
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

/** The person who binds wallets here: tenant C holds no projects, so nothing else depends on it. */
const PERSON = "Operator C";

/**
 * Installs the wallets and returns the fresh address they hold and the requests they received
 * (kept in the test process, so navigations do not lose them). The first wallet also claims
 * `window.ethereum`, as an extension does.
 */
async function installWallets(
  page: Page,
  wallets: readonly FakeWallet[],
): Promise<{ address: string; calls: string[] }> {
  const account = privateKeyToAccount(generatePrivateKey());
  const calls: string[] = [];
  await page.exposeFunction("__e2eWalletCall", (call: string) => {
    calls.push(call);
  });
  await page.exposeFunction("__e2eWalletSignTyped", (json: string) =>
    account.signTypedData(typedData(JSON.parse(json))),
  );

  for (const [index, wallet] of wallets.entries()) {
    await page.addInitScript(
      ({ address, wallet, claimsWindow }) => {
        const w = window as unknown as Record<string, unknown>;
        let chain = wallet.startChain;
        const known = new Set<number>([wallet.startChain]);
        const record = w["__e2eWalletCall"] as (call: string) => Promise<void>;
        const fail = (message: string, extra: Record<string, unknown>) =>
          Object.assign(new Error(message), extra);

        const provider = {
          ...wallet.flags,
          async request({ method, params }: { method: string; params?: unknown[] }) {
            await record(`${wallet.rdns}:${method}`);
            const target = () => {
              const request = params?.[0] as { chainId: string } | undefined;
              return Number.parseInt(request?.chainId ?? "", 16);
            };
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
                return null;
              }
              case "wallet_addEthereumChain":
                known.add(target());
                chain = target();
                return null;
              case "eth_signTypedData_v4": {
                if (Number((JSON.parse(params?.[1] as string) as { domain: { chainId: unknown } }).domain.chainId) !== chain) {
                  throw fail("Provided chainId must match the active chainId", { code: -32602 });
                }
                return (w["__e2eWalletSignTyped"] as (json: string) => Promise<string>)(params?.[1] as string);
              }
              default:
                throw fail(`unsupported ${method}`, { code: 4200 });
            }
          },
          on() {},
          removeListener() {},
        };

        if (claimsWindow) Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
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
      { address: account.address, wallet, claimsWindow: index === 0 },
    );
  }

  return { address: account.address.toLowerCase(), calls };
}

/** viem wants bigint for the integer fields the server sends as decimal strings. */
function typedData(request: {
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}): TypedDataDefinition {
  const numeric = new Set(
    (request.types[request.primaryType] ?? []).filter((field) => /^u?int\d*$/.test(field.type)).map((field) => field.name),
  );
  const message = Object.fromEntries(
    Object.entries(request.message).map(([key, value]) => [key, numeric.has(key) ? BigInt(value as string) : value]),
  );
  return { ...request, message } as unknown as TypedDataDefinition;
}

async function openWallets(page: Page) {
  await page.goto("/w/settings");
  const section = page.getByTestId("settings-wallets");
  await expect(section).toBeVisible();
  return section;
}

/**
 * The account holds one wallet (0130); the seed gave Operator C one, so every binding here is a
 * replacement: the screen names the wallet it replaces, and nothing is signed until confirmed.
 */
async function replaceAndConfirm(section: ReturnType<Page["getByTestId"]>, start?: () => Promise<void>) {
  const current = (await section.getByTestId("wallet-current").getByTestId("wallet-address").textContent())!;
  await (start ? start() : section.getByTestId("replace-wallet").click());
  const confirm = section.getByTestId("replace-confirm");
  await expect(confirm).toContainText(`This will replace ${current}`, { ignoreCase: true });
  await confirm.getByTestId("confirm-replace").click();
  return current;
}

test.describe("a wallet is connected only to sign", () => {
  test("signing in asks no wallet anything, even with one installed, and offers none", async ({ page }) => {
    const { calls } = await installWallets(page, [METAMASK]);
    await page.goto("/connect");
    await expect(page.getByLabel("Email address")).toBeVisible();
    await expect(page.getByRole("button", { name: /wallet/i })).toHaveCount(0);

    await connectAs(page, PERSON, { wallet: false });
    await expect(page.getByTestId("sign-in-method")).toHaveText("email");
    expect(calls).toEqual([]);
  });

  test("MetaMask desktop — starting on Ethereum (1), adds the chain and signs the binding", async ({ page }) => {
    const { address, calls } = await installWallets(page, [METAMASK]);
    await connectAs(page, PERSON, { wallet: false });
    expect(calls).toEqual([]);

    const section = await openWallets(page);
    await replaceAndConfirm(section);
    await expect(section.getByTestId("wallet-current")).toContainText(address, { ignoreCase: true });

    // The chain is switched (here added first) before the typed data is signed, never a message.
    expect(calls).toContain("io.metamask:wallet_addEthereumChain");
    expect(calls).toContain("io.metamask:eth_signTypedData_v4");
    expect(calls.some((call) => call.endsWith(":personal_sign"))).toBe(false);
  });

  test("MetaMask mobile — offers to add the chain even when 4902 is wrapped in -32603", async ({ page }) => {
    const { address, calls } = await installWallets(page, [{ ...METAMASK, mode: "mobile-nested" }]);
    await connectAs(page, PERSON, { wallet: false });

    const section = await openWallets(page);
    await replaceAndConfirm(section);
    await expect(section.getByTestId("wallet-current")).toContainText(address, { ignoreCase: true });
    expect(calls).toContain("io.metamask:wallet_addEthereumChain");
  });

  test("Trust Wallet — a refused chain switch stops the signature and keeps the session", async ({ page }) => {
    const { address, calls } = await installWallets(page, [
      {
        name: "Trust Wallet",
        rdns: "com.trustwallet.app",
        flags: { isTrust: true, isTrustWallet: true },
        startChain: 56,
        mode: "reject-switch",
      },
    ]);
    await connectAs(page, PERSON, { wallet: false });

    const section = await openWallets(page);
    const before = await replaceAndConfirm(section);
    // EIP-712 needs the right chain; the rejection is shown and nothing is bound or signed.
    await expect(section.getByRole("alert")).toBeVisible();
    await expect(section.getByTestId("wallet-list")).not.toContainText(address, { ignoreCase: true });
    // Nothing was replaced: the account keeps the wallet it had.
    await expect(section.getByTestId("wallet-current")).toContainText(before, { ignoreCase: true });
    expect(calls).not.toContain("com.trustwallet.app:eth_signTypedData_v4");
    // A wallet's refusal is not a sign-out: the account session is not the wallet's.
    await expect(page.getByRole("banner").getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  test("with Brave and MetaMask both installed, signs with the chosen wallet", async ({ page }) => {
    const { address, calls } = await installWallets(page, [
      { name: "Brave Wallet", rdns: "com.brave.wallet", flags: { isBraveWallet: true }, startChain: 1, mode: "desktop" },
      METAMASK,
    ]);
    await connectAs(page, PERSON, { wallet: false });

    const section = await openWallets(page);
    await replaceAndConfirm(section, () => section.getByRole("button", { name: "Replace · MetaMask" }).click());
    await expect(section.getByTestId("wallet-current")).toContainText(address, { ignoreCase: true });

    // Only the chosen wallet receives requests, not whichever grabbed `window.ethereum` first.
    expect(calls.some((call) => call === "io.metamask:eth_signTypedData_v4")).toBe(true);
    expect(calls.some((call) => call.startsWith("com.brave.wallet:"))).toBe(false);
  });
});

/**
 * One signing wallet per account (0130): changing it is one ceremony that names the wallet it
 * replaces; disabling it without a replacement ends every session (AC-27).
 */
test.describe("the account's one signing wallet", () => {
  test("replace shows the wallet it replaces, signs nothing until confirmed, and keeps the session", async ({ page }) => {
    const { address, calls } = await installWallets(page, [METAMASK]);
    await connectAs(page, PERSON, { wallet: false });
    const section = await openWallets(page);
    await expect(section.getByTestId("replace-wallet")).toHaveText("Replace");
    await expect(section.getByTestId("disable-wallet")).toHaveText("Disable");
    const current = (await section.getByTestId("wallet-current").getByTestId("wallet-address").textContent())!;

    // Cancel first: the wallet was asked for its address, never for a signature.
    await section.getByTestId("replace-wallet").click();
    const confirm = section.getByTestId("replace-confirm");
    await expect(confirm).toContainText(`This will replace ${current}`, { ignoreCase: true });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    expect(calls).not.toContain("io.metamask:eth_signTypedData_v4");

    // The person says why; a compromised key is said to stay out for good.
    await section.getByTestId("replace-wallet").click();
    await expect(confirm.getByLabel("Why are you replacing it?")).toHaveValue("rotation");
    await confirm.getByLabel("Why are you replacing it?").selectOption("key_compromised");
    await expect(confirm).toContainText("can never be bound again");
    await confirm.getByTestId("confirm-replace").click();
    await expect(section.getByTestId("wallet-current")).toContainText(address, { ignoreCase: true });
    // The replaced wallet is history, and this session is still signed in.
    await expect(section.getByTestId("wallet-history")).toContainText(current, { ignoreCase: true });
    await expect(page.getByRole("banner").getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("settings-wallets").getByTestId("wallet-current")).toContainText(address, {
      ignoreCase: true,
    });
  });

  test("disable without a replacement signs out and leaves the account with no signing wallet", async ({ page }) => {
    await installWallets(page, [METAMASK]);
    await connectAs(page, PERSON, { wallet: false });
    const section = await openWallets(page);
    await section.getByTestId("disable-wallet").click();
    await expect(section).toContainText("leaves the account with no signing wallet");
    await section.getByLabel("Decision reason").fill("rotating keys in the E2E run");
    await section.locator("form").getByRole("button", { name: "Disable" }).click();
    await expect(page).toHaveURL(/\/connect/);

    // Signed in again (a fresh page: its own virtual authenticator), the account has no wallet.
    const again = await page.context().newPage();
    await connectAs(again, PERSON, { wallet: false });
    const after = await openWallets(again);
    await expect(after.getByTestId("wallet-current")).toHaveCount(0);
    await expect(after.getByTestId("bind-wallet")).toBeVisible();
    await expect(after.getByTestId("disable-wallet")).toHaveCount(0);
  });
});
