import { newTestRuntime, EvmMock, HttpActionsMock } from "@chainlink/cre-sdk/test";
import type { CronPayload } from "@chainlink/cre-sdk";
import { recordIdFor, type Config, type RegistryReport } from "../src/protocol.js";

export const RECEIVER = `0x${"ab".repeat(20)}`;
export const REPORT_URL = "https://registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports";
export const TX_HASH = new Uint8Array(32).fill(3);

export function fixture(): { config: Config; report: RegistryReport } {
  const config: Config = {
    schedule: "0 */5 * * * *", reportUrl: REPORT_URL, publicKey: "approved-v1", chainName: "anvil-devnet",
    chainId: "31337", receiver: RECEIVER, ttlSeconds: "300", gasLimit: "500000", allowLocalHttp: false,
  };
  const report: RegistryReport = {
    chainId: "31337", receiver: RECEIVER, recordId: recordIdFor(config.publicKey), registryVersion: "1",
    contentHash: `0x${"22".repeat(32)}`, observedAt: "1700000000", validUntil: "1700000300",
    sequence: "9007199254740993", status: 2,
  };
  return { config, report };
}

export const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
export const base64 = (value: string | Uint8Array) =>
  Buffer.from(typeof value === "string" ? new TextEncoder().encode(value) : value).toString("base64");

export function testRuntime(config: unknown, token: string | null = "test-token") {
  const secrets = token === null ? null : new Map([["main", new Map([["REGISTRY_BEARER_TOKEN", token]])]]);
  return newTestRuntime<Config>(secrets, {}, config as Config);
}

export function cronPayload(seconds: bigint = 1700000000n, nanos = 0): CronPayload {
  return { scheduledExecutionTime: { seconds, nanos } } as CronPayload;
}

export function respondWith(body: unknown, statusCode = 200) {
  const http = HttpActionsMock.testInstance();
  let calls = 0;
  http.sendRequest = () => {
    calls += 1;
    return { statusCode, body: base64(typeof body === "string" ? body : JSON.stringify(body)) };
  };
  return { http, calls: () => calls };
}

export type Delivery = {
  txStatus: "TX_STATUS_SUCCESS" | "TX_STATUS_FATAL" | "TX_STATUS_REVERTED";
  receiverContractExecutionStatus?: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS" | "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED";
  txHash?: string;
};

export function successfulDelivery(): Delivery {
  return { txStatus: "TX_STATUS_SUCCESS", receiverContractExecutionStatus: "RECEIVER_CONTRACT_EXECUTION_STATUS_SUCCESS", txHash: base64(TX_HASH) };
}

export const evmMock = () => EvmMock.testInstance(7759470850252068959n);

export function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected an error");
}
