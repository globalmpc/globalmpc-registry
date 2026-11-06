// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectWorkspaceNav } from "../src/components/project/ProjectWorkspaceNav";
const route = vi.hoisted(() => ({ pathname: "/w/projects/p1" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
afterEach(cleanup);
it("keeps four main sections with the current document area and only its related tools", () => {
  route.pathname = "/w/projects/p1/documents/u1";
  const view = render(<ProjectWorkspaceNav projectId="p1" />);
  expect(view.container.querySelectorAll(".project-navigation-main > a")).toHaveLength(4);
  expect(screen.getByRole("link", { name: "Documents & evidence" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Document status" })).toBeDefined();
  expect(screen.queryByRole("link", { name: "CRE" })).toBeNull();
});
it("keeps secondary project tools collapsed on overview and groups claims with documents", () => {
  route.pathname = "/w/projects/p1";
  const view = render(<ProjectWorkspaceNav projectId="p1" />);
  expect(view.container.querySelector("details")!.open).toBe(false);
  route.pathname = "/w/projects/p1/claims/c1";
  view.rerender(<ProjectWorkspaceNav projectId="p1" />);
  expect(screen.getByRole("link", { name: "Documents & evidence" }).getAttribute("aria-current")).toBe("page");
});
