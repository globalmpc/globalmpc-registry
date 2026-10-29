// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import Explorer from "../src/app/explorer/page";
import PublicProject from "../src/app/explorer/projects/[publicKey]/page";
import Search from "../src/app/explorer/search/page";
import Disclosures from "../src/app/disclosures/page";
import Governance from "../src/app/governance/page";
import { PublicRegistryBrowser } from "../src/components/PublicRegistryBrowser";
import { PublicRecord } from "../src/components/PublicRecord";
import { mockHttp } from "./support/http";
import type { PublicProjection } from "../src/lib/api";
afterEach(() => {
  cleanup();
  window.history.replaceState({}, "", "/");
  vi.unstubAllGlobals();
});
const entry = {
  entryVersionId: "v1",
  version: "1",
  status: "published",
  publicKey: "MPC-1",
  publishedAt: "2026-10-20",
  legalEffect: "none",
  disclaimerCodes: [],
  revokedAt: null,
  history: [],
  limitations: ["Desk review only"],
  authorityScope: ["License"],
  authorityType: "mining",
  staleStatus: "fresh",
  sourceAge: "1 day",
} as PublicProjection;
const listItem = {
  entryVersionId: "v1",
  publicKey: "MPC-1",
  version: "1",
  status: "published",
  publishedAt: "2026-10-20",
  revokedAt: null,
  supersededByVersion: null,
  projection: {
    projectName: "Copper",
    mineral: ["copper", 3, "gold"],
    absent: 3,
  },
};
it("searches public records, appends a cursor page and clears search without retaining old rows", async () => {
  let pageFails = true;
  const calls = mockHttp({
    "GET /api/v1/public/registries/project?limit=20": {
      items: [listItem],
      nextCursor: "next",
    },
    "GET /api/v1/public/registries/project?limit=20&cursor=next": () => {
      if (pageFails) throw new Error("Next page unavailable");
      return {
        items: [
          {
            ...listItem,
            entryVersionId: "v2",
            publicKey: "MPC-2",
            revokedAt: "2026-10-20",
            supersededByVersion: "2",
          },
        ],
        nextCursor: null,
      };
    },
    "GET /api/v1/public/registries/project?q=gold&limit=20": {
      items: [],
      nextCursor: null,
    },
  });
  render(
    <PublicRegistryBrowser
      registryType="project"
      hrefFor={(item) => `/explorer/projects/${item.publicKey}`}
      searchPlaceholder="Name"
      emptyMessage="No published projects"
      columns={[
        { field: "projectName", label: "Name" },
        { field: "mineral", label: "Mineral" },
        { field: "absent", label: "Missing" },
      ]}
    />,
  );
  await screen.findByText("Copper");
  expect(screen.getByText("copper, gold")).toBeTruthy();
  fireEvent.click(screen.getByText("Load more"));
  await screen.findByRole("alert");
  expect(screen.getByText("MPC-1")).toBeTruthy();
  pageFails = false;
  fireEvent.click(screen.getByText("Load more"));
  await screen.findByText("MPC-2");
  fireEvent.change(screen.getByLabelText("Search"), {
    target: { value: " gold " },
  });
  fireEvent.submit(screen.getByTestId("public-search-submit").closest("form")!);
  await screen.findByText("Nothing published matches “gold”.");
  expect(screen.queryByText("MPC-1")).toBeNull();
  fireEvent.click(screen.getByText("Clear"));
  await screen.findByText("MPC-1");
  expect(calls.at(-1)?.url).toBe("/api/v1/public/registries/project?limit=20");
});
it("keeps limitations and status at every depth and distinguishes proof inclusion from finality", async () => {
  const proof = {
    included: false,
    root: "0xroot",
    batchId: "batch1",
    leafHash: "leaf",
    path: [],
    chainId: 56,
    transactionHash: "0xtx",
    proves: ["Bytes unchanged"],
    doesNotProve: ["No factual guarantee"],
  };
  mockHttp({ "GET /api/v1/public/proofs/v1": proof });
  const view = render(<PublicRecord entry={entry} />);
  await screen.findByText(/Not confirmed yet/);
  for (const depth of ["explanation", "expert", "basic"]) {
    fireEvent.click(screen.getByTestId(`depth-${depth}`));
    expect(screen.getByTestId("shared-limitations").textContent).toContain(
      "Desk review only",
    );
    expect(screen.getByTestId("shared-status").textContent).toBe("published");
  }
  fireEvent.click(screen.getByTestId("depth-expert"));
  expect(screen.getByTestId("proof-disclaimer").textContent).toContain(
    "No factual guarantee",
  );
  mockHttp({ "GET /api/v1/public/proofs/v2": { ...proof, included: true } });
  view.rerender(
    <PublicRecord
      entry={{ ...entry, entryVersionId: "v2", revokedAt: "2026-10-20" }}
    />,
  );
  await screen.findByText("Confirmed");
});
it("does not fabricate metadata or an integrity proof when a version is unanchored", async () => {
  mockHttp({
    "GET /api/v1/public/proofs/v1": () => {
      throw new Error("Not anchored");
    },
  });
  render(
    <PublicRecord
      entry={{
        ...entry,
        publishedAt: null,
        authorityScope: [],
        staleStatus: null,
        sourceAge: null,
      }}
    />,
  );
  fireEvent.click(screen.getByTestId("depth-explanation"));
  expect(
    screen.getByText("The published record states no authority scope."),
  ).toBeTruthy();
  expect(screen.getByText(/Not anchored yet/)).toBeTruthy();
});
it("looks up a public key from the URL and allows an explicit registry lookup", async () => {
  window.history.replaceState(
    {},
    "",
    "/explorer?publicKey=MPC-1&registryType=project",
  );
  const calls = mockHttp({
    "GET /api/v1/public/registries/project?limit=20": {
      items: [],
      nextCursor: null,
    },
    "GET /api/v1/public/registries/project/MPC-1": entry,
    "GET /api/v1/public/proofs/v1": () => {
      throw new Error("No proof");
    },
    "GET /api/v1/public/registries/verification/missing": () => {
      throw new Error("Record not found");
    },
  });
  render(<Explorer />);
  await screen.findByText("Published record");
  fireEvent.change(screen.getByLabelText("Registry"), {
    target: { value: "verification" },
  });
  fireEvent.change(screen.getByLabelText("Public key"), {
    target: { value: " missing " },
  });
  fireEvent.submit(screen.getByLabelText("Public key").closest("form")!);
  await screen.findByRole("alert");
  expect(screen.queryByText("Published record")).toBeNull();
  expect(calls.at(-1)?.url).toContain("verification/missing");
});
it("resolves a shareable project URL and displays lookup errors", async () => {
  mockHttp({
    "GET /api/v1/public/registries/project/MPC-1": entry,
    "GET /api/v1/public/proofs/v1": () => {
      throw new Error("No proof");
    },
  });
  await act(async () =>
    render(<PublicProject params={Promise.resolve({ publicKey: "MPC-1" })} />),
  );
  await screen.findByText("Published record");
  cleanup();
  mockHttp({
    "GET /api/v1/public/registries/project/MPC-1": () => {
      throw new Error("Missing record");
    },
  });
  await act(async () =>
    render(<PublicProject params={Promise.resolve({ publicKey: "MPC-1" })} />),
  );
  await screen.findByRole("alert");
});
it("searches by hash, links each registry correctly and blocks wallet-address lookups", async () => {
  window.history.replaceState({}, "", "/explorer/search?q=hash1");
  mockHttp({
    "GET /api/v1/public/search?q=hash1": {
      query: "hash1",
      kind: "hash",
      chainId: 56,
      matches: ["project", "verification"].map((registryType, i) => ({
        entryVersionId: `v${i}`,
        registryType,
        publicKey: `key${i}`,
        matchedOn: "transaction_hash",
        status: "published",
        version: 1,
        transactionHash: "0xtx",
      })),
    },
  });
  render(<Search />);
  await screen.findByTestId("search-results");
  expect(screen.getByRole("link", { name: "key0" }).getAttribute("href")).toBe(
    "/explorer/projects/key0",
  );
  expect(
    screen.getByRole("link", { name: "key1" }).getAttribute("href"),
  ).toContain("registryType=verification");
  cleanup();
  window.history.replaceState({}, "", `/explorer/search?q=0x${"a".repeat(40)}`);
  const calls = mockHttp({});
  render(<Search />);
  await screen.findByTestId("search-address-notice");
  expect(calls).toHaveLength(0);
  fireEvent.change(screen.getByLabelText("Find a record"), {
    target: { value: "gold" },
  });
  expect(
    (screen.getByTestId("global-search-submit") as HTMLButtonElement).disabled,
  ).toBe(false);
});
it("links each hash match to the explorer of the chain it was stored on", async () => {
  // The deployment now runs on 5611; an anchor sent on BSC mainnet and one sent before the move
  // on the local chain keep their own chains. A match without a chain falls back to the top level.
  const tx = (n: string) => `0x${n.repeat(64)}`;
  window.history.replaceState({}, "", `/explorer/search?q=${tx("a")}`);
  mockHttp({
    [`GET /api/v1/public/search?q=${tx("a")}`]: {
      query: tx("a"),
      kind: "hash",
      chainId: 5611,
      matches: [
        { chainId: 56, hash: tx("b") },
        { chainId: 31337, hash: tx("c") },
        { chainId: undefined, hash: tx("d") },
      ].map(({ chainId, hash }, i) => ({
        entryVersionId: `v${i}`,
        registryType: "project",
        publicKey: `key${i}`,
        matchedOn: "transaction_hash",
        status: "published",
        version: "1",
        merkleRoot: null,
        transactionHash: hash,
        ...(chainId === undefined ? {} : { chainId }),
      })),
    },
  });
  render(<Search />);
  await screen.findByTestId("search-results");
  const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
  expect(hrefs).toContain(`https://bscscan.com/tx/${tx("b")}`);
  expect(hrefs).toContain(`https://testnet.opbnbscan.com/tx/${tx("d")}`);
  // The local chain has no explorer — not a link to opBNBScan, where the hash does not exist.
  expect(hrefs.some((href) => href?.includes(tx("c")))).toBe(false);
});
it("paginates disclosure events while preserving scope and distinguishing corrections from revocations", async () => {
  const events = [
    {
      eventId: "e1",
      eventKind: "revocation",
      occurredAt: "2026-10-20",
      registryType: "project",
      publicKey: "MPC-1",
      registryVersion: { version: 2, projection: { projectName: "Copper" } },
    },
    {
      eventId: "e2",
      eventKind: "suspension",
      occurredAt: "2026-10-20",
      registryType: "verification",
      publicKey: "MPC-2",
      lifecycle: { fromState: "active", toState: "suspended" },
    },
  ];
  let fail = true;
  const scope = [{ kind: "private_dispute", reason: "Not public" }];
  mockHttp({
    "GET /api/v1/public/disclosures?limit=20": {
      items: events,
      nextCursor: "next",
      notCovered: scope,
    },
    "GET /api/v1/public/disclosures?limit=20&cursor=next": () => {
      if (fail) throw new Error("Page failed");
      return {
        items: [
          {
            eventId: "e3",
            eventKind: "dispute",
            occurredAt: "2026-10-20",
            registryType: "project",
            publicKey: "MPC-3",
            resolvedAt: "2026-10-20",
          },
          {
            eventId: "e4",
            eventKind: "pause",
            occurredAt: "2026-10-20",
            registryType: "asset",
            publicKey: "MPC-4",
          },
        ],
        nextCursor: null,
        notCovered: scope,
      };
    },
  });
  render(<Disclosures />);
  await screen.findByText("Copper");
  expect(screen.getByText("active → suspended")).toBeTruthy();
  fireEvent.click(screen.getByText("Load more"));
  await screen.findByRole("alert");
  fail = false;
  fireEvent.click(screen.getByText("Load more"));
  await screen.findByText("Still open");
  expect(screen.getByTestId("disclosure-not-covered").textContent).toContain(
    "Not public",
  );
});
it("opens protocol proposal details with frozen thresholds and transition history", async () => {
  const proposal = {
    id: "g1",
    title: "Improve review",
    proposalType: "protocol",
    state: "voting",
    tally: {
      for: "1000000000000000000",
      against: "0",
      abstain: "0",
      voterCount: 1,
    },
  };
  mockHttp({
    "GET /api/v1/public/governance/centralization": () => {
      throw new Error("Disclosure unavailable");
    },
    "GET /api/v1/public/governance/proposals?limit=20": {
      items: [proposal],
      nextCursor: "next",
    },
    "GET /api/v1/public/governance/proposals?limit=20&cursor=next": {
      items: [{ ...proposal, id: "g2", title: "Other proposal" }],
      nextCursor: null,
    },
    "GET /api/v1/public/governance/proposals/g1": {
      ...proposal,
      rationale: "More reviewers",
      conflictDisclosure: null,
      executionMode: null,
      quorum: { numerator: 1, denominator: 2 },
      threshold: { numerator: 2, denominator: 3 },
      votingOpensAt: null,
      votingClosesAt: null,
      transitions: [
        {
          fromState: "draft",
          toState: "voting",
          occurredAt: "2026-10-20",
          reason: "Opened",
        },
      ],
    },
  });
  render(<Governance />);
  await screen.findByText("Improve review");
  fireEvent.click(screen.getByText("Improve review"));
  await screen.findByTestId("public-proposal-detail");
  expect(screen.getByText("2/3")).toBeTruthy();
  expect(screen.getByText("Opened")).toBeTruthy();
  fireEvent.click(screen.getByText("Close"));
  expect(screen.queryByTestId("public-proposal-detail")).toBeNull();
  fireEvent.click(screen.getByText("Load more"));
  await screen.findByText("Other proposal");
});
it("shows the stored anchor contract of each hash match, linked on its chain's explorer", async () => {
  // A later contract version lives at a new address: the contract comes from the match, and a
  // match without one says so rather than borrowing another contract.
  const tx = (n: string) => `0x${n.repeat(64)}`;
  const v1 = `0x${"a1".repeat(20)}`;
  const v2 = `0x${"b2".repeat(20)}`;
  window.history.replaceState({}, "", `/explorer/search?q=${tx("e")}`);
  mockHttp({
    [`GET /api/v1/public/search?q=${tx("e")}`]: {
      query: tx("e"),
      kind: "hash",
      chainId: 5611,
      matches: [
        { chainId: 5611, hash: tx("e"), contractAddress: v1 },
        { chainId: 56, hash: tx("f"), contractAddress: v2 },
        { chainId: 31337, hash: tx("1"), contractAddress: v1 },
        { chainId: 5611, hash: tx("2"), contractAddress: null },
        { chainId: null, hash: null, contractAddress: null },
      ].map(({ chainId, hash, contractAddress }, i) => ({
        entryVersionId: `c${i}`,
        registryType: "project",
        publicKey: `ckey${i}`,
        matchedOn: "transaction_hash",
        status: "published",
        version: "1",
        merkleRoot: null,
        transactionHash: hash,
        chainId,
        contractAddress,
      })),
    },
  });
  render(<Search />);
  await screen.findByTestId("search-results");
  const hrefs = screen.getAllByRole("link").map((link) => link.getAttribute("href"));
  expect(hrefs).toContain(`https://testnet.opbnbscan.com/address/${v1}`);
  expect(hrefs).toContain(`https://bscscan.com/address/${v2}`);
  const cells = screen.getAllByTestId("search-contract").map((cell) => cell.textContent);
  // Unsent match: no contract line at all.
  expect(cells).toHaveLength(4);
  // The local chain has no explorer: the address is shown, not linked.
  expect(cells[2]).toContain(v1);
  expect(hrefs.filter((href) => href?.endsWith(`/address/${v1}`))).toHaveLength(1);
  expect(cells[3]).toContain("Not recorded for this anchor");
});
it("shows the stored anchor contract in the integrity proof", async () => {
  const contract = `0x${"a1".repeat(20)}`;
  const proof = {
    included: true,
    merkleVerified: true,
    root: "0xroot",
    batchId: "batch1",
    leafHash: "leaf",
    proof: [],
    chainId: 5611,
    contractAddress: contract,
    transactionHash: `0x${"ab".repeat(32)}`,
    proves: [],
    doesNotProve: [],
  };
  mockHttp({ "GET /api/v1/public/proofs/v1": proof });
  render(<PublicRecord entry={entry} />);
  const cell = await screen.findByTestId("proof-contract");
  expect(cell.querySelector("a")?.getAttribute("href")).toBe(`https://testnet.opbnbscan.com/address/${contract}`);
  expect(cell.textContent).toBe(contract);
});
