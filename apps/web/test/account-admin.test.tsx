// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import Admin from "../src/app/w/admin/page";
import type { AdminSubject } from "../src/lib/api";
import { mockHttp } from "./support/http";

/** Account administration on the admin screen (WP6): sign-in methods, invitations, recoveries. */
const session = vi.hoisted(() => ({
  token: "cookie-session" as string | null,
  loading: false,
  session: {
    authenticated: true,
    subjectId: "admin",
    aal: "aal2",
    mfaSatisfied: true,
    // What the server lists for an administrator; the screen offers controls by these.
    actions: ["admin.read", "admin.subject.manage", "admin.wallet.manage", "admin.role.propose", "admin.role.approve", "document.rule.manage", "admin.notification.manage", "admin.invitation.manage", "admin.email_change.propose", "admin.email_change.approve", "admin.mfa_reset.propose", "admin.mfa_reset.approve", "admin.subject_suspension.propose", "admin.subject_suspension.approve"] as string[],
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
  return {
    ...Object.fromEntries(
      [
        "/admin/subjects",
        "/admin/role-grants",
        "/admin/role-revocations",
        "/admin/notification-sinks",
        "/document-link-rules",
        "/admin/invitations",
        "/admin/email-changes",
        "/organizations",
      ].map((path) => [`GET /api/v1${path}`, { items: [] }]),
    ),
    "GET /api/v1/admin/mfa-resets": { items: [] },
    "GET /api/v1/admin/subject-suspensions": { items: [] },
  };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  render(<Admin />);
  await waitFor(() => expect(calls.filter((call) => call.method === "GET")).toHaveLength(10));
  return calls;
}
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const firstPost = (calls: ReturnType<typeof mockHttp>, suffix: string) =>
  calls.find((call) => call.method === "POST" && call.url.endsWith(suffix));

const pendingChange = (requestedBy: string) => ({
  id: "chg",
  subjectId: "person",
  newEmail: "new@example.test",
  reason: "Name changed",
  requestedBySubjectId: requestedBy,
  requestedAt: "2026-11-01T00:00:00Z",
  state: "pending",
  decidedBySubjectId: null,
  decidedAt: null,
  decisionReason: null,
  completedAt: null,
  closedReason: null,
  version: 2,
});
const pendingReset = {
  id: "rst",
  subjectId: "person",
  subjectName: "Reviewer",
  reason: "Lost phone",
  requestedBySubjectId: "other",
  requestedAt: "2026-11-01T00:00:00Z",
  state: "pending",
  decidedBySubjectId: null,
  decidedAt: null,
  decisionReason: null,
  enrolmentWindowUntil: null,
  closedReason: null,
  version: 1,
};

const pendingSuspension = (requestedBy: string, action: "suspend" | "reinstate" = "suspend") => ({
  id: "sus",
  subjectId: "person",
  subjectName: "Reviewer",
  action,
  reason: "Left the company",
  requestedBySubjectId: requestedBy,
  requestedAt: "2026-11-01T00:00:00Z",
  state: "pending",
  decidedBySubjectId: null,
  decidedAt: null,
  decisionReason: null,
  enrolmentWindowUntil: null,
  closedReason: null,
  version: 3,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("account administration (WP6)", () => {
  it("names how each person signs in and explains an account with no way in", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = {
      items: [
        { ...person, id: "admin", displayName: "Me", signInMethods: ["email", "google"] },
        { ...person, id: "lost", displayName: "Lost", locked: true, signInMethods: [] },
        { ...person, id: "old", displayName: "Old API" },
      ],
    };
    await mount(data);
    const cells = await screen.findAllByTestId("subject-sign-in-methods");
    expect(cells.map((cell) => cell.textContent)).toEqual(["email, Google", "no way to sign in", "—"]);
    expect(screen.getByTestId("subject-you").textContent).toBe("you");
    expect(screen.getByTestId("admin-locked").textContent).toContain("1 account cannot sign in");
    expect(screen.getByTestId("admin-locked").textContent).toContain("Lost has no email address");
  });

  it("invites one address into one organisation with an idempotency key and no role", async () => {
    const data = routes();
    data["GET /api/v1/organizations"] = { items: [{ id: "org-1", legalName: "Acme", jurisdiction: "KR" }] };
    data["POST /api/v1/admin/invitations"] = {};
    const calls = await mount(data);
    await screen.findByRole("option", { name: "Acme" });
    const send = screen.getByRole("button", { name: "Send invitation" });
    expect(send.hasAttribute("disabled")).toBe(true);
    change("Email address", " new@example.test ");
    change("Organisation", "org-1");
    fireEvent.click(send);
    await waitFor(() =>
      expect(firstPost(calls, "/admin/invitations")?.body).toEqual({
        email: "new@example.test",
        organizationId: "org-1",
      }),
    );
    expect(firstPost(calls, "/admin/invitations")?.headers.get("idempotency-key")).toBeTruthy();
    await waitFor(() => expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe(""));
  });

  it("lets the organisation id be typed when the list is not available to this role", async () => {
    const data = routes();
    data["GET /api/v1/organizations"] = () =>
      Response.json({ code: "AUTHORIZATION_DENIED", message: "no", requestId: "r" }, { status: 403 });
    await mount(data);
    const field = screen.getByLabelText("Organisation");
    expect(field.tagName).toBe("INPUT");
  });

  it("revokes a pending invitation against its current version", async () => {
    const data = routes();
    data["GET /api/v1/admin/invitations"] = {
      items: [
        {
          id: "inv",
          email: "pending@example.test",
          organizationId: "org-1",
          state: "pending",
          invitedBySubjectId: "admin",
          createdAt: "2026-11-01T00:00:00Z",
          expiresAt: "2026-11-08T00:00:00Z",
          acceptedAt: null,
          acceptedSubjectId: null,
          revokedAt: null,
          closedReason: null,
          version: 4,
        },
      ],
    };
    data["POST /api/v1/admin/invitations/inv/revoke"] = {};
    const calls = await mount(data);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(firstPost(calls, "/revoke")).toBeDefined());
    expect(firstPost(calls, "/revoke")?.headers.get("if-match")).toBe('"4"');
  });

  it("offers the proposer of an email change no decision", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = { items: [person] };
    data["GET /api/v1/admin/email-changes"] = { items: [pendingChange("admin")] };
    await mount(data);
    await screen.findByText("waiting for another administrator");
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("decides another administrator's email change with a reason and the current version", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = { items: [person] };
    data["GET /api/v1/admin/email-changes"] = { items: [pendingChange("other")] };
    data["POST /api/v1/admin/email-changes/chg/decision"] = {};
    const calls = await mount(data);
    const approve = await screen.findByRole("button", { name: "Approve" });
    expect(approve.hasAttribute("disabled")).toBe(true);
    change("Decision reason", " Checked with HR ");
    fireEvent.click(approve);
    await waitFor(() =>
      expect(firstPost(calls, "/decision")?.body).toEqual({ decision: "approve", reason: "Checked with HR" }),
    );
    expect(firstPost(calls, "/decision")?.headers.get("if-match")).toBe('"2"');
  });

  it("proposes an email change and a second-factor reset for someone else, never oneself", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = { items: [{ ...person, id: "admin", displayName: "Me" }, person] };
    data["POST /api/v1/admin/email-changes"] = {};
    data["POST /api/v1/admin/mfa-resets"] = {};
    const calls = await mount(data);
    await screen.findAllByRole("option", { name: "Reviewer" });
    expect(screen.queryByRole("option", { name: "Me" })).toBeNull();
    change("New address", "reviewer@example.test");
    const [changePerson, resetPerson] = screen.getAllByLabelText("Person");
    fireEvent.change(changePerson!, { target: { value: "person" } });
    fireEvent.change(resetPerson!, { target: { value: "person" } });
    const [changeReason, resetReason] = screen.getAllByLabelText("Reason");
    fireEvent.change(changeReason!, { target: { value: "Married" } });
    fireEvent.change(resetReason!, { target: { value: "Lost every factor" } });
    const proposeChange = screen.getByRole("button", { name: "Propose email change" });
    const proposeReset = screen.getByRole("button", { name: "Propose factor reset" });
    fireEvent.click(proposeChange);
    await waitFor(() =>
      expect(firstPost(calls, "/admin/email-changes")?.body).toEqual({
        subjectId: "person",
        newEmail: "reviewer@example.test",
        reason: "Married",
      }),
    );
    await waitFor(() => expect(proposeReset.hasAttribute("disabled")).toBe(false));
    fireEvent.click(proposeReset);
    await waitFor(() =>
      expect(firstPost(calls, "/admin/mfa-resets")?.body).toEqual({ subjectId: "person", reason: "Lost every factor" }),
    );
  });

  it("says why a suspension closed a request, never its expiry or an open window", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = { items: [person] };
    data["GET /api/v1/admin/invitations"] = {
      items: [
        {
          id: "inv-closed",
          email: "closed@example.test",
          organizationId: "org-1",
          state: "expired",
          invitedBySubjectId: "other",
          createdAt: "2026-11-01T00:00:00Z",
          expiresAt: "2026-11-08T00:00:00Z",
          acceptedAt: null,
          acceptedSubjectId: null,
          revokedAt: null,
          closedReason: "inviter_suspended",
          version: 2,
        },
      ],
    };
    data["GET /api/v1/admin/email-changes"] = {
      items: [{ ...pendingChange("other"), state: "expired", closedReason: "subject_suspended" }],
    };
    data["GET /api/v1/admin/mfa-resets"] = {
      items: [
        // Approved, with a window still ahead — but its approver's suspension closed it.
        {
          ...pendingReset,
          id: "closed",
          state: "approved",
          enrolmentWindowUntil: "2030-01-01T10:00:00Z",
          closedReason: "approver_suspended",
        },
        { ...pendingReset, id: "open", state: "approved", enrolmentWindowUntil: "2030-01-02T10:00:00Z" },
      ],
    };
    data["GET /api/v1/admin/subject-suspensions"] = {
      items: [
        {
          ...pendingSuspension("other", "reinstate"),
          state: "rejected",
          enrolmentWindowUntil: "2030-01-01T10:00:00Z",
          closedReason: "proposer_suspended",
        },
      ],
    };
    await mount(data);

    const invitation = await screen.findByTestId("invitation-state");
    expect(invitation.textContent).toContain("Closed — inviter suspended");
    expect(invitation.textContent).not.toContain("expires");
    // A closed invitation is not offered for revocation.
    expect(screen.queryByRole("button", { name: "Revoke" })).toBeNull();

    const emailChange = screen.getByTestId("email-change-state");
    expect(emailChange.textContent).toContain("Closed — person suspended");
    expect(emailChange.textContent).not.toContain("expired");

    const resets = screen.getByTestId("mfa-reset-list");
    const [closedReset, openReset] = [...resets.querySelectorAll("li")];
    expect(closedReset!.textContent).toContain("Closed — approver suspended");
    expect(closedReset!.textContent).not.toContain("approved");
    expect(closedReset!.textContent).not.toContain("may enrol until");
    // The same shape without a closure is still an open window.
    expect(openReset!.textContent).toContain("approved");
    expect(openReset!.textContent).toContain("may enrol until 2030-01-02 10:00");

    const suspension = screen.getByTestId("suspension-list");
    expect(suspension.textContent).toContain("Closed — proposer suspended");
    expect(suspension.textContent).not.toContain("may enrol until");
  });

  it("states the two-person separation refusal in one sentence", async () => {
    const data = routes();
    data["GET /api/v1/admin/subjects"] = { items: [person] };
    data["GET /api/v1/admin/mfa-resets"] = {
      items: [
        { ...pendingReset, state: "approved", id: "old", enrolmentWindowUntil: "2026-11-02T10:00:00Z" },
        pendingReset,
      ],
    };
    data["POST /api/v1/admin/mfa-resets/rst/decision"] = () =>
      Response.json(
        { code: "ACCOUNT_RECOVERY_SEPARATION_REQUIRED", message: "separation", requestId: "r" },
        { status: 409 },
      );
    await mount(data);
    expect((await screen.findByTestId("mfa-reset-list")).textContent).toContain("may enrol until 2026-11-02 10:00");
    change("Decision reason", "Verified by phone");
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    expect((await screen.findByTestId("account-admin-error")).textContent).toContain(
      "Another administrator has to handle this one.",
    );
  });

  describe("suspension (AUTH-06)", () => {
    it("proposes a suspension and a reinstatement of someone else, never oneself", async () => {
      const data = routes();
      data["GET /api/v1/admin/subjects"] = { items: [{ ...person, id: "admin", displayName: "Me" }, person] };
      data["POST /api/v1/admin/subject-suspensions"] = {};
      const calls = await mount(data);
      const panel = within(await screen.findByTestId("admin-suspensions"));
      expect(panel.queryByRole("option", { name: "Me" })).toBeNull();
      const propose = panel.getByRole("button", { name: "Propose suspension" });
      expect(propose.hasAttribute("disabled")).toBe(true);
      fireEvent.change(panel.getByLabelText("Person"), { target: { value: "person" } });
      expect(propose.hasAttribute("disabled")).toBe(true);
      fireEvent.change(panel.getByLabelText("Reason"), { target: { value: "  Left the company " } });
      fireEvent.click(propose);
      await waitFor(() =>
        expect(firstPost(calls, "/admin/subject-suspensions")?.body).toEqual({
          subjectId: "person",
          action: "suspend",
          reason: "Left the company",
        }),
      );
      expect(firstPost(calls, "/admin/subject-suspensions")?.headers.get("idempotency-key")).toBeTruthy();
      // The reason is cleared after a proposal, so the next one needs its own.
      await waitFor(() => expect((panel.getByLabelText("Reason") as HTMLInputElement).value).toBe(""));
      fireEvent.change(panel.getByLabelText("Reason"), { target: { value: "Came back" } });
      fireEvent.click(panel.getByRole("button", { name: "Propose reinstatement" }));
      await waitFor(() =>
        expect(
          calls.filter((call) => call.method === "POST" && call.url.endsWith("/admin/subject-suspensions")).at(-1)?.body,
        ).toEqual({ subjectId: "person", action: "reinstate", reason: "Came back" }),
      );
    });

    it("marks a suspended person in the people list and the picker", async () => {
      const data = routes();
      data["GET /api/v1/admin/subjects"] = { items: [{ ...person, suspendedAt: "2026-11-01T09:00:00Z" }] };
      await mount(data);
      expect((await screen.findByTestId("subject-suspended")).textContent).toContain("suspended 2026-11-01");
      const panel = within(screen.getByTestId("admin-suspensions"));
      expect(panel.getByRole("option", { name: "Reviewer (suspended)" })).toBeTruthy();
    });

    it("offers the proposer no decision", async () => {
      const data = routes();
      data["GET /api/v1/admin/subjects"] = { items: [person] };
      data["GET /api/v1/admin/subject-suspensions"] = { items: [pendingSuspension("admin")] };
      await mount(data);
      const list = within(await screen.findByTestId("suspension-list"));
      expect(list.getByText("waiting for another administrator")).toBeTruthy();
      expect(list.queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it("decides another administrator's proposal with a reason and the current version", async () => {
      const data = routes();
      data["GET /api/v1/admin/subjects"] = { items: [person] };
      data["GET /api/v1/admin/subject-suspensions"] = { items: [pendingSuspension("other")] };
      data["POST /api/v1/admin/subject-suspensions/sus/decision"] = {};
      const calls = await mount(data);
      const list = within(await screen.findByTestId("suspension-list"));
      expect(list.getByText(/suspend · pending · Left the company/)).toBeTruthy();
      const approve = list.getByRole("button", { name: "Approve" });
      expect(approve.hasAttribute("disabled")).toBe(true);
      fireEvent.change(list.getByLabelText("Decision reason"), { target: { value: " Confirmed with HR " } });
      fireEvent.click(approve);
      await waitFor(() =>
        expect(firstPost(calls, "/subject-suspensions/sus/decision")?.body).toEqual({
          decision: "approve",
          reason: "Confirmed with HR",
        }),
      );
      const sent = firstPost(calls, "/subject-suspensions/sus/decision")!;
      expect(sent.headers.get("if-match")).toBe('"3"');
      expect(sent.headers.get("idempotency-key")).toBeTruthy();
    });

    it("shows a reinstatement's enrolment window once approved", async () => {
      const data = routes();
      data["GET /api/v1/admin/subjects"] = { items: [person] };
      data["GET /api/v1/admin/subject-suspensions"] = {
        items: [
          {
            ...pendingSuspension("other", "reinstate"),
            state: "approved",
            decidedBySubjectId: "admin",
            decidedAt: "2026-11-02T10:00:00Z",
            enrolmentWindowUntil: "2026-11-03T10:00:00Z",
          },
        ],
      };
      await mount(data);
      const list = await screen.findByTestId("suspension-list");
      expect(list.textContent).toContain("reinstate · approved");
      expect(list.textContent).toContain("may enrol until 2026-11-03 10:00");
      expect(within(list).queryByRole("button", { name: "Approve" })).toBeNull();
    });

    it.each([
      ["SUSPENSION_STATE_CONFLICT", "Only an active person can be suspended, and only a suspended one reinstated."],
      ["SUSPENSION_ALREADY_PENDING", "A request for this person is already waiting for a decision."],
    ])("states the %s refusal in one sentence", async (code, sentence) => {
      const data = routes();
      data["GET /api/v1/admin/subjects"] = { items: [person] };
      data["POST /api/v1/admin/subject-suspensions"] = () =>
        Response.json({ code, message: code, requestId: "r" }, { status: 409 });
      await mount(data);
      const panel = within(await screen.findByTestId("admin-suspensions"));
      fireEvent.change(panel.getByLabelText("Person"), { target: { value: "person" } });
      fireEvent.change(panel.getByLabelText("Reason"), { target: { value: "Left" } });
      fireEvent.click(panel.getByRole("button", { name: "Propose suspension" }));
      expect((await screen.findByTestId("account-admin-error")).textContent).toContain(sentence);
    });
  });
});
