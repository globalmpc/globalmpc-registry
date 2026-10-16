// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Impacts from "../src/app/w/projects/[id]/impacts/page";
import { mockHttp } from "./support/http";
import { documentNode } from "./support/documents";
const auth = vi.hoisted(() => ({ token: "token" as string | null, loading: false }));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const root = "/api/v1/projects/p1";
const impact = (id: string, depth = 0) => ({
  id,
  uploadId: depth ? "report" : "license",
  originUploadId: "license",
  successorUploadId: "replacement",
  cause: "superseded",
  depth,
  viaUploadId: depth ? "license" : null,
  viaKind: depth ? "depends_on" : null,
  resolution: "open",
  resolvedBy: null,
  revisedByUploadId: null,
  resolutionNote: null,
  nextActions: [],
  detectedAt: "2026-01-01",
});
function routes(): Record<string, unknown> {
  return {
    [`GET ${root}/document-graph`]: {
      nodes: [documentNode("license"), documentNode("report"), documentNode("replacement")],
    },
    [`GET ${root}/document-impacts`]: {
      items: [
        impact("self"),
        impact("downstream", 1),
        {
          ...impact("closed"),
          resolution: "no_change_needed",
          resolutionNote: "Already checked",
          resolvedAt: "2026-01-02",
        },
      ],
      truncated: true,
      total: 4,
    },
  };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  await act(async () => {
    render(<Impacts params={Promise.resolve({ id: "p1" })} />);
  });
  if (auth.token) await screen.findByTestId("impact-select-self");
  return calls;
}
beforeEach(() => {
  auth.token = "token";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("document change judgments", () => {
  it("shows open impact trees separately from previously judged records", async () => {
    await mount();
    expect(screen.getByTestId("impact-group-license").textContent).toContain("report.pdf");
    expect(screen.getByTestId("impacts-closed").textContent).toContain("Already checked");
    expect(screen.getByTestId("impacts-truncated")).toBeDefined();
  });
  it.each(["no_change_needed", "not_applicable"])(
    "records %s only with explicit selection and a reason",
    async (resolution) => {
      const data = routes();
      data[`POST ${root}/document-impacts/resolutions`] = {};
      const calls = await mount(data);
      const button = screen.getByRole("button", { name: "Apply to 0 selected" });
      expect(button.hasAttribute("disabled")).toBe(true);
      fireEvent.click(screen.getByTestId("impact-select-downstream"));
      fireEvent.change(screen.getByLabelText("Judgment"), { target: { value: resolution } });
      fireEvent.change(screen.getByLabelText("Reason"), {
        target: { value: " Source still applies " },
      });
      fireEvent.click(screen.getByRole("button", { name: "Apply to 1 selected" }));
      await waitFor(() =>
        expect(calls.find((call) => call.method === "POST")?.body).toEqual({
          impactIds: ["downstream"],
          resolution,
          note: "Source still applies",
        }),
      );
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Apply to 0 selected" })).toBeDefined(),
      );
    },
  );
  it("retains a failed selection so the reviewer can adjust a conflicting judgment", async () => {
    const data = routes();
    data[`POST ${root}/document-impacts/resolutions`] = Response.json(
      { code: "CONFLICT", message: "Already resolved", retryable: false, correlationId: "impact" },
      { status: 409 },
    );
    await mount(data);
    fireEvent.click(screen.getByTestId("impact-select-self"));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Checked" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply to 1 selected" }));
    await screen.findByText("Already resolved");
    expect((screen.getByTestId("impact-select-self") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByTestId("impact-select-self"));
    expect(
      screen.getByRole("button", { name: "Apply to 0 selected" }).hasAttribute("disabled"),
    ).toBe(true);
  });
  it("does not load private impact records when disconnected", async () => {
    auth.token = null;
    const calls = await mount({});
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/No account is connected/)).toBeDefined();
  });
});
