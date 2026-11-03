// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as webauthn from "@simplewebauthn/browser";
import AccountSettingsPage from "../src/app/w/settings/page";
import { StepUpProvider, useStepUp } from "../src/components/auth/StepUp";
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
  roleBindings: [{ role: "reviewer_cp_qp", organizationId: null, projectId: null }],
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
    <StepUpProvider>
      <AccountSettingsPage />
    </StepUpProvider>,
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
      <StepUpProvider>
        <AccountSettingsPage />
      </StepUpProvider>,
    );
    expect(view.container.querySelector(".page-head")).toBeNull();
    expect(calls.some((call) => call.url.endsWith("/auth/mfa"))).toBe(false);
  });

  it("lists factors, identities and wallets as the server reports them", async () => {
    mount();
    expect((await screen.findByTestId("passkey-name")).textContent).toBe("Laptop");
    expect(screen.getByTestId("passkey-list").textContent).toContain("synced");
    expect(screen.getByTestId("totp-state").textContent).toContain("Set up");
    expect(screen.getByTestId("recovery-remaining").textContent).toBe("9 unused");
    const identities = await screen.findByTestId("settings-identities");
    await within(identities).findByText(/linked when you accepted the invitation/);
    // Google is linked already; only Microsoft is offered.
    expect(screen.queryByTestId("link-google")).toBeNull();
    expect(screen.getByTestId("link-microsoft")).toBeTruthy();
    expect((await screen.findByTestId("wallet-list")).textContent).toContain("bound by you");
  });

  it("renames a passkey", async () => {
    const calls = mount(routes({ "PATCH /api/v1/auth/mfa/passkeys/pk1": passkey }));
    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("Rename"), { target: { value: " Work laptop " } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(posted(calls, "/passkeys/pk1")[0]?.body).toEqual({ name: "Work laptop" }));
  });

  it("removes the factor this session proved with and signs the browser out", async () => {
    const calls = mount(
      routes({ "POST /api/v1/auth/mfa/totp/removal": { revokedSessions: 2, currentSessionEnded: true } }),
    );
    const totp = await screen.findByTestId("totp-state");
    fireEvent.click(within(totp).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/connect"));
    expect(s.signOut).toHaveBeenCalledOnce();
    expect(posted(calls, "/totp/removal")).toHaveLength(1);
  });

  it("asks for the passkey when the server requires it, then retries the removal once", async () => {
    vi.mocked(webauthn.startAuthentication).mockResolvedValue({ id: "cred" } as never);
    let attempts = 0;
    const calls = mount(
      routes({
        "POST /api/v1/auth/mfa/passkeys/pk1/removal": () =>
          ++attempts === 1
            ? refusal(403, "MFA_PASSKEY_REQUIRED")
            : Response.json({ revokedSessions: 0, currentSessionEnded: false }),
        "POST /api/v1/auth/mfa/passkeys/authentication/options": { options: {} },
        "POST /api/v1/auth/mfa/passkeys/authentication/verify": {
          aal: "aal3",
          secondFactor: "passkey",
          recoveryCodes: null,
          sessionEnded: false,
        },
      }),
    );
    const list = await screen.findByTestId("passkey-list");
    fireEvent.click(within(list).getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByTestId("step-up");
    expect(dialog.textContent).toContain("This action needs your passkey.");
    // aal3 is a passkey: no authenticator-code field is offered.
    await within(dialog).findByTestId("passkey-prove");
    expect(within(dialog).queryByLabelText("6-digit code from your authenticator app")).toBeNull();
    fireEvent.click(within(dialog).getByTestId("passkey-prove"));
    await waitFor(() => expect(posted(calls, "/pk1/removal")).toHaveLength(2));
    expect(s.refresh).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId("step-up")).toBeNull());
    expect(s.signOut).not.toHaveBeenCalled();
  });

  it("does nothing more when the person closes the prompt", async () => {
    const calls = mount(
      routes({ "POST /api/v1/auth/mfa/recovery-codes": () => refusal(403, "MFA_STEP_UP_REQUIRED", { requiredAal: "aal2" }) }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Generate new codes" }));
    const dialog = await screen.findByTestId("step-up");
    expect(dialog.textContent).toContain("This action needs a second factor.");
    await within(dialog).findByLabelText("6-digit code from your authenticator app");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("step-up")).toBeNull());
    expect(posted(calls, "/recovery-codes")).toHaveLength(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells a person without a passkey how to get one instead of an empty prompt", async () => {
    mount(
      routes({
        "GET /api/v1/auth/mfa": status({ passkeyEnrolled: false, passkeys: [] }),
        "POST /api/v1/auth/mfa/totp/removal": () => refusal(403, "MFA_PASSKEY_REQUIRED"),
      }),
    );
    const totp = await screen.findByTestId("totp-state");
    fireEvent.click(within(totp).getByRole("button", { name: "Remove" }));
    expect((await screen.findByTestId("step-up-no-passkey")).textContent).toContain("no passkey yet");
  });

  it("shows new recovery codes once", async () => {
    mount(routes({ "POST /api/v1/auth/mfa/recovery-codes": { recoveryCodes: ["n-1", "n-2"] } }));
    fireEvent.click(await screen.findByRole("button", { name: "Generate new codes" }));
    expect((await screen.findByTestId("recovery-code-list")).textContent).toBe("n-1n-2");
    // Copy and download stay in this browser: the clipboard, and a file made from a local blob.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await screen.findByRole("button", { name: "Copied" });
    expect(writeText).toHaveBeenCalledWith("n-1\nn-2");
    const blobs: Blob[] = [];
    const createObjectURL = vi.fn((blob: Blob) => {
      blobs.push(blob);
      return "blob:local";
    });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL, revokeObjectURL }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Download" }));
    expect(click).toHaveBeenCalledOnce();
    expect(await blobs[0]!.text()).toBe("n-1\nn-2\n");
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:local");
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByTestId("settings-factors")).toBeTruthy();
  });

  it("adds a factor directly when allowed, and after a step-up when the server says so", async () => {
    vi.mocked(webauthn.startRegistration).mockResolvedValue({ id: "new" } as never);
    let stepped = false;
    const calls = mount(
      routes({
        "GET /api/v1/auth/mfa": () =>
          status({ enrolment: { passkey: stepped ? "allowed" : "MFA_PASSKEY_REQUIRED", totp: "MFA_TOTP_ALREADY_ENROLLED" } }),
        "POST /api/v1/auth/mfa/passkeys/authentication/options": { options: {} },
        "POST /api/v1/auth/mfa/passkeys/authentication/verify": () => {
          stepped = true;
          return { aal: "aal3", secondFactor: "passkey", recoveryCodes: null, sessionEnded: false };
        },
        "POST /api/v1/auth/mfa/passkeys/registration/options": { options: {} },
        "POST /api/v1/auth/mfa/passkeys/registration/verify": {
          aal: "aal3",
          secondFactor: "passkey",
          recoveryCodes: null,
          sessionEnded: false,
        },
      }),
    );
    vi.mocked(webauthn.startAuthentication).mockResolvedValue({ id: "cred" } as never);
    fireEvent.click(await screen.findByTestId("add-factor"));
    const dialog = await screen.findByTestId("step-up");
    fireEvent.click(await within(dialog).findByTestId("passkey-prove"));
    fireEvent.click(await screen.findByTestId("passkey-enrol"));
    await waitFor(() => expect(posted(calls, "/registration/verify")).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("add-factor")).toBeTruthy());
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
        replaceReason: "key_compromised",
      }),
    );
  });

  it("reads the session list and the session again after a factor removal ends other sessions", async () => {
    const calls = mount(
      routes({ "POST /api/v1/auth/mfa/totp/removal": { revokedSessions: 1, currentSessionEnded: false } }),
    );
    await screen.findByTestId("session-other");
    const listed = calls.filter((call) => call.url.endsWith("/auth/sessions")).length;
    s.refresh.mockClear();
    const totp = await screen.findByTestId("totp-state");
    fireEvent.click(within(totp).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(posted(calls, "/totp/removal")).toHaveLength(1));
    // Removing a factor ends the other sessions that proved with it: the list is read again, and
    // the session itself (the header's factor and level) too.
    await waitFor(() =>
      expect(calls.filter((call) => call.url.endsWith("/auth/sessions")).length).toBeGreaterThan(listed),
    );
    expect(s.refresh).toHaveBeenCalled();
    expect(s.signOut).not.toHaveBeenCalled();
  });

  it("reads the session list again after an unlink and after regenerating recovery codes", async () => {
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
    const afterUnlink = count();
    fireEvent.click(screen.getByRole("button", { name: "Generate new codes" }));
    await waitFor(() => expect(count()).toBeGreaterThan(afterUnlink));
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
    expect(within(operator).getByTestId("replace-done-inactive").textContent).toBe("reviewer_cp_qp");
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
    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(4));
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/connect"));
  });
});

