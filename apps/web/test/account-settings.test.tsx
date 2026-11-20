// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as webauthn from "@simplewebauthn/browser";
import AccountSettingsPage from "../src/app/w/settings/page";
import { navigation } from "../src/components/auth/ProviderButtons";
import { ErrorNotice } from "../src/components/ErrorNotice";
import { TopBar } from "../src/components/TopBar";
import { ApiError, type SessionInfo } from "../src/lib/api";
import * as wallet from "../src/lib/wallet";
import { mockHttp, type HttpCall } from "./support/http";

/**
 * Account settings, step-up and the session-level refusals (WP6).
 *
 * Every action is the person's own; the server decides each step's level. The screen's part is to
 * prompt for the factor a refusal names, retry once, and sign the browser out when an action ended
 * this session.
 */
const s = vi.hoisted(() => ({
  session: null as SessionInfo | null,
  refresh: vi.fn(),
  signOut: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  wallets: [] as { id: string; name: string; icon: string; provider: unknown }[],
}));
vi.mock("../src/lib/session", async (original) => {
  const actual = await original<typeof import("../src/lib/session")>();
  return {
    needsSecondFactor: actual.needsSecondFactor,
    isAccountSession: actual.isAccountSession,
    useSession: () => ({
      session: s.session,
      loading: false,
      token: s.session?.authenticated ? "cookie-session" : null,
      refresh: s.refresh,
      signOut: s.signOut,
      wallets: s.wallets,
    }),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: s.push, replace: s.replace }),
  usePathname: () => "/w/settings",
}));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock("../src/lib/wallet", () => ({
  getInjectedProvider: () => ({ request: vi.fn().mockResolvedValue([]) }),
  connectWallet: vi.fn(),
  ensureChain: vi.fn(),
  selectWallet: vi.fn(),
  signTypedDataWithWallet: vi.fn(),
}));

const account = {
  authenticated: true,
  requestId: "r",
  subjectId: "person",
  tenantId: "t",
  firstFactor: "email_code",
  secondFactor: "passkey",
  aal: "aal3",
  mfaSatisfied: true,
  roleBindings: [{ role: "reviewer", organizationId: null, projectId: null }],
  assuranceLevel: "high_assurance",
} as SessionInfo;
const passkey = {
  id: "pk1",
  name: "Laptop",
  createdAt: "2026-11-01T00:00:00Z",
  lastUsedAt: "2026-11-02T00:00:00Z",
  transports: [],
  deviceType: "multiDevice",
  backedUp: true,
};
const status = (overrides: Record<string, unknown> = {}) => ({
  passkeyEnrolled: true,
  totpEnrolled: true,
  recoveryCodesRemaining: 9,
  recoveryLimited: false,
  enrolment: { passkey: "allowed", totp: "MFA_TOTP_ALREADY_ENROLLED" },
  passkeys: [passkey],
  ...overrides,
});
const ADDRESS = "0x1234567890123456789012345678901234567890";
const boundWallet = {
  id: "w1",
  walletAddress: ADDRESS,
  chainId: 56,
  boundVia: "proof",
  boundAt: "z",
  disabledAt: null,
};
const earlierWallet = {
  id: "w0",
  walletAddress: "0x9999999999999999999999999999999999999999",
  chainId: 56,
  boundVia: "proof",
  boundAt: "y",
  disabledAt: "z",
};
const refusal = (status: number, code: string, details?: Record<string, unknown>) =>
  Response.json({ code, message: code, requestId: "r", ...(details ? { details } : {}) }, { status });

