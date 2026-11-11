// @vitest-environment jsdom
import * as React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceShell } from "../src/components/WorkspaceShell";
const state = vi.hoisted(() => ({ path: "/w/projects/p1/requirements", actions: ["project.read", "readiness.read", "registry.read"] }));
vi.mock("next/navigation", () => ({usePathname: () => state.path}));
vi.mock("../src/lib/session", () => ({useSession: () => ({token:"test",session:{subjectId:"s1",tenantId:"t1",actions:state.actions}})}));
vi.mock("../src/lib/api", () => ({getProject: async () => ({projectKey:"P1",name:"Mine"})}));
afterEach(cleanup);
it("has one requirements destination and labels the publication gate accurately", async () => {
  await act(async () => {render(<WorkspaceShell>Work</WorkspaceShell>);});
  expect(screen.getAllByRole("link",{name:"Requirements"})).toHaveLength(1);
  expect(screen.getByRole("link",{name:"Requirements"}).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link",{name:"Publication decision"}).getAttribute("href")).toBe("/w/projects/p1/gates/registry_publication");
  expect(screen.queryByText("More project tools")).toBeNull();
  expect(screen.getByText("CRE status relay").getAttribute("href")).toBe("/w/projects/p1/cre");
});
it("retains direct-route context and does not offer operator tools without registry access", async () => {
  state.path="/w/projects/p1/readiness";state.actions=["project.read","readiness.read"];
  await act(async () => {render(<WorkspaceShell>Assessment</WorkspaceShell>);});
  expect(screen.getByRole("link",{name:"Readiness"}).getAttribute("aria-current")).toBe("page");
  expect(screen.queryByText("CRE status relay")).toBeNull();
  expect(screen.getByText("Assessment")).toBeTruthy();
});

it("keeps document and upload subroutes in their visible project sections", async () => {
  state.path="/w/projects/p1/documents"; state.actions=["project.read","evidence.read","readiness.read"];
  let view!: ReturnType<typeof render>;
  await act(async () => {view=render(<WorkspaceShell>Files</WorkspaceShell>);});
  expect(screen.getByRole("link",{name:"Documents & evidence"}).getAttribute("aria-current")).toBe("page");
  state.path="/w/projects/p1/register";
  view.rerender(<WorkspaceShell>Upload</WorkspaceShell>);
  expect(screen.getByRole("link",{name:"Requirements"}).getAttribute("aria-current")).toBe("page");
});
