// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Project from "../src/app/w/projects/[id]/page";
import type { ProjectOverview } from "../src/lib/projects-api";
import { mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({
  token: "token" as string | null,
  loading: false,
  session: {
    actions: [
      "project.update",
      "project.registration.request",
      "project.fact.record",
      "project.party.submit",
      "project.stakeholder.record",
    ],
  },
}));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const root = "/api/v1/projects/p1";
function overview(): ProjectOverview {
  return {
    projectId: "p1",
    projectKey: "MPC-123",
    name: "Mine",
    hostCountryIso3: "MNG",
    minerals: ["copper"],
    referenceStatus: "synthetic_test_project",
    relationshipStatus: "pending",
    lifecycleState: "candidate",
    ownerOrganizationName: "Sponsor",
    version: 3,
    facts: [
      {
        factKey: "mineral_rights",
        status: "pending",
        recorded: true,
        evidence: null,
        asOf: null,
        version: 1,
        history: [],
      },
    ],
    parties: [],
    lifecycle: [
      {
        fromState: "candidate",
        toState: "data_preparation",
        reason: "Evidence requested",
        occurredAt: "2026-01-01",
      },
    ],
    registries: [
      {
        registryType: "project",
        status: "draft",
        latestVersion: 1,
        publishedAt: null,
        anchored: false,
      },
    ],
    readiness: [
      {
        gateId: "registry_publication",
        status: "gap",
        generatedAt: "2026-01-01",
        openGaps: [{ requirementId: "license", status: "gap", reasonCode: "NO_EVIDENCE" }],
      },
    ],
    decisions: [
      {
        gateId: "registry_publication",
        decision: "no_go",
        decisionAuthority: "Independent authority",
        signedAt: "2026-01-01",
      },
    ],
    dataAge: {
      newestSourceAsOf: null,
      oldestSourceAsOf: null,
      sourceCount: 0,
      openStaleSignals: 1,
    },
    limitations: ["Not an investment offering"],
    registrationRequests: [
      {
        id: "request",
        note: "Please review",
        requestedAt: "2026-01-01",
        answeredByPublication: false,
      },
    ],
    stakeholderEventCount: 0,
    activity: [
      { command: "ProjectRegistered", effectiveRole: "mpc_operator", occurredAt: "2026-01-01" },
    ],
    requestId: "request-id",
    asOf: "2026-01-01",
  };
}
function routes(): Record<string, unknown> {
  return {
    [`GET ${root}/overview`]: overview(),
    [`GET ${root}/stakeholder-events`]: { items: [] },
    [`GET ${root}/disclosure-restrictions/active`]: { items: [] },
    [`GET ${root}/offering-gate`]: {
      absenceNotice: "Offering unavailable",
      missing: [{ key: "issuer", label: "Issuer basis", why: "Unconfirmed", owner: "Sponsor" }],
      unsupported: [],
      notMeaning: "Not approval",
    },
  };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  await act(async () => {
    render(<Project params={Promise.resolve({ id: "p1" })} />);
  });
  if (auth.token) await screen.findByRole("heading", { name: "Identity" });
  return calls;
}
beforeEach(() => {
  auth.token = "token";
  auth.session.actions = [
    "project.update",
    "project.registration.request",
    "project.fact.record",
    "project.party.submit",
    "project.stakeholder.record",
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
describe("project identity and recorded decisions", () => {
  it("keeps a reference label separate from factual confirmation and human decisions", async () => {
    await mount();
    expect(screen.getByTestId("reference-standing").textContent).toContain(
      "does not confirm rights",
    );
    expect(screen.getByTestId("readiness-card").textContent).not.toContain("no_go");
    expect(screen.getByTestId("decision-card").textContent).toContain("no_go");
    expect(screen.getByTestId("offering-gate").textContent).toContain("Offering unavailable");
    expect(screen.getByTestId("gaps-and-limitations").textContent).toContain("NO_EVIDENCE");
  });
  it("version-checks identity edits without changing ownership or reference standing", async () => {
    const data = routes();
    data[`PATCH ${root}`] = {};
    const calls = await mount(data);
    change("Project name", "New mine name");
    change("Mineral list (comma separated)", " copper, gold, ");
    change("Reason for the change", "Corrected register");
    fireEvent.submit(screen.getByLabelText("Project name").closest("form")!);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        name: "New mine name",
        minerals: ["copper", "gold"],
        reason: "Corrected register",
      }),
    );
    expect(calls.find((call) => call.method === "PATCH")?.headers.get("if-match")).toBe('"3"');
  });
  it("records a registration request without treating it as publication", async () => {
    const data = routes();
    data[`POST ${root}/registration-requests`] = {};
    const calls = await mount(data);
    change("Request note", "Ready for independent review");
    fireEvent.click(screen.getByRole("button", { name: "Request registration" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        note: "Ready for independent review",
      }),
    );
    expect(calls.some((call) => call.url.includes("/publication"))).toBe(false);
  });
  it("hides update and registration forms when the server does not grant their actions", async () => {
    auth.session.actions = [];
    await mount();
    expect(screen.queryByLabelText("Project name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Request registration" })).toBeNull();
  });
  it("does not silently overwrite a conflicting identity edit", async () => {
    const data = routes();
    data[`PATCH ${root}`] = Response.json(
      {
        code: "VERSION_CONFLICT",
        message: "Project changed",
        retryable: false,
        correlationId: "project",
      },
      { status: 412 },
    );
    await mount(data);
    change("Project name", "Updated mine");
    change("Reason for the change", "Correction");
    fireEvent.submit(screen.getByLabelText("Project name").closest("form")!);
    await screen.findByText("Project changed");
    expect((screen.getByLabelText("Project name") as HTMLInputElement).value).toBe("Updated mine");
  });
  it("records a stakeholder event without asserting unverified evidence is confirmed", async () => {
    const data = routes();
    data[`POST ${root}/stakeholder-events`] = {};
    const calls = await mount(data);
    change("Summary", "Consent requested");
    change("Date of the event", "2026-01-02");
    fireEvent.submit(screen.getByLabelText("Summary").closest("form")!);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
        summary: "Consent requested",
        occurredOn: "2026-01-02",
        status: "pending",
        evidence: null,
      }),
    );
  });
  it("records a matrix version with evidence rather than inheriting the reference label", async () => {
    const data = routes();
    data[`POST ${root}/facts/mineral_rights/confirmations`] = {};
    const calls = await mount(data);
    const panel = within(screen.getByTestId("fact-matrix"));
    fireEvent.change(panel.getByLabelText("Status"), { target: { value: "confirmed" } });
    fireEvent.change(panel.getByLabelText("Evidence id"), { target: { value: "receipt-1" } });
    fireEvent.change(panel.getByLabelText("Reason"), {
      target: { value: "Checked original source" },
    });
    fireEvent.submit(panel.getByLabelText("Status").closest("form")!);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
        status: "confirmed",
        evidence: { kind: "source_receipt", id: "receipt-1" },
      }),
    );
  });
  it("does not fetch a protected overview while disconnected", async () => {
    auth.token = null;
    const calls = await mount({});
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/No account is connected/)).toBeDefined();
  });
});
