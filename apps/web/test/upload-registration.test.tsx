// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { validateDocumentClassification } from "../src/lib/document-profile-recovery";
import Register from "../src/app/w/projects/[id]/register/page";
import { mockHttp, type HttpCall } from "./support/http";
vi.mock("../src/lib/session", () => ({
  useSession: () => ({
    token: "cookie-session",
    session: { actions: ["source.upload"] },
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const saved = {
  reused: false,
  id: "u1",
  version: 1,
  documentType: null,
  validUntil: null,
};
const current = {
  uploadId: "u1",
  version: 2,
  documentType: null,
  validUntil: null,
  state: "scanned_clean",
  revokedAt: null,
  supersededByUploadId: null,
};
const mismatch = () =>
  Response.json(
    {
      code: "RESOURCE_VERSION_MISMATCH",
      message: "Document changed",
      retryable: false,
      correlationId: "test",
    },
    { status: 412 },
  );
async function prepare(type = "Exploration report") {
  await act(async () => {
    render(<Register params={Promise.resolve({ id: "p1" })} />);
  });
  fireEvent.change(screen.getByLabelText("Choose a file"), {
    target: {
      files: [new File(["source"], "source.txt", { type: "text/plain" })],
    },
  });
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  fireEvent.change(screen.getByLabelText("Document type"), {
    target: { value: type },
  });
}
it("rebases a scanner-only version change without uploading again", async () => {
  const calls = mockHttp({
    "POST /api/v1/projects/p1/uploads": saved,
    "PATCH /api/v1/uploads/u1/document-profile": (call: HttpCall) =>
      call.headers.get("if-match") === '"1"'
        ? mismatch()
        : { ...saved, version: 3 },
    "GET /api/v1/projects/p1/document-graph?focus=u1": {
      nodes: [current],
      links: [],
    },
  });
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByRole("heading", { name: "File uploaded" });
  const patches = calls.filter((call) => call.method === "PATCH");
  expect(patches.map((call) => call.headers.get("if-match"))).toEqual([
    '"1"',
    '"2"',
  ]);
  expect(patches[0]!.headers.get("idempotency-key")).not.toBe(
    patches[1]!.headers.get("idempotency-key"),
  );
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
it("validates classification before creating the upload", async () => {
  const calls = mockHttp({});
  await prepare("x".repeat(81));
  fireEvent.submit(screen.getByLabelText("Document type").closest("form")!);
  await screen.findByRole("alert");
  expect(calls).toHaveLength(0);
  expect(screen.getByLabelText("Document type").getAttribute("maxlength")).toBe(
    "80",
  );
});
it("allows a server-rejected classification to be corrected on the stored upload", async () => {
  let attempts = 0;
  const calls = mockHttp({
    "POST /api/v1/projects/p1/uploads": saved,
    "PATCH /api/v1/uploads/u1/document-profile": () =>
      ++attempts === 1
        ? Response.json(
            {
              code: "REQUEST_INVALID",
              message: "Classification rejected",
              retryable: false,
              correlationId: "test",
            },
            { status: 400 },
          )
        : { ...saved, version: 2 },
  });
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByText(/Classification rejected/);
  expect(
    (screen.getByLabelText("Document type") as HTMLInputElement).disabled,
  ).toBe(false);
  fireEvent.change(screen.getByLabelText("Document type"), {
    target: { value: "Corrected classification" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry classification" }));
  await screen.findByRole("heading", { name: "File uploaded" });
  const patches = calls.filter((call) => call.method === "PATCH");
  expect(patches[0]!.headers.get("idempotency-key")).not.toBe(
    patches[1]!.headers.get("idempotency-key"),
  );
  expect(patches[1]!.body).toMatchObject({
    documentType: "Corrected classification",
  });
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
it("recovers a scanner change between a transport failure and explicit retry using the original key first", async () => {
  let attempts = 0;
  const calls = mockHttp({
    "POST /api/v1/projects/p1/uploads": saved,
    "PATCH /api/v1/uploads/u1/document-profile": (call: HttpCall) => {
      if (++attempts === 1) throw new Error("Reply lost");
      return call.headers.get("if-match") === '"1"'
        ? mismatch()
        : { ...saved, version: 3 };
    },
    "GET /api/v1/projects/p1/document-graph?focus=u1": {
      nodes: [current],
      links: [],
    },
  });
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByText("Reply lost");
  fireEvent.click(screen.getByRole("button", { name: "Retry classification" }));
  await screen.findByRole("heading", { name: "File uploaded" });
  const patches = calls.filter((call) => call.method === "PATCH");
  expect(patches.map((call) => call.headers.get("if-match"))).toEqual([
    '"1"',
    '"1"',
    '"2"',
  ]);
  expect(patches[0]!.headers.get("idempotency-key")).toBe(
    patches[1]!.headers.get("idempotency-key"),
  );
  expect(patches[1]!.headers.get("idempotency-key")).not.toBe(
    patches[2]!.headers.get("idempotency-key"),
  );
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
});
it("recognizes an already committed classification after a lost response without a third write", async () => {
  let attempts = 0;
  const calls = mockHttp({
    "POST /api/v1/projects/p1/uploads": saved,
    "PATCH /api/v1/uploads/u1/document-profile": () => {
      if (++attempts === 1) throw new Error("Reply lost");
      return mismatch();
    },
    "GET /api/v1/projects/p1/document-graph?focus=u1": {
      nodes: [{ ...current, documentType: "Exploration report" }],
      links: [],
    },
  });
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByText("Reply lost");
  fireEvent.click(screen.getByRole("button", { name: "Retry classification" }));
  await screen.findByRole("heading", { name: "File uploaded" });
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(2);
});
it("does not automatically overwrite another editor's classification", async () => {
  const calls = mockHttp({
    "POST /api/v1/projects/p1/uploads": saved,
    "PATCH /api/v1/uploads/u1/document-profile": (call: HttpCall) =>
      call.headers.get("if-match") === '"1"'
        ? mismatch()
        : { ...saved, version: 3 },
    "GET /api/v1/projects/p1/document-graph?focus=u1": {
      nodes: [{ ...current, documentType: "Other editor's type" }],
      links: [],
    },
  });
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByText(/Classification changed on the server/);
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry classification" }));
  await screen.findByRole("heading", { name: "File uploaded" });
  expect(
    calls.filter((call) => call.method === "PATCH")[1]!.headers.get("if-match"),
  ).toBe('"2"');
});
it.each(["revoked", "rejected", "scanned_infected", "missing"])(
  "stops recovery when the document is %s",
  async (state) => {
    const node = {
      ...current,
      state,
      ...(state === "revoked" ? { revokedAt: "2026-01-01" } : {}),
    };
    const calls = mockHttp({
      "POST /api/v1/projects/p1/uploads": saved,
      "PATCH /api/v1/uploads/u1/document-profile": mismatch,
      "GET /api/v1/projects/p1/document-graph?focus=u1": {
        nodes: state === "missing" ? [] : [node],
        links: [],
      },
    });
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
    await screen.findByRole("alert");
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "File uploaded" })).toBeNull();
  },
);
it("shares the server's trimmed length constraint and refuses non-calendar dates before upload", () => {
  expect(
    validateDocumentClassification({
      documentType: ` ${"a".repeat(80)} `,
      validUntil: "2028-02-29",
    }),
  ).toEqual({ documentType: "a".repeat(80), validUntil: "2028-02-29" });
  expect(() =>
    validateDocumentClassification({ documentType: "a".repeat(81) }),
  ).toThrow();
  expect(() =>
    validateDocumentClassification({ validUntil: "2027-02-29" }),
  ).toThrow("real calendar date");
  expect(() =>
    validateDocumentClassification({ validUntil: "not-a-date" }),
  ).toThrow();
});
it("bounds repeated scanner conflicts and permits another explicit retry", async () => {
  let patches = 0;
  let reads = 0;
  const calls = mockHttp({
    "POST /api/v1/projects/p1/uploads": saved,
    "PATCH /api/v1/uploads/u1/document-profile": () =>
      ++patches < 4 ? mismatch() : { ...saved, version: 4 },
    "GET /api/v1/projects/p1/document-graph?focus=u1": () => ({
      nodes: [{ ...current, version: ++reads + 1 }],
      links: [],
    }),
  });
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByRole("alert");
  expect(patches).toBe(2);
  fireEvent.click(screen.getByRole("button", { name: "Retry classification" }));
  await screen.findByRole("heading", { name: "File uploaded" });
  expect(
    calls
      .filter((call) => call.method === "PATCH")
      .map((call) => call.headers.get("if-match")),
  ).toEqual(['"1"', '"2"', '"2"', '"3"']);
  expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
});

it.each(["", "Different classification"])(
  "preserves an existing document when duplicate registration requests %s",
  async (type) => {
    const calls = mockHttp({
      "POST /api/v1/projects/p1/uploads": {
        ...saved,
        reused: true,
        state: "quarantined",
        documentType: "Original classification",
        validUntil: "2028-12-31",
      },
      "PATCH /api/v1/uploads/u1/document-profile": saved,
    });
    await prepare(type);
    fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
    await screen.findByRole("heading", { name: "File already stored" });
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
    expect(
      screen
        .getByRole("link", { name: "View existing document →" })
        .getAttribute("href"),
    ).toBe("/w/projects/p1/documents/u1");
  },
);
it("preserves metadata when an older upload response lacks creation information", async () => {
  const calls = mockHttp({
    "POST /api/v1/projects/p1/uploads": {
      id: "u1",
      version: 1,
      documentType: null,
      validUntil: null,
    },
    "PATCH /api/v1/uploads/u1/document-profile": saved,
  });
  await prepare();
  fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
  await screen.findByRole("heading", { name: "File already stored" });
  expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(0);
});

it.each([false, true])(
  "retries a lost upload response with the original key and honors reused=%s",
  async (reused) => {
    let requests = 0;
    const calls = mockHttp({
      "POST /api/v1/projects/p1/uploads": () => {
        if (++requests === 1) throw new Error("Upload reply lost");
        return { ...saved, reused };
      },
      "PATCH /api/v1/uploads/u1/document-profile": { ...saved, version: 2 },
    });
    await prepare();
    fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
    await screen.findByText("Upload reply lost");
    fireEvent.click(screen.getByRole("button", { name: "Upload privately" }));
    await screen.findByRole("heading", {
      name: reused ? "File already stored" : "File uploaded",
    });
    const uploads = calls.filter((call) => call.method === "POST");
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.headers.get("idempotency-key")).toBe(
      uploads[1]!.headers.get("idempotency-key"),
    );
    expect(calls.filter((call) => call.method === "PATCH")).toHaveLength(
      reused ? 0 : 1,
    );
  },
);
