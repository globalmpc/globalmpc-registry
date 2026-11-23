// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as webauthn from "@simplewebauthn/browser";
import Connect from "../src/app/connect/page";
import OidcCallbackPage from "../src/app/auth/oidc/[provider]/callback/page";
import AcceptInvitationPage from "../src/app/invitations/accept/page";
import EmailChangePage from "../src/app/account/email-change/page";
import { EmailCodeForm, formatRemaining, resendDelaySeconds } from "../src/components/auth/EmailCodeForm";
import { navigation } from "../src/components/auth/ProviderButtons";
import { pendingInvitation } from "../src/lib/pending-invitation";
import type { SessionInfo } from "../src/lib/api";
import { mockHttp, type HttpCall } from "./support/http";

/**
 * Sign-in, second factor, provider callback, invitation and email-change screens (WP6).
 *
 * The real API client runs against a stubbed `fetch`, so each test checks what reaches the server
 * as well as what the person sees.
 */
const s = vi.hoisted(() => ({
  session: null as SessionInfo | null,
  loading: false,
  refresh: vi.fn(),
  signOut: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
  params: { provider: "google" } as { provider: string },
}));
vi.mock("../src/lib/session", async (original) => {
  const actual = await original<typeof import("../src/lib/session")>();
  return {
    needsSecondFactor: actual.needsSecondFactor,
    isAccountSession: actual.isAccountSession,
    useSession: () => ({
      session: s.session,
      loading: s.loading,
      token: s.session?.authenticated ? "cookie-session" : null,
      refresh: s.refresh,
      signOut: s.signOut,
      wallets: [],
    }),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: s.push, replace: s.replace }),
  useParams: () => s.params,
  usePathname: () => "/",
}));
vi.mock("@simplewebauthn/browser", () => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));

const aal1 = {
  authenticated: true,
  requestId: "r",
  subjectId: "person",
  firstFactor: "email_code",
  aal: "aal1",
  mfaSatisfied: false,
} as SessionInfo;
const aal2 = { ...aal1, aal: "aal2", secondFactor: "totp", mfaSatisfied: true, workspaceAvailable: true } as SessionInfo;
const methods = (overrides: Record<string, unknown> = {}) => ({
  emailCode: true,
  google: false,
  emailCodeDigits: 8,
  emailCodeTtlMinutes: 10,
  requestId: "r",
  ...overrides,
});
const status = (overrides: Record<string, unknown> = {}) => ({
  passkeyEnrolled: false,
  totpEnrolled: false,
  recoveryCodesRemaining: null,
  recoveryLimited: false,
  enrolment: { passkey: "allowed", totp: "allowed" },
  passkeys: [],
  ...overrides,
});
const factor = (overrides: Record<string, unknown> = {}) => ({
  aal: "aal2",
  secondFactor: "totp",
  recoveryCodes: null,
  sessionEnded: false,
  ...overrides,
});
const refusal = (status: number, code: string, details?: Record<string, unknown>) => () =>
  Response.json({ code, message: code, requestId: "r", ...(details ? { details } : {}) }, { status });
const posted = (calls: HttpCall[], suffix: string) =>
  calls.find((call) => call.method === "POST" && call.url.endsWith(suffix));
