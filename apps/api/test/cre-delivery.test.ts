import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectCreDelivery } from "../src/services/cre-delivery.js";
const rpc = vi.hoisted(() => ({ getChainId: vi.fn(), getBlock: vi.fn(), readContract: vi.fn() }));
vi.mock("viem", async original => ({ ...await original<typeof import("viem")>(), createPublicClient: () => rpc }));
const expected = { chainId: "5611", receiver: `0x${"12".repeat(20)}`, recordId: `0x${"34".repeat(32)}`,
  registryVersion: "1", contentHash: `0x${"56".repeat(32)}`, observedAt: "100", validUntil: "400", sequence: "1", status: 2 };
const config = { chainId: 5611, chainRpcUrl: "https://rpc.example" };
const state = () => ({ ...expected, chainId: 5611n, registryVersion: 1n, observedAt: 100n, validUntil: 400n, sequence: 1n });
beforeEach(() => { vi.clearAllMocks(); rpc.getChainId.mockResolvedValue(5611); rpc.getBlock.mockResolvedValue({ number: 55n, timestamp: 200n }); rpc.readContract.mockResolvedValue(state()); });
describe("CRE receiver observation", () => {
  it("reads the dedicated CRE chain while retaining a different anchor chain", async () => {
    rpc.getChainId.mockResolvedValue(97);
    rpc.readContract.mockResolvedValue({ ...state(), chainId: 97n });
    expect(await inspectCreDelivery({ ...config, creChainId: 97, creChainRpcUrl: "https://cre.example" }, { ...expected, chainId: "97" }))
      .toMatchObject({ state: "matched", report: { chainId: "97" } });
    vi.clearAllMocks();
    expect(await inspectCreDelivery({ ...config, creChainId: 97, creChainRpcUrl: null }, { ...expected, chainId: "97" }))
      .toMatchObject({ state: "not_configured" });
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });
  it("compares every field at a single block, independently of positive status", async () => {
    expect(await inspectCreDelivery(config, expected)).toEqual({ state: "matched", checkedAt: "200", report: expected, fresh: true });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber: 55n, address: expected.receiver, args: [expected.recordId] }));
    rpc.getBlock.mockResolvedValue({ number: 56n, timestamp: 400n });
    expect(await inspectCreDelivery(config, expected)).toMatchObject({ state: "matched", fresh: false });
  });
  it.each(["contentHash", "receiver", "recordId", "status", "sequence"])("does not claim a match when %s differs", async key => {
    const value = key === "status" ? 3 : key === "sequence" ? 2n : key === "receiver" ? `0x${"99".repeat(20)}` : `0x${"99".repeat(32)}`;
    rpc.readContract.mockResolvedValue({ ...state(), [key]: value });
    expect(await inspectCreDelivery(config, expected)).toMatchObject({ state: "different" });
  });
  it("reports an empty receiver separately", async () => {
    rpc.readContract.mockResolvedValue({ ...state(), sequence: 0n });
    expect(await inspectCreDelivery(config, expected)).toMatchObject({ state: "empty", report: null, fresh: false });
  });
  it("refuses a mismatched RPC chain before contract reads", async () => {
    rpc.getChainId.mockResolvedValue(97);
    expect(await inspectCreDelivery(config, expected)).toMatchObject({ state: "unavailable" });
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it("does not expose RPC errors or infer non-delivery from outages", async () => {
    rpc.readContract.mockRejectedValue(new Error("secret-rpc-credential"));
    expect(await inspectCreDelivery(config, expected)).toEqual({ state: "unavailable", checkedAt: null, report: null, fresh: null });
  });
  it("does not call RPC without configuration or for historical other-chain reports", async () => {
    expect(await inspectCreDelivery({ ...config, chainRpcUrl: null }, expected)).toMatchObject({ state: "not_configured" });
    expect(await inspectCreDelivery(config, { ...expected, chainId: "31337" })).toMatchObject({ state: "unavailable" });
    expect(rpc.getChainId).not.toHaveBeenCalled();
  });
});
