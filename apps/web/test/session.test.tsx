// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import { SessionProvider, useSession, type TypedDataRequest } from "../src/lib/session";
import * as api from "../src/lib/api";
import * as wallet from "../src/lib/wallet";

vi.mock("../src/lib/api", () => ({
  getSession: vi.fn(),
  logout: vi.fn(),
  requestSiweNonce: vi.fn(),
  verifySiwe: vi.fn(),
}));
vi.mock("../src/lib/wallet", async (original) => ({
  ...(await original<typeof import("../src/lib/wallet")>()),
  connectWallet: vi.fn(),
  ensureChain: vi.fn(),
  getInjectedProvider: vi.fn(),
  hasInjectedWallet: vi.fn(),
  selectWallet: vi.fn(),
  subscribeWallets: vi.fn(),
  personalSign: vi.fn(),
  signTypedDataWithWallet: vi.fn(),
  subscribeProviderEvents: vi.fn(),
  walletFlags: vi.fn(),
}));

const address = "0x1234567890123456789012345678901234567890";
const request: TypedDataRequest = {
  domain: { name: "Registry", version: "1", chainId: 56 },
  types: {
    Review: [
      { name: "version", type: "uint256" },
      { name: "note", type: "string" },
    ],
  },
  primaryType: "Review",
  message: { version: "2", note: "checked" },
};
async function mount() {
  const hook = renderHook(() => useSession(), { wrapper: SessionProvider });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(api.getSession).mockResolvedValue({ authenticated: false, requestId: "test" });
  vi.mocked(api.logout).mockResolvedValue();
  vi.mocked(api.requestSiweNonce).mockResolvedValue({
    nonce: "abcdefgh12345678",
    domain: "localhost:3000",
    uri: "http://localhost:3000",
    chainId: 56,
    statement: "Sign in",
    expiresAt: "2030-01-01T00:00:00Z",
  });
  vi.mocked(api.verifySiwe).mockResolvedValue({
    sessionToken: "verified-token",
    verifiedWalletAddress: address,
    expiresAt: "2030-01-01T00:00:00Z",
  });
  vi.mocked(wallet.subscribeWallets).mockReturnValue(vi.fn());
  vi.mocked(wallet.subscribeProviderEvents).mockReturnValue(vi.fn());
  vi.mocked(wallet.walletFlags).mockReturnValue([]);
  vi.mocked(wallet.connectWallet).mockResolvedValue(address);
  vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 56, switched: false });
  vi.mocked(wallet.personalSign).mockResolvedValue("0xsigned");
});
afterEach(cleanup);

describe("session lifecycle", () => {
  it("restores the token and selected wallet after reload", async () => {
    localStorage.setItem("mpc.session.token", "stored-token");
    localStorage.setItem("mpc.session.wallet", address);
    localStorage.setItem("mpc.session.walletId", "chosen-wallet");
    const chosen = {
      id: "chosen-wallet",
      name: "Chosen",
      icon: "",
      provider: {},
    } as wallet.DiscoveredWallet;
    vi.mocked(wallet.subscribeWallets).mockImplementation((notify) => {
      notify([chosen]);
      return vi.fn();
    });
    const { result } = await mount();
    expect(api.getSession).toHaveBeenCalledWith("stored-token");
    expect(result.current.walletAddress).toBe(address);
    expect(wallet.selectWallet).toHaveBeenCalledWith(chosen);
    expect(result.current.walletAvailable).toBe(true);
  });

  it("tolerates corrupt diagnostic history and an expired session", async () => {
    sessionStorage.setItem("mpc.wallet.trace", "not JSON");
    vi.mocked(api.getSession).mockRejectedValue(new Error("expired"));
    const { result } = await mount();
    expect(result.current.session).toBeNull();
    expect(result.current.connectionLog).toEqual([]);
  });

  it("refreshes using the current token", async () => {
    localStorage.setItem("mpc.session.token", "existing");
    const { result } = await mount();
    await act(() => result.current.refresh());
    expect(api.getSession).toHaveBeenLastCalledWith("existing");
  });

  it("clears local credentials even when server logout fails", async () => {
    for (const key of ["token", "wallet", "account", "walletId"])
      localStorage.setItem(`mpc.session.${key}`, key);
    vi.mocked(api.logout).mockRejectedValue(new Error("offline"));
    const { result } = await mount();
    await act(() => result.current.signOut());
    expect(api.logout).toHaveBeenCalledWith("token");
    expect(localStorage.length).toBe(0);
    expect(result.current.token).toBeNull();
    expect(result.current.session).toBeNull();
    expect(result.current.walletAddress).toBeNull();
  });

  it("rejects signing while disconnected", async () => {
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).rejects.toThrow("No account is connected");
  });

  it("requires a provider context", () => {
    expect(() => renderHook(() => useSession())).toThrow("inside SessionProvider");
  });
});

