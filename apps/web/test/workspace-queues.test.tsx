// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Activity from "../src/app/w/activity/page";
import Audit from "../src/app/w/audit/page";
import Authorities from "../src/app/w/authorities/page";
import Notifications from "../src/app/w/notifications/page";
import Integrations from "../src/app/w/integrations/page";
import Registries from "../src/app/w/registries/page";
import Work from "../src/app/w/work/page";
import { mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({
  token: "token" as string | null,
  loading: false,
  session: { authenticated: true, actions: [] as string[] },
}));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
beforeEach(() => {
  auth.token = "token";
  auth.loading = false;
  auth.session.authenticated = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("paginates personal activity without losing the first page and reports pagination errors", async () => {
  let fail = true;
  const item = {
    id: "e1",
    command: "Uploaded",
    occurredAt: "2026-10-20",
    projectId: "p1",
    resourceType: "document",
    effectiveRole: "operator",
    signatureOrTx: "0xsig",
  };
  mockHttp({
    "GET /api/v1/me/activity": { items: [item], nextCursor: "next/1" },
    "GET /api/v1/me/activity?cursor=next%2F1": () => {
      if (fail) throw new Error("Page unavailable");
      return {
        items: [
          {
            ...item,
            id: "e2",
            command: "Reviewed",
            projectId: null,
            effectiveRole: null,
            signatureOrTx: null,
          },
        ],
        nextCursor: null,
      };
    },
  });
  render(<Activity />);
  await screen.findByText("Uploaded");
  fireEvent.click(screen.getByText("Load more"));
  await screen.findByRole("alert");
  fail = false;
  fireEvent.click(screen.getByText("Load more"));
  await screen.findByText("Reviewed");
  expect(screen.getByText("Uploaded")).toBeTruthy();
  expect(screen.queryByText("Load more")).toBeNull();
});
it("shows audit backlog as delayed rather than lost and sends resource filters", async () => {
  const event = {
    id: "e1",
    command: "ClaimRecorded",
    resourceType: "claim",
    resourceId: "claim1",
    occurredAt: "2026-10-20T10:00:00",
    actorWalletAddress: "0xactor",
    effectiveRole: "operator",
    beforeVersion: 1,
    afterVersion: 2,
    reason: "Evidence added",
  };
  const calls = mockHttp({
    "GET /api/v1/audit-events?": { items: [event] },
    "GET /api/v1/audit-events?resourceType=claim": { items: [] },
    "GET /api/v1/outbox-backlog": {
      pending: 2,
      oldestPendingAgeSeconds: 60,
      publishedLastHour: 3,
      deadLettered: 1,
      byEventType: [{ eventType: "Recorded", pending: 2 }],
      deadLetteredByEventType: [
        { eventType: "Failed", deadLettered: 1, lastError: "Timeout" },
      ],
    },
  });
  render(<Audit />);
  await screen.findByTestId("audit-table");
  expect(screen.getByTestId("backlog-pending").textContent).toContain(
    "delayed, not lost",
  );
  expect(screen.getByTestId("backlog-dead-lettered").textContent).toContain(
    "needs a replay",
  );
  fireEvent.change(screen.getByLabelText("Narrow by resource type"), {
    target: { value: "claim" },
  });
  await screen.findByText(/No matching records/);
  fireEvent.click(screen.getByText("Search"));
  await waitFor(() =>
    expect(
      calls.filter((c) => c.url.endsWith("resourceType=claim")),
    ).toHaveLength(2),
  );
});
const authority = {
  id: "a1",
  name: "Mining office",
  jurisdiction: "MNG",
  verificationMethod: "manual",
  proves: ["License exists"],
  doesNotProve: ["Commercial value"],
  adapterState: "active",
  adapterStateReason: "Approved",
  integrationStage: "active",
  integrationStageSince: "2026-10-01",
  reconciliationRequired: true,
  nextAction: "Reconcile",
  recognizedScope: ["rights"],
  callable: true,
  state: "accepted",
};
it("shows authority stages, limitations and blocked integrations distinctly", async () => {
  mockHttp({
    "GET /api/v1/jurisdictions/MNG/profile": {
      activeCount: 1,
      manualCount: 1,
      pendingCount: 2,
      stageCounts: { active: 1 },
      authorities: [
        authority,
        ...["manual", "blocked", "pending"].map((adapterState, i) => ({
          ...authority,
          id: `b${i}`,
          name: `Office ${i}`,
          adapterState,
          adapterStateReason: null,
          integrationStageSince: null,
          reconciliationRequired: false,
          nextAction: null,
        })),
      ],
      limitations: ["No site inspection"],
    },
    "GET /api/v1/jurisdictions/KOR/profile": () => {
      throw new Error("Unknown jurisdiction");
    },
  });
  render(<Authorities />);
  await screen.findByTestId("authority-table");
  expect(screen.getAllByText("Commercial value")).toHaveLength(4);
  expect(screen.getByText("No site inspection")).toBeTruthy();
  await screen.findByRole("button", { name: "Search" });
  fireEvent.change(screen.getByLabelText("Jurisdiction (ISO3)"), {
    target: { value: "kor" },
  });
  await screen.findByRole("alert");
  expect(screen.queryByTestId("profile-summary")).toBeNull();
});
it("marks a notification read for the caller and reloads role notifications", async () => {
  let read = false;
  const calls = mockHttp({
    "GET /api/v1/notifications": () => ({
      items: [
        {
          id: "n1",
          kind: "review_assigned",
          summary: "Review copper",
          link: "/w/work",
          audience: "role",
          audienceRole: "reviewer",
          occurredAt: "2026-10-20",
          read,
        },
        {
          id: "n2",
          kind: "readiness_gap",
          summary: "Gap",
          link: "/w/work",
          audience: "you",
          occurredAt: "2026-10-20",
          read: true,
        },
      ],
      truncated: true,
    }),
    "POST /api/v1/notifications/n1/read": () => {
      read = true;
      return {};
    },
  });
  render(<Notifications />);
  await screen.findByTestId("notifications-table");
  expect(screen.getByText(/1 unread among those listed/)).toBeTruthy();
  fireEvent.click(screen.getByText("Mark read"));
  await waitFor(() =>
    expect(screen.getAllByText("read by you")).toHaveLength(2),
  );
  expect(
    calls.find((c) => c.method === "POST")?.headers.get("idempotency-key"),
  ).toBeTruthy();
});
it("separates callable authorities from blocked and missing integrations", async () => {
  mockHttp({
    "GET /api/v1/authorities": {
      items: [
        authority,
        {
          ...authority,
          id: "a2",
          name: "Blocked office",
          callable: false,
          state: "proposed",
          nextAction: "Await acceptance",
        },
      ],
    },
  });
  render(<Integrations />);
  await screen.findByText("Mining office");
  expect(
    within(screen.getByTestId("integrations-pending")).getByText(
      "Await acceptance",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByTestId("integrations-accepted")).queryByText(
      "Blocked office",
    ),
  ).toBeNull();
});
it("does not link draft registry entries to public pages and filters published registries", async () => {
  mockHttp({
    "GET /api/v1/registry-entries": {
      items: [
        {
          entryId: "r1",
          registryType: "project",
          status: "draft",
          publicKey: "draft-key",
          latestVersion: 1,
          anchored: false,
        },
        {
          entryId: "r2",
          registryType: "verification",
          status: "published",
          publicKey: "public-key",
          latestVersion: 2,
          anchored: true,
          revokedAt: "2026-10-20",
          publishedAt: "2026-10-19",
        },
      ],
    },
  });
  render(<Registries />);
  await screen.findByTestId("registry-table");
  expect(screen.queryByRole("link", { name: "draft-key" })).toBeNull();
  expect(
    screen.getByRole("link", { name: "public-key" }).getAttribute("href"),
  ).toContain("registryType=verification");
  fireEvent.click(screen.getByRole("button", { name: "asset" }));
  expect(screen.getByText(/Nothing has been recorded/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "all" }));
  expect(screen.getByText("in a batch")).toBeTruthy();
});
it("includes unassigned work and flags unresolved conflicts instead of hiding them", async () => {
  mockHttp({
    "GET /api/v1/my-work": {
      assignedToMe: [
        {
          caseId: "c1",
          projectId: "p1",
          projectName: "Copper",
          state: "assigned",
          assignedAt: "2026-10-20",
          conflictStatus: "unresolved",
        },
      ],
      waitingOnOthers: [
        { id: "w1", summary: "Waiting for approver", since: "2026-10-19" },
      ],
      unassigned: [
        {
          kind: "review",
          id: "u1",
          projectId: "p2",
          summary: "Unassigned review",
          since: "2026-10-18",
        },
      ],
      unassignedTruncated: true,
    },
  });
  render(<Work />);
  await screen.findByText("Copper");
  expect(screen.getByText("unresolved")).toBeTruthy();
  expect(screen.getByText("Unassigned review")).toBeTruthy();
  expect(screen.getByText("Waiting for approver")).toBeTruthy();
});
for (const [name, Component, route] of [
  ["activity", Activity, "/api/v1/me/activity"],
  ["audit", Audit, "/api/v1/audit-events?"],
  ["authorities", Authorities, "/api/v1/jurisdictions/MNG/profile"],
  ["notifications", Notifications, "/api/v1/notifications"],
  ["integrations", Integrations, "/api/v1/authorities"],
  ["registries", Registries, "/api/v1/registry-entries"],
  ["work", Work, "/api/v1/my-work"],
] as const) {
  it(`${name} distinguishes a request failure from no connected account`, async () => {
    mockHttp({
      [`GET ${route}`]: () => {
        throw new Error("Unavailable");
      },
      "GET /api/v1/outbox-backlog": {},
    });
    render(<Component />);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Unavailable",
    );
    cleanup();
    auth.token = null;
    auth.session.authenticated = false;
    const calls = mockHttp({});
    render(<Component />);
    expect(screen.getByText(/No account is connected/)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });
}
