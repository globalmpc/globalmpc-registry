import { describe, expect } from "vitest";
import { test, HttpActionsMock, REPORT_METADATA_HEADER_LENGTH } from "@chainlink/cre-sdk/test";
import type { CronPayload } from "@chainlink/cre-sdk";
import { bytesToHex, decodeAbiParameters } from "viem";
import {
  ERRORS, MAX_REPORT_BYTES, executionKey, parseConfig, reportAbi, validateReport, type Config,
} from "../src/protocol.js";
import { initWorkflow, onCron } from "../src/workflow.js";
import {
  base64, cronPayload, encode, errorOf, evmMock, fixture, respondWith, successfulDelivery, testRuntime,
  type Delivery,
} from "./fixtures.js";

const decodeReport = (rawReport: Uint8Array) =>
  decodeAbiParameters(reportAbi, bytesToHex(rawReport.slice(REPORT_METADATA_HEADER_LENGTH)));

describe("SDKWorkflow", () => {
  test("relays one validated report through the real handler", () => {
    const { config, report } = fixture();
    const runtime = testRuntime(config);
    let calls = 0;
    let writes = 0;
    HttpActionsMock.testInstance().sendRequest = (request) => {
      calls += 1;
      expect(request.url).toBe(config.reportUrl);
      expect(request.method).toBe("POST");
      expect(request.multiHeaders["Authorization"]?.values).toEqual(["Bearer test-token"]);
      expect(request.multiHeaders["Content-Type"]?.values).toEqual(["application/json"]);
      expect(request.multiHeaders["Idempotency-Key"]?.values).toEqual([executionKey(config, 1700000000n, 0)]);
      // The CRE HTTP capability caps timeouts at 10 seconds; responses must not be cached.
      expect(request.timeout?.seconds).toBe(10n);
      expect(request.timeout?.nanos ?? 0).toBe(0);
      expect(request.cacheSettings?.store).toBe(false);
      expect(JSON.parse(new TextDecoder().decode(request.body))).toStrictEqual({
        publicKey: config.publicKey, chainId: config.chainId, receiver: config.receiver, ttlSeconds: config.ttlSeconds,
      });
      return { statusCode: 200, body: base64(JSON.stringify(report)) };
    };
    evmMock().writeReport = (request) => {
      writes += 1;
      expect(bytesToHex(request.receiver)).toBe(config.receiver);
      const decoded = decodeReport(request.report!.rawReport);
      // viem decodes addresses in EIP-55 checksum case.
      expect([decoded[0], decoded[1].toLowerCase(), ...decoded.slice(2)]).toEqual([31337n, config.receiver, report.recordId, 1n, report.contentHash, 1700000000n,
        1700000300n, 9007199254740993n, 2]);
      expect(request.gasConfig?.gasLimit).toBe(500000n);
      return successfulDelivery();
    };
    expect(onCron(runtime, cronPayload())).toBe(`0x${"03".repeat(32)}`);
    expect([calls, writes]).toEqual([1, 1]);
    expect(runtime.getLogs().join("\n")).toContain("Registry status report delivered");
    expect(runtime.getLogs().join("\n")).not.toContain("test-token");
    expect(initWorkflow(config)).toHaveLength(1);
  });
});

describe("HTTPFailures", () => {
  for (const code of [301, 401, 403, 409, 429, 500]) {
    test(`${code}`, () => {
      const { config } = fixture();
      const runtime = testRuntime(config);
      respondWith("SECRET", code);
      expect(errorOf(() => onCron(runtime, cronPayload())).message).toBe(ERRORS.request);
    });
  }
  test("transport-error-redacted", () => {
    const { config } = fixture();
    const runtime = testRuntime(config);
    HttpActionsMock.testInstance().sendRequest = () => {
      throw new Error("SECRET upstream token test-token");
    };
    const error = errorOf(() => onCron(runtime, cronPayload()));
    expect(error.message).toBe(ERRORS.request);
    expect(runtime.getLogs().join("\n")).not.toMatch(/SECRET|test-token/);
  });
});

