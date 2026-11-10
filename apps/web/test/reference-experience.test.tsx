// @vitest-environment jsdom
import * as React from "react";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Team from "../src/app/w/projects/[id]/team/page";
import Audit from "../src/app/w/projects/[id]/audit/page";
import { DisclosurePreview } from "../src/components/DisclosurePreview";
import { DirectoryEvidence } from "../src/components/DirectoryEvidence";
import { WorkspaceShell } from "../src/components/WorkspaceShell";
import { StageAssessments } from "../src/components/StageAssessments";
import { PageFrame } from "../src/components/PageFrame";
import { PublicProjectHeader } from "../src/components/PublicProjectHeader";
import { PublicRegistryBrowser } from "../src/components/PublicRegistryBrowser";
import Register from "../src/app/w/projects/[id]/register/page";
import Help from "../src/app/w/help/page";
import type { LedgerSummary } from "../src/lib/evidence-ledger-api";
import { mockHttp } from "./support/http";
const state = vi.hoisted(() => ({
  path: "/w/projects/p1/requirements",
  session: {
    subjectId: "subject",
    actions: [
      "project.read",
      "evidence.read",
      "source.upload",
      "readiness.read",
    ],
  },
}));
vi.mock("next/navigation", () => ({ usePathname: () => state.path }));
vi.mock("../src/lib/session", () => ({
  useSession: () => ({ token: "token", session: state.session }),
}));
beforeEach(() => {
  state.session.subjectId = "subject";
  state.path = "/w/projects/p1/requirements";
  state.session.actions = [
    "project.read",
    "evidence.read",
    "source.upload",
    "readiness.read",
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
it("shows project context only for the selected route, retains children and filters action destinations", async () => {
  let resolve!: (value: unknown) => void;
  mockHttp({
    "GET /api/v1/projects/p1": {
      id: "p1",
      projectKey: "P1",
      name: "First project",
    },
    "GET /api/v1/projects/p2": () =>
      new Promise((r) => {
        resolve = r;
      }),
  });
  const view = render(
    <WorkspaceShell>
      <p>Project content</p>
    </WorkspaceShell>,
  );
  await screen.findByText("First project");
  expect(screen.getByText("Project content")).toBeTruthy();
  expect(
    screen
      .getByRole("link", { name: "Requirements" })
      .getAttribute("aria-current"),
  ).toBe("page");
  expect(screen.queryByRole("link", { name: "Review evidence" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Workspace navigation" }));
  expect(
    screen
      .getByRole("button", { name: "Close navigation" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  state.path = "/w/projects/p2/requirements";
  view.rerender(
    <WorkspaceShell>
      <p>Project content</p>
    </WorkspaceShell>,
  );
  expect(screen.queryByText("First project")).toBeNull();
  await act(async () =>
    resolve({ id: "p2", projectKey: "P2", name: "Second project" }),
  );
  expect(screen.getByText("Second project")).toBeTruthy();
  state.path = "/w/settings";
  state.session.actions = [];
  view.rerender(<WorkspaceShell>Account</WorkspaceShell>);
  expect(screen.queryByText("Second project")).toBeNull();
  expect(
    screen.queryByRole("navigation", { name: "Selected project" }),
  ).toBeNull();
  expect(screen.getByRole("link", { name: "Account settings" })).toBeTruthy();
});
it("does not fetch project data for a session lacking project.read", async () => {
  state.session.actions = [];
  const calls = mockHttp({});
  render(<WorkspaceShell>Role-free guidance</WorkspaceShell>);
  expect(calls).toHaveLength(0);
  expect(screen.getByText("Role-free guidance")).toBeTruthy();
});
it("renders only server-assessed gates and keeps missing and N/A evidence distinct", () => {
  const summary: LedgerSummary = {
    evaluatedAt: "2026-11-09T00:00:00Z",
    inputSnapshotHash: "hash",
    currentStage: "stage.exploration",
    limitations: [],
    items: [
      {
        claimType: "licence",
        displayName: "Mining licence",
        status: "not_applicable",
        reasons: [],
        limitations: [],
      },
    ],
    stages: [
      {
        gateId: "stage.exploration",
        ruleSetVersion: "2",
        status: "gap",
        requiredItems: "2",
        reviewedItems: "1",
        missing: ["licence"],
      },
    ],
  };
  const view = render(<StageAssessments summary={summary} />);
  expect(screen.getByText("Mining licence")).toBeTruthy();
  expect(screen.getByText("Reviewed 1 / 2 required items")).toBeTruthy();
  expect(view.container.querySelectorAll("details")).toHaveLength(1);
  expect(screen.queryByText("Closure")).toBeNull();
  view.rerender(<StageAssessments summary={{ ...summary, stages: [] }} />);
  expect(screen.getByText(/No stage rules have been assessed/)).toBeTruthy();
});
it("centers every authentication route but keeps the workspace layout full width", () => {
  state.path = "/auth/mfa";
  const view = render(<PageFrame>Second factor</PageFrame>);
  expect(view.container.querySelector("main")!.className).toContain(
    "auth-page",
  );
  state.path = "/w/settings";
  view.rerender(<PageFrame>Settings</PageFrame>);
  expect(view.container.querySelector("main")!.className).toContain(
    "workspace-page",
  );
  expect(view.container.querySelector("main")!.className).not.toContain(
    "auth-page",
  );
});
it("copies the public citation with its version and keeps revocation visible", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(
    <PublicProjectHeader
      publicKey="P1"
      entry={{
        entryVersionId: "v1",
        version: "3",
        status: "published",
        publishedAt: null,
        revokedAt: "2026-11-09",
        history: [],
        limitations: [],
        legalEffect: "none",
        disclaimerCodes: [],
        projectName: "Mine",
        mineral: ["Copper"],
        hostCountry: "MNG",
      }}
    />,
  );
  expect(screen.getByText("published · revoked")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cite" }));
  await screen.findByText("Citation copied");
  expect(writeText.mock.calls[0]![0]).toContain("published version 3");
  writeText.mockRejectedValue(new Error("denied"));
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  await screen.findByText(/Copy is unavailable/);
});
it("offers retry instead of claiming no publications after a failed list request", async () => {
  let failed = true;
  mockHttp({
    "GET /api/v1/public/registry-entries?registryType=project&limit=20": () => {
      if (failed) throw new Error("Network unavailable");
      return { items: [], nextCursor: null };
    },
  });
  // Keep this test independent of query parameter ordering.
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (failed) throw new Error("Network unavailable");
      return new Response(JSON.stringify({ items: [], nextCursor: null }));
    }),
  );
  render(
    <PublicRegistryBrowser
      cards
      registryType="project"
      searchPlaceholder="Find project"
      emptyMessage="No publications"
    />,
  );
  await screen.findByRole("button", { name: "Retry published records" });
  expect(screen.queryByText("No publications")).toBeNull();
  failed = false;
  fireEvent.click(
    screen.getByRole("button", { name: "Retry published records" }),
  );
  await screen.findByText("No publications");
});
it("retries classification without duplicating an uploaded file and shows the scan boundary", async () => {
  const calls = mockHttp({});
  let profileAttempts = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        headers: new Headers(),
        body: null,
      });
      if (url.endsWith("/uploads"))
        return new Response(
          JSON.stringify({ reused: false, id: "u1", version: 1 }),
        );
      if (++profileAttempts === 1) throw new Error("Profile save interrupted");
      return new Response(JSON.stringify({ id: "u1", version: 2 }));
    }),
  );
  const params = Promise.resolve({ id: "p1" });
  await act(async () => {
    render(<Register params={params} />);
  });
  fireEvent.change(screen.getByLabelText("Choose a file"), {
    target: {
      files: [
        new File(["evidence"], "report.pdf", { type: "application/pdf" }),
      ],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Document type"), {
    target: { value: "Exploration report" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByText("Profile save interrupted");
  fireEvent.click(screen.getByRole("button", { name: "Retry classification" }));
  await screen.findByRole("heading", { name: "File uploaded" });
  expect(calls.filter((call) => call.url.endsWith("/uploads"))).toHaveLength(1);
  expect(screen.getByText(/must pass malware scanning/)).toBeTruthy();
});
it("provides real help destinations instead of prototype placeholders", () => {
  render(<Help />);
  expect(
    screen
      .getByRole("link", { name: "Choose a project →" })
      .getAttribute("href"),
  ).toBe("/w/projects");
  expect(screen.queryByText("SOON")).toBeNull();
});
it("keeps project team assignments separate from organization-wide roles and excludes other projects", async () => {
  state.session.actions = ["admin.read"];
  const subject = (id: string, projectId: string | null) => ({
    id,
    displayName: id,
    kind: "person",
    locked: false,
    roles: [
      { id: `${id}-role`, role: "data_steward", projectId, revokedAt: null },
    ],
  });
  mockHttp({
    "GET /api/v1/projects/p1": { id: "p1" },
    "GET /api/v1/admin/subjects": {
      items: [
        subject("Project member", "p1"),
        subject("Broader role", null),
        subject("Other project", "p2"),
        {
          ...subject("Former member", "p1"),
          roles: [
            { role: "data_steward", projectId: "p1", revokedAt: "2026-01-01" },
          ],
        },
      ],
    },
  });
  await act(async () => {
    render(<Team params={Promise.resolve({ id: "p1" })} />);
  });
  await screen.findByText("Project member");
  expect(screen.getByText("Broader role")).toBeTruthy();
  expect(screen.queryByText("Other project")).toBeNull();
  expect(screen.queryByText("Former member")).toBeNull();
});
it("uses the selected project's audit filter and never queries operational outbox state", async () => {
  state.session.actions = ["audit.read"];
  const calls = mockHttp({
    "GET /api/v1/audit-events?projectId=p1": {
      items: [
        {
          id: "e1",
          occurredAt: "2026-11-09",
          command: "evidence.changed",
          resourceType: "claim",
          effectiveRole: "data_steward",
          beforeVersion: 1,
          afterVersion: 2,
        },
      ],
    },
  });
  await act(async () => {
    render(<Audit params={Promise.resolve({ id: "p1" })} />);
  });
  await screen.findByText("evidence · changed");
  expect(calls.map((call) => call.url)).toEqual([
    "/api/v1/audit-events?projectId=p1",
  ]);
});
it("does not fetch team or audit information for a session without the required actions", async () => {
  state.session.actions = [];
  const calls = mockHttp({});
  await act(async () => {
    render(
      <>
        <Team params={Promise.resolve({ id: "p1" })} />
        <Audit params={Promise.resolve({ id: "p1" })} />
      </>,
    );
  });
  expect(calls).toHaveLength(0);
  expect(
    screen.getAllByRole("link", { name: "Request access →" }),
  ).toHaveLength(2);
});
it("labels previews as unpublished and uses no proof or public lookup for private draft data", () => {
  const calls = mockHttp({});
  render(
    <DisclosurePreview
      projection={{
        projectName: "Private draft",
        status: "registered",
        projectKey: "P1",
        limitations: ["Desk review only"],
        legalEffect: "none",
      }}
    />,
  );
  expect(screen.getByText("Draft preview · not published")).toBeTruthy();
  expect(screen.getByText("Desk review only")).toBeTruthy();
  expect(calls).toHaveLength(0);
});
it("does not manufacture project evidence coverage from missing or invalid public metadata", () => {
  const view = render(<DirectoryEvidence value={null} />);
  expect(screen.getByText("Evidence coverage unavailable")).toBeTruthy();
  view.rerender(
    <DirectoryEvidence
      value={{ currentStage: "stage.production", items: [] }}
    />,
  );
  expect(screen.queryByText("Production")).toBeNull();
});
it("clears project identity when the account changes even though the cookie-session marker is unchanged", async () => {
  let release!: (value: unknown) => void;
  let count = 0;
  mockHttp({
    "GET /api/v1/projects/p1": () =>
      ++count === 1
        ? { id: "p1", projectKey: "P1", name: "Previous account project" }
        : new Promise((resolve) => {
            release = resolve;
          }),
  });
  const view = render(<WorkspaceShell>Account-specific work</WorkspaceShell>);
  await screen.findByText("Previous account project");
  state.session.subjectId = "another-subject";
  view.rerender(<WorkspaceShell>Account-specific work</WorkspaceShell>);
  expect(screen.queryByText("Previous account project")).toBeNull();
  await act(async () =>
    release({ id: "p1", projectKey: "P1", name: "New account project" }),
  );
  expect(screen.getByText("New account project")).toBeTruthy();
});
it("does not load the team directory under a project the server refuses", async () => {
  state.session.actions = ["admin.read"];
  const calls = mockHttp({
    "GET /api/v1/projects/p1": () =>
      new Response(
        JSON.stringify({
          code: "AUTHORIZATION_DENIED",
          message: "Project access denied",
          retryable: false,
          correlationId: "test",
        }),
        { status: 403 },
      ),
  });
  await act(async () => {
    render(<Team params={Promise.resolve({ id: "p1" })} />);
  });
  await screen.findByRole("alert");
  expect(calls.map((call) => call.url)).toEqual(["/api/v1/projects/p1"]);
  expect(
    screen.queryByRole("heading", { name: "Project assignments" }),
  ).toBeNull();
});

it("clears unfinished form state when navigating between documents in the same project", async () => {
  mockHttp({ "GET /api/v1/projects/p1": { id: "p1", name: "Scoped project" } });
  function Draft() {
    const [text, setText] = React.useState("");
    return (
      <input
        aria-label="Unsaved classification"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }
  state.path = "/w/projects/p1/documents/first";
  const view = render(
    <WorkspaceShell>
      <Draft />
    </WorkspaceShell>,
  );
  fireEvent.change(screen.getByLabelText("Unsaved classification"), {
    target: { value: "First document only" },
  });
  state.path = "/w/projects/p1/documents/second";
  view.rerender(
    <WorkspaceShell>
      <Draft />
    </WorkspaceShell>,
  );
  expect(
    (screen.getByLabelText("Unsaved classification") as HTMLInputElement).value,
  ).toBe("");
  await screen.findByText("Scoped project");
});