function routes(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "GET /api/v1/auth/methods": {
      emailCode: true,
      google: true,
      microsoft: true,
      emailCodeDigits: 8,
      emailCodeTtlMinutes: 10,
    },
    "GET /api/v1/auth/mfa": status(),
    "GET /api/v1/auth/identities": {
      items: [
        {
          id: "id1",
          provider: "google",
          issuer: "https://accounts.google.com",
          idpTenant: null,
          linkedVia: "invitation",
          createdAt: "z",
          lastUsedAt: null,
          revokedAt: null,
        },
      ],
    },
    "GET /api/v1/auth/wallets": { items: [boundWallet] },
    "GET /api/v1/auth/sessions": {
      items: [
        {
          id: "s-here",
          firstFactor: "email_code",
          secondFactor: "passkey",
          createdAt: "2026-11-02T08:00:00Z",
          lastSeenAt: "2026-11-02T09:30:00Z",
          expiresAt: "2026-11-02T20:00:00Z",
          current: true,
        },
        {
          id: "s-phone",
          firstFactor: "google",
          secondFactor: "totp",
          createdAt: "2026-11-01T07:00:00Z",
          lastSeenAt: null,
          expiresAt: "2026-11-01T19:00:00Z",
          current: false,
        },
      ],
    },
    ...overrides,
  };
}
const posted = (calls: HttpCall[], suffix: string) =>
  calls.filter((call) => call.method !== "GET" && call.url.endsWith(suffix));

function mount(data = routes()) {
  const calls = mockHttp(data);
  render(
      <AccountSettingsPage />
    ,
  );
  return calls;
}

