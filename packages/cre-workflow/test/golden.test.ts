import { describe, expect, test } from "vitest";
import { canonicalReport, encodeReport, executionKey, goJson, recordIdFor, reportRequestBody, validateReport } from "../src/protocol.js";
import { fixture } from "./fixtures.js";

/**
 * Vectors captured from the previous Go workflow (cre-sdk-go 1.21.0, Go encoding/json and
 * go-ethereum ABI) immediately before its removal. Matching keys means a scheduled run
 * retried across the migration reuses the same Registry idempotency reservation.
 */
const GO = {
  key: "cre-773c9a6f4f6b2ec541ba0383de9199872c270fb4877faffd612c9f68e80d588c-report",
  keyHtml: "cre-9283f16c83b3665c32bffd0b2e2d462e5b558760b5c28c8b221cae8db17cedf8-report",
  keyNanos: "cre-fa2dd57b613c94cdfa1890a61306f1c70b5307ce97de0dc8b2705bf0144aea98-report",
  keyLineSeparators: "cre-a8583873e6407affe98995cf43c1a5868c228cad31b9efb9e5ecd34df901873a-report",
  keyNonAscii: "cre-332db5eb00c96b2b5afba7f430d7490778f3e4ba39b9884e0eeb5a4edb45b68d-report",
  keyControl: "cre-3355a1a961df2ab8f767cd477819ac219ffb7073096dc015975d833e9178bad5-report",
  keyMax: "cre-c709a4b51514445c7bad72b31ecbd26364166325c905d7605f4dc65c56c41063-report",
  recordId: "0x6b0dd50e213e83aa474278b8fb2a4f45f7ff8964f2cfeaa0ac13589ef8c9627b",
  body: '{"publicKey":"approved-v1","chainId":"31337","receiver":"0xabababababababababababababababababababab","ttlSeconds":"300"}',
  canonical: '{"chainId":"31337","receiver":"0xabababababababababababababababababababab","recordId":"0x6b0dd50e213e83aa474278b8fb2a4f45f7ff8964f2cfeaa0ac13589ef8c9627b","registryVersion":"1","contentHash":"0x2222222222222222222222222222222222222222222222222222222222222222","observedAt":"1700000000","validUntil":"1700000300","sequence":"9007199254740993","status":2}',
  abi: "0x0000000000000000000000000000000000000000000000000000000000007a69000000000000000000000000abababababababababababababababababababab6b0dd50e213e83aa474278b8fb2a4f45f7ff8964f2cfeaa0ac13589ef8c9627b00000000000000000000000000000000000000000000000000000000000000012222222222222222222222222222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000006553f100000000000000000000000000000000000000000000000000000000006553f22c00000000000000000000000000000000000000000000000000200000000000010000000000000000000000000000000000000000000000000000000000000002",
};

describe("Go golden vectors", () => {
  const { config, report } = fixture();
  test("idempotency keys", () => {
    expect(executionKey(config, 1700000000n, 0)).toBe(GO.key);
    expect(executionKey({ ...config, publicKey: "a&b<c>" }, 1700000000n, 0)).toBe(GO.keyHtml);
    expect(executionKey(config, 1700000000n, 5)).toBe(GO.keyNanos);
    expect(executionKey({ ...config, publicKey: "line\u2028sep\u2029x" }, 1700000000n, 0)).toBe(GO.keyLineSeparators);
    expect(executionKey({ ...config, publicKey: "café-😀" }, 1700000000n, 0)).toBe(GO.keyNonAscii);
    expect(executionKey({ ...config, publicKey: "q\"b\\s/\t\n\x01\x7f" }, 1700000000n, 0)).toBe(GO.keyControl);
    expect(executionKey({ ...config, receiver: `0x${"AB".repeat(20)}` }, 1700000000n, 0)).toBe(GO.key);
    expect(executionKey(config, 253402300799n, 999999999)).toBe(GO.keyMax);
  });
  test("Go escaping differs from JSON.stringify only for HTML and line separators", () => {
    expect(goJson(["<>&\u2028\u2029"])).toBe('["\\u003c\\u003e\\u0026\\u2028\\u2029"]');
    expect(goJson({ a: "é\t" })).toBe(JSON.stringify({ a: "é\t" }));
  });
  test("record identity, request body, consensus JSON and ABI", () => {
    expect(recordIdFor(config.publicKey)).toBe(GO.recordId);
    expect(goJson(reportRequestBody(config))).toBe(GO.body);
    const validated = validateReport(JSON.stringify(report), config);
    expect(canonicalReport(validated)).toBe(GO.canonical);
    const abi = encodeReport(validated);
    expect(abi).toBe(GO.abi);
    expect((abi.length - 2) / 2).toBe(288);
  });
});
