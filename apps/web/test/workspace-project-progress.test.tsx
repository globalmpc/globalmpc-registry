// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WorkspaceProjectProgress } from "../src/components/WorkspaceProjectProgress";
import { mockHttp } from "./support/http";
import { createProgressRequests } from "../src/lib/project-progress-requests";
let requests: ReturnType<typeof createProgressRequests>;
vi.mock("../src/lib/project-progress-requests", async original => {
  const actual=await original<typeof import("../src/lib/project-progress-requests")>();
  return {...actual,projectProgressRequests:{load:(...args:Parameters<typeof requests.load>)=>requests.load(...args)}};
});
beforeEach(()=>{requests=createProgressRequests();});
const snapshot = {evaluatedAt:"2026-11-11",inputSnapshotHash:"h",items:[],limitations:[],stages:[],currentStage:null};
afterEach(() => {cleanup();vi.unstubAllGlobals();vi.restoreAllMocks();});
it("renders saved progress for 50 rows without evaluating any ledger", async () => {
  const calls=mockHttp({});
  const saved={...snapshot,evaluatedAt:"2026-11-01T00:00:00Z"};
  render(<>{Array.from({length:50},(_,i)=><WorkspaceProjectProgress key={i} token="test" projectId={`p${i}`} savedSummary={saved} />)}</>);
  expect(screen.getAllByText("Saved assessment · may be outdated")).toHaveLength(50);
  expect(screen.getAllByText("Assessed 2026-11-01T00:00:00Z")).toHaveLength(50);
  await act(async()=>{});
  expect(calls).toHaveLength(0);
});
it("loads only on demand and retains saved evidence through a failed refresh and retry", async () => {
  let fail=true;
  const calls=mockHttp({"GET /api/v1/projects/p1/evidence-ledger": () => fail ? new Response(JSON.stringify({message:"Denied",code:"FORBIDDEN"}),{status:403}) : {snapshot}});
  render(<WorkspaceProjectProgress token="test" projectId="p1" savedSummary={{...snapshot,evaluatedAt:"saved"}} />);
  expect(calls).toHaveLength(0);
  fireEvent.click(screen.getByRole("button",{name:"Refresh progress"}));
  await screen.findByText(/Progress unavailable/);
  expect(screen.getByText("Assessed saved")).toBeTruthy();
  fail=false;fireEvent.click(screen.getByRole("button",{name:"Retry progress"}));
  await screen.findByText("Last requested assessment · may be outdated");
  expect(screen.queryByText("Assessed saved")).toBeNull();
  expect(calls).toHaveLength(2);
});
it("discards an earlier project request without automatically loading the new project", async () => {
  let resolve!: (value:unknown)=>void;
  const calls=mockHttp({"GET /api/v1/projects/p1/evidence-ledger":()=>new Promise(r=>{resolve=r;})});
  const view=render(<WorkspaceProjectProgress token="test" projectId="p1" />);
  fireEvent.click(screen.getByRole("button",{name:"Load progress"}));
  view.rerender(<WorkspaceProjectProgress token="test" projectId="p2" />);
  await act(async () => resolve({snapshot}));
  expect(calls).toHaveLength(1);
  expect(screen.queryByText("Stage not configured")).toBeNull();
  expect(screen.getByRole("button",{name:"Load progress"})).toBeTruthy();
  expect(screen.getByRole("link",{name:"Inspect requirements →"}).getAttribute("href")).toBe("/w/projects/p2/requirements");
});
it("caps explicit requests across 50 rows and cancels removed queued rows", async () => {
  const releases:((value:unknown)=>void)[]=[];
  const calls=mockHttp(Object.fromEntries(Array.from({length:50},(_,i)=>[`GET /api/v1/projects/p${i}/evidence-ledger`,()=>new Promise(resolve=>releases.push(resolve))])));
  const view=render(<>{Array.from({length:50},(_,i)=><WorkspaceProjectProgress key={i} token="test" projectId={`p${i}`} />)}</>);
  expect(calls).toHaveLength(0);
  screen.getAllByRole("button",{name:"Load progress"}).forEach(button=>fireEvent.click(button));
  expect(calls).toHaveLength(2);
  expect(screen.getAllByRole("button",{name:"Load progress"}).every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
  view.unmount();
  await act(async()=>{releases.forEach(resolve=>resolve({snapshot}));});
  expect(calls).toHaveLength(2);
});
it("discards the previous account result when the cookie marker and project ID are unchanged", async () => {
  let release!:(value:unknown)=>void;
  const calls=mockHttp({"GET /api/v1/projects/p1/evidence-ledger":()=>new Promise(resolve=>{release=resolve;})});
  const view=render(<WorkspaceProjectProgress key="tenant:old-subject" token="cookie-session" projectId="p1" />);
  fireEvent.click(screen.getByRole("button",{name:"Load progress"}));
  view.rerender(<WorkspaceProjectProgress key="tenant:new-subject" token="cookie-session" projectId="p1" />);
  await act(async()=>release({snapshot}));
  expect(screen.queryByText("Stage not configured")).toBeNull();
  expect(calls).toHaveLength(1);
});
it("recovers from 429 in the same mounted row only after an explicit retry past cooldown", async () => {
  let now=1000;vi.spyOn(Date,"now").mockImplementation(()=>now);
  let limited=true;
  const calls=mockHttp({"GET /api/v1/projects/limited/evidence-ledger":()=>limited ? new Response(JSON.stringify({message:"Wait",code:"RATE_LIMITED",retryable:true,correlationId:"test"}),{status:429}) : {snapshot}});
  render(<WorkspaceProjectProgress token="test" projectId="limited" />);
  fireEvent.click(screen.getByRole("button",{name:"Load progress"}));
  await screen.findByText(/Progress loading paused/);
  expect(screen.getByRole("link",{name:"Inspect requirements →"}).getAttribute("href")).toBe("/w/projects/limited/requirements");
  fireEvent.click(screen.getByRole("button",{name:"Retry progress"}));
  await screen.findByText(/Progress loading paused/);
  expect(calls).toHaveLength(1);
  now+=60_001;limited=false;
  await act(async()=>{});expect(calls).toHaveLength(1);
  fireEvent.click(screen.getByRole("button",{name:"Retry progress"}));
  await screen.findByText("Stage not configured");expect(calls).toHaveLength(2);
});
