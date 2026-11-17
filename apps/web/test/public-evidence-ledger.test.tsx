// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PublicEvidenceLedger } from "../src/components/PublicEvidenceLedger";
import type { LedgerSummary } from "../src/lib/evidence-ledger-api";

afterEach(cleanup);
const summary: LedgerSummary = {
  evaluatedAt: "2026-11-16T00:00:00Z", inputSnapshotHash: "hash", currentStage: "stage.exploration", limitations: ["Synthetic assessment only"],
  items: [
    {claimType:"licence",displayName:"Mining licence",status:"reviewed",reasons:[],limitations:["Desk review only"]},
    {claimType:"resource",displayName:"Resource estimate",status:"missing",reasons:[],limitations:[]},
  ],
  stages: [
    {gateId:"stage.exploration",ruleSetVersion:"1",status:"ok",itemClaimTypes:["licence"],reviewedItems:"1",requiredItems:"1"},
    {gateId:"stage.resource_defined",ruleSetVersion:"1",status:"gap",itemClaimTypes:["resource"],reviewedItems:"0",requiredItems:"1"},
    {gateId:"stage.feasibility",ruleSetVersion:"1",status:"not_evaluable",itemClaimTypes:[],reviewedItems:"0",requiredItems:"0"},
  ],
};
it("uses one stage selector, published links and resettable search without confusing coverage with approval", () => {
  render(<PublicEvidenceLedger summary={summary}/>);
  const stages=screen.getByRole("list",{name:"Project stages"});
  expect(within(stages).getAllByRole("button")).toHaveLength(5);
  expect((screen.getByTestId("assessment-details") as HTMLDetailsElement).open).toBe(false);
  expect(screen.getByRole("heading",{name:/Document review items/})).toBeTruthy();
  expect(screen.getByText("Mining licence")).toBeTruthy();
  expect(screen.queryByText("Resource estimate")).toBeNull();
  fireEvent.click(within(stages).getByRole("button",{name:/Resource definition/}));
  expect(screen.getByText("Resource estimate")).toBeTruthy();
  expect(screen.queryByText("Mining licence")).toBeNull();
  fireEvent.change(screen.getByLabelText("Search evidence items"),{target:{value:"no match"}});
  expect(screen.getByText("No items match these filters.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"Clear filters"}));
  expect(screen.getByText("Resource estimate")).toBeTruthy();
  fireEvent.click(within(stages).getByRole("button",{name:/Feasibility/}));
  expect(screen.getByText("No published items are linked to this stage.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:"All published items"}));
  expect(screen.getByText("Mining licence")).toBeTruthy();
  expect(screen.getByText("Resource estimate")).toBeTruthy();
  expect(screen.getByText(/not a signed decision or permission/)).toBeTruthy();
});
it("preserves older publications without claiming stage membership or hiding their results", () => {
  render(<PublicEvidenceLedger summary={{...summary,stages:summary.stages.map(({itemClaimTypes:_links,...stage})=>stage)}}/>);
  expect(screen.getByText(/does not include item-to-stage links/)).toBeTruthy();
  expect(screen.getByText("Mining licence")).toBeTruthy();
  expect(screen.getByText("Resource estimate")).toBeTruthy();
  fireEvent.click(screen.getByRole("button",{name:/Production/}));
  expect(screen.getByText(/No assessment was published for this stage/)).toBeTruthy();
  expect(screen.getByText("Resource estimate")).toBeTruthy();
});
