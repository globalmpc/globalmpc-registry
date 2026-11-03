// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accessPending,
  assuranceNarrowedFor,
  assuranceNarrowedRoles,
  can,
  effectiveRoles,
  rolesAllInactive,
} from "../src/lib/access";
import { landingPath, safeNextPath } from "../src/lib/next-path";
import { ApiError, type SessionInfo } from "../src/lib/api";
import { WorkspaceGate } from "../src/components/WorkspaceGate";
import { ErrorNotice } from "../src/components/ErrorNotice";
import { AssuranceNotice } from "../src/components/AssuranceNotice";
import AccessPendingPage from "../src/app/w/access-pending/page";
import Projects from "../src/app/w/projects/page";
import OidcCallbackPage from "../src/app/auth/oidc/[provider]/callback/page";
import { mockHttp } from "./support/http";

/**
 * The access-pending landing (plan §4 journey 1), roles narrowed by identity assurance, and
 * write controls offered by the session's actions. All of it is guidance: the server decides.
 */
const s = vi.hoisted(() => ({
  path: "/w/projects",
  session: null as SessionInfo | null,
  signOut: vi.fn(),
  refresh: vi.fn(),
  push: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("../src/lib/session", async (original) => {
  const actual = await original<typeof import("../src/lib/session")>();
  return {
    needsSecondFactor: actual.needsSecondFactor,
    isAccountSession: actual.isAccountSession,
    useSession: () => ({
      session: s.session,
      loading: false,
      token: s.session?.authenticated ? "cookie-session" : null,
      signOut: s.signOut,
      refresh: s.refresh,
      wallets: [],
    }),
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => s.path,
  useRouter: () => ({ push: s.push, replace: s.replace }),
  useParams: () => ({ provider: "google" }),
}));

const base = {
  authenticated: true,
  requestId: "r",
  subjectId: "person",
  tenantId: "t",
  firstFactor: "email_code",
  secondFactor: "passkey",
  aal: "aal3",
  mfaSatisfied: true,
  assuranceLevel: "high_assurance",
  roleBindings: [],
  narrowedRoles: [],
  actions: [],
} as SessionInfo;
const binding = (role: string) => ({ role, organizationId: null, projectId: null });
/** No role at all: an invitation accepted, the grant not landed. */
const pending = base;
/** A reviewer whose operator-verified wallet was replaced: held, not in effect. */
const inactive = {
  ...base,
  assuranceLevel: "wallet_only",
  roleBindings: [binding("reviewer_assurance"), binding("reviewer_cp_qp")],
} as SessionInfo;
const steward = {
  ...base,
  assuranceLevel: "identity_bound",
  roleBindings: [binding("data_steward")],
  actions: ["project.read", "source.upload", "claim.curate"],
} as SessionInfo;

beforeEach(() => {
  s.path = "/w/projects";
  s.session = pending;
  for (const f of [s.signOut, s.refresh, s.push, s.replace]) f.mockReset();
  s.signOut.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("what the session can use", () => {
  it("reads actions as the server listed them, never widening", () => {
    expect(can(steward, "source.upload")).toBe(true);
    expect(can(steward, "project.create")).toBe(false);
    expect(can(null, "project.read")).toBe(false);
    expect(can({ actions: undefined }, "project.read")).toBe(false);
  });

  it("separates roles in effect from roles below their assurance minimum", () => {
    expect(assuranceNarrowedRoles(inactive)).toEqual([
      { role: "reviewer_assurance", requiredAssurance: "high_assurance" },
      { role: "reviewer_cp_qp", requiredAssurance: "high_assurance" },
    ]);
    expect(effectiveRoles(inactive)).toEqual([]);
    const mixed = { ...inactive, roleBindings: [binding("project_voter"), binding("data_steward")] } as SessionInfo;
    expect(effectiveRoles(mixed)).toEqual(["project_voter"]);
    expect(assuranceNarrowedRoles(mixed).map((entry) => entry.role)).toEqual(["data_steward"]);
    // An unknown role needs the highest level, as on the server.
    expect(assuranceNarrowedRoles({ ...steward, roleBindings: [binding("made_up")] })).toEqual([
      { role: "made_up", requiredAssurance: "high_assurance" },
    ]);
    // A level the screen cannot read narrows everything rather than nothing.
    expect(effectiveRoles({ ...steward, assuranceLevel: "bogus" })).toEqual([]);
    expect(assuranceNarrowedRoles({ ...inactive, authenticated: false })).toEqual([]);
  });

  it("names only the inactive roles an action would use", () => {
    expect(assuranceNarrowedFor(inactive, ["attestation.sign"]).map((entry) => entry.role)).toEqual([
      "reviewer_assurance",
      "reviewer_cp_qp",
    ]);
    expect(assuranceNarrowedFor(inactive, ["gate.decide"])).toEqual([]);
    expect(assuranceNarrowedFor(inactive, ["no.such.action"])).toEqual([]);
  });

  it("is pending with no role at all, and not while a factor is owed or a role awaits a step-up", () => {
    expect(accessPending(pending)).toBe(true);
    expect(accessPending(steward)).toBe(false);
    expect(accessPending({ ...pending, aal: "aal1" })).toBe(false);
    expect(accessPending({ ...pending, recoveryLimited: true })).toBe(false);
    expect(accessPending({ ...pending, tenantId: null })).toBe(false);
    expect(accessPending({ ...pending, authenticated: false })).toBe(false);
    expect(accessPending({ ...pending, narrowedRoles: [{ role: "reviewer_lab", requiredAal: "aal3" }] })).toBe(
      false,
    );
    expect(rolesAllInactive(inactive)).toBe(true);
    expect(rolesAllInactive(pending)).toBe(false);
    expect(rolesAllInactive(steward)).toBe(false);
    expect(
      rolesAllInactive({ ...inactive, narrowedRoles: [{ role: "gate_approver", requiredAal: "aal3" }] }),
    ).toBe(false);
  });
});

describe("landing after sign-in", () => {
  it("lands a person without a usable role on access pending, others on the projects", () => {
    expect(landingPath(pending)).toBe("/w/access-pending");
    expect(landingPath(inactive)).toBe("/w/access-pending");
    expect(landingPath(steward)).toBe("/w/projects");
    expect(landingPath(null)).toBe("/w/projects");
  });

  it("honours a same-site next, and drops an off-site one", () => {
    expect(landingPath(pending, "/w/settings")).toBe("/w/settings");
    expect(landingPath(steward, "/w/governance?space=project")).toBe("/w/governance?space=project");
    for (const next of ["//evil.example", "https://evil.example", "/\\evil", "/w\u0000x", ""]) {
      expect(landingPath(pending, next)).toBe("/w/access-pending");
    }
    expect(safeNextPath("//evil.example")).toBe("/w/projects");
  });

  it("sends a provider sign-in without a role to access pending", async () => {
    window.history.replaceState(null, "", "/auth/oidc/google/callback?state=st&code=cd");
    s.refresh.mockResolvedValue(pending);
    mockHttp({
      "POST /api/v1/auth/oidc/google/callback": () =>
        Response.json({ aal: "aal2" }, { headers: { "x-mpc-oidc-purpose": "sign_in" } }),
    });
    render(<OidcCallbackPage />);
    await waitFor(() => expect(s.replace).toHaveBeenCalledWith("/w/access-pending"));
  });
});

describe("the access-pending state", () => {
  const gate = () =>
    render(
      <WorkspaceGate>
        <p>Private records</p>
      </WorkspaceGate>,
    );

  it("replaces every role screen with what to do next, and signs out from there", async () => {
    for (const path of ["/w/projects", "/w/governance", "/w/audit", "/w/work", "/w/projects/p1"]) {
      s.path = path;
      const view = gate();
      expect(screen.queryByText("Private records")).toBeNull();
      const panel = screen.getByTestId("access-pending");
      expect(panel.textContent).toContain("Access pending");
      expect(panel.textContent).toContain("second administrator approves each grant");
      expect(screen.getByTestId("access-pending-request").getAttribute("href")).toBe("/w/access-requests");
      expect(screen.getByTestId("access-pending-settings").getAttribute("href")).toBe("/w/settings");
      // No refusal box and no role list: nothing here is an error.
      expect(screen.queryByTestId("error-notice")).toBeNull();
      view.unmount();
    }
    gate();
    fireEvent.click(screen.getByTestId("access-pending-sign-out"));
    await waitFor(() => expect(s.signOut).toHaveBeenCalledOnce());
  });

  it("keeps the person's own account, activity and access requests open", () => {
    for (const path of [
      "/w/access-pending",
      "/w/settings",
      "/w/activity",
      "/w/access-requests",
      "/w/identity/upgrade",
      "/w/projects/p1/access-requests",
    ]) {
      s.path = path;
      const view = gate();
      expect(screen.getByText("Private records")).toBeTruthy();
      view.unmount();
    }
  });

  it("explains roles held below their assurance minimum instead of a refusal", () => {
    s.session = inactive;
    gate();
    const panel = screen.getByTestId("access-pending");
    expect(panel.textContent).toContain("Your roles are not in effect");
    expect(panel.textContent).toContain("Admin → Set assurance");
    expect(screen.getByTestId("access-pending-inactive-roles").textContent).toContain(
      "reviewer_assurance — needs high_assurance",
    );
  });

  it("lets a session with a usable role through", () => {
    s.session = steward;
    gate();
    expect(screen.getByText("Private records")).toBeTruthy();
  });

  it("the landing page itself sends a person whose access is in effect on", () => {
    s.session = steward;
    render(<AccessPendingPage />);
    expect(screen.queryByTestId("access-pending")).toBeNull();
    expect(screen.getByRole("link", { name: /Open the projects/ }).getAttribute("href")).toBe("/w/projects");
    cleanup();
    s.session = pending;
    render(<AccessPendingPage />);
    expect(screen.getByTestId("access-pending")).toBeTruthy();
  });
});

describe("write controls follow the session's actions", () => {
  const list = () =>
    mockHttp({ "GET /api/v1/projects": { items: [], truncated: false } });

  it("offers New project only to a session that can create one", async () => {
    s.session = steward;
    list();
    const view = render(<Projects />);
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByRole("button", { name: "New project" })).toBeNull();
    view.unmount();
    s.session = { ...steward, actions: [...(steward.actions ?? []), "project.create"] };
    list();
    render(<Projects />);
    expect(await screen.findByRole("button", { name: "New project" })).toBeTruthy();
  });
});

describe("refusals as the flow should say them", () => {
  const error = (code: string, details?: Record<string, unknown>, status = 400) =>
    new ApiError(status, { code, message: code, retryable: false, correlationId: "c", details } as never);

  it("says a signing mismatch is about the signing wallet in the signing flows, and about binding elsewhere", () => {
    const view = render(<ErrorNotice error={error("SIGNATURE_SIGNER_MISMATCH")} context="signing" />);
    expect(screen.getByTestId("error-notice").textContent).toContain(
      "This signature came from a wallet that is not your account's signing wallet",
    );
    expect(screen.getByTestId("error-notice").textContent).not.toContain("being bound");
    view.unmount();
    render(<ErrorNotice error={error("SIGNATURE_SIGNER_MISMATCH")} />);
    expect(screen.getByTestId("error-notice").textContent).toContain("than the one being bound");
  });

  it("states an assurance refusal as the administrator's step, not a role list", () => {
    render(
      <ErrorNotice
        error={error(
          "AUTHORIZATION_DENIED",
          {
            reason: "ASSURANCE_LEVEL_INSUFFICIENT",
            requiredAssurance: "high_assurance",
            requiredRoles: ["reviewer_cp_qp", "reviewer_lab"],
          },
          403,
        )}
      />,
    );
    expect(screen.getByTestId("assurance-needed").textContent).toBe("Identity verification needed — ask an admin");
    expect(screen.getByTestId("error-notice").textContent).toContain("identity assurance high_assurance");
    expect(screen.getByTestId("error-notice").textContent).not.toContain("One of these roles is required");
  });

  it("says up front, before signing, that the roles a screen needs are not in effect", () => {
    s.session = inactive;
    const view = render(<AssuranceNotice actions={["attestation.sign"]} />);
    const notice = screen.getByTestId("assurance-notice");
    expect(notice.textContent).toContain("Identity verification needed — ask an admin");
    expect(notice.textContent).toContain("reviewer_assurance");
    view.unmount();
    // Nothing to say when the screen's roles are in effect or are not the person's.
    render(<AssuranceNotice actions={["gate.decide"]} />);
    expect(screen.queryByTestId("assurance-notice")).toBeNull();
    s.session = steward;
    render(<AssuranceNotice actions={["attestation.sign", "claim.curate"]} />);
    expect(screen.queryByTestId("assurance-notice")).toBeNull();
  });
});
