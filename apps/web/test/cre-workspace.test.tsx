// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Cre from "../src/app/w/projects/[id]/cre/page";
import { mockHttp } from "./support/http";
const auth = vi.hoisted(() => ({ token: "cookie-session" as string | null, loading: false }));
vi.mock("../src/lib/session", () => ({ useSession: () => auth }));
const projectId = "00000000-0000-4000-8000-000000000001";
const reportId = "00000000-0000-4000-8000-000000000002";
const url = `/api/v1/projects/${projectId}/cre-reports`;
const report = { chainId: "5611", receiver: `0x${"12".repeat(20)}`, recordId: `0x${"34".repeat(32)}`,
  registryVersion: "1", contentHash: `0x${"56".repeat(32)}`, observedAt: "1700000000", validUntil: "1700000300", sequence: "1", status: 2 };
const workspace = () => ({ chainId: "5611", rpcConfigured: true, publication: { publicKey: "project-public", version: 1, status: "published" }, reports: [] as { id: string; report: typeof report }[] });
beforeEach(() => { auth.token = "cookie-session"; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function mount(routes: Parameters<typeof mockHttp>[0]) {
  const calls = mockHttp(routes);
  await act(async () => { render(<Cre params={Promise.resolve({ id: projectId })} />); });
  return calls;
}
describe("CRE workspace", () => {
  it("generates BSC Testnet97 reports from the server destination", async () => {
    const data = { ...workspace(), chainId: "97" };
    const calls = await mount({ [`GET ${url}`]: data, [`POST ${url}`]: { ...report, chainId: "97" } });
    await screen.findByText("BSC Testnet (97)");
    fireEvent.change(screen.getByLabelText("Receiver contract address"), { target: { value: report.receiver } });
    fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
    await screen.findByText(/Report generated/);
    expect(calls.find(c => c.method === "POST")?.body).toEqual({ chainId: "97", publicKey: "project-public", receiver: report.receiver, ttlSeconds: "300" });
  });
  it("guides an unpublished project to separate-person approval and prevents report generation", async () => {
    await mount({ [`GET ${url}`]: { ...workspace(), publication: null } });
    expect(await screen.findByText(/No approved public version/)).toBeDefined();
    expect(screen.getByRole("link", { name: /Open publication/ }).getAttribute("href")).toBe(`/w/projects/${projectId}/publication`);
    expect(screen.getByRole("button", { name: "Generate report" }).hasAttribute("disabled")).toBe(true);
  });
  it("uses the server chain, retains a retry key and distinguishes report creation from receiver delivery", async () => {
    const data = workspace(); let attempts = 0;
    const calls = await mount({ [`GET ${url}`]: () => data, [`POST ${url}`]: () => {
      if (++attempts === 1) throw new Error("network interrupted");
      data.reports = [{ id: reportId, report }]; return report;
    }, [`GET ${url}/${reportId}/delivery`]: { state: "matched", checkedAt: "1700000300", report, fresh: false } });
    await screen.findByText("opBNB testnet (5611)");
    fireEvent.change(screen.getByLabelText("Receiver contract address"), { target: { value: report.receiver } });
    fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Generate report" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Generate report" }));
    await screen.findByText(/Report generated\. It has not been submitted/);
    const posts = calls.filter(c => c.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0]?.headers.get("idempotency-key")).toBe(posts[1]?.headers.get("idempotency-key"));
    expect(posts[1]?.body).toEqual({ chainId: "5611", publicKey: "project-public", receiver: report.receiver, ttlSeconds: "300" });
    expect(posts[1]?.headers.has("authorization")).toBe(false);
    expect(screen.getByText("Receiver state not checked.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Check receiver" }));
    expect(await screen.findByText("Receiver matches this report")).toBeDefined();
    expect(screen.getByText(/no fresh observation/)).toBeDefined();
  });
  it("does not fetch protected data while signed out", async () => {
    auth.token = null; const calls = await mount({});
    expect(screen.getByText(/Sign in to view/)).toBeDefined(); expect(calls).toHaveLength(0);
  });
  it("blocks unsupported chains and invalid receiver input", async () => {
    await mount({ [`GET ${url}`]: { ...workspace(), chainId: "56" } });
    await screen.findByText(/This chain is not supported/);
    fireEvent.change(screen.getByLabelText("Receiver contract address"), { target: { value: "invalid" } });
    expect(screen.getByText(/Enter a nonzero/)).toBeDefined();
    expect(screen.getByRole("button", { name: "Generate report" }).hasAttribute("disabled")).toBe(true);
  });
});