describe("session-level refusals", () => {
  function Runner({ action }: { readonly action: () => Promise<unknown> }) {
    const { run } = useStepUp();
    return (
      <button type="button" onClick={() => void run(action).catch(() => undefined)}>
        run
      </button>
    );
  }

  it("sends a first-factor session to the second-factor screen instead of prompting", async () => {
    mockHttp({});
    render(
      <StepUpProvider>
        <Runner action={() => Promise.reject(new ApiError(403, { code: "MFA_REQUIRED", message: "x" } as never))} />
      </StepUpProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "run" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/auth/mfa"));
    expect(screen.queryByTestId("step-up")).toBeNull();
  });

  it("passes other refusals through untouched", async () => {
    const other = new ApiError(403, { code: "AUTHORIZATION_DENIED", message: "x" } as never);
    const action = vi.fn(() => Promise.reject(other));
    mockHttp({});
    render(
      <StepUpProvider>
        <Runner action={action} />
      </StepUpProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "run" }));
    await waitFor(() => expect(action).toHaveBeenCalledOnce());
    expect(screen.queryByTestId("step-up")).toBeNull();
  });

  it("requires the provider", () => {
    expect(() => render(<Runner action={async () => undefined} />)).toThrow("inside StepUpProvider");
  });

  it("explains a level refusal on a screen and offers the factor", async () => {
    mockHttp({ "GET /api/v1/auth/mfa": status() });
    const narrowed = new ApiError(403, {
      code: "AUTHORIZATION_DENIED",
      message: "x",
      details: { reason: "AUTHENTICATION_LEVEL_INSUFFICIENT", requiredAal: "aal3" },
    } as never);
    render(
      <StepUpProvider>
        <ErrorNotice error={narrowed} />
      </StepUpProvider>,
    );
    expect(screen.getByTestId("error-notice").textContent).toContain("This action needs your passkey.");
    fireEvent.click(screen.getByRole("button", { name: "Verify and try again" }));
    const dialog = await screen.findByTestId("step-up");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("step-up")).toBeNull());
  });

  it("sends a session still owing its second factor to that screen", () => {
    render(<ErrorNotice error={new ApiError(403, { code: "MFA_REQUIRED", message: "x" } as never)} />);
    expect(screen.getByRole("link", { name: "Second step →" }).getAttribute("href")).toBe("/auth/mfa");
  });

  it("states a known refusal in one sentence and an ended session as such", () => {
    const view = render(
      <ErrorNotice error={new ApiError(409, { code: "MFA_RESET_SELF_TARGET", message: "raw", retryable: false } as never)} />,
    );
    expect(screen.getByTestId("error-notice").textContent).toContain("You cannot reset your own second factors.");
    view.rerender(<ErrorNotice error={new ApiError(401, { code: "UNAUTHENTICATED", message: "raw" } as never)} />);
    expect(screen.getByRole("link", { name: "Sign in again →" })).toBeTruthy();
  });
});

