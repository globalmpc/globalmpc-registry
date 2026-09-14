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
      const target = () => Number.parseInt((params?.[0] as { chainId: string }).chainId, 16);
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

    await switchChain(97);

    expect(wallet.calls).toContain("wallet_addEthereumChain");
    expect(wallet.chain()).toBe(97);
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

    const failure = await switchChain(97).catch((caught: unknown) => caught);

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

    await switchChain(97);

    expect(wallet.calls.filter((method) => method === "wallet_switchEthereumChain")).toHaveLength(2);
    expect(wallet.chain()).toBe(97);
  });
});

describe("ensureChain", () => {
  it("does not request a switch when already aligned", async () => {
    const wallet = fakeWallet({ start: 97 });
    use(wallet.provider);

    await expect(ensureChain(97)).resolves.toEqual({ before: 97, switched: false });
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
