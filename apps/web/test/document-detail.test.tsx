// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { File } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Document from "../src/app/w/projects/[id]/documents/[uploadId]/page";
import { mockHttp } from "./support/http";
import { documentNode } from "./support/documents";
const auth = vi.hoisted(() => ({ token: "token" as string | null, loading: false }));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const graphUrl = "GET /api/v1/projects/p1/document-graph?focus=doc";
function routes(): Record<string, unknown> {
  return {
    [graphUrl]: {
      nodes: [documentNode("doc"), documentNode("other")],
      links: [],
      truncated: false,
      limit: 50,
      totalNodes: 2,
    },
    "GET /api/v1/uploads/doc/impact-preview": { items: [] },
  };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  await act(async () => {
    render(<Document params={Promise.resolve({ id: "p1", uploadId: "doc" })} />);
  });
  if (auth.token) await screen.findByRole("heading", { name: "Profile" });
  return calls;
}
beforeEach(() => {
  auth.token = "token";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("document provenance", () => {
  it("does not load protected documents while disconnected", async () => {
    auth.token = null;
    const calls = await mount({});
    expect(screen.getByText(/No account is connected/)).toBeDefined();
    expect(calls).toHaveLength(0);
  });
  it("saves only changed profile fields with the current version", async () => {
    const data = routes();
    data["PATCH /api/v1/uploads/doc/document-profile"] = {};
    const calls = await mount(data);
    expect(screen.getByRole("button", { name: "Save profile" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: " report " } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        documentType: "report",
      }),
    );
    expect(calls.find((call) => call.method === "PATCH")?.headers.get("if-match")).toBe('"3"');
  });
  it.each(["rests_on", "rested_on_by"])(
    "preserves the %s direction when linking documents",
    async (direction) => {
      const data = routes();
      data["POST /api/v1/projects/p1/document-links"] = {};
      const calls = await mount(data);
      fireEvent.change(screen.getByLabelText("Other document"), { target: { value: "other" } });
      fireEvent.change(screen.getByLabelText("Direction"), { target: { value: direction } });
      fireEvent.change(screen.getByLabelText("Note (optional)"), {
        target: { value: " supports estimate " },
      });
      fireEvent.submit(screen.getByLabelText("Other document").closest("form")!);
      await waitFor(() =>
        expect(calls.find((call) => call.method === "POST")?.body).toEqual({
          upstreamUploadId: direction === "rests_on" ? "other" : "doc",
          downstreamUploadId: direction === "rests_on" ? "doc" : "other",
          kind: "depends_on",
          note: "supports estimate",
        }),
      );
    },
  );
  it("excludes revoked, infected and superseded documents from new links", async () => {
    const data = routes();
    data[graphUrl] = {
      nodes: [
        documentNode("doc"),
        documentNode("other"),
        documentNode("revoked", { revokedAt: "2030-01-01" }),
        documentNode("scanned_infected", { state: "scanned_infected" }),
        documentNode("old", { supersededByUploadId: "other" }),
      ],
      links: [],
      truncated: false,
    };
    await mount(data);
    const values = within(screen.getByLabelText("Other document"))
      .getAllByRole("option")
      .map((option) => (option as HTMLOptionElement).value);
    expect(values).toEqual(["", "other"]);
  });
  it("records a removal reason instead of deleting relation history", async () => {
    const data = routes();
    data[graphUrl] = {
      nodes: [documentNode("doc"), documentNode("other")],
      links: [
        {
          id: "link",
          upstreamUploadId: "other",
          downstreamUploadId: "doc",
          kind: "depends_on",
          origin: "user",
          note: "source",
        },
      ],
      truncated: false,
    };
    data["POST /api/v1/document-links/link/removal"] = {};
    const calls = await mount(data);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    fireEvent.change(screen.getByLabelText("Why"), { target: { value: " Wrong relation " } });
    fireEvent.submit(screen.getByLabelText("Why").closest("form")!);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        reason: "Wrong relation",
      }),
    );
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });
  it("previews affected downstream documents before making any change", async () => {
    const data = routes();
    data["GET /api/v1/uploads/doc/impact-preview"] = {
      items: [{ uploadId: "other", viaUploadId: "doc", viaKind: "depends_on", depth: 1 }],
    };
    const calls = await mount(data);
    expect(screen.getByTestId("impact-preview").textContent).toContain("other.pdf");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("requires a reason to revoke a document and preserves the version check", async () => {
    const data = routes();
    data["POST /api/v1/uploads/doc/revoke"] = {};
    const calls = await mount(data);
    const button = screen.getByRole("button", { name: "Revoke document" });
    expect(button.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Why this document is revoked"), {
      target: { value: " Issued in error " },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        reason: "Issued in error",
      }),
    );
    expect(calls.find((call) => call.method === "POST")?.headers.get("if-match")).toBe('"3"');
  });
  it("keeps a replacement quarantined and marks which document it supersedes", async () => {
    const data = routes();
    data["POST /api/v1/projects/p1/uploads"] = { id: "new", version: 1, state: "quarantined" };
    data["PATCH /api/v1/uploads/new/document-profile"] = {
      id: "new",
      version: 2,
      state: "quarantined",
    };
    const calls = await mount(data);
    fireEvent.change(screen.getByLabelText("File"), {
      target: { files: [new File(["corrected"], "new.pdf", { type: "application/pdf" })] },
    });
    fireEvent.change(screen.getByLabelText("New version valid until (optional)"), {
      target: { value: "2030-12-31" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Upload new version" }));
    await screen.findByTestId("new-version-created");
    expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
      supersedesUploadId: "doc",
      documentType: "license",
      validUntil: "2030-12-31",
    });
    expect(calls.some((call) => call.url.endsWith("/promote"))).toBe(false);
    expect(screen.getByTestId("new-version-created").textContent).toContain("waiting for the scan");
  });
  it("makes revoked documents read-only but keeps the revocation reason visible", async () => {
    const data = routes();
    data[graphUrl] = {
      nodes: [
        documentNode("doc", {
          revokedAt: "2030-01-01",
          revocationReason: "Compromised issuer key",
        }),
      ],
      links: [],
      truncated: false,
    };
    await mount(data);
    expect(screen.getByTestId("document-revoked").textContent).toContain("Compromised issuer key");
    expect(screen.getByLabelText("Document type").hasAttribute("disabled")).toBe(true);
    expect(screen.queryByRole("button", { name: "Revoke document" })).toBeNull();
  });
  it("reports a version conflict rather than discarding the user's profile edit", async () => {
    const data = routes();
    data["PATCH /api/v1/uploads/doc/document-profile"] = Response.json(
      {
        code: "VERSION_CONFLICT",
        message: "Document changed",
        retryable: false,
        correlationId: "version",
      },
      { status: 412 },
    );
    await mount(data);
    fireEvent.change(screen.getByLabelText("Document type"), { target: { value: "report" } });
    fireEvent.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Document changed");
    expect((screen.getByLabelText("Document type") as HTMLInputElement).value).toBe("report");
  });
});