describe("MalformedReports", () => {
  const cases: Record<string, Record<string, unknown>> = {
    chain: { chainId: "1" }, receiver: { receiver: `0x${"33".repeat(20)}` }, record: { recordId: `0x${"44".repeat(32)}` },
    "version-zero": { registryVersion: "0" }, overflow: { sequence: "18446744073709551616" }, fraction: { sequence: "1.5" },
    "json-number": { sequence: 1 }, lifetime: { validUntil: "1700000301" }, "nonpositive-lifetime": { validUntil: "1700000000" },
    status: { status: 6 }, "negative-status": { status: -1 }, "unknown-field": { privateData: "SECRET" },
    "zero-hash": { contentHash: `0x${"00".repeat(32)}` },
  };
  for (const [name, mutation] of Object.entries(cases)) {
    test(name, () => {
      const { config, report } = fixture();
      const error = errorOf(() => validateReport(JSON.stringify({ ...report, ...mutation }), config));
      expect(Object.values(ERRORS)).toContain(error.message);
      expect(error.message).not.toContain("SECRET");
    });
  }
  const bodies: Record<string, string> = {
    syntax: "SECRET invalid JSON", array: "[]", null: "null", oversize: "x".repeat(MAX_REPORT_BYTES + 1),
  };
  for (const [name, body] of Object.entries(bodies)) {
    test(name, () => {
      const { config } = fixture();
      const runtime = testRuntime(config);
      respondWith(body);
      const error = errorOf(() => onCron(runtime, cronPayload()));
      expect(Object.values(ERRORS)).toContain(error.message);
      expect(error.message).not.toContain("SECRET");
    });
  }
});

describe("ConfigurationBoundaries", () => {
  const cases: Record<string, unknown>[] = [
    { reportUrl: "http://registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports" },
    { reportUrl: "https://user:password@registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports" },
    { reportUrl: "https://registry.example/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports?token=x" },
    { reportUrl: "http://127.0.0.2/api/v1/projects/00000000-0000-4000-8000-000000000001/cre-reports", allowLocalHttp: true },
    { chainName: "ethereum-mainnet", chainId: "1" }, { receiver: `0x${"00".repeat(20)}` },
    { collectUrl: "https://registry.example/collect" }, { collectBody: {} }, { ttlSeconds: "3601" }, { gasLimit: "0" },
  ];
  cases.forEach((mutation, index) => {
    test(`${index}`, () => {
      const { config } = fixture();
      expect(() => parseConfig(encode({ ...config, ...mutation }))).toThrow();
    });
  });
  test("explicit-loopback", () => {
    const { config } = fixture();
    for (const origin of ["http://127.0.0.1:3001", "http://localhost:3001", "http://[::1]:3001"]) {
      const reportUrl = config.reportUrl.replace("https://registry.example", origin);
      expect(parseConfig(encode({ ...config, reportUrl, allowLocalHttp: true })).reportUrl).toBe(reportUrl);
      expect(() => parseConfig(encode({ ...config, reportUrl }))).toThrow(ERRORS.https);
    }
  });
});

describe("DeliveryFailures", () => {
  const cases: Record<string, (result: Delivery) => void> = {
    fatal: (result) => { result.txStatus = "TX_STATUS_FATAL"; },
    reverted: (result) => { result.txStatus = "TX_STATUS_REVERTED"; },
    "consumer-reverted": (result) => { result.receiverContractExecutionStatus = "RECEIVER_CONTRACT_EXECUTION_STATUS_REVERTED"; },
    "consumer-unknown": (result) => { delete result.receiverContractExecutionStatus; },
    "hash-missing": (result) => { delete result.txHash; },
  };
  for (const [name, modify] of Object.entries(cases)) {
    test(name, () => {
      const { config, report } = fixture();
      const runtime = testRuntime(config);
      respondWith(report);
      evmMock().writeReport = () => {
        const result = successfulDelivery();
        modify(result);
        return result;
      };
      expect(errorOf(() => onCron(runtime, cronPayload())).message).toBe(ERRORS.delivery);
    });
  }
});

describe("ExecutionIdentity", () => {
  test("binds receiver case-insensitively, TTL and scheduled time", () => {
    const { config } = fixture();
    const key = executionKey(config, 1700000000n, 0);
    expect(executionKey({ ...config, receiver: config.receiver.toUpperCase().replace("0X", "0x") }, 1700000000n, 0)).toBe(key);
    expect(executionKey({ ...config, ttlSeconds: "301" }, 1700000000n, 0)).not.toBe(key);
    expect(executionKey(config, 1700000001n, 0)).not.toBe(key);
    expect(executionKey(config, 1700000000n, 1)).not.toBe(key);
    expect(() => onCron(testRuntime(config), {} as CronPayload)).toThrow(ERRORS.cronMissing);
  });
});

