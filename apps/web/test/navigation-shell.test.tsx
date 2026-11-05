// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceGate } from "../src/components/WorkspaceGate";
import { TopBar } from "../src/components/TopBar";
import { Address } from "../src/components/Address";
import Connect from "../src/app/connect/page";
import { PublicFooter } from "../src/components/PublicFooter";
import Landing from "../src/app/page";
import Asset from "../src/app/asset-registry/page";
import Legal from "../src/app/legal/page";
import DataRoom from "../src/app/w/data-room/page";
import Verification from "../src/app/w/verification/page";
import Readiness from "../src/app/w/readiness/page";
import PublicProjects from "../src/app/explorer/projects/page";
import PublicVerifications from "../src/app/explorer/verifications/page";
import RoleAccess from "../src/app/w/access-requests/page";
import ProjectAccess from "../src/app/w/projects/[id]/access-requests/page";
import Assurance from "../src/app/w/identity/upgrade/page";
import { mockHttp } from "./support/http";
const s = vi.hoisted(() => ({
  path: "/w/projects",
  token: "token" as string | null,
  loading: false,
  wallets: [] as { id: string; name: string; icon: string | null }[],
  session: {
    authenticated: true,
    tenantId: "tenant1" as string | null,
    assuranceLevel: "high_assurance",
    roleBindings: [] as { role: string }[],
    actions: [] as string[],
  },
  signOut: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("../src/lib/session", async (original) => {
  const actual = await original<typeof import("../src/lib/session")>();
  return {
    useSession: () => s,
    needsSecondFactor: actual.needsSecondFactor,
    isAccountSession: actual.isAccountSession,
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => s.path,
  useRouter: () => ({ push: s.push, replace: s.replace }),
}));
beforeEach(() => {
  s.path = "/w/projects";
  s.token = "token";
  s.loading = false;
  s.session.authenticated = true;
  s.session.tenantId = "tenant1";
  s.session.roleBindings = [];
  s.wallets = [];
  for (const f of [s.signOut, s.push, s.replace, s.refresh])
    f.mockReset();
  s.refresh.mockImplementation(async () => s.session);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("gates loading, signed-out and tenantless sessions while always allowing access guidance", () => {
  s.loading = true;
  const view = render(
    <WorkspaceGate>
      <p>Private records</p>
    </WorkspaceGate>,
  );
  expect(screen.queryByText("Private records")).toBeNull();
  expect(screen.getByText("Loading your session…")).toBeTruthy();
  s.loading = false;
  s.session.authenticated = false;
  view.rerender(
    <WorkspaceGate>
      <p>Private records</p>
    </WorkspaceGate>,
  );
  expect(screen.getByTestId("workspace-signed-out")).toBeTruthy();
  s.session.authenticated = true;
  s.session.tenantId = null;
  view.rerender(
    <WorkspaceGate>
      <p>Private records</p>
    </WorkspaceGate>,
  );
  expect(screen.getByTestId("workspace-no-tenant")).toBeTruthy();
  expect(screen.queryByText("Private records")).toBeNull();
  for (const path of [
    "/w/access-requests",
    "/w/identity/upgrade",
    "/w/projects/p1/access-requests",
  ]) {
    s.path = path;
    view.rerender(
      <WorkspaceGate>
        <p>Access guidance</p>
      </WorkspaceGate>,
    );
    expect(screen.getByText("Access guidance")).toBeTruthy();
  }
  s.path = "/w/projects";
  s.session.tenantId = "tenant1";
  s.session.roleBindings = [{ role: "data_steward" }];
  view.rerender(
    <WorkspaceGate>
      <p>Private records</p>
    </WorkspaceGate>,
  );
  expect(screen.getByText("Private records")).toBeTruthy();
});
it("keeps public navigation available after sign-in and closes its expanded menu", async () => {
  const view = render(<TopBar />);
  const menu = screen.getByText("Public registry", { exact: true }).closest("details")!;
  menu.open = true;
  const publicLink = menu.querySelector("a")!;
  publicLink.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(publicLink);
  expect(menu.open).toBe(false);
  fireEvent.click(screen.getByText("Account", { exact: true }));
  const disconnect = screen
    .getAllByRole("button")
    .find((b) => b.textContent?.includes("Sign out"))!;
  fireEvent.click(disconnect);
  expect(s.signOut).toHaveBeenCalledOnce();
  s.session.authenticated = false;
  view.rerender(<TopBar />);
  expect(screen.getByRole("link", { name: "Sign in →" })).toBeTruthy();
});
it("copies the full address and provides a manual-copy fallback", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  vi.useFakeTimers();
  render(<Address value="0xabcdef" />);
  fireEvent.click(screen.getByRole("button"));
  await act(async () => {});
  expect(write).toHaveBeenCalledWith("0xabcdef");
  expect(screen.getByText("Copied")).toBeTruthy();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1600);
  });
  expect(screen.getByText("Copy")).toBeTruthy();
  write.mockRejectedValue(new Error("Denied"));
  fireEvent.click(screen.getByRole("button"));
  await act(async () => {});
  expect(screen.getByText("Select to copy")).toBeTruthy();
});
it("offers no wallet sign-in, whatever an older server still reports (WP7)", async () => {
  // A server from before WP7 still sends the switch; the screen no longer has anything to draw for it.
  mockHttp({
    "GET /api/v1/auth/methods": {
      emailCode: true,
      google: false,
      microsoft: false,
      legacyWalletLogin: true,
      emailCodeDigits: 8,
      emailCodeTtlMinutes: 10,
      requestId: "r",
    },
  });
  s.session.authenticated = false;
  s.wallets = [{ id: "wallet1", name: "Wallet One", icon: "data:image/png;base64,AA" }];
  render(<Connect />);
  expect(await screen.findByTestId("email-sign-in")).toBeTruthy();
  expect(screen.queryByTestId("legacy-wallet-sign-in")).toBeNull();
  expect(screen.queryByTestId("connect-wallet")).toBeNull();
  expect(screen.queryByTestId("connect-wallet-wallet1")).toBeNull();
});
it("keeps product boundaries and inactive asset gates visible on public informational pages", () => {
  render(<Landing />);
  expect(screen.getByTestId("landing-boundaries").textContent).toContain("not");
  expect(screen.getByRole("heading", { name: "Verification Registry" })).toBeDefined();
  cleanup();
  render(<Asset />);
  expect(screen.getByText("Legal issuance decision")).toBeTruthy();
  cleanup();
  render(<Legal />);
  expect(screen.getByRole("heading", { level: 1 })).toBeTruthy();
});
for (const [Component, label, path] of [
  [DataRoom, "Open Data Room", "data-room"],
  [Verification, "Open verification", "verification"],
  [Readiness, "Readiness", "readiness"],
] as const)
  it(`links the global ${path} entry to the selected project's screen`, async () => {
    mockHttp({
      "GET /api/v1/projects": {
        items: [
          {
            id: "p1",
            projectKey: "MPC-1",
            name: "Copper",
            lifecycleState: "draft",
            hostCountryIso3: "MNG",
          },
        ],
      },
    });
    render(<Component />);
    expect(
      (
        await screen.findByRole("link", { name: `${label} — MPC-1` })
      ).getAttribute("href"),
    ).toBe(`/w/projects/p1/${path}`);
  });
it("public registry routes use their own registry types and citable links", async () => {
  for (const [Component, type, key] of [
    [PublicProjects, "project", "MPC-1"],
    [PublicVerifications, "verification", "VER-1"],
  ] as const) {
    mockHttp({
      [`GET /api/v1/public/registries/${type}?limit=20`]: {
        items: [
          {
            publicKey: key,
            entryVersionId: "v1",
            projection: {},
            status: "published",
            version: 1,
            publishedAt: null,
          },
        ],
        nextCursor: null,
      },
    });
    render(<Component />);
    expect(
      (await screen.findByRole("link", { name: key })).getAttribute("href"),
    ).toContain(
      type === "project" ? "/explorer/projects/" : "registryType=verification",
    );
    cleanup();
  }
});
it("permission routes explain who can grant access without pretending to file requests", async () => {
  render(<RoleAccess />);
  expect(screen.getByText("No role allows this action")).toBeTruthy();
  cleanup();
  render(<Assurance />);
  expect(
    screen.getByText("Identity assurance is not high enough"),
  ).toBeTruthy();
  cleanup();
  await act(async () =>
    render(<ProjectAccess params={Promise.resolve({ id: "p1" })} />),
  );
  expect(screen.getByText("Not assigned to this project")).toBeTruthy();
  expect(screen.getByText("This screen does not file a request")).toBeTruthy();
});

it("keeps anonymous header to brand and sign-in, with secondary destinations in the footer", () => {
  s.session.authenticated = false;
  const view = render(<><TopBar /><PublicFooter /></>);
  expect(view.container.querySelector("header nav")?.getAttribute("style")).toContain("display: none");
  expect(screen.getByRole("link", { name: "Sign in →" })).toBeDefined();
  const more = screen.getByText("More", { exact: true }).closest("details")!;
  expect(more.open).toBe(false);
  fireEvent.click(screen.getByText("More", { exact: true }));
  expect(more.open).toBe(true);
  expect(screen.getByRole("link", { name: "Proof Verifier" })).toBeDefined();
});

it("dismisses header menus with Escape or outside interaction and keeps one menu open", async () => {
  render(<TopBar />);
  const publicMenu = screen.getByText("Public registry", { exact: true }).closest("details")!;
  const accountMenu = screen.getByText("Account", { exact: true }).closest("details")!;
  fireEvent.click(publicMenu.querySelector("summary")!);
  await waitFor(() => expect(publicMenu.open).toBe(true));
  fireEvent.click(accountMenu.querySelector("summary")!);
  await waitFor(() => expect(accountMenu.open).toBe(true));
  expect(publicMenu.open).toBe(false);
  accountMenu.querySelector("summary")!.focus();
  fireEvent.keyDown(accountMenu.querySelector("summary")!, { key: "Escape" });
  expect(accountMenu.open).toBe(false);
  fireEvent.click(publicMenu.querySelector("summary")!);
  fireEvent.pointerDown(document.body);
  expect(publicMenu.open).toBe(false);
});


it("switches header and footer menus synchronously without queued toggle races", () => {
  const view = render(<><TopBar /><PublicFooter /></>);
  const account = screen.getByText("Account", { exact: true }).closest("details")!;
  const footer = screen.getByText("More", { exact: true }).closest("details")!;
  fireEvent.click(account.querySelector("summary")!);
  expect(account.open).toBe(true);
  fireEvent.click(footer.querySelector("summary")!);
  expect(account.open).toBe(false);
  expect(footer.open).toBe(true);
  fireEvent.click(account.querySelector("summary")!);
  expect(account.open).toBe(true);
  expect(footer.open).toBe(false);
  expect(view.container.querySelectorAll("details[open]")).toHaveLength(1);
});
