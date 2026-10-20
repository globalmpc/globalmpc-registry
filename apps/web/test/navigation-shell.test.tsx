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
  signingIn: false,
  error: null as string | null,
  walletAvailable: true,
  wallets: [] as { id: string; name: string; icon: string | null }[],
  connectionLog: [] as { at: string; step: string; detail: string }[],
  session: {
    authenticated: true,
    tenantId: "tenant1" as string | null,
    walletAddress: "0xabc",
    assuranceLevel: "high_assurance",
    roleBindings: [] as { role: string }[],
    actions: [] as string[],
  },
  signOut: vi.fn(),
  signIn: vi.fn(),
  signInWithWallet: vi.fn(),
  push: vi.fn(),
  demo: [] as { label: string; description: string }[],
}));
vi.mock("../src/lib/session", () => ({
  useSession: () => s,
  DEMO_ACCOUNTS: s.demo,
  demoAddress: () => "0xdemo",
}));
vi.mock("next/navigation", () => ({
  usePathname: () => s.path,
  useRouter: () => ({ push: s.push }),
}));
beforeEach(() => {
  s.path = "/w/projects";
  s.token = "token";
  s.loading = false;
  s.session.authenticated = true;
  s.session.tenantId = "tenant1";
  s.session.roleBindings = [];
  s.wallets = [];
  s.demo.length = 0;
  s.error = null;
  s.connectionLog = [];
  s.walletAvailable = true;
  for (const f of [s.signOut, s.signIn, s.signInWithWallet, s.push])
    f.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("gates loading, signed-out and unenrolled sessions while always allowing access guidance", () => {
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
  expect(screen.getByTestId("enrollment-wallet").textContent).toContain(
    "0xabc",
  );
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
  view.rerender(
    <WorkspaceGate>
      <p>Private records</p>
    </WorkspaceGate>,
  );
  expect(screen.getByText("Private records")).toBeTruthy();
});
it("keeps public navigation available after sign-in and closes its expanded menu", async () => {
  const view = render(<TopBar />);
  const menu = view.container.querySelector("details")!;
  menu.open = true;
  const publicLink = menu.querySelector("a")!;
  publicLink.addEventListener("click", (event) => event.preventDefault());
  fireEvent.click(publicLink);
  expect(menu.open).toBe(false);
  const disconnect = screen
    .getAllByRole("button")
    .find((b) => b.textContent?.includes("Disconnect"))!;
  fireEvent.click(disconnect);
  expect(s.signOut).toHaveBeenCalledOnce();
  s.session.authenticated = false;
  view.rerender(<TopBar />);
  expect(screen.getByRole("link", { name: "Connect account →" })).toBeTruthy();
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
it("navigates only after successful wallet or demo sign-in and copies diagnostics", async () => {
  s.signInWithWallet.mockResolvedValueOnce(false).mockResolvedValue(true);
  s.signIn.mockResolvedValue(true);
  s.demo.push({ label: "Demo operator", description: "Synthetic" });
  s.error = "Rejected";
  s.connectionLog = [
    { at: "2026-10-20T10:00:00", step: "connect", detail: "rejected" },
  ];
  const write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: write },
  });
  const view = render(<Connect />);
  fireEvent.click(screen.getByTestId("connect-wallet"));
  await act(async () => {});
  expect(s.push).not.toHaveBeenCalled();
  s.wallets = [
    { id: "wallet1", name: "Wallet One", icon: "data:image/png;base64,AA" },
  ];
  view.rerender(<Connect />);
  fireEvent.click(screen.getByTestId("connect-wallet-wallet1"));
  await waitFor(() => expect(s.push).toHaveBeenCalledWith("/w/projects"));
  fireEvent.click(screen.getByText("Demo operator"));
  await waitFor(() => expect(s.signIn).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByText("Copy details"));
  expect(write).toHaveBeenCalledWith("2026-10-20T10:00:00 connect rejected");
});
it("keeps product boundaries and inactive asset gates visible on public informational pages", () => {
  render(<Landing />);
  expect(screen.getByTestId("landing-boundaries").textContent).toContain("not");
  expect(
    screen
      .getByRole("link", { name: "Connect account →" })
      .getAttribute("href"),
  ).toBe("/connect");
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
