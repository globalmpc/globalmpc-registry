import type postgres from "postgres";
import { beforeEach, expect, it, vi } from "vitest";
import { createLedgerSweep, createLedgerSweepRunner } from "../src/evidence-ledger.js";

it("drains a running assessment at shutdown and refuses subsequent work", async () => {
  let finish!: (value: {ran: boolean; recorded: number}) => void;
  const sweep = vi.fn(() => new Promise<{ran: boolean; recorded: number}>((resolve) => { finish = resolve; }));
  const result = vi.fn();
  const runner = createLedgerSweepRunner(sweep, result, vi.fn());
  runner.kick();
  await Promise.resolve();
  runner.kick();
  let stopped = false;
  const drain = runner.stop().then(() => { stopped = true; });
  await Promise.resolve();
  expect(stopped).toBe(false);
  expect(sweep).toHaveBeenCalledOnce();
  finish({ran: true, recorded: 2});
  await drain;
  expect(result).toHaveBeenCalledWith({ran: true, recorded: 2});
  runner.kick();
  await Promise.resolve();
  expect(sweep).toHaveBeenCalledOnce();
});

it("reports failures without rejecting delivery and allows a later retry", async () => {
  const sweep = vi.fn().mockRejectedValueOnce(new Error("assessment unavailable"))
    .mockResolvedValue({ran: true, recorded: 1});
  const result = vi.fn();
  const error = vi.fn();
  const runner = createLedgerSweepRunner(sweep, result, error);
  runner.kick();
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  runner.kick();
  await vi.waitFor(() => expect(result).toHaveBeenCalledWith({ran: true, recorded: 1}));
  await runner.stop();
  expect(sweep).toHaveBeenCalledTimes(2);
});

const ledger = vi.hoisted(() => ({
  compute: vi.fn(),
  withTenant: vi.fn(),
}));
vi.mock("@mpc/db", async (original) => ({
  ...await original<typeof import("@mpc/db")>(),
  computeEvidenceLedger: ledger.compute,
  withTenant: ledger.withTenant,
}));
beforeEach(() => {
  ledger.compute.mockReset().mockResolvedValue(null);
  ledger.withTenant.mockReset().mockImplementation(async (_sql, _scope, action) => action({}));
});

function projectQueue(count: number) {
  const projects = Array.from({length: count}, (_, i) => ({
    id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
    tenant_id: `10000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
  }));
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    // Exercise the query's externally visible bounds and order, rather than an unbounded fixture.
    expect(strings.join("?")).toContain("ORDER BY p.id LIMIT");
    const cursor = values[0] as string | null;
    const limit = values.at(-1) as number;
    return projects.filter(project => cursor === null || project.id > cursor).slice(0, limit);
  });
  return {projects, query, sql: query as unknown as postgres.Sql};
}

it("bounds each interval and eventually refreshes every tenant before wrapping", async () => {
  const {projects, query, sql} = projectQueue(5);
  let now = 0;
  const sweep = createLedgerSweep(sql, 1000, () => now, 2);
  await expect(sweep()).resolves.toEqual({ran: true, recorded: 0});
  expect(ledger.compute.mock.calls.map(call => call[2])).toEqual(projects.slice(0, 2).map(p => p.id));
  await expect(sweep()).resolves.toEqual({ran: false, recorded: 0});
  expect(query).toHaveBeenCalledTimes(1);
  now += 1000;
  await sweep();
  now += 1000;
  await sweep();
  expect(ledger.compute.mock.calls.map(call => call[2])).toEqual(projects.map(p => p.id));
  for (const [index, call] of ledger.withTenant.mock.calls.entries()) {
    expect(call[1]).toEqual({tenantId: projects[index]!.tenant_id});
    expect(ledger.compute.mock.calls[index]!.slice(1, 3)).toEqual([projects[index]!.tenant_id, projects[index]!.id]);
  }
  now += 1000;
  await sweep();
  expect(ledger.compute.mock.calls.slice(-2).map(call => call[2])).toEqual(projects.slice(0, 2).map(p => p.id));
});

it("continues past a failed project and retries it after completing the cursor cycle", async () => {
  const {projects, sql} = projectQueue(3);
  let now = 0;
  ledger.compute.mockRejectedValueOnce(new Error("unavailable project"));
  const sweep = createLedgerSweep(sql, 1000, () => now, 2);
  await expect(sweep()).rejects.toThrow("batch contained failed assessments");
  expect(ledger.compute.mock.calls.map(call => call[2])).toEqual(projects.slice(0, 2).map(p => p.id));
  now += 1000;
  await sweep();
  expect(ledger.compute.mock.calls.at(-1)![2]).toBe(projects[2]!.id);
  now += 1000;
  await sweep();
  expect(ledger.compute.mock.calls.slice(-2).map(call => call[2])).toEqual(projects.slice(0, 2).map(p => p.id));
});

it("rejects invalid work bounds before querying", () => {
  const {query, sql} = projectQueue(0);
  for (const size of [0, -1, 1.5, 101, Number.NaN]) {
    expect(() => createLedgerSweep(sql, 1000, Date.now, size)).toThrow(RangeError);
  }
  expect(query).not.toHaveBeenCalled();
});


it("keeps the current page after a selection outage instead of dropping projects", async () => {
  const {projects, query, sql} = projectQueue(3);
  let now = 0;
  const sweep = createLedgerSweep(sql, 1000, () => now, 1);
  await sweep();
  query.mockRejectedValueOnce(new Error("database temporarily unavailable"));
  now += 1000;
  await expect(sweep()).rejects.toThrow("database temporarily unavailable");
  now += 1000;
  await sweep();
  expect(ledger.compute.mock.calls.map(call => call[2])).toEqual(projects.slice(0, 2).map(p => p.id));
});