describe("MissingCredential", () => {
  for (const [name, token] of [["absent", null], ["malformed", "bad token\n"]] as const) {
    test(name, () => {
      const { config, report } = fixture();
      const responder = respondWith(report);
      expect(() => onCron(testRuntime(config, token), cronPayload())).toThrow(ERRORS.credential);
      expect(responder.calls()).toBe(0);
    });
  }
});

describe("StatusPreservation", () => {
  for (const status of [1, 2, 3, 4, 5]) {
    test(`${status}`, () => {
      const { config, report } = fixture();
      respondWith({ ...report, status });
      evmMock().writeReport = (request) => {
        expect(decodeReport(request.report!.rawReport)[8]).toBe(status);
        return successfulDelivery();
      };
      expect(onCron(testRuntime(config), cronPayload())).toBe(`0x${"03".repeat(32)}`);
    });
  }
});

describe("RequiredReportFields", () => {
  for (const field of ["chainId", "receiver", "recordId", "registryVersion", "contentHash", "observedAt", "validUntil", "sequence", "status"]) {
    test(field, () => {
      const { config, report } = fixture();
      const input: Record<string, unknown> = { ...report };
      delete input[field];
      expect(() => validateReport(JSON.stringify(input), config)).toThrow(ERRORS.reportInvalid);
    });
  }
});

describe("InvalidScheduledTime", () => {
  const payloads: Record<string, CronPayload | undefined> = {
    nil: undefined,
    missing: {} as CronPayload,
    zero: cronPayload(0n),
    negative: cronPayload(-1n),
    "invalid-nanos": cronPayload(1700000000n, 1_000_000_000),
    "negative-nanos": cronPayload(1700000000n, -1),
    "fractional-nanos": cronPayload(1700000000n, 0.5),
    "out-of-range": cronPayload(253402300800n),
  };
  for (const [name, payload] of Object.entries(payloads)) {
    test(name, () => {
      const { config, report } = fixture();
      const responder = respondWith(report);
      expect(() => onCron(testRuntime(config), payload)).toThrow();
      expect(responder.calls()).toBe(0);
    });
  }
  test("unsafe-number-seconds", () => {
    const { config, report } = fixture();
    const responder = respondWith(report);
    const payload = { scheduledExecutionTime: { seconds: 2 ** 60, nanos: 0 } } as unknown as CronPayload;
    expect(() => onCron(testRuntime(config), payload)).toThrow(ERRORS.cronInvalid);
    expect(() => executionKey(config, 0n, 0)).toThrow(ERRORS.scheduledTime);
    expect(responder.calls()).toBe(0);
  });
});

describe("ConfigurationInputLimits", () => {
  const cases: Record<string, (config: Config) => void> = {
    "empty-public-key": (c) => { c.publicKey = ""; }, "public-key-limit": (c) => { c.publicKey = "x".repeat(201); },
    // 101 UTF-8 bytes in 51 UTF-16 code units: the limit counts bytes, as before.
    "public-key-byte-limit": (c) => { c.publicKey = "é".repeat(100) + "x"; },
    "lone-surrogate": (c) => { c.publicKey = "a\uD800b"; },
    "empty-schedule": (c) => { c.schedule = ""; }, "schedule-limit": (c) => { c.schedule = "x".repeat(101); },
    "negative-ttl": (c) => { c.ttlSeconds = "-1"; }, "ttl-overflow": (c) => { c.ttlSeconds = "18446744073709551616"; },
    "gas-fraction": (c) => { c.gasLimit = "1.1"; }, "numeric-input-limit": (c) => { c.gasLimit = "9".repeat(79); },
    "url-limit": (c) => { c.reportUrl = "x".repeat(2049); },
    "encoded-path": (c) => { c.reportUrl = c.reportUrl.replace("/api/", "/%61pi/"); },
    fragment: (c) => { c.reportUrl += "#"; }, "empty-query": (c) => { c.reportUrl += "?"; },
    port: (c) => { c.reportUrl = c.reportUrl.replace("registry.example", "registry.example:65536"); },
    "port-zero": (c) => { c.reportUrl = c.reportUrl.replace("registry.example", "registry.example:0"); },
    "unparseable-host": (c) => { c.reportUrl = c.reportUrl.replace("registry.example", "999.1.1.1"); },
    "dot-segment": (c) => { c.reportUrl = c.reportUrl.replace("/api/", "/x/../api/"); },
  };
  for (const [name, modify] of Object.entries(cases)) {
    test(name, () => {
      const { config } = fixture();
      modify(config);
      expect(() => parseConfig(encode(config))).toThrow();
    });
  }
  test("document-limits", () => {
    const { config } = fixture();
    expect(() => parseConfig(new Uint8Array(MAX_REPORT_BYTES + 1).fill(120))).toThrow(ERRORS.configTooLarge);
    expect(() => parseConfig(new TextEncoder().encode(`${JSON.stringify(config)} {}`))).toThrow(ERRORS.configInvalid);
    expect(() => parseConfig(encode({ ...config, allowLocalHttp: "yes" }))).toThrow(ERRORS.configInvalid);
    expect(() => initWorkflow(null as unknown as Config)).toThrow(ERRORS.configInvalid);
    const { allowLocalHttp: _omitted, ...withoutFlag } = config;
    expect(parseConfig(encode(withoutFlag)).allowLocalHttp).toBe(false);
    expect(parseConfig(encode({ ...config, reportUrl: config.reportUrl.replace(".example", ".example:8443") })).reportUrl)
      .toContain(":8443/");
  });
});

