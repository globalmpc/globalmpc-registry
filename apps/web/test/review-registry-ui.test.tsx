// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReviewRegistryPanel } from "../src/components/ReviewRegistryPanel";
import { mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({
  token: "token",
  loading: false,
  session: {
    subjectId: "reviewer",
    actions: ["review_registry.read", "review_registry.propose", "review_registry.approve"],
  },
}));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const root = "/api/v1/review-registry/policy-sets/proposals";
const proposal = {
  id: "proposal",
  itemKey: "gate-rules",
  itemVersion: "2",
  effectiveFrom: "2030-01-01",
  rationale: "Updated evidence",
  state: "pending",
  proposedBySubjectId: "other",
  version: 3,
};
function routes(): Record<string, unknown> {
  return { [`GET ${root}`]: { items: [proposal] } };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  render(<ReviewRegistryPanel />);
  if (auth.session.actions.includes("review_registry.read")) await screen.findByText("gate-rules");
  return calls;
}
beforeEach(() => {
  auth.session.actions = [
    "review_registry.read",
    "review_registry.propose",
    "review_registry.approve",
  ];
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("review registry separation of duties", () => {
  it("does not read the registry when the server grants no read action", async () => {
    auth.session.actions = [];
    const calls = await mount({});
    expect(calls).toHaveLength(0);
    expect(screen.queryByTestId("review-registry")).toBeNull();
  });
  it("does not offer to approve one's own proposal", async () => {
    const data = routes();
    data[`GET ${root}`] = { items: [{ ...proposal, proposedBySubjectId: "reviewer" }] };
    await mount(data);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.getByText(/someone else decides/)).toBeDefined();
  });
  it.each(["Approve", "Reject"])(
    "requires a reason and current version to %s",
    async (decision) => {
      const data = routes();
      data[`POST ${root}/proposal/decision`] = {};
      const calls = await mount(data);
      const button = screen.getByRole("button", { name: decision });
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.change(screen.getByLabelText("Decision reason"), {
        target: { value: " Evidence checked " },
      });
      fireEvent.click(button);
      await waitFor(() =>
        expect(calls.find((call) => call.method === "POST")?.body).toEqual({
          decision: decision.toLowerCase(),
          reason: "Evidence checked",
        }),
      );
      expect(calls.find((call) => call.method === "POST")?.headers.get("if-match")).toBe('"3"');
    },
  );
  it.each(["null", "[]", "42", "invalid"])(
    "rejects invalid proposal payload %s before sending a write",
    async (payload) => {
      const calls = await mount();
      fireEvent.change(screen.getByLabelText("Payload (JSON)"), { target: { value: payload } });
      fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "Evidence scope" } });
      fireEvent.click(screen.getByRole("button", { name: "Propose" }));
      await screen.findByText(/Payload (must be|is not)/);
      expect(calls.some((call) => call.method === "POST")).toBe(false);
    },
  );
  it("proposes an explicit payload and leaves creation to independent approval", async () => {
    const data = routes();
    data[`POST ${root}`] = proposal;
    const calls = await mount(data);
    fireEvent.change(screen.getByLabelText("Payload (JSON)"), {
      target: { value: '{"definition":{"ruleSetId":"scope"}}' },
    });
    fireEvent.change(screen.getByLabelText("Rationale"), { target: { value: "New scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Propose" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        definition: { ruleSetId: "scope" },
        rationale: "New scope",
      }),
    );
    expect(calls.some((call) => call.url.endsWith("/decision"))).toBe(false);
  });
  it.each([
    ["Attestation schemas", "attestation-schemas", "schemaKey"],
    ["Credentials", "credentials", "credentialType"],
    ["Jurisdiction profiles", "jurisdiction-profiles", "jurisdiction"],
  ])("uses the %s registry and resets its payload template", async (label, segment, field) => {
    const data = routes();
    data[`GET /api/v1/review-registry/${segment}/proposals`] = { items: [] };
    const calls = await mount(data);
    fireEvent.click(screen.getByRole("button", { name: label }));
    await waitFor(() => expect(calls.some((call) => call.url.includes(`/${segment}/`))).toBe(true));
    expect(
      JSON.parse((screen.getByLabelText("Payload (JSON)") as HTMLTextAreaElement).value),
    ).toHaveProperty(field!);
  });
});
