// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CatalogClaimForm } from "../src/components/CatalogClaimForm";
import {
  EvidenceLedger,
  EvidenceLedgerWarnings,
  WorkspaceEvidenceLedger,
} from "../src/components/EvidenceLedger";
import { mockHttp } from "./support/http";
import type { LedgerSummary } from "../src/lib/evidence-ledger-api";
import type { ObjectUpload } from "../src/lib/api";

const entry = {
  id: "catalog-1",
  claimType: "licence",
  catalogVersion: 2,
  displayName: "Licence",
  description: null,
  definition: {
    fields: [
      {
        key: "number",
        label: "Licence number",
        type: "string",
        required: true,
      },
      { key: "valid", label: "Valid", type: "boolean", required: true },
      { key: "area", label: "Area", type: "number", required: false },
    ],
  },
};
const summary: LedgerSummary = {
  evaluatedAt: "2026-10-23T00:00:00Z",
  inputSnapshotHash: "0x123",
  items: [
    {
      claimType: "licence",
      displayName: "Licence",
      grade: "partially_verified",
      reviewScope: ["licence"],
      reviews: [
        {
          reviewerHandle: `0x${"ab".repeat(32)}`,
          credentialType: "competent_person",
          attestationType: "professional_signoff",
          signedAt: "2026-10-23T00:00:00Z",
          limitations: "Scope excludes site inspection",
        },
      ],
      status: "reviewed",
      reasons: [],
      limitations: ["Desk review only"],
    },
  ],
  stages: [
    {
      gateId: "stage.exploration",
      ruleSetVersion: "1",
      status: "ok",
      missing: [],
      reviewedItems: "1",
      requiredItems: "2",
    },
  ],
  currentStage: "stage.exploration",
  limitations: ["Not legal approval"],
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe("catalog claim and evidence assessment", () => {
  it("pins chosen definition, preserves false and decimal precision, and only offers scanned documents", async () => {
    const calls = mockHttp({
      "GET /api/v1/claim-types": { items: [entry], nextCursor: null },
      "POST /api/v1/projects/p1/claims": { id: "claim-1" },
    });
    const saved = vi.fn(async () => {});
    render(
      <CatalogClaimForm
        token="token"
        projectId="p1"
        uploads={
          [
            {
              id: "clean",
              state: "scanned_clean",
              originalFilename: "clean.pdf",
              revokedAt: null,
            },
            { id: "bad", state: "quarantined", originalFilename: "unsafe.pdf", revokedAt: null },
            { id: "promoted", state: "promoted", originalFilename: "promoted.pdf", revokedAt: null },
            { id: "revoked-clean", state: "scanned_clean", originalFilename: "revoked-clean.pdf", revokedAt: "2026-10-23T00:00:00Z" },
            { id: "revoked-promoted", state: "promoted", originalFilename: "revoked-promoted.pdf", revokedAt: "2026-10-23T00:00:00Z" },
          ] as ObjectUpload[]
        }
        onSaved={saved}
      />,
    );
    await screen.findByLabelText("Claim definition");
    fireEvent.change(screen.getByLabelText("Claim definition"), {
      target: { value: "catalog-1" },
    });
    fireEvent.change(screen.getByLabelText("Licence number (required)"), {
      target: { value: "LIC-1" },
    });
    fireEvent.change(screen.getByLabelText("Valid (required)"), {
      target: { value: "false" },
    });
    fireEvent.change(screen.getByLabelText("Area (optional)"), {
      target: { value: "12345678901234567890.12" },
    });
    const areaInput = screen.getByLabelText(
      "Area (optional)",
    ) as HTMLInputElement;
    expect(new RegExp(`^(?:${areaInput.pattern})$`).test(areaInput.value)).toBe(
      true,
    );
    expect(new RegExp(`^(?:${areaInput.pattern})$`).test("12e9")).toBe(false);
    expect(screen.queryByText("unsafe.pdf")).toBeNull();
    expect(screen.queryByRole("option", { name: "revoked-clean.pdf" })).toBeNull();
    expect(screen.queryByRole("option", { name: "revoked-promoted.pdf" })).toBeNull();
    expect(screen.getByRole("option", { name: "promoted.pdf" })).toBeDefined();
    fireEvent.change(screen.getByLabelText("Claim supporting document"), {
      target: { value: "clean" },
    });
    fireEvent.change(screen.getByLabelText("Claim source reference"), {
      target: { value: "Licence page 1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save catalog claim" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      catalogEntryId: "catalog-1",
      claimType: "licence",
      structuredValues: {
        number: "LIC-1",
        valid: false,
        area: "12345678901234567890.12",
      },
      documentUploadIds: ["clean"],
      asOf: null,
    });
    expect(
      (screen.getByLabelText("Licence number (required)") as HTMLInputElement)
        .value,
    ).toBe("");
  });
  it("requires a new document choice if the selected upload is revoked on refresh", async () => {
    const calls = mockHttp({
      "GET /api/v1/claim-types": { items: [entry], nextCursor: null },
      "POST /api/v1/projects/p1/claims": { id: "claim-1" },
    });
    const saved = vi.fn(async () => {});
    const upload = { id: "clean", state: "promoted", originalFilename: "clean.pdf", revokedAt: null } as ObjectUpload;
    const { rerender } = render(<CatalogClaimForm token="token" projectId="p1" uploads={[upload]} onSaved={saved} />);
    fireEvent.change(await screen.findByLabelText("Claim definition"), { target: { value: "catalog-1" } });
    fireEvent.change(screen.getByLabelText("Licence number (required)"), { target: { value: "LIC-1" } });
    fireEvent.change(screen.getByLabelText("Valid (required)"), { target: { value: "false" } });
    fireEvent.change(screen.getByLabelText("Claim supporting document"), { target: { value: "clean" } });
    fireEvent.change(screen.getByLabelText("Claim source reference"), { target: { value: "Page 1" } });
    rerender(<CatalogClaimForm token="token" projectId="p1" uploads={[{ ...upload, revokedAt: "2026-10-23T00:00:00Z" }]} onSaved={saved} />);
    fireEvent.submit(screen.getByLabelText("Claim source reference").closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain("selected document is no longer available");
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    expect(screen.queryByRole("option", { name: "clean.pdf" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Claim supporting document"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save catalog claim" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ documentUploadIds: [] });
  });
  it("retains entered values and retries an uncertain save with the same idempotency key", async () => {
    let attempt = 0;
    const calls = mockHttp({
      "GET /api/v1/claim-types": { items: [entry], nextCursor: null },
      "POST /api/v1/projects/p1/claims": () => {
        attempt += 1;
        if (attempt === 1)
          return new Response(
            JSON.stringify({
              code: "UNAVAILABLE",
              message: "Retry this request",
              retryable: true,
              correlationId: "test",
            }),
            { status: 503 },
          );
        return { id: "claim-1" };
      },
    });
    const saved = vi.fn(async () => {});
    render(
      <CatalogClaimForm
        token="token"
        projectId="p1"
        uploads={[]}
        onSaved={saved}
      />,
    );
    fireEvent.change(await screen.findByLabelText("Claim definition"), {
      target: { value: "catalog-1" },
    });
    fireEvent.change(screen.getByLabelText("Licence number (required)"), {
      target: { value: "LIC-1" },
    });
    fireEvent.change(screen.getByLabelText("Valid (required)"), {
      target: { value: "false" },
    });
    fireEvent.change(screen.getByLabelText("Claim source reference"), {
      target: { value: "Page 1" },
    });
    fireEvent.change(screen.getByLabelText("Claim as-of date (optional)"), {
      target: { value: "2024-02-29" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save catalog claim" }));
    await screen.findByText("Retry this request");
    expect(
      (screen.getByLabelText("Licence number (required)") as HTMLInputElement)
        .value,
    ).toBe("LIC-1");
    expect(
      (screen.getByLabelText("Claim as-of date (optional)") as HTMLInputElement)
        .value,
    ).toBe("2024-02-29");
    fireEvent.click(screen.getByRole("button", { name: "Save catalog claim" }));
    await waitFor(() => expect(saved).toHaveBeenCalledOnce());
    const posts = calls.filter((call) => call.method === "POST");
    expect(posts[0]!.body).toMatchObject({ asOf: "2024-02-29" });
    expect(posts[1]!.body).toMatchObject({ asOf: "2024-02-29" });
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers.get("idempotency-key")).toBe(
      posts[1]!.headers.get("idempotency-key"),
    );
  });
  it.each(["2025-02-29", "0000-01-01", "9999-12-31"])(
    "rejects invalid or future claim date %s before sending",
    async (date) => {
      const calls = mockHttp({
        "GET /api/v1/claim-types": { items: [entry], nextCursor: null },
        "POST /api/v1/projects/p1/claims": { id: "claim-1" },
      });
      render(
        <CatalogClaimForm
          token="token"
          projectId="p1"
          uploads={[]}
          onSaved={async () => {}}
        />,
      );
      fireEvent.change(await screen.findByLabelText("Claim definition"), {
        target: { value: "catalog-1" },
      });
      fireEvent.change(screen.getByLabelText("Claim source reference"), {
        target: { value: "Page 1" },
      });
      const input = screen.getByLabelText(
        "Claim as-of date (optional)",
      ) as HTMLInputElement;
      // Bypass native validation to check the guard before any API request.
      input.setAttribute("type", "text");
      fireEvent.change(input, { target: { value: date } });
      fireEvent.submit(input.closest("form")!);
      expect((await screen.findByRole("alert")).textContent).toBe(
        "Choose a real claim date on or before today (UTC).",
      );
      expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
    },
  );
  it("keeps approval-time assessment separate from current warnings", () => {
    render(
      <>
        <EvidenceLedger summary={summary} title="Approved evidence" />
        <EvidenceLedgerWarnings
          current={{
            evaluatedAt: "2026-10-24T00:00:00Z",
            warnings: [
              {
                claimType: "licence",
                status: "needs_re_review",
                reasons: ["Document expired"],
              },
            ],
          }}
        />
      </>,
    );
    expect(screen.getByTestId("ledger-status-licence").textContent).toBe(
      "Reviewed",
    );
    expect(screen.getByTestId("evidence-ledger-current").textContent).toContain(
      "Needs another review",
    );
    expect(
      screen.getByText("Desk review only", { exact: false }),
    ).toBeDefined();
    expect(screen.getByText("Not legal approval")).toBeDefined();
    expect(
      screen.getByText("Evidence grade: Partially verified"),
    ).toBeDefined();
    expect(screen.getByText("Reviewed item scope: Licence")).toBeDefined();
    expect(screen.queryByText("stage.exploration")).toBeNull();
    expect(screen.getAllByText("Exploration")).toHaveLength(2);
    expect(screen.getByText(/Reviewed 1 \/ 2 required items/)).toBeDefined();
    expect(
      screen.getByRole("list", { name: "Scoped reviews for Licence" })
        .textContent,
    ).toContain("competent_person");
    expect(screen.getByText("Scope excludes site inspection")).toBeDefined();
  });
  it("reports unavailable assessment rather than showing missing data as success", async () => {
    mockHttp({
      "GET /api/v1/projects/p1/evidence-ledger": new Response(
        JSON.stringify({
          code: "UNAVAILABLE",
          message: "Assessment unavailable",
          retryable: true,
          correlationId: "test",
        }),
        { status: 503 },
      ),
    });
    await act(async () => {
      render(<WorkspaceEvidenceLedger token="token" projectId="p1" />);
    });
    expect(
      await screen.findByRole("heading", {
        name: "Current evidence assessment unavailable",
      }),
    ).toBeDefined();
    expect(screen.queryByText(/No catalog items assessed/)).toBeNull();
  });
  it("supports paginated definitions without silently truncating the selector", async () => {
    mockHttp({
      "GET /api/v1/claim-types": { items: [entry], nextCursor: "licence" },
      "GET /api/v1/claim-types?cursor=licence": {
        items: [
          {
            ...entry,
            id: "catalog-2",
            claimType: "permit",
            displayName: "Permit",
          },
        ],
        nextCursor: null,
      },
    });
    render(
      <CatalogClaimForm
        token="token"
        projectId="p1"
        uploads={[]}
        onSaved={async () => {}}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Load more definitions" }),
    );
    expect(
      await screen.findByRole("option", { name: "Permit · v2" }),
    ).toBeDefined();
    expect(
      screen.queryByRole("button", { name: "Load more definitions" }),
    ).toBeNull();
  });
});
