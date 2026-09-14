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
 * 지갑마다 다른 응답.
 *
 * 체인이 없을 때 지갑이 주는 응답이 제각각이다. 데스크톱 MetaMask는 4902,
 * MetaMask 모바일은 `-32603` 안에 싼 4902 또는 아예 코드 없음. 최상위 코드만 보던
 * 예전 코드는 모바일 사용자를 체인 추가 제안 없이 "전환 실패"에서 멈추게 했다.
 */

type Failure = { code?: number; data?: unknown; message: string };

/** 체인 목록을 갖는 가짜 지갑. `switchFailure`는 모르는 체인일 때 던지는 것이다. */
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
          // 추가만 하고 전환하지 않는 지갑이 있다.
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
  // wallet.ts는 `window`가 있을 때만 provider를 돌려준다.
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
  it("최상위 코드를 읽는다", () => {
    expect(rpcErrorCode({ code: 4902 })).toBe(4902);
    expect(rpcErrorCode({ code: 4001 })).toBe(4001);
  });

  it("MetaMask 모바일이 -32603 안에 싼 코드를 읽는다", () => {
    expect(rpcErrorCode({ code: -32603, data: { originalError: { code: 4902 } } })).toBe(4902);
  });

  it("싼 코드가 없으면 최상위를 그대로 준다", () => {
    expect(rpcErrorCode({ code: -32603 })).toBe(-32603);
  });

  it("코드가 없으면 undefined다", () => {
    expect(rpcErrorCode(new Error("no code"))).toBeUndefined();
    expect(rpcErrorCode(null)).toBeUndefined();
  });
});

describe("switchChain — 체인이 없는 지갑", () => {
  it("데스크톱 MetaMask(4902) — 추가를 제안하고 그 체인으로 간다", async () => {
    const wallet = fakeWallet({ start: 1 });
    use(wallet.provider);

    await switchChain(97);

    expect(wallet.calls).toContain("wallet_addEthereumChain");
    expect(wallet.chain()).toBe(97);
  });

  it("MetaMask 모바일(-32603 안의 4902) — 추가를 제안한다", async () => {
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

  it("코드 없이 실패하는 지갑 — 그래도 추가를 제안한다", async () => {
    const wallet = fakeWallet({ start: 1, switchFailure: () => ({ message: "Unrecognized chain ID" }) });
    use(wallet.provider);

    await switchChain(56);

    expect(wallet.calls).toContain("wallet_addEthereumChain");
    expect(wallet.chain()).toBe(56);
  });

  it("사용자가 거부하면 추가를 띄우지 않는다 — 거부는 선택이다", async () => {
    const wallet = fakeWallet({ start: 1, switchFailure: () => ({ code: 4001, message: "User rejected" }) });
    use(wallet.provider);

    const failure = await switchChain(97).catch((caught: unknown) => caught);

    expect(failure).toBeInstanceOf(WalletError);
    expect((failure as WalletError).rejectedByUser).toBe(true);
    // 감싸도 원래 코드가 남는다. 연결 기록이 이 값을 쓴다.
    expect((failure as WalletError).code).toBe(4001);
    expect(rpcErrorCode(failure)).toBe(4001);
    expect(wallet.calls).not.toContain("wallet_addEthereumChain");
  });

  it("추가만 하고 전환하지 않는 지갑 — 한 번 더 전환한다", async () => {
    const wallet = fakeWallet({ start: 1, addSwitches: false });
    use(wallet.provider);

    await switchChain(97);

    expect(wallet.calls.filter((method) => method === "wallet_switchEthereumChain")).toHaveLength(2);
    expect(wallet.chain()).toBe(97);
  });
});

describe("ensureChain", () => {
  it("이미 맞으면 전환을 요청하지 않는다", async () => {
    const wallet = fakeWallet({ start: 97 });
    use(wallet.provider);

    await expect(ensureChain(97)).resolves.toEqual({ before: 97, switched: false });
    expect(wallet.calls).not.toContain("wallet_switchEthereumChain");
  });

  it("다르면 전환하고 이전 체인을 알려 준다", async () => {
    const wallet = fakeWallet({ start: 1, known: [1, 56] });
    use(wallet.provider);

    await expect(ensureChain(56)).resolves.toEqual({ before: 1, switched: true });
  });
});

describe("walletFlags", () => {
  it("지갑이 켠 표시만 모은다 — 기록용이다", () => {
    const provider = { request: async () => null, isMetaMask: true, isBraveWallet: true, isTrust: false };
    expect(walletFlags(provider as unknown as Eip1193Provider)).toEqual(["isMetaMask", "isBraveWallet"]);
    expect(walletFlags(null)).toEqual([]);
  });
});
