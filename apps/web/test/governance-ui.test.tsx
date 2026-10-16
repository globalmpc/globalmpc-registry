// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Governance from "../src/app/w/governance/page";
import { mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({
  token: "token" as string | null,
  loading: false,
  session: { roleBindings: [{ role: "protocol_proposer" }] },
}));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const root = "/api/v1/governance/proposals";
const proposal = (state = "voting", space = "protocol") => ({
  id: "proposal",
  title: "Review schema",
  rationale: "Improve scope",
  state,
  space,
  version: 4,
  conflictDisclosure: "No conflict known",
  executionMode: "record_only",
  execution: { state: null, records: [] },
  tally: {
    forWeight: "20",
    againstWeight: "10",
    abstainWeight: "0",
    reason: "Quorum not met",
    provisionalOutcome: "no_quorum",
    quorumMet: false,
  },
  quorum: { numerator: 1, denominator: 4 },
  eligibleWeight: "1000",
  eligibleWeightSource: "manual",
  weightSource: "manual",
});
function routes(): Record<string, unknown> {
  return {
    [`GET ${root}`]: { items: [proposal()], truncated: false },
    "GET /api/v1/public/governance/centralization": {
      currentStage: "G0",
      centralizedPowers: ["pause"],
      governanceRoles: [{ role: "mpc_operator", power: "administer", activeHolders: 1 }],
      anchor: { contracts: [], note: "No deployment" },
      stages: [{ stage: "G0", current: true, description: "Initial operation" }],
      transitionCriteria: { note: "Not yet met", candidates: ["independent review"] },
      limitations: ["Not legal approval"],
    },
  };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  render(<Governance />);
  if (auth.token) await screen.findByTestId("proposal-table");
  return calls;
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => {
  auth.token = "token";
  auth.session.roleBindings = [{ role: "protocol_proposer" }];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("governance authority and evidence", () => {
  it("does not treat a proposal as a legal approval", async () => {
    await mount();
    expect(screen.getByTestId("governance-boundary").textContent).toMatch(/legal|approval/);
    expect(screen.getByTestId("weight-source-proposal").textContent).toContain("Entered manually");
    expect(screen.getByTestId("quorum-proposal").textContent).toContain("Not met");
    expect(await screen.findByTestId("governance-stage")).toBeDefined();
  });
  it("requires an eligible denominator and conflict disclosure before proposing", async () => {
    const data = routes();
    data[`POST ${root}`] = proposal("draft");
    const calls = await mount(data);
    change("Title", " New schema ");
    change("Rationale (required)", " Better scope ");
    const create = screen.getByTestId("create-proposal");
    expect(create.hasAttribute("disabled")).toBe(true);
    change("Eligible weight (required)", "1000");
    change("Conflict disclosure (required)", " none known ");
    fireEvent.click(create);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
        space: "protocol",
        projectId: null,
        title: "New schema",
        rationale: "Better scope",
        eligibleWeight: "1000",
        conflictDisclosure: "none known",
        executionMode: "record_only",
      }),
    );
  });
  it("requires a project scope for a project proposer", async () => {
    auth.session.roleBindings = [{ role: "project_proposer" }];
    const data = routes();
    data[`POST ${root}`] = proposal("draft", "project");
    const calls = await mount(data);
    change("Title", "Project valuation");
    change("Rationale (required)", "Independent valuation needed");
    change("Eligible weight (required)", "1000");
    change("Conflict disclosure (required)", "none");
    expect(screen.getByTestId("create-proposal").hasAttribute("disabled")).toBe(true);
    change("Project ID", "p1");
    fireEvent.click(screen.getByTestId("create-proposal"));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
        space: "project",
        projectId: "p1",
        proposalType: "independent_valuation_request",
      }),
    );
  });
  it("does not offer voting or proposing to an operator", async () => {
    auth.session.roleBindings = [{ role: "mpc_operator" }];
    await mount();
    expect(screen.queryByTestId("create-proposal")).toBeNull();
    expect(screen.queryByTestId("vote-for-proposal")).toBeNull();
  });
  it.each(["for", "against", "abstain"])(
    "records a %s vote only in the voter's space",
    async (choice) => {
      auth.session.roleBindings = [{ role: "protocol_voter" }];
      const data = routes();
      data[`POST ${root}/proposal/votes`] = proposal();
      const calls = await mount(data);
      change("Vote weight", "25");
      fireEvent.click(screen.getByTestId(`vote-${choice}-proposal`));
      await waitFor(() =>
        expect(calls.find((call) => call.method === "POST")?.body).toEqual({
          choice,
          weight: "25",
        }),
      );
      expect(screen.queryByTestId("create-proposal")).toBeNull();
    },
  );
  it("does not let a protocol voter vote on a project proposal", async () => {
    auth.session.roleBindings = [{ role: "protocol_voter" }];
    const data = routes();
    data[`GET ${root}`] = { items: [proposal("voting", "project")] };
    await mount(data);
    expect(screen.queryByTestId("vote-for-proposal")).toBeNull();
  });
  it.each([
    ["draft", "review"],
    ["review", "announced"],
    ["announced", "voting"],
    ["voting", "no_quorum"],
    ["succeeded", "timelocked"],
    ["timelocked", "recorded"],
    ["recorded", "execution_pending"],
  ])("advances %s only to %s with a reason and version", async (state, next) => {
    const data = routes();
    data[`GET ${root}`] = { items: [proposal(state)], truncated: false };
    data[`POST ${root}/proposal/transitions`] = proposal(next);
    const calls = await mount(data);
    const button = screen.getByTestId(`advance-${next}-proposal`);
    expect(button.hasAttribute("disabled")).toBe(true);
    change("Reason for the state change (required)", " Evidence checked ");
    fireEvent.click(button);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        toState: next,
        reason: "Evidence checked",
      }),
    );
    expect(calls.find((call) => call.method === "POST")?.headers.get("if-match")).toBe('"4"');
  });
  it("binds an execution record to one selected proposal and its evidence hash", async () => {
    auth.session.roleBindings = [{ role: "execution_recorder" }];
    const data = routes();
    data[`GET ${root}`] = { items: [proposal("execution_pending")], truncated: false };
    data[`POST ${root}/proposal/execution-records`] = proposal("executed");
    const calls = await mount(data);
    expect(screen.getByTestId("record-executed-proposal").hasAttribute("disabled")).toBe(true);
    for (const [label, value] of [
      ["For proposal", "proposal"],
      ["Executed by", "Operator"],
      ["Under authority", "Recorded decision"],
      ["What was executed", "Published rule"],
      ["Evidence reference", "private:record-1"],
      ["Evidence hash (0x + 64 hex)", `0x${"ab".repeat(32)}`],
      ["What this record does not establish", "No legal approval"],
    ])
      change(label!, value!);
    fireEvent.click(screen.getByTestId("record-executed-proposal"));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
        outcome: "executed",
        evidenceHash: `0x${"ab".repeat(32)}`,
        limitations: ["No legal approval"],
      }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText("Executed by") as HTMLInputElement).value).toBe(""),
    );
  });
  it("keeps a failed proposal editable and displays the server's error", async () => {
    const data = routes();
    data[`POST ${root}`] = Response.json(
      {
        code: "CONFLICT",
        message: "Already proposed",
        retryable: false,
        correlationId: "proposal",
      },
      { status: 409 },
    );
    await mount(data);
    change("Title", "New schema");
    change("Rationale (required)", "Scope");
    change("Eligible weight (required)", "1000");
    change("Conflict disclosure (required)", "none");
    fireEvent.click(screen.getByTestId("create-proposal"));
    await screen.findByText("Already proposed");
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("New schema");
  });
  it("does not load governance proposals without authentication", async () => {
    auth.token = null;
    const calls = await mount({});
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/No account is connected/)).toBeDefined();
  });
});
