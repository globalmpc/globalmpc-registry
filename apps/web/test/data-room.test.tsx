// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { File } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import DataRoom from "../src/app/w/projects/[id]/data-room/page";
import { mockHttp } from "./support/http";

const session = vi.hoisted(() => ({ token: "session-token" as string | null, loading: false }));
vi.mock("../src/lib/session", () => ({ useSession: () => session }));
const root = "/api/v1/projects/p1";
const source = {
  id: "authority-1",
  name: "Registry",
  connectionId: "connection-1",
  connectionKey: "licenses",
  adapterState: "ready",
  callable: true,
};
const upload = (id: string, state: string) => ({
  id,
  state,
  version: 3,
  originalFilename: `${id}.pdf`,
  documentType: "license",
  validUntil: null,
  byteSize: 1024,
  nextActions: [],
});
function routes(): Record<string, unknown> {
  return {
    [`GET ${root}`]: { id: "p1", hostCountryIso3: "MNG" },
    [`GET ${root}/claims`]: { items: [], truncated: false },
    [`GET ${root}/source-receipts`]: { items: [], truncated: false },
    [`GET ${root}/uploads`]: {
      items: [],
      nextCursor: null,
      total: 0,
      scanner: { state: "running", secondsSinceHeartbeat: 1 },
    },
    [`GET ${root}/document-graph`]: { nodes: [], truncated: false },
    "GET /api/v1/jurisdictions/MNG/profile": { authorities: [source] },
  };
}
async function mount() {
  await act(async () => {
    render(<DataRoom params={Promise.resolve({ id: "p1" })} />);
  });
  await screen.findByRole("heading", { name: /^Data Room$/ });
  if (session.token) await screen.findByLabelText("Source connection");
}
function query() {
  fireEvent.change(screen.getByLabelText("Query field"), { target: { value: " license " } });
  fireEvent.change(screen.getByLabelText("Query value"), { target: { value: " MV-123 " } });
}
beforeEach(() => {
  session.token = "session-token";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Data Room evidence and source workflows", () => {
  it("does not fetch protected data while signed out", async () => {
    session.token = null;
    const calls = mockHttp({});
    await act(async () => {
      render(<DataRoom params={Promise.resolve({ id: "p1" })} />);
    });
    expect(screen.getByText(/No account is connected/)).toBeDefined();
    expect(calls).toEqual([]);
  });

  it("keeps quarantined and infected files out of evidence and download actions", async () => {
    const data = routes();
    data[`GET ${root}/uploads`] = {
      items: [
        upload("pending", "quarantined"),
        upload("bad", "scanned_infected"),
        upload("clean", "scanned_clean"),
        upload("evidence", "promoted"),
      ],
      nextCursor: null,
      total: 4,
      scanner: null,
    };
    mockHttp(data);
    await mount();
    expect(screen.queryByTestId("download-pending")).toBeNull();
    expect(screen.queryByTestId("promote-bad")).toBeNull();
    expect(screen.getByTestId("promote-clean")).toBeDefined();
    expect(screen.getByTestId("download-evidence")).toBeDefined();
    const options = within(screen.getByLabelText("Supporting document")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "None",
      "clean.pdf",
      "evidence.pdf",
    ]);
  });

  it("sends the current file version and an idempotency key when promoting", async () => {
    const data: Record<string, unknown> = routes();
    data[`GET ${root}/uploads`] = {
      items: [upload("clean", "scanned_clean")],
      nextCursor: null,
      total: 1,
      scanner: null,
    };
    data["POST /api/v1/uploads/clean/promote"] = upload("clean", "promoted");
    const calls = mockHttp(data);
    await mount();
    fireEvent.click(screen.getByTestId("promote-clean"));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const call = calls.find((item) => item.method === "POST")!;
    expect(call.headers.get("if-match")).toBe('"3"');
    expect(call.headers.get("authorization")).toBe("Bearer session-token");
    expect(call.headers.get("idempotency-key")).toBeTruthy();
  });

  it("does not silently overwrite evidence changed by another operator", async () => {
    const data: Record<string, unknown> = routes();
    data[`GET ${root}/uploads`] = {
      items: [upload("clean", "scanned_clean")],
      nextCursor: null,
      total: 1,
      scanner: null,
    };
    data["POST /api/v1/uploads/clean/promote"] = Response.json(
      {
        code: "VERSION_CONFLICT",
        message: "Changed first",
        retryable: false,
        correlationId: "corr-1",
        details: { expectedVersion: "3", currentVersion: "4" },
      },
      { status: 412 },
    );
    mockHttp(data);
    await mount();
    fireEvent.click(screen.getByTestId("promote-clean"));
    await screen.findByText("Changed first");
    expect(screen.getByText(/read it again before deciding/)).toBeDefined();
    expect(screen.getByTestId("promote-clean").hasAttribute("disabled")).toBe(false);
  });

  it("downloads scanned evidence using an expiring link with opener isolation", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const data: Record<string, unknown> = routes();
    data[`GET ${root}/uploads`] = {
      items: [upload("clean", "scanned_clean")],
      nextCursor: null,
      total: 1,
      scanner: null,
    };
    data["POST /api/v1/uploads/clean/download-link"] = {
      url: "https://files.example.test/one-time",
    };
    mockHttp(data);
    await mount();
    fireEvent.click(screen.getByTestId("download-clean"));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "https://files.example.test/one-time",
        "_blank",
        "noopener",
      ),
    );
  });

  it("appends cursor pages without losing already loaded files", async () => {
    const data: Record<string, unknown> = routes();
    data[`GET ${root}/uploads`] = {
      items: [upload("first", "quarantined")],
      nextCursor: "cursor / 2",
      total: 2,
      scanner: null,
    };
    data[`GET ${root}/uploads?cursor=cursor+%2F+2`] = {
      items: [upload("second", "scanned_infected")],
      nextCursor: null,
      total: 2,
      scanner: null,
    };
    mockHttp(data);
    await mount();
    fireEvent.click(screen.getByTestId("uploads-load-more"));
    await screen.findByText("second.pdf");
    expect(screen.getByText("first.pdf")).toBeDefined();
    expect(screen.queryByTestId("uploads-load-more")).toBeNull();
  });

  it.each(["never_seen", "stale", "unknown"])(
    "explains scanner state %s without suggesting evidence is ready",
    async (state) => {
      const data: Record<string, unknown> = routes();
      data[`GET ${root}/uploads`] = {
        items: [],
        nextCursor: null,
        total: 0,
        scanner: { state, secondsSinceHeartbeat: 120 },
      };
      mockHttp(data);
      await mount();
      expect(screen.getByTestId("scanner-status").textContent).toMatch(/quarantine|unverified/);
    },
  );

  it("requires an actual query and leaves confirmation to the server lookup", async () => {
    const data: Record<string, unknown> = routes();
    data["POST /api/v1/source-connections/connection-1/collect"] = {
      result: "source_returned_no_record",
      confirmed: false,
    };
    const calls = mockHttp(data);
    await mount();
    const button = screen.getByRole("button", { name: "Look up the official source" });
    expect(button.hasAttribute("disabled")).toBe(true);
    query();
    fireEvent.click(button);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        projectId: "p1",
        queryBasis: { license: "MV-123" },
      }),
    );
    expect(
      within(screen.getByLabelText("Result")).queryByRole("option", {
        name: "confirmed_from_source",
      }),
    ).toBeNull();
  });

  it("records a manual source check with its actual text hash and limitations", async () => {
    const data: Record<string, unknown> = routes();
    data[`POST ${root}/source-receipts`] = {};
    const calls = mockHttp(data);
    await mount();
    query();
    fireEvent.change(screen.getByLabelText("Document or page reference"), {
      target: { value: " page 2 " },
    });
    fireEvent.change(screen.getByLabelText("Original as received (optional)"), {
      target: { value: " source extract " },
    });
    fireEvent.change(screen.getByLabelText("What this record does not show (optional)"), {
      target: { value: " offline check " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Record the result" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
      authorityId: "authority-1",
      connectionId: "connection-1",
      result: "source_returned_no_record",
      endpointOrDocumentRef: "page 2",
      limitations: ["offline check"],
      documentUploadId: null,
      rawHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
    });
  });

  it("uploads a file into quarantine without promoting it", async () => {
    const data: Record<string, unknown> = routes();
    data[`POST ${root}/uploads`] = upload("new", "quarantined");
    const calls = mockHttp(data);
    await mount();
    fireEvent.change(screen.getByLabelText("Choose a file"), {
      target: { files: [new File(["report"], "report.pdf", { type: "application/pdf" })] },
    });
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    const post = calls.find((call) => call.method === "POST")!;
    expect(post.url).toBe(`${root}/uploads`);
    expect(post.body).toMatchObject({ originalFilename: "report.pdf" });
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("preserves the server's permission error and access-request path", async () => {
    const data: Record<string, unknown> = routes();
    data[`GET ${root}/claims`] = Response.json(
      {
        code: "AUTHORIZATION_DENIED",
        message: "Reviewer required",
        retryable: false,
        correlationId: "corr-permission",
        details: { requiredRoles: ["reviewer_cp_qp"], accessRequestPath: "/w/access-requests" },
      },
      { status: 403 },
    );
    mockHttp(data);
    await act(async () => {
      render(<DataRoom params={Promise.resolve({ id: "p1" })} />);
    });
    await screen.findByText("Reviewer required");
    expect(screen.getByText("reviewer_cp_qp")).toBeDefined();
    expect(screen.getByRole("link", { name: /access/i }).getAttribute("href")).toBe(
      "/w/access-requests",
    );
  });
});

it("adds an unreviewed claim, records a versioned conflict, and preserves failures for retry", async () => {
  const data = routes();
  let claimAdded = false,
    failed = false;
  data[`GET ${root}/claims`] = () => ({
    items: claimAdded
      ? [
          {
            id: "c1",
            claimType: "mining_right_registration",
            valueText: "MV-123",
            unit: "license",
            evidenceTier: "P1",
            verificationState: "unreviewed",
            grade: "unverified",
            version: 2,
          },
        ]
      : [],
    truncated: false,
  });
  data[`POST ${root}/claims`] = () => {
    if (failed) throw new Error("Claim rejected");
    claimAdded = true;
    return {};
  };
  data["POST /api/v1/claims/c1/conflicts"] = () => {
    if (failed) throw new Error("Conflict rejected");
    return {};
  };
  const calls = mockHttp(data);
  await mount();
  fireEvent.click(screen.getByText("Add a mining right claim"));
  await screen.findByTestId("conflict-c1");
  expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
    claimType: "mining_right_registration",
    evidenceTier: "P1",
  });
  expect(calls.find((c) => c.method === "POST")?.body).not.toHaveProperty(
    "verificationState",
  );
  fireEvent.click(screen.getByTestId("conflict-c1"));
  await waitFor(() =>
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(2),
  );
  expect(
    calls.find((c) => c.url.endsWith("/conflicts"))?.headers.get("if-match"),
  ).toBe('"2"');
  await waitFor(() =>
    expect(screen.getByTestId("conflict-c1").hasAttribute("disabled")).toBe(
      false,
    ),
  );
  failed = true;
  fireEvent.click(screen.getByTestId("conflict-c1"));
  await screen.findByText("Conflict rejected");
  fireEvent.click(screen.getByText("Add a mining right claim"));
  await screen.findByText("Claim rejected");
});