describe("ReceiverCanonicalization", () => {
  test("normalizes configured receiver in config, request body and delivery", () => {
    const { config, report } = fixture();
    const upper = { ...config, receiver: `0x${config.receiver.slice(2).toUpperCase()}` };
    const parsed = parseConfig(encode(upper));
    expect(parsed.receiver).toBe(config.receiver);
    const runtime = testRuntime(upper);
    HttpActionsMock.testInstance().sendRequest = (request) => {
      expect(JSON.parse(new TextDecoder().decode(request.body)).receiver).toBe(config.receiver);
      return { statusCode: 200, body: base64(JSON.stringify(report)) };
    };
    evmMock().writeReport = (request) => {
      expect(bytesToHex(request.receiver)).toBe(config.receiver);
      return successfulDelivery();
    };
    expect(onCron(runtime, cronPayload())).toBe(`0x${"03".repeat(32)}`);
  });
  test("rejects a non-canonical receiver from the API", () => {
    // Stricter than the Go workflow: the API contract emits lowercase addresses only.
    const { config, report } = fixture();
    expect(() => validateReport(JSON.stringify({ ...report, receiver: report.receiver.toUpperCase().replace("0X", "0x") }), config))
      .toThrow(ERRORS.reportInvalid);
  });
});

describe("Redaction", () => {
  test("node-mode capability errors never carry response or transport text", () => {
    const { config } = fixture();
    const runtime = testRuntime(config);
    HttpActionsMock.testInstance().sendRequest = () => ({ statusCode: 200, body: "!!not-base64" as string });
    const error = errorOf(() => onCron(runtime, cronPayload()));
    expect(Object.values(ERRORS)).toContain(error.message);
  });
  test("report generation and delivery capability errors are fixed", () => {
    const { config, report } = fixture();
    respondWith(report);
    evmMock().writeReport = () => {
      throw new Error("SECRET rpc http://user:pass@node");
    };
    const error = errorOf(() => onCron(testRuntime(config), cronPayload()));
    expect(error.message).toBe(ERRORS.delivery);
  });
  test("unexpected consensus failures use a fixed message", () => {
    const { config } = fixture();
    const runtime = testRuntime(config);
    runtime.runInNodeMode = (() => () => ({ result: () => { throw new Error("SECRET consensus detail"); } })) as never;
    expect(errorOf(() => onCron(runtime, cronPayload())).message).toBe(ERRORS.consensus);
  });
  test("report signing failures use a fixed message", () => {
    const { config, report } = fixture();
    const runtime = testRuntime(config);
    respondWith(report);
    runtime.report = (() => ({ result: () => { throw new Error("SECRET signer"); } })) as never;
    expect(errorOf(() => onCron(runtime, cronPayload())).message).toBe(ERRORS.generation);
  });
  test("secret lookup errors use a fixed message", () => {
    const { config } = fixture();
    const runtime = testRuntime(config);
    runtime.getSecret = (() => { throw new Error("SECRET vault detail"); }) as never;
    expect(errorOf(() => onCron(runtime, cronPayload())).message).toBe(ERRORS.credential);
  });
});

