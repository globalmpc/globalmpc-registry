import type { Page } from "@playwright/test";
import type { TypedDataDefinition } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { demoWalletKey } from "./demo-people";

/**
 * A browser wallet for the specs (EIP-1193), standing in for an extension (WP7).
 *
 * The page sees an ordinary `window.ethereum`; every request it makes is answered here, in the
 * test process, with the demo person's key — the key never enters the page. The app treats it as
 * it treats any extension: it asks for the wallet only when something is signed, checks that the
 * address is bound to the signed-in account, switches the chain, and sends the server's typed data
 * unchanged. Nothing here signs anyone in; a wallet cannot.
 */

const CHAIN_ID = 31337;

/** Which person's key answers for each page. Set by `useWallet`, read by the exposed function. */
const holders = new WeakMap<Page, string>();
const installed = new WeakSet<Page>();

export interface WalletRequestLog {
  readonly method: string;
}

/** Requests the page made, per page — a spec can show the wallet was asked only to sign. */
const requests = new WeakMap<Page, WalletRequestLog[]>();

export function walletRequests(page: Page): readonly WalletRequestLog[] {
  return requests.get(page) ?? [];
}

/**
 * Makes `label`'s wallet the one this page's `window.ethereum` answers with. Installs the wallet
 * on the first call for a page (it is injected before any page script, on every navigation).
 */
export async function useWallet(page: Page, label: string): Promise<void> {
  holders.set(page, label);
  if (installed.has(page)) return;
  installed.add(page);
  requests.set(page, []);

  await page.exposeFunction("__e2eWalletRequest", async (method: string, params: unknown[]) => {
    requests.get(page)?.push({ method });
    const holder = holders.get(page);
    if (!holder) throw new Error("no wallet holder for this page");
    const account = privateKeyToAccount(demoWalletKey(holder));
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        return [account.address];
      case "eth_chainId":
        return `0x${CHAIN_ID.toString(16)}`;
      case "wallet_switchEthereumChain": {
        const target = Number.parseInt(String((params[0] as { chainId?: string } | undefined)?.chainId), 16);
        if (target !== CHAIN_ID) throw Object.assign(new Error("Unrecognized chain"), { code: 4902 });
        return null;
      }
      case "eth_signTypedData_v4": {
        const [address, json] = params as [string, string];
        if (address.toLowerCase() !== account.address.toLowerCase()) {
          throw Object.assign(new Error("Unknown account"), { code: 4100 });
        }
        return account.signTypedData(typedData(JSON.parse(json)));
      }
      default:
        throw Object.assign(new Error(`Unsupported method ${method}`), { code: 4200 });
    }
  });

  await page.addInitScript(() => {
    const call = (window as unknown as {
      __e2eWalletRequest(method: string, params: unknown[]): Promise<unknown>;
    }).__e2eWalletRequest;
    const provider = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        try {
          return await call(method, params ?? []);
        } catch (caught) {
          // Errors cross the bridge as messages; the app reads EIP-1193 codes from them.
          const message = caught instanceof Error ? caught.message : String(caught);
          const code = /Unrecognized chain/.test(message) ? 4902 : /Unknown account/.test(message) ? 4100 : 4200;
          throw Object.assign(new Error(message), { code });
        }
      },
      on() {},
      removeListener() {},
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
  });
}

/**
 * The server's typed data as viem signs it. It sends integers as decimal strings; viem wants
 * bigint for the uint/int fields of the primary type.
 */
function typedData(request: {
  domain: Record<string, unknown>;
  types: Record<string, { name: string; type: string }[]>;
  primaryType: string;
  message: Record<string, unknown>;
}): TypedDataDefinition {
  const numeric = new Set(
    (request.types[request.primaryType] ?? [])
      .filter((field) => /^u?int\d*$/.test(field.type))
      .map((field) => field.name),
  );
  const message = Object.fromEntries(
    Object.entries(request.message).map(([key, value]) => [
      key,
      numeric.has(key) && (typeof value === "string" || typeof value === "number") ? BigInt(value) : value,
    ]),
  );
  return { ...request, message } as unknown as TypedDataDefinition;
}
