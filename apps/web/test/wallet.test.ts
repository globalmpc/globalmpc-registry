import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureChain,
  rpcErrorCode,
  selectWallet,
  switchChain,
  walletFlags,
  WalletError,
  type Eip1193Provider,
} from "../src/lib/wallet.js";

/**
 * Responses differ by wallet.
 *
 * Wallets respond differently when the chain is missing. Desktop MetaMask returns 4902;
 * MetaMask mobile returns 4902 wrapped in `-32603`, or no code at all. The old code, which read only
 * the top-level code, left mobile users stuck at "switch failed" with no offer to add the chain.
 */

type Failure = { code?: number; data?: unknown; message: string };

/** A fake wallet with a chain list. `switchFailure` is what it throws for an unknown chain. */
function fakeWallet(options: {
  start: number;
  known?: number[];
  switchFailure?: (target: number) => Failure;
  addSwitches?: boolean;
}) {
  let chain = options.start;
  const known = new Set(options.known ?? [options.start]);
  const calls: string[] = [];

  const provider: Eip1193Provider = {
    async request({ method, params }) {
      calls.push(method);
      const target = () => {
        const request = params?.[0] as { chainId: string } | undefined;
        return Number.parseInt(request?.chainId ?? "", 16);
      };
      switch (method) {
        case "eth_chainId":
          return `0x${chain.toString(16)}`;
        case "wallet_switchEthereumChain": {
          const next = target();
          if (!known.has(next) || options.switchFailure) {
            const failure = options.switchFailure?.(next) ?? { code: 4902, message: "Unrecognized chain" };
            throw Object.assign(new Error(failure.message), failure);
          }
          chain = next;
          return null;
        }
        case "wallet_addEthereumChain": {
          const next = target();
          known.add(next);
          // Some wallets only add and do not switch.
          if (options.addSwitches !== false) chain = next;
          return null;
        }
        default:
          throw new Error(`unsupported ${method}`);
      }
    },
  };

  return { provider, calls, chain: () => chain, allow: () => (options.switchFailure = undefined) };
}

beforeEach(() => {
  // wallet.ts returns a provider only when `window` exists.
  vi.stubGlobal("window", {});
});

afterEach(() => {
  selectWallet(null);
  vi.unstubAllGlobals();
});

function use(provider: Eip1193Provider): void {
  selectWallet({ id: "test.wallet", name: "Test", icon: null, provider });
}

