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
import Projects from "../src/app/w/projects/page";
import NewProject from "../src/app/w/projects/new/page";
import Readiness from "../src/app/w/projects/[id]/readiness/page";
import Anchors from "../src/app/w/anchors/page";
import { mockHttp } from "./support/http";
const state = vi.hoisted(() => ({
  token: "token" as string | null,
  loading: false,
  session: {
    authenticated: true,
    tenantId: "tenant1",
    roleBindings: [{ role: "mpc_operator" }],
  },
  push: vi.fn(),
}));
vi.mock("../src/lib/session", () => ({ useSession: () => state }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: state.push }) }));
beforeEach(() => {
  state.token = "token";
  state.loading = false;
  state.push.mockReset();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const org = { id: "o1", legalName: "Sponsor", jurisdiction: "MNG" };
it("registers under the selected owner and retains an idempotency key across retries", async () => {
  let fail = true;
  const calls = mockHttp({
    "GET /api/v1/organizations": {
      items: [org, { ...org, id: "o2", legalName: "Other" }],
    },
    "POST /api/v1/projects": () => {
      if (fail) throw new Error("Try again");
      return { id: "p1" };
    },
  });
  render(<NewProject />);
  await screen.findByText("Sponsor · MNG");
  expect(
    (screen.getByRole("button", { name: "Register" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  for (const [label, value] of [
    ["Project key", " SYNTH-1 "],
    ["Name", " Copper "],
    ["Host country (ISO3)", "mng"],
    ["Minerals (comma separated)", " copper, gold, "],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  fireEvent.change(screen.getByLabelText("Owning organization"), {
    target: { value: "o2" },
  });
  fireEvent.click(screen.getByLabelText("Synthetic test project"));
  fireEvent.submit(
    screen.getByRole("button", { name: "Register" }).closest("form")!,
  );
  await screen.findByRole("alert");
  fail = false;
  fireEvent.submit(
    screen.getByRole("button", { name: "Register" }).closest("form")!,
  );
  await waitFor(() =>
    expect(state.push).toHaveBeenCalledWith("/w/projects/p1"),
  );
  const posts = calls.filter((c) => c.method === "POST");
  expect(posts[0]?.body).toEqual({
    projectKey: "SYNTH-1",
    name: "Copper",
    hostCountryIso3: "MNG",
    minerals: ["copper", "gold"],
    ownerOrganizationId: "o2",
    referenceStatus: "synthetic_test_project",
  });
  expect(posts[0]?.headers.get("idempotency-key")).toBe(
    posts[1]?.headers.get("idempotency-key"),
  );
});
it("preselects the only organization, reports load errors, and avoids requests without a token", async () => {
  mockHttp({ "GET /api/v1/organizations": { items: [org] } });
  render(<NewProject />);
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Owning organization") as HTMLSelectElement).value,
    ).toBe("o1"),
  );
  cleanup();
  mockHttp({
    "GET /api/v1/organizations": () => {
      throw new Error("No organization access");
    },
  });
  render(<NewProject />);
  await screen.findByRole("alert");
  expect(screen.getByText("No organization available")).toBeTruthy();
  cleanup();
  state.token = null;
  const calls = mockHttp({});
  render(<NewProject />);
  expect(calls).toHaveLength(0);
});
const row = {
  id: "p1",
  projectKey: "MPC-1",
  name: "Copper",
  hostCountryIso3: "MNG",
  minerals: ["copper"],
  referenceStatus: "official_reference",
  lifecycleState: "suspended",
  projectRegistryStatus: "published",
  readinessSummary: "gap",
  weakestGrade: "verified",
  openStaleSignals: 2,
  ownerOrganizationName: "Sponsor",
  updatedAt: "2026-10-20",
};
it("renders project facts and sends every filter to the server, clearing filters explicitly", async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      return Response.json({
        items:
          requests.length === 1
            ? [
                row,
                {
                  ...row,
                  id: "p2",
                  projectKey: "MPC-2",
                  lifecycleState: "draft",
                  minerals: [],
                  referenceStatus: "none",
                  projectRegistryStatus: "none",
                  readinessSummary: null,
                  weakestGrade: null,
                  openStaleSignals: 0,
                },
              ]
            : [],
        truncated: true,
      });
    }),
  );
  render(<Projects />);
  await screen.findByTestId("project-list");
  expect(screen.getByText("2 stale signal(s)")).toBeTruthy();
  expect(screen.getByText("No claims")).toBeTruthy();
  for (const [label, value] of [
    ["Stage", "draft"],
    ["Host country (ISO3)", "mng"],
    ["Weakest grade", "verified"],
    ["Reference label", "official_reference"],
  ]) {
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    await waitFor(() =>
      expect(requests.at(-1)).toContain(
        encodeURIComponent(value === "mng" ? "MNG" : value!),
      ),
    );
  }
  for (const label of ["Assigned to me", "Has a gap", "Stale evidence"]) {
    await act(async () => fireEvent.click(screen.getByLabelText(label)));
  }
  expect(requests.at(-1)).toContain("assignment=mine");
  expect(requests.at(-1)).toContain("gap=true");
  expect(requests.at(-1)).toContain("stale=true");
  expect(screen.getByText(/No project matches these filters/)).toBeTruthy();
  for (const label of [
    "Stage",
    "Weakest grade",
    "Reference label",
    "Host country (ISO3)",
  ])
    await act(async () =>
      fireEvent.change(screen.getByLabelText(label), { target: { value: "" } }),
    );
  for (const label of ["Assigned to me", "Has a gap", "Stale evidence"])
    await act(async () => fireEvent.click(screen.getByLabelText(label)));
  expect(requests.at(-1)).toBe("/api/v1/projects");
  expect(screen.getByText(/No projects are registered/)).toBeTruthy();
});
it("displays project list errors and waits for session hydration", async () => {
  state.loading = true;
  const calls = mockHttp({
    "GET /api/v1/projects": () => {
      throw new Error("Network down");
    },
  });
  const view = render(<Projects />);
  expect(calls).toHaveLength(0);
  state.loading = false;
  view.rerender(<Projects />);
  await screen.findByRole("alert");
  cleanup();
  state.token = null;
  render(<Projects />);
  expect(screen.getByText(/No account is connected/)).toBeTruthy();
});
it("recomputes readiness without allowing edits and links to a separate human decision", async () => {
  let fail = false;
  const calls = mockHttp({
    "POST /api/v1/projects/p1/readiness-assessments": () => {
      if (fail) throw new Error("Assessment unavailable");
      return {
        id: "a1",
        status: "gap",
        requirementResults: [
          {
            requirementId: "license",
            status: "gap",
            applicable: true,
            reasonCode: "MISSING",
            cause: "License missing",
            neededEvidence: ["license"],
            nextAction: "Upload",
          },
          {
            requirementId: "other",
            status: "not_evaluable",
            applicable: false,
            reasonCode: "NA",
            cause: "Not applicable",
            neededEvidence: [],
            nextAction: null,
          },
        ],
        ruleSetVersion: "v2",
        canonicalResultHash: "hash1",
        evaluatedAsOf: "2026-10-20",
        authority: "policy",
        legalEffect: "none",
        limitations: ["No legal approval"],
      };
    },
  });
  await act(async () =>
    render(<Readiness params={Promise.resolve({ id: "p1" })} />),
  );
  fireEvent.change(screen.getByLabelText("Rule set ID"), {
    target: { value: "policy2" },
  });
  fireEvent.click(screen.getByText("Recompute"));
  await screen.findByText("Reproducibility");
  expect(calls[0]?.body).toEqual({ policySetId: "policy2" });
  expect(
    screen
      .getByRole("link", { name: /Record the human decision/ })
      .getAttribute("href"),
  ).toContain("/gates/");
  fail = true;
  fireEvent.click(screen.getByText("Recompute"));
  await screen.findByRole("alert");
  expect(screen.queryByText("Reproducibility")).toBeNull();
});
it("renders chain states distinctly, resubmits manually, and refreshes the batch list", async () => {
  const rows = [
    "confirmed",
    "included",
    "submitted",
    "proposed",
    "failed",
    "created",
  ].map((confirmationState, i) => ({
    id: `id${i}`,
    batchId: `0x${i}123456789abcdef`,
    confirmationState,
    confirmations: i,
    recordCount: 1,
    blockNumber: i || null,
    attempts: 1,
    reorgCount: i % 2,
    lastError: i === 4 ? "Reverted" : null,
    needsAttention: i === 4,
    proposal:
      i === 3
        ? { safeAddress: "0xsafe", calldataHash: "0xdata123456789abc" }
        : null,
  }));
  let fail = false;
  const calls = mockHttp({
    "GET /api/v1/anchor-batches": { items: rows, truncated: true },
    "POST /api/v1/anchor-batches/id4/resubmit": () => {
      if (fail) throw new Error("Resubmit refused");
      return {};
    },
  });
  render(<Anchors />);
  await screen.findByTestId("anchor-table");
  expect(screen.getByText("Not confirmed yet")).toBeTruthy();
  expect(screen.getByTestId("safe-proposal")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Resubmit" }));
  await waitFor(() =>
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(2),
  );
  fail = true;
  fireEvent.click(screen.getByRole("button", { name: "Resubmit" }));
  await screen.findByRole("alert");
});
