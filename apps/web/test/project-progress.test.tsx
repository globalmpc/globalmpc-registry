// @vitest-environment jsdom
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ProjectProgress, stageCoverage } from "../src/components/ProjectProgress";
import type { LedgerSummary } from "../src/lib/evidence-ledger-api";
afterEach(cleanup);
const summary: LedgerSummary = {
  evaluatedAt: "2026-11-11T00:00:00Z", inputSnapshotHash: "hash", items: [], limitations: [],
  currentStage: "stage.resource_defined", stages: [
    {gateId:"stage.exploration",ruleSetVersion:"1",status:"gap",reviewedItems:"1",requiredItems:"3",missing:["licence","licence"]},
    {gateId:"stage.resource_defined",ruleSetVersion:"1",status:"ok",reviewedItems:"2",requiredItems:"2"},
  ],
};
it("keeps an earlier gap visible even when a later evidence stage passes", () => {
  render(<ProjectProgress summary={summary} />);
  expect(screen.getByText("Resource definition")).toBeTruthy();
  expect(screen.getByText("Needs attention: Exploration")).toBeTruthy();
  expect(screen.getByText("1 / 3 required evidence items reviewed")).toBeTruthy();
  expect(screen.getByText("1 missing evidence type(s)")).toBeTruthy();
  expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1");
  expect(screen.getByText(/not a signed decision/)).toBeTruthy();
});
it("distinguishes no stage rules from a failing first stage", () => {
  const view=render(<ProjectProgress summary={{...summary,currentStage:null,stages:[]}} />);
  expect(screen.getByText("Stage not configured")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  view.rerender(<ProjectProgress summary={{...summary,currentStage:null}} />);
  expect(screen.getByText("No stage established")).toBeTruthy();
  expect(screen.getByText("Needs attention: Exploration")).toBeTruthy();
});
it("never substitutes whole-catalog totals or zero for unavailable stage coverage", () => {
  render(<ProjectProgress summary={{...summary,stages:[{...summary.stages[0],reviewedItems:undefined,requiredItems:undefined}]}} published />);
  expect(screen.getByText("Required-item coverage unavailable")).toBeTruthy();
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/in this published version/)).toBeTruthy();
});
it("does not draw a completed bar for zero, invalid or inverted counts", () => {
  for (const [reviewedItems,requiredItems] of [["-1","2"],["2","1"],["NaN","2"],["1","9007199254740992"]]) {
    expect(stageCoverage({...summary.stages[0],reviewedItems,requiredItems})).toBeNull();
  }
  render(<ProjectProgress summary={{...summary,stages:[{...summary.stages[0],reviewedItems:"0",requiredItems:"0",status:"not_evaluable"}]}} />);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText("Assessment incomplete")).toBeTruthy();
});

it("does not call a later passing assessment a completed human decision", () => {
  render(<ProjectProgress summary={{...summary,stages:[summary.stages[1]]}} />);
  expect(screen.getByText("All assessed stages meet evidence requirements")).toBeTruthy();
  expect(screen.queryByText(/approved to proceed/i)).toBeNull();
});

it("does not turn reviewed coverage into a passing gate", () => {
  render(<ProjectProgress summary={{...summary,currentStage:null,stages:[{...summary.stages[0],reviewedItems:"3",requiredItems:"3"}]}} />);
  expect(screen.getByText("Needs attention: Exploration")).toBeTruthy();
  expect(screen.queryByText("All assessed stages meet evidence requirements")).toBeNull();
  expect(screen.getByText(/not a signed decision/)).toBeTruthy();
});
