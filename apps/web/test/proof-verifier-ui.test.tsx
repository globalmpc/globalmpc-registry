// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { File } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashProjection, keccak256 } from "@mpc/canonical";
import Verifier from "../src/app/verify/page";
import { mockHttp } from "./support/http";
const leaf = keccak256(new TextEncoder().encode("registry-leaf"));
const proof = {
  leafHash: leaf,
  root: leaf,
  proof: [],
  merkleVerified: false,
  included: false,
  confirmationState: "pending",
  chainId: 56,
  transactionHash: null,
  proves: ["Inclusion of bytes"],
  doesNotProve: ["Not factual truth"],
};
const route = "GET /api/v1/public/proofs/version";
const recordRoute = "GET /api/v1/public/registries/project/MPC-123";
function check() {
  fireEvent.change(screen.getByLabelText("Public key"), { target: { value: " MPC-123 " } });
  fireEvent.click(screen.getByRole("button", { name: "Check proof" }));
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("independent public proof verification", () => {
  it("recomputes inclusion rather than trusting the server's false verification flag", async () => {
    mockHttp({ [recordRoute]: { entryVersionId: "version", revokedAt: null }, [route]: proof });
    render(<Verifier />);
    check();
    await screen.findByTestId("verify-result");
    expect(screen.getByTestId("verify-merkle").textContent).toContain("Leads to the root");
    expect(screen.getByTestId("verify-included").textContent).toContain(
      "Not reported as confirmed yet",
    );
    expect(screen.getByTestId("verify-disclaimer").textContent).toContain("Not factual truth");
  });
  it("detects a bad Merkle path even when the server claims success", async () => {
    mockHttp({
      [recordRoute]: { entryVersionId: "version" },
      [route]: { ...proof, root: `0x${"ab".repeat(32)}`, merkleVerified: true },
    });
    render(<Verifier />);
    check();
    await screen.findByTestId("verify-result");
    expect(screen.getByTestId("verify-merkle").textContent).toContain("Does not lead");
  });
  it.each([true, false])(
    "compares an independently retained leaf (matching: %s)",
    async (match) => {
      mockHttp({ [recordRoute]: { entryVersionId: "version" }, [route]: proof });
      render(<Verifier />);
      fireEvent.change(screen.getByLabelText("Expected leaf hash (optional)"), {
        target: { value: match ? leaf : `0x${"ab".repeat(32)}` },
      });
      check();
      await screen.findByTestId("verify-expected");
      expect(screen.getByTestId("verify-expected").textContent).toContain(
        match ? "Same as" : "Different from",
      );
    },
  );
  it("keeps revocation separate from the integrity of already anchored bytes", async () => {
    mockHttp({
      [recordRoute]: { entryVersionId: "version", revokedAt: "2026-01-01" },
      [route]: proof,
    });
    render(<Verifier />);
    check();
    await screen.findByTestId("verify-revoked");
    expect(screen.getByTestId("verify-merkle").textContent).toContain("Leads to the root");
    expect(screen.getByTestId("verify-revoked").textContent).toContain("Do not cite it as current");
  });
  it("explains absence of an anchor without claiming a failed proof", async () => {
    mockHttp({
      [recordRoute]: { entryVersionId: "version" },
      [route]: Response.json({ message: "No anchor yet", code: "NOT_FOUND" }, { status: 404 }),
    });
    render(<Verifier />);
    check();
    await screen.findByTestId("verify-not-anchored");
    expect(screen.queryByTestId("verify-result")).toBeNull();
  });
  it("shows a registry lookup error rather than treating it as missing anchoring", async () => {
    mockHttp({
      [recordRoute]: Response.json(
        {
          message: "Record missing",
          code: "NOT_FOUND",
          correlationId: "missing",
          retryable: false,
        },
        { status: 404 },
      ),
    });
    render(<Verifier />);
    check();
    await screen.findByText("Record missing");
    expect(screen.queryByTestId("verify-not-anchored")).toBeNull();
  });
  it("hashes saved JSON locally without sending its contents over HTTP", async () => {
    const calls = mockHttp({});
    render(<Verifier />);
    const content = { name: "Mine", version: "1" };
    const input = document.querySelector('input[type="file"]')!;
    fireEvent.change(input, {
      target: {
        files: [new File([JSON.stringify(content)], "record.json", { type: "application/json" })],
      },
    });
    await screen.findByTestId("file-hash");
    expect(screen.getByTestId("file-hash").textContent).toContain(hashProjection(content));
    expect(calls).toHaveLength(0);
  });
  it("rejects an invalid saved JSON file without uploading it", async () => {
    const calls = mockHttp({});
    render(<Verifier />);
    fireEvent.change(document.querySelector('input[type="file"]')!, {
      target: { files: [new File(["not JSON"], "bad.json")] },
    });
    await screen.findByText(/not JSON we can canonicalise/);
    expect(calls).toHaveLength(0);
  });
});
