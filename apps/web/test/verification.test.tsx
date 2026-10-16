// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Verification from "../src/app/w/projects/[id]/verification/page";
import { mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({
  token: "token" as string | null,
  session: { actions: ["claim.curate"], roleBindings: [{ role: "reviewer_cp_qp" }] },
  signTypedData: vi.fn(),
}));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const root = "/api/v1/projects/p1";
const reviewCase = {
  id: "case",
  state: "assigned",
  assignmentId: "assignment",
  claimIds: ["claim"],
  evidenceSnapshotHash: "0xsnapshot",
  version: 3,
  transitions: [],
};
const typedData = {
  domain: { chainId: 56 },
  types: {},
  primaryType: "Review",
  message: { evidence: "0xsnapshot" },
};
function routes(): Record<string, unknown> {
  return {
    [`GET ${root}/claims`]: {
      items: [{ id: "claim", claimType: "license", valueText: "MV-123", grade: "ungraded" }],
      truncated: false,
    },
    [`GET ${root}/verification-cases`]: { items: [reviewCase] },
    [`GET ${root}/review-assignment-options`]: {
      reviewers: [
        {
          subjectId: "reviewer",
          displayName: "Independent reviewer",
          roles: ["reviewer_cp_qp"],
          credentials: [{ id: "credential", credentialType: "QP", issuerReference: "authority" }],
        },
      ],
      schemas: [
        {
          id: "schema",
          schemaKey: "professional",
          schemaVersion: "1",
          attestationType: "professional_signoff",
          jurisdictionProfile: "MNG",
        },
      ],
    },
    "POST /api/v1/verification-cases": reviewCase,
    "POST /api/v1/verification-cases/case/attestations": {
      id: "draft",
      state: "draft",
      payloadHash: "0xpayload",
    },
    "POST /api/v1/attestations/draft/signature-requests": {
      signatureRequestId: "request",
      typedData,
      humanReadablePayload: "Scope: MV-123; limited to submitted evidence",
      expiresAt: "2030-01-01",
    },
    "POST /api/v1/attestations/draft/signatures": {
      id: "draft",
      state: "valid",
      signerWalletAddress: "0x1111111111111111111111111111111111111111",
      pastSignatureRemainsValid: true,
      ongoingApplicability: "current",
    },
  };
}
async function mount(data = routes()) {
  const calls = mockHttp(data);
  await act(async () => {
    render(<Verification params={Promise.resolve({ id: "p1" })} />);
  });
  if (auth.token) await screen.findByTestId("select-case-case");
  return calls;
}
async function draft() {
  fireEvent.click(screen.getByTestId("select-case-case"));
  fireEvent.click(screen.getByRole("button", { name: "Create the draft" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Create a signature request" }).hasAttribute("disabled"),
    ).toBe(false),
  );
}
async function sign() {
  await draft();
  fireEvent.click(screen.getByRole("button", { name: "Create a signature request" }));
  await screen.findByTestId("signing-payload");
  fireEvent.click(screen.getByTestId("sign-attestation"));
  await screen.findByTestId("signed-result");
}
beforeEach(() => {
  auth.token = "token";
  auth.session.actions = ["claim.curate"];
  auth.signTypedData.mockReset().mockResolvedValue("0xsigned");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("independent verification", () => {
  it("does not fetch evidence without authentication", async () => {
    auth.token = null;
    const calls = await mount({});
    expect(screen.getByText(/No account is connected/)).toBeDefined();
    expect(calls).toHaveLength(0);
  });
  it("requires evidence, credential and schema before assigning a review", async () => {
    const calls = await mount();
    const assign = screen.getByRole("button", { name: "Assign the review" });
    expect(assign.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    await waitFor(() => expect(assign.hasAttribute("disabled")).toBe(false));
    fireEvent.click(assign);
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toEqual({
        projectId: "p1",
        schemaId: "schema",
        claimIds: ["claim"],
        reviewerSubjectId: "reviewer",
        credentialId: "credential",
        conflictStatus: "none",
      }),
    );
  });
  it("does not request assignment options for a reviewer without curation rights", async () => {
    auth.session.actions = [];
    const calls = await mount();
    expect(screen.queryByTestId("assignment-options")).toBeNull();
    expect(calls.some((call) => call.url.endsWith("review-assignment-options"))).toBe(false);
  });
  it("explains missing reviewers and schemas instead of allowing a broken assignment", async () => {
    const data = routes();
    data[`GET ${root}/review-assignment-options`] = { reviewers: [], schemas: [] };
    await mount(data);
    await screen.findByTestId("no-reviewer");
    expect(screen.getByTestId("no-schema")).toBeDefined();
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Assign the review" }).hasAttribute("disabled")).toBe(
      true,
    );
  });
  it("requires limitations and fixes the selected evidence scope in the draft", async () => {
    const calls = await mount();
    fireEvent.click(screen.getByTestId("select-case-case"));
    const field = screen.getByLabelText("What this review did not check (required)");
    fireEvent.change(field, { target: { value: " " } });
    expect(screen.getByRole("button", { name: "Create the draft" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.change(field, { target: { value: " No site visit " } });
    fireEvent.click(screen.getByRole("button", { name: "Create the draft" }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({
        assignmentId: "assignment",
        claimScope: ["claim"],
        limitations: "No site visit",
      }),
    );
  });
  it("shows the signing scope and submits the wallet signature for that one request", async () => {
    const calls = await mount();
    await sign();
    expect(screen.getByTestId("signing-payload").textContent).toContain("MV-123");
    expect(auth.signTypedData).toHaveBeenCalledWith(typedData);
    expect(calls.find((call) => call.url.endsWith("/signatures"))?.body).toEqual({
      signatureRequestId: "request",
      signature: "0xsigned",
    });
    expect(screen.getByTestId("signed-result").textContent).toContain(
      "Stands as it was at the time of signing",
    );
  });
  it("does not submit anything when the wallet refuses to sign", async () => {
    auth.signTypedData.mockRejectedValue(new Error("Wallet rejected"));
    const calls = await mount();
    await draft();
    fireEvent.click(screen.getByRole("button", { name: "Create a signature request" }));
    await screen.findByTestId("signing-payload");
    fireEvent.click(screen.getByTestId("sign-attestation"));
    await screen.findByText("Wallet rejected");
    expect(calls.some((call) => call.url.endsWith("/signatures"))).toBe(false);
  });
  it("version-checks state changes and reloads the transition history", async () => {
    const data = routes();
    data["POST /api/v1/verification-cases/case/transitions"] = () => {
      data[`GET ${root}/verification-cases`] = {
        items: [
          {
            ...reviewCase,
            state: "changes_requested",
            version: 4,
            transitions: [
              {
                id: "transition",
                fromState: "assigned",
                toState: "changes_requested",
                reason: "Missing citation",
                occurredAt: "2030-01-01T00:00:00Z",
              },
            ],
          },
        ],
      };
      return {};
    };
    const calls = await mount(data);
    fireEvent.click(screen.getByTestId("select-case-case"));
    expect(screen.getByTestId("transition-changes_requested").hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: " Missing citation " },
    });
    fireEvent.click(screen.getByTestId("transition-changes_requested"));
    await screen.findByTestId("transition-history");
    expect(calls.find((call) => call.method === "POST")?.headers.get("if-match")).toBe('"3"');
    expect(screen.getByTestId("transition-history").textContent).toContain("Missing citation");
  });
  it.each(["dismissed", "upheld"])(
    "appends a %s dispute outcome without deleting the signature",
    async (outcome) => {
      const data = routes();
      const dispute = {
        id: "dispute",
        reasonCode: "EVIDENCE_QUESTIONED",
        detail: "Date unclear",
        resolvedAt: null,
      };
      data["POST /api/v1/attestations/draft/disputes"] = { state: "disputed" };
      data["GET /api/v1/attestations/draft/disputes"] = { items: [dispute] };
      data["POST /api/v1/disputes/dispute/resolution"] = () => {
        data["GET /api/v1/attestations/draft/disputes"] = {
          items: [{ ...dispute, resolvedAt: "2030-01-01", outcome, resolution: "Checked source" }],
        };
        return { attestationState: "disputed", outcome };
      };
      const calls = await mount(data);
      await sign();
      fireEvent.click(screen.getByTestId("dispute-attestation"));
      const resolve = await screen.findByTestId(`resolve-${outcome}-dispute`);
      expect(resolve.hasAttribute("disabled")).toBe(true);
      fireEvent.change(screen.getByLabelText("Basis for resolution (required)"), {
        target: { value: " Checked source " },
      });
      fireEvent.click(resolve);
      await screen.findByText("Checked source");
      expect(calls.find((call) => call.url.endsWith("/resolution"))?.body).toEqual({
        outcome,
        resolution: "Checked source",
      });
      expect(calls.some((call) => call.method === "DELETE")).toBe(false);
    },
  );
});
