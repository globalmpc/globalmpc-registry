// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isAccountSession,
  needsSecondFactor,
  SessionProvider,
  useSession,
  type TypedDataRequest,
} from "../src/lib/session";
import * as api from "../src/lib/api";
import * as accountApi from "../src/lib/account-api";
import * as wallet from "../src/lib/wallet";

vi.mock("../src/lib/api", () => ({
  SESSION_MARKER: "cookie-session",
  getSession: vi.fn(),
  logout: vi.fn(),
}));
vi.mock("../src/lib/account-api", () => ({ listWallets: vi.fn() }));
vi.mock("../src/lib/wallet", async (original) => ({
  ...(await original<typeof import("../src/lib/wallet")>()),
  connectWallet: vi.fn(),
  ensureChain: vi.fn(),
  subscribeWallets: vi.fn(),
  signTypedDataWithWallet: vi.fn(),
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
const signedOut = { authenticated: false, requestId: "test" } as const;
const accountSession = {
  authenticated: true,
  requestId: "test",
  subjectId: "person",
  tenantId: "tenant",
  firstFactor: "email_code",
  secondFactor: "totp",
  aal: "aal2",
  mfaSatisfied: true,
} as api.SessionInfo;
const boundWallet = (overrides: Partial<accountApi.AccountWallet> = {}): accountApi.AccountWallet => ({
  id: "w",
  walletAddress: address.toUpperCase().replace("0X", "0x"),
  chainId: 56,
  boundVia: "proof",
  boundAt: "2026-11-01T00:00:00Z",
  disabledAt: null,
  ...overrides,
});

async function mount() {
  const hook = renderHook(() => useSession(), { wrapper: SessionProvider });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  vi.mocked(api.getSession).mockResolvedValue(signedOut);
  vi.mocked(api.logout).mockResolvedValue();
  vi.mocked(wallet.subscribeWallets).mockReturnValue(vi.fn());
  vi.mocked(wallet.connectWallet).mockResolvedValue(address);
  vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 56, switched: false });
  vi.mocked(accountApi.listWallets).mockResolvedValue({ items: [boundWallet()] });
});
afterEach(cleanup);

describe("session lifecycle (cookie session, WP6)", () => {
  it("reads the session from the cookie and removes what older builds left in storage", async () => {
    // The token before WP6, and the demo account, wallet, extension and trace of the wallet
    // sign-in WP7 removed.
    for (const key of ["token", "wallet", "account", "walletId"]) localStorage.setItem(`mpc.session.${key}`, key);
    sessionStorage.setItem("mpc.wallet.trace", "[]");
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    const chosen = { id: "chosen-wallet", name: "Chosen", icon: "", provider: {} } as wallet.DiscoveredWallet;
    vi.mocked(wallet.subscribeWallets).mockImplementation((notify) => {
      notify([chosen]);
      return vi.fn();
    });
    const { result } = await mount();
    // No credential is handed to the client: the web server attaches the cookie.
    expect(api.getSession).toHaveBeenCalledWith(null);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(result.current.token).toBe("cookie-session");
    expect(result.current.wallets).toEqual([chosen]);
  });

  it("still loads when storage is blocked", async () => {
    const blocked = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    const { result } = await mount();
    expect(result.current.session).toEqual(accountSession);
    blocked.mockRestore();
  });

  it("has no session marker while signed out", async () => {
    const { result } = await mount();
    expect(result.current.token).toBeNull();
  });

  it("treats an expired session as signed out", async () => {
    vi.mocked(api.getSession).mockRejectedValue(new Error("expired"));
    const { result } = await mount();
    expect(result.current.session).toBeNull();
    expect(result.current.token).toBeNull();
  });

  it("refreshes and returns the new session — after a second factor the level is read again", async () => {
    const { result } = await mount();
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    let next: api.SessionInfo | null = null;
    await act(async () => {
      next = await result.current.refresh();
    });
    expect(next).toEqual(accountSession);
    expect(result.current.token).toBe("cookie-session");
  });

  it("keeps the screen during a later read instead of going back to loading", async () => {
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    const { result } = await mount();
    let release: (value: api.SessionInfo) => void = () => undefined;
    vi.mocked(api.getSession).mockImplementation(() => new Promise((resolve) => (release = resolve)));
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = result.current.refresh();
    });
    // The workspace gate would swap the page out on `loading`, dropping state shown once.
    expect(result.current.loading).toBe(false);
    expect(result.current.session).toEqual(accountSession);
    await act(async () => {
      release({ ...accountSession, aal: "aal3" });
      await pending;
    });
    expect(result.current.session?.aal).toBe("aal3");
  });

  it("clears local state even when server logout fails", async () => {
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    vi.mocked(api.logout).mockRejectedValue(new Error("offline"));
    const { result } = await mount();
    await act(() => result.current.signOut());
    expect(api.logout).toHaveBeenCalledWith();
    expect(result.current.token).toBeNull();
    expect(result.current.session).toBeNull();
  });

  it("rejects signing while signed out", async () => {
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).rejects.toThrow("No account is signed in");
    expect(wallet.connectWallet).not.toHaveBeenCalled();
  });

  it("unsubscribes wallet discovery when unmounted", async () => {
    const stopDiscovery = vi.fn();
    vi.mocked(wallet.subscribeWallets).mockReturnValue(stopDiscovery);
    const hook = await mount();
    hook.unmount();
    expect(stopDiscovery).toHaveBeenCalledOnce();
  });

  it("requires a provider context", () => {
    expect(() => renderHook(() => useSession())).toThrow("inside SessionProvider");
  });
});

