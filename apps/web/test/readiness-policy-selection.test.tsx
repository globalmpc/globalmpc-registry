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
import Readiness from "../src/app/w/projects/[id]/readiness/page";
import Gate from "../src/app/w/projects/[id]/gates/[gateId]/page";
import { mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({
  token: "session" as string | null,
  session: {
    tenantId: "tenant-a",
    subjectId: "operator-a",
    actions: ["readiness.recompute", "registry.read", "gate.decide"],
  },
}));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
beforeEach(() => {
  auth.token = "session";
  auth.session.subjectId = "operator-a";
  auth.session.actions = [
    "readiness.recompute",
    "registry.read",
    "gate.decide",
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const policy = (id = "actual-policy") => ({
  id,
  ruleSetId: "approved-readiness",
  version: "2.0.0",
  gateId: "registry_publication",
  jurisdictionProfile: "MNG",
  effectiveFrom: "2026-01-01T00:00:00Z",
});
const result = {
  id: "assessment-a",
  status: "gap",
  requirementResults: [],
  canonicalResultHash: "hash",
  evaluatedAsOf: "2026-01-01",
  ruleSetVersion: "2.0.0",
  authority: "policy",
  legalEffect: "none",
  limitations: [],
};
const url = "GET /api/v1/projects/p1/readiness-policy-options";
async function mount(gate = false) {
  await act(async () => {
    render(
      gate ? (
        <Gate
          params={Promise.resolve({ id: "p1", gateId: "registry_publication" })}
        />
      ) : (
        <Readiness params={Promise.resolve({ id: "p1" })} />
      ),
    );
  });
}
it("uses the actual tenant policy rather than a seed UUID", async () => {
  const calls = mockHttp({
    [url]: { items: [policy()] },
    "POST /api/v1/projects/p1/readiness-assessments": result,
  });
  await mount();
  expect(
    (
      (await screen.findByRole("combobox", {
        name: "Rule set",
      })) as HTMLSelectElement
    ).value,
  ).toBe("actual-policy");
  fireEvent.click(screen.getByRole("button", { name: "Recompute" }));
  await screen.findByText("Reproducibility");
  expect(calls.find((call) => call.method === "POST")?.body).toEqual({
    policySetId: "actual-policy",
  });
});
it("explains missing configuration and prevents a guaranteed failing recomputation", async () => {
  const calls = mockHttp({ [url]: { items: [] } });
  await mount();
  await screen.findByText("No effective rule set is available");
  expect(
    (screen.getByRole("button", { name: "Recompute" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    screen
      .getByRole("link", { name: "Open review registries →" })
      .getAttribute("href"),
  ).toBe("/w/registries");
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
});
it("requires a choice among multiple versions and clears a result when the policy changes", async () => {
  mockHttp({
    [url]: { items: [policy("first"), policy("second")] },
    "POST /api/v1/projects/p1/readiness-assessments": result,
  });
  await mount();
  const select = await screen.findByRole("combobox", { name: "Rule set" });
  expect(
    (screen.getByRole("button", { name: "Recompute" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(select, { target: { value: "second" } });
  fireEvent.click(screen.getByRole("button", { name: "Recompute" }));
  await screen.findByText("Reproducibility");
  fireEvent.change(select, { target: { value: "first" } });
  expect(screen.queryByText("Reproducibility")).toBeNull();
});
it("recovers option loading failures through an explicit retry", async () => {
  let fail = true;
  mockHttp({
    [url]: () => {
      if (fail) throw new Error("Options unavailable");
      return { items: [policy()] };
    },
  });
  await mount();
  await screen.findByRole("alert");
  expect(
    (screen.getByRole("button", { name: "Recompute" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Retry rule sets" }));
  await screen.findByRole("combobox", { name: "Rule set" });
});
it("gate decisions request only their gate's policies and send the selected ID", async () => {
  const calls = mockHttp({
    [url + "?gateId=registry_publication"]: { items: [policy()] },
    "POST /api/v1/projects/p1/readiness-assessments": result,
  });
  await mount(true);
  await screen.findByRole("combobox", { name: "Rule set" });
  fireEvent.click(
    screen.getByRole("button", { name: "Load current readiness" }),
  );
  await waitFor(() =>
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      policySetId: "actual-policy",
    }),
  );
});
it("does not request options for a session lacking recomputation authority", async () => {
  auth.session.actions = [];
  const calls = mockHttp({});
  await mount();
  expect(
    screen.getByText("Your current session cannot recompute readiness."),
  ).toBeTruthy();
  expect(calls).toHaveLength(0);
});
it("drops old options and assessments when the account changes", async () => {
  let finish: ((value: unknown) => void) | undefined;
  let initial = true;
  mockHttp({
    [url]: () => {
      if (initial) {
        initial = false;
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return { items: [policy("new-account-policy")] };
    },
  });
  const params = Promise.resolve({ id: "p1" });
  let view: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Readiness params={params} />);
  });
  auth.session.subjectId = "operator-b";
  await act(async () => {
    view!.rerender(<Readiness params={params} />);
  });
  await screen.findByRole("combobox", { name: "Rule set" });
  await act(async () => {
    finish?.({ items: [policy("old-account-policy")] });
  });
  expect(
    (screen.getByRole("combobox", { name: "Rule set" }) as HTMLSelectElement)
      .value,
  ).toBe("new-account-policy");
});

it("opens the gate belonging to the assessed policy", async () => {
  mockHttp({
    [url]: { items: [{ ...policy(), gateId: "stage.exploration" }] },
    "POST /api/v1/projects/p1/readiness-assessments": result,
  });
  await mount();
  await screen.findByRole("combobox", { name: "Rule set" });
  fireEvent.click(screen.getByRole("button", { name: "Recompute" }));
  const link = await screen.findByRole("link", { name: "Record the human decision →" });
  expect(link.getAttribute("href")).toBe("/w/projects/p1/gates/stage.exploration");
});
