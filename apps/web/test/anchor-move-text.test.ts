import { describe, expect, it } from "vitest";
import { moveRefusalText } from "../src/app/w/anchors/move-text";

const refusal = (reason: string, result: string | null = null) => ({
  toChainId: 31337,
  reason,
  result,
  refusedAt: "2026-01-01T00:00:00.000Z",
});

describe("why a chain move was refused", () => {
  it("tells the operator what to do when an earlier send's outcome cannot be read back", () => {
    const text = moveRefusalText(refusal("send_outcome_unknown"), 5611);
    // Not the raw code: the remedy is a check of the old chain and a resubmit there.
    expect(text).not.toContain("send_outcome_unknown");
    expect(text).toContain("Move to chain 31337 refused");
    expect(text).toContain("the batch may already be there");
    // A resubmit on the old chain asks only its configured contract, so the copy must not promise
    // a full check: the operator checks every contract that chain used.
    expect(text).toContain("Check every contract registered for chain 5611");
    expect(text).toContain("checks only the contract configured now");
    expect(text).not.toContain("checks the chain before sending");
    // An operator-settled send blocks the move permanently.
    expect(text).toContain("for good if an operator settled that send");
  });

  it("explains a target the worker would not move to", () => {
    const text = moveRefusalText(refusal("target_not_allowed"), 5611);
    expect(text).not.toContain("target_not_allowed");
    expect(text).toContain("not in the same environment");
  });

  it("explains a request dropped because the transaction went on", () => {
    const text = moveRefusalText(refusal("not_movable", "confirmed"), 5611);
    expect(text).toContain("Move to chain 31337 dropped");
    expect(text).toContain("now confirmed");
  });

  it("keeps the existing reasons and shows an unknown one as it is", () => {
    expect(moveRefusalText(refusal("batch_on_chain"), 5611)).toBe(
      "Move to chain 31337 refused: the batch is already on chain 5611",
    );
    expect(moveRefusalText({ ...refusal("other_transaction"), toChainId: null }, 5611)).toBe(
      "Move refused: the batch has another transaction there",
    );
    expect(moveRefusalText(refusal("something_new"), 5611)).toBe("Move to chain 31337 refused: something_new");
  });
});
