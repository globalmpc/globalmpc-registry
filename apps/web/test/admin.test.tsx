// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Admin from "../src/app/w/admin/page";
import type { AdminSubject } from "../src/lib/api";
import { mockHttp } from "./support/http";

const session = vi.hoisted(() => ({
  token: "admin-token" as string | null,
  loading: false,
  session: {
    authenticated: true,
    subjectId: "admin",
    chainId: 56,
    walletAddress: "0x1111111111111111111111111111111111111111",
  },
}));
vi.mock("../src/lib/session", () => ({ useSession: () => session }));
const person = {
  id: "person",
  displayName: "Reviewer",
  locked: false,
  wallets: [],
  roles: [],
  kind: "person",
} satisfies AdminSubject;
function routes(): Record<string, unknown> {
  return Object.fromEntries(
    [
      "/admin/subjects",
      "/admin/role-grants",
      "/admin/role-revocations",
      "/admin/notification-sinks",
      "/document-link-rules",
    ].map((path) => [`GET /api/v1${path}`, { items: [] }]),
  );
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  render(<Admin />);
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Add person" }).hasAttribute("disabled")).toBe(true),
  );
  await waitFor(() => expect(calls.filter((call) => call.method === "GET")).toHaveLength(5));
  return calls;
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
beforeEach(() => {
  session.token = "admin-token";
  session.session.authenticated = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("administration safety workflows", () => {
  it("does not load administration records without an account", () => {
    session.token = null;
    session.session.authenticated = false;
    const calls = mockHttp({});
    render(<Admin />);
    expect(screen.getByText("No account is connected.")).toBeDefined();
    expect(calls).toHaveLength(0);
  });

  it("creates a person without silently assigning wallets or roles", async () => {
    const data = routes();
    data["POST /api/v1/admin/subjects"] = person;
    const calls = await mount(data);
    change("Name", "New reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      displayName: "New reviewer",
    });
    await waitFor(() => expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(""));
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });

  it("shows locked accounts and binds recovery wallets to the server's chain", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = { items: [{ ...person, locked: true }] };
    data["POST /api/v1/admin/subjects/person/wallets"] = person;
    const calls = await mount(data);
    await screen.findByTestId("admin-locked");
    fireEvent.click(screen.getByRole("button", { name: "Bind wallet" }));
    const bind = screen.getByRole("button", { name: /^Bind$/ });
    expect(bind.hasAttribute("disabled")).toBe(true);
    change("Wallet address", " 0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCDEF ");
    change("Assurance level", "high_assurance");
    change("What you checked (required)", " checked ID ");
    fireEvent.click(bind);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        walletAddress: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdef",
        chainId: 56,
        assuranceLevel: "high_assurance",
        justification: "checked ID",
      }),
    );
  });

  it("records role proposals as proposals rather than approving them", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = { items: [person] };
    data["POST /api/v1/admin/role-grants"] = {};
    const calls = await mount(data);
    fireEvent.click(await screen.findByRole("button", { name: "Propose role" }));
    change("Role", " data_steward ");
    change("Why", "Handles source records");
    fireEvent.submit(screen.getByLabelText("Role").closest("form")!);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        subjectId: "person",
        role: "data_steward",
        reason: "Handles source records",
      }),
    );
    expect(calls.some((call) => call.url.endsWith("/decision"))).toBe(false);
  });

  it("does not offer self-approval of a role proposal", async () => {
    const data = routes();
    data["GET /api/v1/admin/role-grants"] = {
      items: [
        {
          id: "own",
          subjectName: "Reviewer",
          role: "reviewer_cp_qp",
          state: "pending",
          requestedBySubjectId: "admin",
          reason: "Independent review",
          version: 2,
        },
      ],
    };
    await mount(data);
    const table = await screen.findByTestId("admin-role-grants");
    expect(within(table).queryByRole("button", { name: "Approve" })).toBeNull();
    expect(within(table).getByText(/someone else decides/)).toBeDefined();
  });

  it.each(["Approve", "Reject"])(
    "sends a version-checked %s decision for another proposer's request",
    async (decision) => {
      const data = routes();
      data["GET /api/v1/admin/role-grants"] = {
        items: [
          {
            id: "grant",
            subjectName: "Reviewer",
            role: "reviewer_cp_qp",
            state: "pending",
            requestedBySubjectId: "someone-else",
            reason: "Independent review",
            version: 2,
          },
        ],
      };
      data["POST /api/v1/admin/role-grants/grant/decision"] = {};
      const calls = await mount(data);
      fireEvent.click(await screen.findByRole("button", { name: decision }));
      await waitFor(() => expect(calls.some((call) => call.method === "POST")).toBe(true));
      const call = calls.find((item) => item.method === "POST")!;
      expect(call.body?.decision).toBe(decision.toLowerCase());
      expect(call.headers.get("if-match")).toBe('"2"');
      expect(call.headers.get("idempotency-key")).toBeTruthy();
    },
  );

  it("does not offer to disable the administrator's own wallet", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = {
      items: [
        {
          ...person,
          wallets: [
            {
              id: "own",
              walletAddress: session.session.walletAddress,
              assuranceLevel: "high_assurance",
              disabledAt: null,
              version: 1,
            },
          ],
        },
      ],
    };
    await mount(data);
    const table = await screen.findByTestId("admin-subjects");
    await within(table).findByText("Reviewer");
    expect(within(table).queryByRole("button", { name: "Disable" })).toBeNull();
  });

  it("keeps an audit reason and current version when disabling a lost wallet", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = {
      items: [
        {
          ...person,
          wallets: [
            {
              id: "other",
              walletAddress: "0x2222222222222222222222222222222222222222",
              assuranceLevel: "high_assurance",
              disabledAt: null,
              version: 4,
            },
          ],
        },
      ],
    };
    data["POST /api/v1/admin/wallets/other/disable"] = person;
    const calls = await mount(data);
    fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
    change("What happened", "Lost device");
    fireEvent.submit(screen.getByLabelText("What happened").closest("form")!);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        reasonCode: "key_lost",
        detail: "Lost device",
      }),
    );
    expect(calls.find((call) => call.method === "POST")?.headers.get("if-match")).toBe('"4"');
  });

  it("registers a webhook secret reference rather than a secret value", async () => {
    const data = routes();
    data["POST /api/v1/admin/notification-sinks"] = {};
    const calls = await mount(data);
    change("Webhook URL", " https://hooks.example.test/registry ");
    change("Signing secret reference", " file:/run/secrets/hmac ");
    fireEvent.click(screen.getByRole("button", { name: "Add sink" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        url: "https://hooks.example.test/registry",
        secretReference: "file:/run/secrets/hmac",
      }),
    );
  });

  it("reports how many existing document pairs a new rule linked", async () => {
    const data = routes();
    data["POST /api/v1/document-link-rules"] = { linksCreated: 2 };
    const calls = await mount(data);
    change("Documents of type", " report ");
    change("rest on documents of type", " license ");
    fireEvent.submit(screen.getByLabelText("Documents of type").closest("form")!);
    await screen.findByText("Rule added. It linked 2 existing document pairs.");
    expect(calls.find((call) => call.method === "POST")?.body).toEqual({
      upstreamType: "license",
      downstreamType: "report",
      kind: "depends_on",
      note: null,
    });
  });

  it("shows a failed write without erasing the administrator's input", async () => {
    const data = routes();
    data["POST /api/v1/admin/subjects"] = Response.json(
      {
        code: "AUTHORIZATION_DENIED",
        message: "Permission denied",
        retryable: false,
        correlationId: "admin-denied",
      },
      { status: 403 },
    );
    await mount(data);
    change("Name", "New reviewer");
    fireEvent.click(screen.getByRole("button", { name: "Add person" }));
    await screen.findByText("Permission denied");
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("New reviewer");
  });
});