describe("rpcErrorCode", () => {
  it("reads the top-level code", () => {
    expect(rpcErrorCode({ code: 4902 })).toBe(4902);
    expect(rpcErrorCode({ code: 4001 })).toBe(4001);
  });

  it("reads the code MetaMask mobile wraps inside -32603", () => {
    expect(rpcErrorCode({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(4902);
  });

  it("returns the top level as-is when no wrapped code exists", () => {
    expect(rpcErrorCode({ code: -32603 })).toBe(-32603);
  });

  it("is undefined when there is no code", () => {
    expect(rpcErrorCode(new Error("no code"))).toBeUndefined();
    expect(rpcErrorCode(null)).toBeUndefined();
  });
});

describe("switchChain — wallet without the chain", () => {
  it("desktop MetaMask (4902) — offers to add and moves to that chain", async () => {
    const wallet = fakeWallet({ start: 1 });
    use(wallet.provider);

    await switchChain(31337);

    expect(wallet.calls).toContain("wallet_addEthereumChain");
    expect(wallet.chain()).toBe(31337);
  });

  it("offers the opBNB testnet with its own network details", async () => {
    // The dev deployment runs on 5611. Without an entry the wallet gets no add prompt, and a user
    // whose wallet lacks the testnet is stuck at "switch failed".
    const wallet = fakeWallet({ start: 56 });
    const added: unknown[] = [];
    const request = wallet.provider.request.bind(wallet.provider);
    use({
      request: async (args) => {
        if (args.method === "wallet_addEthereumChain") added.push(args.params?.[0]);
        return request(args);
      },
    });

    await switchChain(5611);

    expect(wallet.chain()).toBe(5611);
    expect(added).toEqual([
      {
        chainId: "0x15eb",
        chainName: "opBNB Testnet",
        nativeCurrency: { name: "tBNB", symbol: "tBNB", decimals: 18 },
        rpcUrls: ["https://opbnb-testnet-rpc.bnbchain.org"],
        blockExplorerUrls: ["https://testnet.opbnbscan.com"],
      },
    ]);
  });

  it("MetaMask mobile (4902 inside -32603) — offers to add", async () => {
    const wallet = fakeWallet({
      start: 1,
      switchFailure: () => ({
        code: -32603,
        data: { originalError: { code: 4902 } },
        message: "Internal JSON-RPC error",
      }),
    });
    use(wallet.provider);

    await switchChain(56);

    expect(wallet.calls).toContain("wallet_addEthereumChain");
    expect(wallet.chain()).toBe(56);
  });

  it("wallet failing with no code — still offers to add", async () => {
    const wallet = fakeWallet({ start: 1, switchFailure: () => ({ message: "Unrecognized chain ID" }) });
    use(wallet.provider);

    await switchChain(56);

    expect(wallet.calls).toContain("wallet_addEthereumChain");
    expect(wallet.chain()).toBe(56);
  });

  it("does not prompt to add when the user rejects — rejection is a choice", async () => {
    const wallet = fakeWallet({ start: 1, switchFailure: () => ({ code: 4001, message: "User rejected" }) });
    use(wallet.provider);

    const failure = await switchChain(31337).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(WalletError);
    expect((failure as WalletError).rejectedByUser).toBe(true);
    // The original code survives wrapping. The connection log uses this value.
    expect((failure as WalletError).code).toBe(4001);
    expect(rpcErrorCode(failure)).toBe(4001);
    expect(wallet.calls).not.toContain("wallet_addEthereumChain");
  });

  it("wallet that adds but does not switch — switches once more", async () => {
    const wallet = fakeWallet({ start: 1, addSwitches: false });
    use(wallet.provider);

    await switchChain(31337);

    expect(wallet.calls.filter((method) => method === "wallet_switchEthereumChain")).toHaveLength(2);
    expect(wallet.chain()).toBe(31337);
  });
});

describe("ensureChain", () => {
  it("does not request a switch when already aligned", async () => {
    const wallet = fakeWallet({ start: 31337 });
    use(wallet.provider);

    await expect(ensureChain(31337)).resolves.toEqual({ before: 31337, switched: false });
    expect(wallet.calls).not.toContain("wallet_switchEthereumChain");
  });

  it("switches when different and reports the previous chain", async () => {
    const wallet = fakeWallet({ start: 1, known: [1, 56] });
    use(wallet.provider);

    await expect(ensureChain(56)).resolves.toEqual({ before: 1, switched: true });
  });
});

describe("walletFlags", () => {
  it("collects only the flags the wallet sets — for logging", () => {
    const provider = { request: async () => null, isMetaMask: true, isBraveWallet: true, isTrust: false };
    expect(walletFlags(provider as unknown as Eip1193Provider)).toEqual(["isMetaMask", "isBraveWallet"]);
    expect(walletFlags(null)).toEqual([]);
  });
});

describe("connection and signatures", () => {
  it("normalizes approved accounts and sends signature parameters in wallet order", async () => {
    const {
      connectWallet,
      personalSign,
      signTypedDataWithWallet,
      subscribeProviderEvents,
    } = await import("../src/lib/wallet.js");
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(["0xABC"])
      .mockResolvedValueOnce("0xpersonal")
      .mockResolvedValueOnce("0xtyped");
    const removeListener = vi.fn();
    use({
      request,
      on: (event, listener) => {
        listeners.set(event, listener);
      },
      removeListener,
    });
    expect(await connectWallet()).toBe("0xabc");
    expect(await personalSign("message", "0xabc")).toBe("0xpersonal");
    expect(
      await signTypedDataWithWallet({ domain: { name: "MPC" } }, "0xabc"),
    ).toBe("0xtyped");
    expect(request).toHaveBeenNthCalledWith(2, {
      method: "personal_sign",
      params: ["message", "0xabc"],
    });
    expect(request).toHaveBeenNthCalledWith(3, {
      method: "eth_signTypedData_v4",
      params: ["0xabc", '{"domain":{"name":"MPC"}}'],
    });
    const onAccounts = vi.fn(),
      onChain = vi.fn();
    const stop = subscribeProviderEvents({ onAccounts, onChain });
    listeners.get("accountsChanged")!(["0xABC"]);
    listeners.get("accountsChanged")!();
    listeners.get("chainChanged")!("0x38");
    expect(onAccounts.mock.calls).toEqual([[["0xabc"]], [[]]]);
    expect(onChain).toHaveBeenCalledWith(56);
    stop();
    expect(removeListener).toHaveBeenCalledTimes(2);
  });
  it("distinguishes empty accounts, explicit rejection and provider failure", async () => {
    const {
      connectWallet,
      personalSign,
      signTypedDataWithWallet,
      currentChainId,
      subscribeProviderEvents,
    } = await import("../src/lib/wallet.js");
    const request = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce({ code: 4001 })
      .mockRejectedValueOnce(new Error("offline"))
      .mockRejectedValueOnce("failed");
    use({ request });
    await expect(connectWallet()).rejects.toThrow("returned no account");
    await expect(connectWallet()).rejects.toMatchObject({
      rejectedByUser: true,
      code: 4001,
    });
    await expect(personalSign("m", "a")).rejects.toThrow("offline");
    await expect(signTypedDataWithWallet({}, "a")).rejects.toThrow("failed");
    expect(() =>
      subscribeProviderEvents({ onAccounts: vi.fn(), onChain: vi.fn() })(),
    ).not.toThrow();
    selectWallet(null);
    for (const operation of [
      () => connectWallet(),
      () => currentChainId(),
      () => personalSign("m", "a"),
      () => signTypedDataWithWallet({}, "a"),
      () => switchChain(56),
    ])
      await expect(operation()).rejects.toThrow("No browser wallet");
  });
});

it("requests wallet announcements after subscribing and deduplicates repeated providers", async () => {
  const { subscribeWallets, hasInjectedWallet } =
    await import("../src/lib/wallet.js");
  const events = new Map<string, (event: Event) => void>();
  const request = vi.fn();
  const onChange = vi.fn();
  const removeEventListener = vi.fn();
  const dispatchEvent = vi.fn(() => {
    expect(events.has("eip6963:announceProvider")).toBe(true);
    return true;
  });
  vi.stubGlobal("window", {
    addEventListener: (name: string, handler: (event: Event) => void) =>
      events.set(name, handler),
    removeEventListener,
    dispatchEvent,
    ethereum: { request },
  });
  const stop = subscribeWallets(onChange);
  const announce = events.get("eip6963:announceProvider")!;
  announce({ detail: {} } as unknown as Event);
  for (const name of ["Wallet", "Renamed wallet"])
    announce({
      detail: {
        info: { rdns: "wallet.test", name, icon: "" },
        provider: { request },
      },
    } as unknown as Event);
  expect(onChange.mock.calls.at(-1)?.[0]).toEqual([
    {
      id: "wallet.test",
      name: "Renamed wallet",
      icon: null,
      provider: { request },
    },
  ]);
  expect(hasInjectedWallet()).toBe(true);
  stop();
  expect(removeEventListener).toHaveBeenCalledWith(
    "eip6963:announceProvider",
    announce,
  );
  vi.stubGlobal("window", undefined);
  expect(() => subscribeWallets(onChange)()).not.toThrow();
  expect(hasInjectedWallet()).toBe(false);
});