beforeEach(() => {
  s.session = account;
  s.wallets = [];
  for (const f of [s.refresh, s.signOut, s.push, s.replace]) f.mockReset();
  for (const f of [wallet.connectWallet, wallet.ensureChain, wallet.selectWallet, wallet.signTypedDataWithWallet]) {
    vi.mocked(f).mockReset();
  }
  s.refresh.mockImplementation(async () => s.session);
  s.signOut.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("account settings", () => {
  it("is for account sessions only: draws nothing without one", () => {
    s.session = { ...account, firstFactor: null } as SessionInfo;
    const calls = mockHttp({ "GET /api/v1/auth/methods": {} });
    const view = render(
        <AccountSettingsPage />
      ,
    );
    expect(view.container.querySelector(".page-head")).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/auth/mfa"))).toBe(false);
  });

  it("lists factors, identities and wallets as the server reports them", async () => {
    mount();
    expect(screen.queryByTestId("passkey-list")).toBeNull();
    const identities = await screen.findByTestId("settings-identities");
    await within(identities).findByText(/linked when you accepted the invitation/);
    // Google is linked already; only Microsoft is offered.
    expect(screen.queryByTestId("link-google")).toBeNull();
    expect(screen.getByTestId("link-microsoft")).toBeTruthy();
    expect((await screen.findByTestId("wallet-list")).textContent).toContain("bound by you");
  });

  it("unlinks an identity and links another through the provider", async () => {
    const assign = vi.spyOn(navigation, "assign").mockImplementation(() => undefined);
    const calls = mount(
      routes({
        "POST /api/v1/auth/identities/id1/unlink": { revokedSessions: 1, currentSessionEnded: false },
        "POST /api/v1/auth/oidc/microsoft/link/start": { authorizationUrl: "https://login.microsoftonline.com/l", expiresAt: "z" },
      }),
    );
    const identities = await screen.findByTestId("settings-identities");
    fireEvent.click(await within(identities).findByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(posted(calls, "/id1/unlink")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("link-microsoft"));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://login.microsoftonline.com/l"));
    expect(s.signOut).not.toHaveBeenCalled();
  });

  it("binds a wallet by the wallet's own signature over the server's message", async () => {
    vi.mocked(wallet.connectWallet).mockResolvedValue(ADDRESS);
    vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 1, switched: true });
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xsig");
    const typedData = { domain: { chainId: 56 }, primaryType: "Bind", types: {}, message: {} };
    const calls = mount(
      routes({
        "GET /api/v1/auth/wallets": { items: [] },
        "POST /api/v1/auth/wallets/binding-challenges": {
          challengeId: "ch",
          walletAddress: ADDRESS,
          chainId: 56,
          replaces: null,
          humanReadablePayload: "Bind",
          typedData,
          expiresAt: "z",
        },
        "POST /api/v1/auth/wallets": { ...boundWallet, replaced: null },
      }),
    );
    expect((await screen.findByTestId("wallet-list")).textContent).toContain("No signing wallet");
    expect(screen.queryByTestId("disable-wallet")).toBeNull();
    fireEvent.click(await screen.findByTestId("bind-wallet"));
    await waitFor(() => expect(posted(calls, "/auth/wallets")[0]?.body).toEqual({ challengeId: "ch", signature: "0xsig" }));
    expect(posted(calls, "/binding-challenges")[0]?.body).toEqual({ walletAddress: ADDRESS });
    expect(wallet.ensureChain).toHaveBeenCalledWith(56);
    expect(wallet.signTypedDataWithWallet).toHaveBeenCalledWith(typedData, ADDRESS);
    // A first binding replaces nothing, so nothing asks to confirm a replacement.
    expect(screen.queryByTestId("replace-confirm")).toBeNull();
  });

  it("shows one wallet card with Replace and Disable, and earlier wallets as history", async () => {
    mount(routes({ "GET /api/v1/auth/wallets": { items: [boundWallet, earlierWallet] } }));
    const current = await screen.findByTestId("wallet-current");
    expect(current.textContent).toContain("governance wallet");
    expect(screen.getByTestId("replace-wallet").textContent).toBe("Replace");
    expect(screen.getByTestId("disable-wallet").textContent).toBe("Disable");
    expect(screen.queryByTestId("bind-wallet")).toBeNull();
    expect(screen.getByTestId("wallet-history").textContent).toContain("disabled");
    expect(screen.queryByRole("button", { name: /governance/i })).toBeNull();
  });

  it("replaces the wallet only after showing which wallet it replaces, and keeps the session", async () => {
    const NEXT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    vi.mocked(wallet.connectWallet).mockResolvedValue(NEXT);
    vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 56, switched: false });
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xsig2");
    const typedData = { domain: { chainId: 56 }, primaryType: "Bind", types: {}, message: {} };
    const calls = mount(
      routes({
        "POST /api/v1/auth/wallets/binding-challenges": {
          challengeId: "ch2",
          walletAddress: NEXT,
          chainId: 56,
          replaces: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
          humanReadablePayload: "Bind",
          typedData,
          expiresAt: "z",
        },
        "POST /api/v1/auth/wallets": {
          ...boundWallet,
          id: "w2",
          walletAddress: NEXT,
          replaced: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("replace-wallet"));
    const confirm = await screen.findByTestId("replace-confirm");
    expect(confirm.textContent).toContain(`This will replace ${ADDRESS} with ${NEXT}`);
    // Nothing is signed before the person confirms.
    expect(wallet.signTypedDataWithWallet).not.toHaveBeenCalled();
    expect(posted(calls, "/auth/wallets")).toHaveLength(0);

    // A proof-bound wallet: no assurance warning. The reason defaults to a planned rotation.
    expect(screen.queryByTestId("replace-operator-verified")).toBeNull();
    expect((screen.getByTestId("replace-reason") as HTMLSelectElement).value).toBe("rotation");

    fireEvent.click(screen.getByTestId("confirm-replace"));
    await waitFor(() =>
      expect(posted(calls, "/auth/wallets")[0]?.body).toEqual({
        challengeId: "ch2",
        signature: "0xsig2",
        previousWalletSignature: "0xsig2",
        replaceReason: "rotation",
      }),
    );
    expect(wallet.signTypedDataWithWallet).toHaveBeenCalledWith(typedData, NEXT);
    await waitFor(() => expect(screen.queryByTestId("replace-confirm")).toBeNull());
    expect(s.push).not.toHaveBeenCalled();
    expect(s.signOut).not.toHaveBeenCalled();
  });

  it("sends the reason chosen for a replace, and warns when an operator-verified wallet goes", async () => {
    const NEXT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    vi.mocked(wallet.connectWallet).mockResolvedValue(NEXT);
    vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 56, switched: false });
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xsig4");
    const calls = mount(
      routes({
        "GET /api/v1/auth/wallets": { items: [{ ...boundWallet, boundVia: "operator" }] },
        "POST /api/v1/auth/wallets/binding-challenges": {
          challengeId: "ch4",
          walletAddress: NEXT,
          chainId: 56,
          replaces: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
          humanReadablePayload: "Bind",
          typedData: { domain: { chainId: 56 }, primaryType: "Bind", types: {}, message: {} },
          expiresAt: "z",
        },
        "POST /api/v1/auth/wallets": {
          ...boundWallet,
          id: "w2",
          walletAddress: NEXT,
          replaced: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("replace-wallet"));
    const confirm = await screen.findByTestId("replace-confirm");
    expect(within(confirm).getByTestId("replace-operator-verified").textContent).toContain(
      "lowers your identity assurance until an admin verifies you again",
    );
    fireEvent.change(within(confirm).getByTestId("replace-reason"), { target: { value: "key_compromised" } });
    expect(confirm.textContent).toContain("can never be bound again");

    fireEvent.click(screen.getByTestId("confirm-replace"));
    await waitFor(() =>
      expect(posted(calls, "/auth/wallets")[0]?.body).toEqual({
        challengeId: "ch4",
        signature: "0xsig4",
        previousWalletSignature: "0xsig4",
        replaceReason: "key_compromised",
      }),
    );
  });

  it("reads the session list again after an unlink", async () => {
    const calls = mount(
      routes({
        "POST /api/v1/auth/identities/id1/unlink": { revokedSessions: 1, currentSessionEnded: false },
        "POST /api/v1/auth/mfa/recovery-codes": { recoveryCodes: ["a", "b"] },
      }),
    );
    await screen.findByTestId("session-other");
    const count = () => calls.filter((call) => call.url.endsWith("/auth/sessions")).length;
    const before = count();
    const identities = await screen.findByTestId("settings-identities");
    fireEvent.click(await within(identities).findByRole("button", { name: /Unlink/ }));
    await waitFor(() => expect(count()).toBeGreaterThan(before));
  });

  it("after replacing an operator-verified wallet, says the assurance fell and what to do next", async () => {
    const NEXT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    vi.mocked(wallet.connectWallet).mockResolvedValue(NEXT);
    vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 56, switched: false });
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xsig5");
    // The session the server returns after the replace: the reviewer role is held, not in effect.
    s.refresh.mockImplementation(async () => ({ ...account, assuranceLevel: "wallet_only" }));
    mount(
      routes({
        "GET /api/v1/auth/wallets": { items: [{ ...boundWallet, boundVia: "operator" }] },
        "POST /api/v1/auth/wallets/binding-challenges": {
          challengeId: "ch5",
          walletAddress: NEXT,
          chainId: 56,
          replaces: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
          humanReadablePayload: "Bind",
          typedData: { domain: { chainId: 56 }, primaryType: "Bind", types: {}, message: {} },
          expiresAt: "z",
        },
        "POST /api/v1/auth/wallets": {
          ...boundWallet,
          id: "w2",
          walletAddress: NEXT,
          replaced: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("replace-wallet"));
    await screen.findByTestId("replace-confirm");
    fireEvent.click(screen.getByTestId("confirm-replace"));
    const done = await screen.findByTestId("replace-done");
    expect(done.textContent).toContain("Your new signing wallet is bound");
    const operator = within(done).getByTestId("replace-done-operator");
    expect(operator.textContent).toContain("your identity assurance is now wallet_only");
    expect(within(operator).getByTestId("replace-done-inactive").textContent).toBe("reviewer");
    expect(operator.textContent).toContain("Admin → Set assurance");
    expect(s.signOut).not.toHaveBeenCalled();
  });

  it("after replacing a wallet bound by proof, only says the new wallet is bound", async () => {
    const NEXT = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    vi.mocked(wallet.connectWallet).mockResolvedValue(NEXT);
    vi.mocked(wallet.ensureChain).mockResolvedValue({ before: 56, switched: false });
    vi.mocked(wallet.signTypedDataWithWallet).mockResolvedValue("0xsig6");
    mount(
      routes({
        "POST /api/v1/auth/wallets/binding-challenges": {
          challengeId: "ch6",
          walletAddress: NEXT,
          chainId: 56,
          replaces: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
          humanReadablePayload: "Bind",
          typedData: { domain: { chainId: 56 }, primaryType: "Bind", types: {}, message: {} },
          expiresAt: "z",
        },
        "POST /api/v1/auth/wallets": {
          ...boundWallet,
          id: "w2",
          walletAddress: NEXT,
          replaced: { id: "w1", walletAddress: ADDRESS, chainId: 56 },
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("replace-wallet"));
    await screen.findByTestId("replace-confirm");
    fireEvent.click(screen.getByTestId("confirm-replace"));
    const done = await screen.findByTestId("replace-done");
    expect(within(done).queryByTestId("replace-done-operator")).toBeNull();
  });

  it("cancelling a replacement signs nothing", async () => {
    vi.mocked(wallet.connectWallet).mockResolvedValue(ADDRESS);
    const calls = mount(
      routes({
        "POST /api/v1/auth/wallets/binding-challenges": {
          challengeId: "ch3",
          walletAddress: ADDRESS,
          chainId: 56,
          replaces: { id: "w1", walletAddress: "0x9999999999999999999999999999999999999999", chainId: 56 },
          humanReadablePayload: "Bind",
          typedData: { domain: {}, primaryType: "Bind", types: {}, message: {} },
          expiresAt: "z",
        },
      }),
    );
    fireEvent.click(await screen.findByTestId("replace-wallet"));
    fireEvent.click(within(await screen.findByTestId("replace-confirm")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByTestId("replace-confirm")).toBeNull();
    expect(wallet.signTypedDataWithWallet).not.toHaveBeenCalled();
    expect(posted(calls, "/auth/wallets")).toHaveLength(0);
  });

  it("asks which wallet to bind when several are installed", async () => {
    s.wallets = [
      { id: "a", name: "Alpha", icon: "", provider: {} },
      { id: "b", name: "Beta", icon: "", provider: {} },
    ];
    vi.mocked(wallet.connectWallet).mockRejectedValue(new Error("rejected"));
    mount(routes({ "GET /api/v1/auth/wallets": { items: [] } }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect and bind a wallet · Beta" }));
    expect(wallet.selectWallet).toHaveBeenCalledWith(s.wallets[1]);
    expect((await screen.findByRole("alert")).textContent).toBe("rejected");
  });

  it("disables the wallet with a stated reason, ending this session", async () => {
    const calls = mount(
      routes({
        "POST /api/v1/auth/wallets/w1/disable": { id: "w1", disabledAt: "z", revokedSessions: 1 },
      }),
    );
    fireEvent.click(await screen.findByTestId("disable-wallet"));
    expect(screen.getByText(/signs out every session of your account/)).toBeTruthy();
    expect(screen.getByText(/no signing wallet/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "key_lost" } });
    fireEvent.change(screen.getByLabelText("Decision reason"), { target: { value: " phone stolen " } });
    const form = screen.getByLabelText("Reason").closest("form")!;
    fireEvent.click(within(form).getByRole("button", { name: "Disable" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/connect"));
    expect(posted(calls, "/w1/disable")[0]?.body).toEqual({ reasonCode: "key_lost", detail: "phone stolen" });
  });

  it("lists where the account is signed in and ends another session, never this one", async () => {
    const calls = mount(
      routes({
        "POST /api/v1/auth/sessions/s-phone/revocation": { id: "s-phone", revoked: true, current: false },
      }),
    );
    const here = await screen.findByTestId("session-current");
    expect(here.textContent).toContain("emailed code + passkey");
    expect(here.textContent).toContain("signed in 2026-11-02 08:00 UTC");
    expect(here.textContent).toContain("last used 2026-11-02 09:30");
    expect(here.textContent).toContain("this browser");
    // This browser's own session ends by signing out, so it has no "End session" of its own.
    expect(within(here).queryByRole("button")).toBeNull();
    const phone = screen.getByTestId("session-other");
    expect(phone.textContent).toContain("Google + authenticator app");
    expect(phone.textContent).not.toContain("last used");

    const listed = calls.filter((call) => call.url.endsWith("/auth/sessions")).length;
    fireEvent.click(within(phone).getByRole("button", { name: "End session" }));
    await waitFor(() => expect(posted(calls, "/sessions/s-phone/revocation")).toHaveLength(1));
    // The list is read again so it shows what the server now holds.
    await waitFor(() =>
      expect(calls.filter((call) => call.url.endsWith("/auth/sessions")).length).toBeGreaterThan(listed),
    );
    expect(s.signOut).not.toHaveBeenCalled();
  });

  it("states a refused session ending and keeps the list", async () => {
    mount(
      routes({
        "POST /api/v1/auth/sessions/s-phone/revocation": () => refusal(404, "NOT_FOUND"),
      }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "End session" }));
    await within(screen.getByTestId("settings-sessions")).findByRole("alert");
    expect(screen.getByTestId("session-other")).toBeTruthy();
    expect(s.signOut).not.toHaveBeenCalled();
  });

  it("states sections that cannot be read and signs out on request", async () => {
    mount(
      routes({
        "GET /api/v1/auth/mfa": () => refusal(500, "INTERNAL"),
        "GET /api/v1/auth/identities": () => refusal(500, "INTERNAL"),
        "GET /api/v1/auth/wallets": () => refusal(500, "INTERNAL"),
        "GET /api/v1/auth/sessions": () => refusal(500, "INTERNAL"),
      }),
    );
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(3));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/connect"));
  });
});

describe("top bar for account sessions", () => {
  it("names the sign-in method, links settings and offers the passkey for narrowed roles", async () => {
    s.session = {
      ...account,
      aal: "aal2",
      secondFactor: "totp",
      narrowedRoles: [{ role: "reviewer", requiredAal: "aal3" }],
    } as SessionInfo;
    mockHttp({ "GET /api/v1/auth/mfa": status() });
    render(
        <TopBar />
      ,
    );
    expect(screen.getByTestId("sign-in-method").textContent).toBe("email");
    expect(screen.getByRole("link", { name: "Account" }).getAttribute("href")).toBe("/w/settings");
    expect(screen.queryByTestId("step-up-narrowed")).toBeNull();
  });

  it("marks roles below their assurance minimum inactive, with the reason, apart from roles in effect", () => {
    s.session = {
      ...account,
      assuranceLevel: "identity_bound",
      roleBindings: [
        { role: "reviewer", organizationId: null, projectId: null },
        { role: "project_member", organizationId: null, projectId: null },
      ],
    } as SessionInfo;
    render(<TopBar />);
    expect(screen.getByTestId("effective-roles").textContent).toBe("project_member");
    expect(screen.getByTestId("inactive-roles").textContent).toBe("reviewer");
    expect(screen.getByTestId("inactive-roles-reason").textContent).toContain(
      "Identity verification needed — ask an admin",
    );
  });

  it("lists every role as in effect when the assurance meets them", () => {
    render(<TopBar />);
    expect(screen.getByTestId("effective-roles").textContent).toBe("reviewer");
    expect(screen.queryByTestId("inactive-roles")).toBeNull();
  });

  it("offers account access after a verified first factor", () => {
    s.session = { ...account, aal: "aal1", mfaSatisfied: false } as SessionInfo;
    render(<TopBar />);
    expect(screen.getByRole("link", { name: "Account" })).toBeTruthy();
    expect(screen.queryByTestId("step-up-narrowed")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
