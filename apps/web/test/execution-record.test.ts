import { describe, expect, it } from "vitest";
import { canRecordExecutionFor, EMPTY_EXECUTION_RECORD } from "../src/lib/execution-record";

describe("execution record form", () => {
  const complete = {
    targetProposalId: "proposal-b",
    executor: "Treasury desk",
    authority: "Board resolution 12",
    executedAction: "Paid the audit invoice",
    evidenceReference: "doc://receipt",
    evidenceHash: `0x${"ab".repeat(32)}`,
    limitation: "Does not establish the amount was correct",
  };

  it("records only against the proposal the form names", () => {
    expect(canRecordExecutionFor(complete, "proposal-b")).toBe(true);
    expect(canRecordExecutionFor(complete, "proposal-a")).toBe(false);
  });

  it("starts empty, with no target", () => {
    expect(canRecordExecutionFor(EMPTY_EXECUTION_RECORD, "")).toBe(false);
  });
});