describe("append-only administration records", () => {
  it("proposes revocation without removing the original role binding", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = {
      items: [{ ...person, roles: [{ id: "binding", role: "data_steward", revokedAt: null }] }],
    };
    data["POST /api/v1/admin/role-revocations"] = {};
    const calls = await mount(data);
    fireEvent.click(await screen.findByRole("button", { name: "Propose revocation" }));
    change("What changed", "Moved to another department");
    fireEvent.click(screen.getByRole("button", { name: "Submit revocation" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        roleBindingId: "binding",
        reasonCode: "offboarding",
        reason: "Moved to another department",
      }),
    );
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it.each(["Approve", "Reject"])(
    "requires a separate, version-checked %s for revocation",
    async (decision) => {
      const data = routes();
      data["GET /api/v1/admin/role-revocations"] = {
        items: [
          {
            id: "revoke",
            roleBindingId: "binding",
            subjectName: "Reviewer",
            role: "data_steward",
            reasonCode: "offboarding",
            reason: "Changed responsibilities",
            state: "pending",
            requestedBySubjectId: "other",
            version: 5,
          },
        ],
      };
      data["POST /api/v1/admin/role-revocations/revoke/decision"] = {};
      const calls = await mount(data);
      fireEvent.click(await screen.findByRole("button", { name: decision }));
      await waitFor(() =>
        expect(calls.find((call) => call.method === "POST")?.body?.decision).toBe(
          decision.toLowerCase(),
        ),
      );
      expect(calls.find((call) => call.method === "POST")?.headers.get("if-match")).toBe('"5"');
    },
  );

  it("retires a document rule with a reason instead of deleting it", async () => {
    const data = routes();
    data["GET /api/v1/document-link-rules"] = {
      items: [
        {
          id: "rule",
          upstreamType: "license",
          downstreamType: "report",
          kind: "depends_on",
          note: null,
          retiredAt: null,
        },
      ],
    };
    data["POST /api/v1/document-link-rules/rule/retirement"] = {};
    const calls = await mount(data);
    fireEvent.click(await screen.findByRole("button", { name: "Retire" }));
    change("Why", " policy changed ");
    fireEvent.submit(screen.getByLabelText("Why").closest("form")!);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        note: "policy changed",
      }),
    );
    expect(calls.find((call) => call.method === "POST")?.url).toBe(
      "/api/v1/document-link-rules/rule/retirement",
    );
  });
});

describe("notification delivery operations", () => {
  it.each(["active", "paused"])(
    "changes a %s sink's state without deleting its delivery history",
    async (state) => {
      const data = routes();
      data["GET /api/v1/admin/notification-sinks"] = {
        items: [
          {
            id: "sink",
            url: "https://hooks.example.test/registry",
            state,
            version: 6,
            delivery: { delivered: 2, pending: 1, failed: 0, lastError: null },
          },
        ],
      };
      data["POST /api/v1/admin/notification-sinks/sink/state"] = {};
      const calls = await mount(data);
      fireEvent.click(
        await screen.findByRole("button", { name: state === "active" ? "Pause" : "Resume" }),
      );
      await waitFor(() =>
        expect(calls.find((call) => call.method === "POST")?.body).toEqual({
          state: state === "active" ? "paused" : "active",
        }),
      );
      expect(calls.find((call) => call.method === "POST")?.headers.get("if-match")).toBe('"6"');
    },
  );
});