const type = (label: string | RegExp, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const TOKEN = "A".repeat(43);

beforeEach(() => {
  s.session = null;
  s.loading = false;
  s.params = { provider: "google" };
  for (const f of [s.refresh, s.signOut, s.push, s.replace]) f.mockReset();
  s.refresh.mockImplementation(async () => s.session);
  s.signOut.mockResolvedValue(undefined);
  window.history.replaceState(null, "", "/");
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("email code form", () => {
  it("waits longer before each further code, capped at five minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 10].map(resendDelaySeconds)).toEqual([30, 60, 120, 240, 300, 300, 300]);
    expect(resendDelaySeconds(0)).toBe(30);
    expect(formatRemaining(61_000)).toBe("1:01");
    expect(formatRemaining(-5)).toBe("0:00");
  });

  it("accepts only digits, submits a full code and states a refusal in one sentence", async () => {
    const onSubmit = vi.fn(async () => {
      const { ApiError } = await import("../src/lib/api");
      throw new ApiError(400, { code: "EMAIL_CODE_INVALID", message: "x", requestId: "r" } as never);
    });
    render(
      <EmailCodeForm digits={8} expiresInMinutes={10} sentAt={Date.now()} sends={1} onResend={vi.fn()} onSubmit={onSubmit} />,
    );
    const submit = screen.getByRole("button", { name: "Continue" });
    type("8-digit code", "12a34-567");
    expect((screen.getByLabelText("8-digit code") as HTMLInputElement).value).toBe("1234567");
    expect(submit.hasAttribute("disabled")).toBe(true);
    type("8-digit code", "12345678");
    fireEvent.click(submit);
    expect((await screen.findByRole("alert")).textContent).toBe("That code is not right. Check it and try again.");
    expect(onSubmit).toHaveBeenCalledWith("12345678");
    expect(screen.getByTestId("code-expiry").textContent).toMatch(/^Code expires in (10:00|9:5\d)$/);
    expect(screen.getByRole("button", { name: /Send a new code in \d+ s/ }).hasAttribute("disabled")).toBe(true);
  });

  it("offers a new code once the wait has passed, and says when a code has expired", async () => {
    const onResend = vi.fn(async () => undefined);
    render(
      <EmailCodeForm
        digits={6}
        expiresInMinutes={1}
        sentAt={Date.now() - 120_000}
        sends={1}
        onResend={onResend}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("code-expiry").textContent).toBe("This code has expired. Ask for a new one.");
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    await waitFor(() => expect(onResend).toHaveBeenCalledOnce());
  });

  it("shows no expiry when this page did not ask for the code", () => {
    render(<EmailCodeForm digits={8} expiresInMinutes={null} sentAt={Date.now()} sends={1} onResend={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId("code-expiry")).toBeNull();
  });
});

describe("sign-in screen", () => {
  it("sends a code, signs in with it and sends a first-factor session to its second factor", async () => {
    window.history.replaceState(null, "", "/connect?next=%2Fw%2Fadmin");
    const calls = mockHttp({
      "GET /api/v1/auth/methods": methods({ emailCodeDigits: 6 }),
      "POST /api/v1/auth/email/start": { accepted: true, message: "m", expiresInMinutes: 10 },
      "POST /api/v1/auth/email/verify": { expiresAt: "2030-01-01T00:00:00Z", aal: "aal1", subjectId: "person" },
    });
    s.refresh.mockResolvedValue(aal1);
    render(<Connect />);
    expect(screen.queryByTestId("legacy-wallet-sign-in")).toBeNull();
    await screen.findByLabelText("Email address");
    type("Email address", " person@example.test ");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByTestId("code-sent")).textContent).toContain("expires in 10 minutes");
    expect(posted(calls, "/email/start")?.body).toEqual({ email: "person@example.test" });
    await waitFor(() => expect(screen.getByLabelText("6-digit code")).toBeTruthy());
    type("6-digit code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/w/admin"));
    expect(posted(calls, "/email/verify")?.body).toEqual({ email: "person@example.test", code: "123456" });
  });

  it("goes straight on when the fresh session already holds its second factor, never off-site", async () => {
    window.history.replaceState(null, "", "/connect?next=https%3A%2F%2Fevil.example");
    mockHttp({
      "GET /api/v1/auth/methods": methods(),
      "POST /api/v1/auth/email/start": { accepted: true, message: "m", expiresInMinutes: 10 },
      "POST /api/v1/auth/email/verify": { expiresAt: "2030-01-01T00:00:00Z", aal: "aal2", subjectId: "person" },
    });
    s.refresh.mockResolvedValue(aal2);
    render(<Connect />);
    await screen.findByLabelText("Email address");
    type("Email address", "person@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByTestId("code-sent");
    type("8-digit code", "12345678");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    // No role yet, and the off-site `next` is dropped: the access-pending landing (journey 1).
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/w/access-pending"));
  });

  it("lands a session holding a role on the projects, and honours a same-site next", async () => {
    window.history.replaceState(null, "", "/connect?next=%2Fw%2Fgovernance");
    mockHttp({
      "GET /api/v1/auth/methods": methods(),
      "POST /api/v1/auth/email/start": { accepted: true, message: "m", expiresInMinutes: 10 },
      "POST /api/v1/auth/email/verify": { expiresAt: "2030-01-01T00:00:00Z", aal: "aal2", subjectId: "person" },
    });
    s.refresh.mockResolvedValue({ ...aal2, roleBindings: [{ role: "reviewer", organizationId: "o", projectId: null }], assuranceLevel: "identity_bound" });
    render(<Connect />);
    await screen.findByLabelText("Email address");
    type("Email address", "person@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    await screen.findByTestId("code-sent");
    type("8-digit code", "12345678");
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/w/governance"));
  });

  it("states a refused code request and lets another address be used", async () => {
    mockHttp({
      "GET /api/v1/auth/methods": methods(),
      "POST /api/v1/auth/email/start": refusal(429, "RATE_LIMITED"),
    });
    render(<Connect />);
    await screen.findByLabelText("Email address");
    type("Email address", "person@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Too many attempts. Wait a few minutes and try again.");
  });

  it("returns to the address step on request", async () => {
    mockHttp({
      "GET /api/v1/auth/methods": methods(),
      "POST /api/v1/auth/email/start": { accepted: true, message: "m", expiresInMinutes: 10 },
    });
    render(<Connect />);
    await screen.findByLabelText("Email address");
    type("Email address", "person@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Send code" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use another address" }));
    expect(screen.getByLabelText("Email address")).toBeTruthy();
  });

  it("starts Google only where configured and leaves for the provider's URL", async () => {
    const assign = vi.spyOn(navigation, "assign").mockImplementation(() => undefined);
    const calls = mockHttp({
      // A server from before WP7 may still send the wallet sign-in switch, and one from before
      // 0171 the Microsoft one; nothing is drawn for either.
      "GET /api/v1/auth/methods": methods({ google: true, microsoft: true, legacyWalletLogin: true }),
      "POST /api/v1/auth/oidc/google/start": { authorizationUrl: "https://accounts.google.com/authorize?x", expiresAt: "z" },
    });
    render(<Connect />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in with Google" }));
    expect(screen.queryByRole("button", { name: "Continue with Microsoft" })).toBeNull();
    expect(screen.queryByTestId("oidc-microsoft")).toBeNull();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/authorize?x"));
    expect(posted(calls, "/oidc/google/start")?.body).toEqual({ purpose: "sign_in" });
    expect(screen.queryByTestId("legacy-wallet-sign-in")).toBeNull();
  });

  it("states a refused provider start", async () => {
    mockHttp({
      "GET /api/v1/auth/methods": methods({ google: true }),
      "POST /api/v1/auth/oidc/google/start": refusal(503, "OIDC_PROVIDER_UNAVAILABLE"),
    });
    render(<Connect />);
    const google = await screen.findByRole("button", { name: "Sign in with Google" });
    expect(screen.queryByLabelText("Email address")).toBeNull();
    fireEvent.click(google);
    expect((await screen.findByRole("alert")).textContent).toBeTruthy();
  });

  it("tells a signed-in person where to go", () => {
    s.session = aal2;
    mockHttp({ "GET /api/v1/auth/methods": methods() });
    render(<Connect />);
    expect(screen.getByText("You are signed in.")).toBeTruthy();
  });
});

describe("provider callback", () => {
  it("removes the provider's code from the address bar and completes sign-in", async () => {
    window.history.replaceState(null, "", "/auth/oidc/google/callback?state=st&code=cd&iss=https%3A%2F%2Faccounts.google.com");
    s.refresh.mockResolvedValue({ ...aal1, firstFactor: "google" });
    const calls = mockHttp({
      "POST /api/v1/auth/oidc/google/callback": () =>
        Response.json({ aal: "aal1" }, { headers: { "x-mpc-oidc-purpose": "sign_in" } }),
    });
    render(<OidcCallbackPage />);
    expect(window.location.search).toBe("");
    expect(window.location.pathname).toBe("/auth/oidc/google/callback");
    await waitFor(() => expect(s.replace).toHaveBeenCalledWith("/w/work"));
    // No binding from the page: the web server adds it from its own cookie.
    expect(posted(calls, "/callback")?.body).toEqual({ state: "st", code: "cd", iss: "https://accounts.google.com" });
  });

  it("reports a link and stays on this session", async () => {
    window.history.replaceState(null, "", "/auth/oidc/google/callback?state=st&code=cd");
    mockHttp({
      "POST /api/v1/auth/oidc/google/callback": () =>
        Response.json({ linked: true }, { headers: { "x-mpc-oidc-purpose": "link" } }),
    });
    render(<OidcCallbackPage />);
    expect((await screen.findByTestId("oidc-linked")).textContent).toContain("Google is now linked");
    expect(s.replace).not.toHaveBeenCalled();
  });

  it("finishes an invitation with a provider and forgets the pending token", async () => {
    pendingInvitation.keep(TOKEN);
    window.history.replaceState(null, "", "/auth/oidc/google/callback?state=st&code=cd");
    s.refresh.mockResolvedValue(aal1);
    mockHttp({
      "POST /api/v1/auth/oidc/google/callback": () =>
        Response.json({}, { headers: { "x-mpc-oidc-purpose": "invitation_accept" } }),
    });
    render(<OidcCallbackPage />);
    await waitFor(() => expect(s.replace).toHaveBeenCalledWith("/w/projects"));
    expect(pendingInvitation.read()).toBeNull();
  });

  it("sends a refused invitation back to the emailed code", async () => {
    pendingInvitation.keep(TOKEN);
    window.history.replaceState(null, "", "/auth/oidc/google/callback?state=st&code=cd");
    mockHttp({ "POST /api/v1/auth/oidc/google/callback": refusal(400, "OIDC_EMAIL_CODE_REQUIRED") });
    render(<OidcCallbackPage />);
    await screen.findByTestId("oidc-error");
    expect(screen.getByRole("link", { name: "Email me a code →" }).getAttribute("href")).toBe("/invitations/accept");
  });

  it("refuses a callback without state or for an unknown provider, without calling the API", async () => {
    const calls = mockHttp({});
    window.history.replaceState(null, "", "/auth/oidc/google/callback?code=cd");
    render(<OidcCallbackPage />);
    await screen.findByTestId("oidc-error");
    expect(screen.getByRole("link", { name: "Back to sign-in" })).toBeTruthy();
    cleanup();
    // Not a provider — nor Microsoft, removed in 0171: nothing is posted for either.
    for (const provider of ["github", "microsoft"]) {
      cleanup();
      s.params = { provider };
      window.history.replaceState(null, "", `/auth/oidc/${provider}/callback?state=s&code=c`);
      render(<OidcCallbackPage />);
      await screen.findByTestId("oidc-error");
    }
    expect(calls).toHaveLength(0);
  });
});

describe("invitation acceptance", () => {
  it("takes the token from the fragment, clears it from the address bar and accepts with the emailed code", async () => {
    window.history.replaceState(null, "", `/invitations/accept#token=${TOKEN}`);
    s.refresh.mockResolvedValue(aal1);
    const calls = mockHttp({
      "GET /api/v1/auth/methods": methods(),
      "POST /api/v1/auth/invitations/accept/start": { expiresInMinutes: 10 },
      "POST /api/v1/auth/invitations/accept/verify": { expiresAt: "z", aal: "aal1", subjectId: "person" },
    });
    render(<AcceptInvitationPage />);
    await screen.findByTestId("invitation-accept");
    expect(window.location.hash).toBe("");
    expect(window.location.href).not.toContain(TOKEN);
    const send = screen.getByRole("button", { name: "Email me a code" });
    expect(send.hasAttribute("disabled")).toBe(true);
    type("Your name, as colleagues will see it", " Kim Reviewer ");
    fireEvent.click(send);
    await screen.findByTestId("code-form");
    expect(posted(calls, "/accept/start")?.body).toEqual({ token: TOKEN });
    type("8-digit code", "12345678");
    fireEvent.click(screen.getByRole("button", { name: "Accept invitation" }));
    await waitFor(() => expect(s.push).toHaveBeenCalledWith("/w/projects"));
    expect(posted(calls, "/accept/verify")?.body).toEqual({ token: TOKEN, code: "12345678", displayName: "Kim Reviewer" });
    expect(pendingInvitation.read()).toBeNull();
  });

  it("never takes the token from the query string", async () => {
    window.history.replaceState(null, "", `/invitations/accept?token=${TOKEN}`);
    mockHttp({ "GET /api/v1/auth/methods": methods() });
    render(<AcceptInvitationPage />);
    expect((await screen.findByTestId("invitation-missing")).textContent).toContain("link from your invitation email");
  });

  it("accepts with a provider, carrying the token and name in the request body only", async () => {
    window.history.replaceState(null, "", `/invitations/accept#token=${TOKEN}`);
    const assign = vi.spyOn(navigation, "assign").mockImplementation(() => undefined);
    const calls = mockHttp({
      "GET /api/v1/auth/methods": methods({ google: true }),
      "POST /api/v1/auth/oidc/google/start": { authorizationUrl: "https://accounts.google.com/o", expiresAt: "z" },
    });
    render(<AcceptInvitationPage />);
    const google = await screen.findByRole("button", { name: "Continue with Google" });
    expect(google.hasAttribute("disabled")).toBe(true);
    type("Your name, as colleagues will see it", "Kim");
    fireEvent.click(google);
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://accounts.google.com/o"));
    expect(posted(calls, "/oidc/google/start")?.body).toEqual({
      purpose: "invitation_accept",
      invitationToken: TOKEN,
      displayName: "Kim",
    });
    // Kept in this tab for the emailed-code fallback after the provider round trip.
    expect(pendingInvitation.read()).toBe(TOKEN);
  });

  it("resumes from the tab's pending token and states a dead invitation", async () => {
    pendingInvitation.keep(TOKEN);
    window.history.replaceState(null, "", "/invitations/accept");
    mockHttp({
      "GET /api/v1/auth/methods": () => Promise.reject(new Error("offline")),
      "POST /api/v1/auth/invitations/accept/start": refusal(400, "INVITATION_INVALID"),
    });
    render(<AcceptInvitationPage />);
    type("Your name, as colleagues will see it", "Kim");
    fireEvent.click(await screen.findByRole("button", { name: "Email me a code" }));
    expect((await screen.findByRole("alert")).textContent).toContain("This invitation cannot be used.");
  });

  it("keeps working when the browser blocks storage", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => pendingInvitation.keep(TOKEN)).not.toThrow();
  });
});

describe("email change completion", () => {
  it("confirms the new address with its code, then signs out everywhere", async () => {
    const calls = mockHttp({
      "GET /api/v1/auth/methods": methods({ emailCodeDigits: 6 }),
      "POST /api/v1/auth/email-change/verify": { completed: true, sessionsRevoked: true },
    });
    render(<EmailChangePage />);
    await screen.findByLabelText("6-digit code");
    type("New address", " new@example.test ");
    type("Confirmation key from your current email", "11111111-1111-4111-8111-111111111111");
    type("6-digit code", "123456");
    fireEvent.click(screen.getByRole("button", { name: "Confirm address" }));
    expect((await screen.findByTestId("email-change-done")).textContent).toContain("Every session has ended");
    expect(posted(calls, "/email-change/verify")?.body).toEqual({ email: "new@example.test", code: "123456", ownerCode: "11111111-1111-4111-8111-111111111111" });
    expect(s.signOut).toHaveBeenCalledOnce();
  });

  it("asks for a new code after the wait", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const calls = mockHttp({
      "GET /api/v1/auth/methods": methods(),
      "POST /api/v1/auth/email-change/start": { accepted: true, message: "m", expiresInMinutes: 10 },
    });
    render(<EmailChangePage />);
    type("New address", "new@example.test");
    vi.setSystemTime(Date.now() + 31_000);
    // The countdown re-reads the clock each second.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
    });
    fireEvent.click(screen.getByRole("button", { name: "Send a new code" }));
    await screen.findByTestId("code-expiry");
    expect(posted(calls, "/email-change/start")?.body).toEqual({ email: "new@example.test" });
    vi.useRealTimers();
  });
});
