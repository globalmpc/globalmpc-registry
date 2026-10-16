// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Documents from "../src/app/w/projects/[id]/documents/page";
import { mockHttp } from "./support/http";
import type { DocumentStatusSummary } from "../src/lib/api";
const auth = vi.hoisted(() => ({ token: "token" as string | null, loading: false }));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const root = "/api/v1/projects/p1";
const item = (uploadId: string) => ({
  uploadId,
  originalFilename: `${uploadId}.pdf`,
  documentType: "license",
  tier: "required",
  status: "expired",
  validUntil: "2026-01-01",
  daysUntilExpiry: -2,
  openImpactCount: 1,
});
function summary(): DocumentStatusSummary {
  return {
    projectId: "p1",
    today: "2026-01-03",
    totals: {
      all: 2,
      current: 1,
      expired: 1,
      superseded: 0,
      pending: 0,
      unusable: 0,
      untyped: 1,
      withoutValidUntil: 1,
      openImpacts: 1,
    },
    tiers: [
      {
        tier: "required",
        declared: 1,
        met: 0,
        expired: 1,
        missing: 0,
        pending: 0,
        incomplete: true,
      },
    ],
    requirements: [
      {
        requirement: {
          id: "requirement",
          projectId: "p1",
          documentType: "license",
          tier: "required",
          note: "Needed before review",
          createdBy: "operator",
          createdAt: "2026-01-01",
          retiredAt: null,
          retirementNote: null,
        },
        status: "expired",
        currentCount: 0,
        expiredCount: 1,
        pendingCount: 0,
        supersededCount: 0,
        nearestValidUntil: "2026-01-01",
        daysUntilExpiry: -2,
      },
    ],
    undeclaredTypes: [
      {
        documentType: "unclassified",
        currentCount: 1,
        expiredCount: 0,
        pendingCount: 0,
        supersededCount: 0,
      },
    ],
    undeclaredTypesTruncated: true,
    nextExpiries: [
      { uploadId: "soon", documentType: "permit", validUntil: "2026-01-05", daysUntilExpiry: 2 },
    ],
  };
}
function routes(): Record<string, unknown> {
  return {
    [`GET ${root}/document-status`]: summary(),
    [`GET ${root}/documents?limit=50`]: { items: [item("expired")], nextCursor: null },
  };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  await act(async () => {
    render(<Documents params={Promise.resolve({ id: "p1" })} />);
  });
  if (auth.token) await screen.findByText("expired.pdf");
  return calls;
}
beforeEach(() => {
  auth.token = "token";
  auth.loading = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("project document requirements", () => {
  it("does not fetch protected document lists when signed out", async () => {
    auth.token = null;
    const calls = await mount({});
    expect(calls).toHaveLength(0);
    expect(screen.getByText(/No account is connected/)).toBeDefined();
  });
  it("declares a tier with its audit note and refreshes actual coverage", async () => {
    const data = routes();
    data[`POST ${root}/document-requirements`] = {};
    const calls = await mount(data);
    fireEvent.change(screen.getByLabelText("Document type", { selector: "input" }), {
      target: { value: " report " },
    });
    fireEvent.change(screen.getByLabelText("Note"), {
      target: { value: " Required by review scope " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Declare type" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        documentType: "report",
        tier: "required",
        note: "Required by review scope",
      }),
    );
  });
  it("retains a reason when retiring an obsolete requirement", async () => {
    const data = routes();
    data["POST /api/v1/document-requirements/requirement/retirement"] = {};
    const calls = await mount(data);
    const retire = screen.getByRole("button", { name: "Retire" });
    expect(retire.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason to retire license"), {
      target: { value: " Scope changed " },
    });
    fireEvent.click(retire);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        reason: "Scope changed",
      }),
    );
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });
  it("filters expired documents on the server and can clear the filter", async () => {
    const data = routes();
    data[`GET ${root}/documents?status=expired&limit=50`] = {
      items: [item("filtered")],
      nextCursor: null,
    };
    const calls = await mount(data);
    fireEvent.click(screen.getByRole("button", { name: /Expired 1/ }));
    await screen.findByText("filtered.pdf");
    expect(screen.queryByText("expired.pdf")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await screen.findByText("expired.pdf");
    expect(calls.filter((call) => call.url.endsWith("documents?limit=50"))).toHaveLength(2);
  });
  it("appends cursor pages rather than replacing the first page", async () => {
    const data = routes();
    data[`GET ${root}/documents?limit=50`] = { items: [item("expired")], nextCursor: "next" };
    data[`GET ${root}/documents?limit=50&cursor=next`] = {
      items: [item("second")],
      nextCursor: null,
    };
    await mount(data);
    fireEvent.click(screen.getByRole("button", { name: /Show more/ }));
    await screen.findByText("second.pdf");
    expect(screen.getByText("expired.pdf")).toBeDefined();
  });
  it("uses an undeclared type to prefill a declaration without inventing a requirement", async () => {
    const calls = await mount();
    fireEvent.click(screen.getByRole("button", { name: "unclassified" }));
    expect(
      (screen.getByLabelText("Document type", { selector: "input" }) as HTMLInputElement).value,
    ).toBe("unclassified");
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
  it("preserves the requested requirement after server rejection", async () => {
    const data = routes();
    data[`POST ${root}/document-requirements`] = Response.json(
      {
        code: "CONFLICT",
        message: "Requirement exists",
        retryable: false,
        correlationId: "requirement",
      },
      { status: 409 },
    );
    await mount(data);
    fireEvent.change(screen.getByLabelText("Document type", { selector: "input" }), {
      target: { value: "license" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Declare type" }));
    await screen.findByText("Requirement exists");
    expect(
      (screen.getByLabelText("Document type", { selector: "input" }) as HTMLInputElement).value,
    ).toBe("license");
  });
});