describe("wallet authentication", () => {
  it("signs the server's SIWE challenge and stores only the verified session", async () => {
    vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 1, switched: true });
    const { result } = await mount();
    await act(async () => expect(await result.current.signInWithWallet()).toBe(true));
    const message = vi.mocked(wallet.personalSign).mock.calls[0]![0];
    expect(message).toContain("Chain ID: 56");
    expect(message).toContain("URI: http://localhost:3000");
    expect(api.verifySiwe).toHaveBeenCalledWith(message, "0xsigned");
    expect(result.current.token).toBe("verified-token");
    expect(localStorage.getItem("mpc.session.wallet")).toBe(address);
    expect(result.current.connectionLog.at(-1)?.step).toBe("session");
  });

  it("allows login when a wallet cannot switch chain", async () => {
    vi.mocked(wallet.ensureChain).mockRejectedValue(new Error("unsupported network"));
    const { result } = await mount();
    await act(async () => expect(await result.current.signInWithWallet()).toBe(true));
    expect(result.current.connectionLog.some((step) => step.detail.includes("not switched"))).toBe(
      true,
    );
  });

  it("does not save a token when server verification fails", async () => {
    vi.mocked(api.verifySiwe).mockRejectedValue(new Error("invalid signature"));
    const { result } = await mount();
    await act(async () => expect(await result.current.signInWithWallet()).toBe(false));
    expect(result.current.error).toBe("invalid signature");
    expect(result.current.signingIn).toBe(false);
    expect(localStorage.getItem("mpc.session.token")).toBeNull();
  });

  it("explains wallet rejection without navigating to a workspace", async () => {
    vi.mocked(wallet.connectWallet).mockRejectedValue(
      new wallet.WalletError("Rejected", true, 4001),
    );
    const { result } = await mount();
    await act(async () => expect(await result.current.signInWithWallet()).toBe(false));
    expect(result.current.error).toMatch(/rejected the request/);
    expect(api.verifySiwe).not.toHaveBeenCalled();
  });

  it("switches to the typed-data chain before asking the wallet to sign", async () => {
    localStorage.setItem("mpc.session.wallet", address);
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xtyped");
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).resolves.toBe("0xtyped");
    expect(wallet.ensureChain).toHaveBeenCalledWith(56);
    expect(wallet.signTypedDataWithWallet).toHaveBeenCalledWith(request, address);
  });

  it("blocks typed-data signing on chain-switch failure", async () => {
    localStorage.setItem("mpc.session.wallet", address);
    vi.mocked(wallet.ensureChain).mockRejectedValue(new Error("unsupported"));
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).rejects.toThrow(
      "Switch the wallet to chain 56",
    );
    expect(wallet.signTypedDataWithWallet).not.toHaveBeenCalled();
  });

  it("invalidates the session when the connected account changes", async () => {
    localStorage.setItem("mpc.session.token", "existing");
    localStorage.setItem("mpc.session.wallet", address);
    const { result } = await mount();
    const events = vi.mocked(wallet.subscribeProviderEvents).mock.calls.at(-1)![0];
    await act(async () => {
      events.onAccounts([]);
    });
    expect(result.current.token).toBeNull();
    expect(result.current.error).toContain("wallet disconnected");
  });

  it("keeps the session for the same account and records chain changes", async () => {
    localStorage.setItem("mpc.session.token", "existing");
    localStorage.setItem("mpc.session.wallet", address);
    const { result } = await mount();
    const events = vi.mocked(wallet.subscribeProviderEvents).mock.calls.at(-1)![0];
    await act(async () => {
      events.onAccounts([address]);
      events.onChain(97);
    });
    expect(result.current.token).toBe("existing");
    expect(result.current.connectionLog.at(-1)).toMatchObject({
      step: "chainChanged",
      detail: "97",
    });
  });
});

describe("demo signing", () => {
  it("uses a real SIWE signature and preserves integer fields in typed-data signing", async () => {
    const demo = { label: "Ephemeral", description: "test", privateKey: generatePrivateKey() };
    const { result } = await mount();
    await act(async () => expect(await result.current.signIn(demo)).toBe(true));
    expect(result.current.account).toEqual(demo);
    expect(result.current.walletAddress).toBeNull();
    expect(api.requestSiweNonce).toHaveBeenCalledWith(
      privateKeyToAccount(demo.privateKey).address.toLowerCase(),
    );
    const signature = await result.current.signTypedData(request);
    const recovered = await recoverTypedDataAddress({
      ...request,
      message: { version: 2n, note: "checked" },
      signature: signature as `0x${string}`,
    });
    expect(recovered).toBe(privateKeyToAccount(demo.privateKey).address);
  });

  it("keeps the user signed out on nonce failure", async () => {
    vi.mocked(api.requestSiweNonce).mockRejectedValue(new Error("nonce unavailable"));
    const { result } = await mount();
    await act(async () =>
      expect(
        await result.current.signIn({
          label: "Ephemeral",
          description: "test",
          privateKey: generatePrivateKey(),
        }),
      ).toBe(false),
    );
    expect(result.current.error).toBe("nonce unavailable");
    expect(result.current.account).toBeNull();
    expect(result.current.signingIn).toBe(false);
  });
});

describe("wallet recovery boundaries", () => {
  it("preserves a user's rejection when switching chain for a signature", async () => {
    localStorage.setItem("mpc.session.wallet", address);
    const rejection = new wallet.WalletError("User declined chain switch", true, 4001);
    vi.mocked(wallet.ensureChain).mockRejectedValue(rejection);
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).rejects.toBe(rejection);
    expect(wallet.signTypedDataWithWallet).not.toHaveBeenCalled();
  });

  it("discards a login's stored wallet selection when no wallet was chosen", async () => {
    localStorage.setItem("mpc.session.walletId", "stale-wallet");
    localStorage.setItem("mpc.session.account", "old-demo");
    const { result } = await mount();
    await act(() => result.current.signInWithWallet());
    expect(localStorage.getItem("mpc.session.walletId")).toBeNull();
    expect(localStorage.getItem("mpc.session.account")).toBeNull();
  });

  it("unsubscribes wallet discovery and provider events when unmounted", async () => {
    localStorage.setItem("mpc.session.wallet", address);
    const stopDiscovery = vi.fn();
    const stopEvents = vi.fn();
    vi.mocked(wallet.subscribeWallets).mockReturnValue(stopDiscovery);
    vi.mocked(wallet.subscribeProviderEvents).mockReturnValue(stopEvents);
    const hook = await mount();
    hook.unmount();
    expect(stopDiscovery).toHaveBeenCalledOnce();
    expect(stopEvents).toHaveBeenCalledOnce();
  });
});
