import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { creReport, type creDelivery } from "@mpc/api-contract";
import type { z } from "zod";
import type { AppConfig } from "../config.js";

const abi = parseAbi([
  "function getState(bytes32 recordId) view returns ((uint256 chainId, address receiver, bytes32 recordId, uint64 registryVersion, bytes32 contentHash, uint64 observedAt, uint64 validUntil, uint64 sequence, uint8 status))",
]);

/** Read only from the operator-configured RPC; addresses come from authorized stored reports. */
export async function inspectCreDelivery(
  config: Pick<AppConfig, "chainId" | "chainRpcUrl"> & Partial<Pick<AppConfig, "creChainId" | "creChainRpcUrl">>,
  expected: z.infer<typeof creReport>,
): Promise<z.infer<typeof creDelivery>> {
  const chainId = config.creChainId ?? config.chainId;
  const rpcUrl = config.creChainRpcUrl !== undefined ? config.creChainRpcUrl : (chainId === config.chainId ? config.chainRpcUrl : null);
  const unknown = { checkedAt: null, report: null, fresh: null };
  if (!rpcUrl) return { state: "not_configured", ...unknown };
  if (expected.chainId !== String(chainId)) return { state: "unavailable", ...unknown };
  try {
    const client = createPublicClient({ transport: http(rpcUrl, { timeout: 5000, retryCount: 0 }) });
    if (await client.getChainId() !== chainId) return { state: "unavailable", ...unknown };
    const block = await client.getBlock();
    const current = await client.readContract({ address: expected.receiver as Address, abi, functionName: "getState",
      args: [expected.recordId as Hex], blockNumber: block.number });
    const checkedAt = block.timestamp.toString();
    if (current.sequence === 0n) return { state: "empty", checkedAt, report: null, fresh: false };
    const report = creReport.parse({ ...current, chainId: current.chainId.toString(), receiver: current.receiver.toLowerCase(),
      registryVersion: current.registryVersion.toString(), observedAt: current.observedAt.toString(),
      validUntil: current.validUntil.toString(), sequence: current.sequence.toString() });
    const matched = (Object.keys(expected) as (keyof typeof expected)[]).every(key => expected[key] === report[key]);
    return { state: matched ? "matched" : "different", checkedAt, report, fresh: BigInt(report.validUntil) > block.timestamp };
  } catch {
    // RPC URLs and provider errors can carry credentials. Unavailable never means not delivered.
    return { state: "unavailable", ...unknown };
  }
}
