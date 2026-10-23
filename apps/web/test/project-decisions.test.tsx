// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Gate from "../src/app/w/projects/[id]/gates/[gateId]/page";
import Publication from "../src/app/w/projects/[id]/publication/page";
import Claim from "../src/app/w/projects/[id]/claims/[claimId]/page";
import { type HttpCall, mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({
  token: "token" as string | null,
  loading: false,
  session: {
    authenticated: true,
    subjectId: "reviewer",
    roleBindings: [{ role: "mpc_operator" }, { role: "disclosure_approver" }],
  },
  signTypedData: vi.fn(),
}));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
beforeEach(() => {
  auth.token = "token";
  auth.session.subjectId = "reviewer";
  auth.session.roleBindings = [
    { role: "mpc_operator" },
    { role: "disclosure_approver" },
  ];
  auth.signTypedData.mockReset().mockResolvedValue("0xsigned");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const project = {
  id: "p1",
  projectKey: "MPC-1",
  name: "Copper",
  hostCountryIso3: "MNG",
  minerals: ["copper"],
  lifecycleState: "registered",
  version: 2,
  asOf: "2026-10-20",
};
async function mount(
  Component: typeof Publication | typeof Claim | typeof Gate,
) {
  await act(async () => {
    render(
      <Component
        params={Promise.resolve({
          id: "p1",
          gateId: "publication",
          claimId: "c1",
        })}
      />,
    );
  });
}
const assessment = (status = "watch") => ({
  id: "a1",
  status,
  requirementResults: [
    {
      requirementId: "rights",
      applicable: true,
      status,
      reasonCode: "CHECK",
      cause: "Needs review",
      neededEvidence: ["license"],
      nextAction: "Upload license",
    },
  ],
});
const failure = () =>
  new Response(
    JSON.stringify({
      code: "CONFLICT",
      message: "Record changed",
      retryable: false,
      correlationId: "trace",
    }),
    { status: 409 },
  );
describe("signed gate decisions", () => {
  it("requires a condition for go on watch and submits the exact signed content", async () => {
    const calls = mockHttp({
      "POST /api/v1/projects/p1/readiness-assessments": assessment(),
      "POST /api/v1/projects/p1/gate-decisions/signature-requests": {
        signatureRequestId: "s1",
        typedData: { domain: {} },
        humanReadablePayload: "Decision signed by reviewer",
      },
      "POST /api/v1/projects/p1/gate-decisions": (call: HttpCall) => ({
        ...call.body,
        signerWalletAddress: "0x1234",
        signedAt: "2026-10-20",
      }),
    });
    await mount(Gate);
    fireEvent.click(screen.getByText("Load current readiness"));
    await screen.findByText("1 requirements are on watch");
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "  Continue with monitoring  " },
    });
    expect(
      (screen.getByRole("button", { name: "go" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText(/Assumptions/), {
      target: { value: " Stable source\n\n " },
    });
    fireEvent.change(screen.getByLabelText(/Conditions/), {
      target: { value: " Monitor weekly\n Renew license " },
    });
    fireEvent.click(screen.getByRole("button", { name: "go" }));
    await screen.findByTestId("recorded-decision");
    expect(calls.at(-1)?.body).toMatchObject({
      decision: "go",
      rationale: "Continue with monitoring",
      assumptions: ["Stable source"],
      conditions: ["Monitor weekly", "Renew license"],
      signature: "0xsigned",
      signatureRequestId: "s1",
      inputAssessmentId: "a1",
    });
    expect(auth.signTypedData).toHaveBeenCalledWith({ domain: {} });
    expect(screen.getByText("Decision signed by reviewer")).toBeTruthy();
  });
  it("blocks go for gaps but permits a signed hold", async () => {
    mockHttp({
      "POST /api/v1/projects/p1/readiness-assessments": assessment("gap"),
      "POST /api/v1/projects/p1/gate-decisions/signature-requests": () => {
        throw new Error("Wallet service unavailable");
      },
    });
    await mount(Gate);
    fireEvent.click(screen.getByText("Load current readiness"));
    await screen.findByTestId("blocking-rights");
    expect(screen.getByText("Needed: license")).toBeTruthy();
    expect(
      (screen.getByText("go (blocked)") as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByLabelText("Rationale (required)"), {
      target: { value: "Wait for evidence" },
    });
    fireEvent.click(screen.getByRole("button", { name: "hold" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Wallet service unavailable",
    );
  });
  it("shows assessment errors and requires a connected account", async () => {
    mockHttp({ "POST /api/v1/projects/p1/readiness-assessments": failure() });
    await mount(Gate);
    fireEvent.click(screen.getByText("Load current readiness"));
    await screen.findByRole("alert");
    cleanup();
    auth.token = null;
    await mount(Gate);
    expect(screen.getByText(/No account is connected/)).toBeTruthy();
  });
});
function publicationRoutes() {
  let drafts: Record<string, unknown>[] = [];
  return {
    "GET /api/v1/projects/p1": project,
    "GET /api/v1/projects/p1/evidence-ledger": { snapshot: { evaluatedAt: "2026-10-23T00:00:00Z", inputSnapshotHash: "snapshot", items: [], stages: [], currentStage: null, limitations: [] } },
    "POST /api/v1/projects/p1/evidence-ledger": { publicProjection: { snapshotId: "snapshot-1", evaluatedAt: "2026-10-23T00:00:00Z", inputSnapshotHash: "snapshot", items: [], stages: [], currentStage: null, limitations: [] } },
    "GET /api/v1/projects/p1/disclosure-restrictions/active": { items: [] },
    "GET /api/v1/registry-entries/drafts?subjectId=p1": () => ({
      items: drafts,
    }),
    "POST /api/v1/registry-entries": () => {
      drafts = [
        {
          id: "d1",
          version: 1,
          state: "pending",
          proposedBySubjectId: "drafter",
          projection: { projectName: "Copper" },
          sourceSnapshotHash: "snapshot",
          commercialReuse: "allowed",
        },
      ];
      return drafts[0];
    },
    "POST /api/v1/registry-entries/drafts/d1/publish": () => {
      drafts = [
        {
          ...drafts[0],
          state: "published",
          publicKey: "public-1",
          decidedAt: "2026-10-20",
        },
      ];
      return { publicKey: "public-1", version: 1, contentHash: "hash" };
    },
    "POST /api/v1/anchor-batches": {
      batchId: "batch1",
      root: "root1",
      recordCount: 1,
      confirmationState: "created",
    },
  };
}
describe("publication separation of duties", () => {
  it("drafts, acknowledges publication and creates a pre-submission batch", async () => {
    const calls = mockHttp(publicationRoutes());
    await mount(Publication);
    await screen.findByText("Copper");
    fireEvent.click(screen.getByTestId("draft"));
    await screen.findByTestId("pending-draft");
    expect((screen.getByTestId("publish") as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByTestId("irreversibility-ack"));
    fireEvent.click(screen.getByTestId("publish"));
    await screen.findByTestId("published-result");
    expect(
      calls.find((c) => c.url.endsWith("/publish"))?.headers.get("if-match"),
    ).toBe('"1"');
    expect(calls.find((c) => c.url.endsWith("/publish"))?.body).toEqual({
      irreversibilityAcknowledged: true,
    });
    fireEvent.click(screen.getByTestId("anchor"));
    await screen.findByTestId("anchor-result");
    expect(screen.getByText(/Not submitted yet/)).toBeTruthy();
    expect(
      calls.find(
        (c) => c.method === "POST" && c.url === "/api/v1/registry-entries",
      )?.body,
    ).toMatchObject({ projection: { legalEffect: "none", stableId: "p1", evidenceLedger: { snapshotId: "snapshot-1" } } });
  });
  it("forbids publishing one's own draft, and shows published state on reload", async () => {
    const routes = publicationRoutes();
    routes["GET /api/v1/registry-entries/drafts?subjectId=p1"] = () => ({
      items: [
        {
          id: "d1",
          state: "pending",
          proposedBySubjectId: "reviewer",
          projection: { nullable: null },
          version: 1,
        },
      ],
    });
    mockHttp(routes);
    await mount(Publication);
    await screen.findByText(/You drafted this/);
    fireEvent.click(screen.getByTestId("irreversibility-ack"));
    expect((screen.getByTestId("publish") as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();
    routes["GET /api/v1/registry-entries/drafts?subjectId=p1"] = () => ({
      items: [
        {
          id: "d1",
          state: "published",
          publicKey: "already-public",
          decidedAt: "2026-10-19",
        },
      ],
    });
    mockHttp(routes);
    await mount(Publication);
    expect(
      (await screen.findByTestId("published-result")).textContent,
    ).toContain("already-public");
  });
  it("shows missing roles and recoverable operation errors", async () => {
    auth.session.roleBindings = [];
    mockHttp(publicationRoutes());
    await mount(Publication);
    await screen.findByText("This account cannot draft or publish");
    cleanup();
    auth.session.roleBindings = [{ role: "mpc_operator" }];
    mockHttp({
      ...publicationRoutes(),
      "POST /api/v1/registry-entries": failure(),
    });
    await mount(Publication);
    await screen.findByText("Copper");
    fireEvent.click(screen.getByTestId("draft"));
    await screen.findByRole("alert");
    await waitFor(() =>
      expect((screen.getByTestId("draft") as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    cleanup();
    auth.token = null;
    await mount(Publication);
    expect(screen.getByText(/No account is connected/)).toBeTruthy();
  });
});
function claimDetail() {
  return {
    id: "c1",
    projectId: "p1",
    claimType: "copper_reserve",
    valueText: "120",
    unit: "tonnes",
    asOf: "2026-10-20",
    sourceCoordinate: { page: 2 },
    sourceReceiptId: "receipt1",
    version: 2,
    evidenceTier: "official",
    verificationState: "unreviewed",
    grade: "verified",
    staleSince: "2026-10-01",
    attestations: [
      {
        id: "at1",
        attestationType: "review",
        state: "active",
        limitations: "Desk review",
        signedAt: "2026-10-10",
        validUntil: null,
      },
    ],
    conflicts: [
      { id: "conflict1", conflictType: "contradiction", resolvedAt: null },
    ],
    conflictingClaimIds: ["c2"],
    derivation: {
      formula: "a+b",
      inputClaimIds: ["c3"],
      unit: null,
      asOf: null,
      recordedAt: "2026-10-19",
    },
    history: [
      { command: "ClaimUpdated", afterVersion: 2, occurredAt: "2026-10-19" },
    ],
    lineage: [{ relationType: "supersedes", fromId: "c1", toId: "c0" }],
    anchors: [
      {
        entryVersionId: "v1",
        merkleRoot: "root1",
        txHash: "0xtx",
        transactionState: "confirmed",
      },
    ],
  };
}
describe("claim provenance", () => {
  it("renders provenance, conflicts, derivation, history and anchor as separate facts", async () => {
    mockHttp({ "GET /api/v1/claims/c1": claimDetail() });
    await mount(Claim);
    expect((await screen.findByTestId("claim-detail")).textContent).toContain(
      "120",
    );
    expect(screen.getByTestId("source-coordinate").textContent).toContain(
      "page: 2",
    );
    expect(screen.getByTestId("claim-provenance").textContent).toContain(
      "No person has reviewed",
    );
    expect(screen.getByTestId("claim-derivation").textContent).toContain("a+b");
    expect(screen.getByTestId("claim-anchor").textContent).toContain(
      "confirmed",
    );
    expect(screen.getByRole("link", { name: /c2/ }).getAttribute("href")).toBe(
      "/w/projects/p1/claims/c2",
    );
  });
  it("distinguishes absent metadata from not found and forbidden", async () => {
    const detail = {
      ...claimDetail(),
      unit: null,
      asOf: null,
      sourceCoordinate: {},
      sourceReceiptId: null,
      evidenceTier: null,
      staleSince: null,
      attestations: [],
      conflicts: [],
      conflictingClaimIds: [],
      derivation: null,
      history: [],
      lineage: [],
      anchors: [],
    };
    mockHttp({ "GET /api/v1/claims/c1": detail });
    await mount(Claim);
    await screen.findByText("No attestation covers this claim.");
    expect(screen.getByText("No change has been recorded.")).toBeTruthy();
    cleanup();
    mockHttp({
      "GET /api/v1/claims/c1": { ...detail, projectId: "another-project" },
    });
    await mount(Claim);
    await screen.findByText(/No claim with this id/);
    expect(screen.queryByTestId("claim-detail")).toBeNull();
    cleanup();
    mockHttp({
      "GET /api/v1/claims/c1": new Response(
        JSON.stringify({
          message: "Forbidden",
          code: "FORBIDDEN",
          retryable: false,
        }),
        { status: 403 },
      ),
    });
    await mount(Claim);
    await screen.findByRole("alert");
  });
});