describe("top bar for account sessions", () => {
  it("names the sign-in method, links settings and offers the passkey for narrowed roles", async () => {
    s.session = {
      ...account,
      aal: "aal2",
      secondFactor: "totp",
      narrowedRoles: [{ role: "reviewer_cp_qp", requiredAal: "aal3" }],
    } as SessionInfo;
    mockHttp({ "GET /api/v1/auth/mfa": status() });
    render(
      <StepUpProvider>
        <TopBar />
      </StepUpProvider>,
    );
    expect(screen.getByTestId("sign-in-method").textContent).toBe("email");
    expect(screen.getByRole("link", { name: "Account" }).getAttribute("href")).toBe("/w/settings");
    fireEvent.click(screen.getByTestId("step-up-narrowed"));
    const dialog = await screen.findByTestId("step-up");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByTestId("step-up")).toBeNull());
  });

  it("marks roles below their assurance minimum inactive, with the reason, apart from roles in effect", () => {
    s.session = {
      ...account,
      assuranceLevel: "wallet_only",
      roleBindings: [
        { role: "reviewer_cp_qp", organizationId: null, projectId: null },
        { role: "project_voter", organizationId: null, projectId: null },
      ],
    } as SessionInfo;
    render(<TopBar />);
    expect(screen.getByTestId("effective-roles").textContent).toBe("project_voter");
    expect(screen.getByTestId("inactive-roles").textContent).toBe("reviewer_cp_qp");
    expect(screen.getByTestId("inactive-roles-reason").textContent).toContain(
      "Identity verification needed — ask an admin",
    );
  });

  it("lists every role as in effect when the assurance meets them", () => {
    render(<TopBar />);
    expect(screen.getByTestId("effective-roles").textContent).toBe("reviewer_cp_qp");
    expect(screen.queryByTestId("inactive-roles")).toBeNull();
  });

  it("hides the workspace while the second factor is owed", () => {
    s.session = { ...account, aal: "aal1", mfaSatisfied: false } as SessionInfo;
    render(<TopBar />);
    expect(screen.queryByRole("link", { name: "Account" })).toBeNull();
    expect(screen.queryByTestId("step-up-narrowed")).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });
});