describe("session kinds", () => {
  it("counts only a signed-in session with a first factor as an account session", () => {
    expect(isAccountSession(accountSession)).toBe(true);
    // The server issues no session without a first factor since WP7 removed the wallet sign-in;
    // one that claims to be signed in without it is not trusted as an account.
    expect(isAccountSession({ ...accountSession, firstFactor: null })).toBe(false);
    expect(isAccountSession(null)).toBe(false);
    expect(isAccountSession(signedOut as api.SessionInfo)).toBe(false);
  });

  it("owes a second factor at aal1 or after a recovery code, not otherwise", () => {
    expect(needsSecondFactor({ ...accountSession, aal: "aal1" })).toBe(true);
    expect(needsSecondFactor({ ...accountSession, recoveryLimited: true })).toBe(true);
    expect(needsSecondFactor(accountSession)).toBe(false);
    expect(needsSecondFactor(null)).toBe(false);
  });
});

describe("wallet only at signing (account sessions, WP5/WP6)", () => {
  it("connects the wallet at the moment of signing and signs with a key bound on this chain", async () => {
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xtyped");
    const { result } = await mount();
    expect(wallet.connectWallet).not.toHaveBeenCalled();
    await expect(result.current.signTypedData(request)).resolves.toBe("0xtyped");
    expect(wallet.connectWallet).toHaveBeenCalledOnce();
    expect(accountApi.listWallets).toHaveBeenCalledOnce();
    expect(wallet.ensureChain).toHaveBeenCalledWith(56);
    expect(wallet.signTypedDataWithWallet).toHaveBeenCalledWith(request, address);
  });

  it.each([
    ["not bound at all", []],
    ["bound on another chain", [boundWallet({ chainId: 97 })]],
    ["disabled", [boundWallet({ disabledAt: "2026-11-01T00:00:00Z" })]],
    ["a different address", [boundWallet({ walletAddress: "0x9999999999999999999999999999999999999999" })]],
  ])("refuses before the wallet opens when the connected key is %s", async (_case, items) => {
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    vi.mocked(accountApi.listWallets).mockResolvedValue({ items });
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).rejects.toThrow("is not bound to your account");
    expect(wallet.signTypedDataWithWallet).not.toHaveBeenCalled();
  });

  it("accepts a bound key on any chain when the request names none", async () => {
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    vi.mocked(accountApi.listWallets).mockResolvedValue({ items: [boundWallet({ chainId: 97 })] });
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xtyped");
    const { result } = await mount();
    const noChain = { ...request, domain: { name: "Registry", version: "1" } };
    await expect(result.current.signTypedData(noChain)).resolves.toBe("0xtyped");
    expect(wallet.ensureChain).not.toHaveBeenCalled();
  });

  it("blocks typed-data signing on chain-switch failure", async () => {
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    vi.mocked(wallet.ensureChain).mockRejectedValue(new Error("unsupported"));
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).rejects.toThrow("Switch the wallet to chain 56");
    expect(wallet.signTypedDataWithWallet).not.toHaveBeenCalled();
  });

  it("preserves a user's rejection when switching chain for a signature", async () => {
    vi.mocked(api.getSession).mockResolvedValue(accountSession);
    const rejection = new wallet.WalletError("User declined chain switch", true, 4001);
    vi.mocked(wallet.ensureChain).mockRejectedValue(rejection);
    const { result } = await mount();
    await expect(result.current.signTypedData(request)).rejects.toBe(rejection);
    expect(wallet.signTypedDataWithWallet).not.toHaveBeenCalled();
  });
});
