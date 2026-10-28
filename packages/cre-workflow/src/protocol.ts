import { createCreReportRequest, creReport } from "@mpc/api-contract/cre";
import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex, type Hex } from "viem";
import { z } from "zod";

/** Anvil's selector in the official Chainlink chain-selectors registry. */
export const ANVIL_SELECTOR = 7759470850252068959n;
export const MAX_REPORT_BYTES = 16384;
/** The CRE HTTP capability rejects longer timeouts. */
export const HTTP_TIMEOUT = "10s";
/** Static 9-word tuple consumed by RegistryStatusReceiver: `report.length == 288`. */
export const REPORT_ABI_BYTES = 288;

/**
 * Every message that may leave the workflow (logs, consensus errors, execution result).
 * They are fixed strings so credentials, response bodies and transport errors never
 * reach a node log or another DON member.
 */
export const ERRORS = {
  configTooLarge: "configuration too large",
  configInvalid: "invalid workflow configuration",
  chain: "only Anvil chain 31337 is supported in this proof of concept",
  receiver: "invalid receiver",
  ttl: "invalid report TTL",
  gas: "invalid gas limit",
  endpoint: "invalid Registry endpoint",
  port: "invalid endpoint port",
  https: "HTTPS required outside explicit loopback demo",
  cronMissing: "cron scheduled time required",
  cronInvalid: "invalid cron timestamp",
  scheduledTime: "invalid scheduled time",
  credential: "Registry credential unavailable",
  request: "Registry request failed",
  responseSize: "Registry response exceeds report limit",
  reportInvalid: "Registry returned an invalid status report",
  identity: "Registry report identity/domain mismatch",
  content: "invalid report content or status",
  lifetime: "invalid report lifetime",
  consensus: "Registry report consensus failed",
  encoding: "failed to encode report",
  generation: "CRE report generation failed",
  delivery: "CRE report delivery did not succeed",
} as const;

const FIXED_MESSAGES: ReadonlySet<string> = new Set(Object.values(ERRORS));

export class WorkflowError extends Error {
  constructor(message: (typeof ERRORS)[keyof typeof ERRORS]) {
    super(message);
    this.name = "WorkflowError";
  }
}

/** Re-raise a known fixed message; replace anything else so it cannot leak detail. */
export function redact(error: unknown, fallback: (typeof ERRORS)[keyof typeof ERRORS]): WorkflowError {
  if (error instanceof Error && FIXED_MESSAGES.has(error.message)) {
    return new WorkflowError(error.message as (typeof ERRORS)[keyof typeof ERRORS]);
  }
  return new WorkflowError(fallback);
}

export type Config = {
  schedule: string;
  reportUrl: string;
  publicKey: string;
  chainName: string;
  chainId: string;
  receiver: string;
  ttlSeconds: string;
  gasLimit: string;
  allowLocalHttp: boolean;
};

export type RegistryReport = z.infer<typeof creReport>;

const configInput = z.object({
  schedule: z.string(),
  reportUrl: z.string(),
  publicKey: z.string(),
  chainName: z.string(),
  chainId: z.string(),
  receiver: z.string(),
  ttlSeconds: z.string(),
  gasLimit: z.string(),
  allowLocalHttp: z.boolean().optional(),
}).strict();

const decimalPattern = /^(0|[1-9][0-9]*)$/;
const positiveDecimal = /^[1-9][0-9]{0,19}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const zeroAddress = `0x${"0".repeat(40)}`;
const zeroHash = `0x${"0".repeat(64)}`;
// The raw URL is what the HTTP capability receives, so it is validated before any
// WHATWG normalisation: no userinfo, query, fragment, percent-encoding or whitespace.
const endpointPattern = /^(https?):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._-]+)(?::([0-9]{1,5}))?(\/api\/v1\/projects\/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\/cre-reports)$/;
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;

/** Positive decimal integer of at most `bits` bits, as the Go workflow accepted. */
export function unsigned(value: string, bits: number): bigint | undefined {
  if (value.length > 78 || !decimalPattern.test(value)) return undefined;
  const integer = BigInt(value);
  return integer > 0n && integer < (1n << BigInt(bits)) ? integer : undefined;
}

/** Bytes → validated config. Used as the SDK `configParser`. */
export function parseConfig(data: Uint8Array): Config {
  if (data.length > MAX_REPORT_BYTES) throw new WorkflowError(ERRORS.configTooLarge);
  let input: unknown;
  try {
    // JSON.parse also rejects a trailing second document.
    input = JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new WorkflowError(ERRORS.configInvalid);
  }
  return validateConfig(input);
}

export function validateConfig(input: unknown): Config {
  const parsed = configInput.safeParse(input);
  if (!parsed.success) throw new WorkflowError(ERRORS.configInvalid);
  const config = parsed.data;
  // Byte limits match the Go workflow. Lone surrogates have no UTF-8 form, so the
  // idempotency identity and the API's record hash could not agree on them.
  if (config.schedule.length === 0 || byteLength(config.schedule) > 100 || config.publicKey.length === 0
    || byteLength(config.publicKey) > 200 || loneSurrogate.test(config.schedule) || loneSurrogate.test(config.publicKey)) {
    throw new WorkflowError(ERRORS.configInvalid);
  }
  // This proof of concept cannot submit to a public chain.
  if (config.chainName !== "anvil-devnet" || config.chainId !== "31337") throw new WorkflowError(ERRORS.chain);
  const receiver = config.receiver.toLowerCase();
  if (!addressPattern.test(config.receiver) || receiver === zeroAddress) throw new WorkflowError(ERRORS.receiver);
  const ttl = unsigned(config.ttlSeconds, 64);
  if (ttl === undefined || ttl > 3600n) throw new WorkflowError(ERRORS.ttl);
  if (unsigned(config.gasLimit, 64) === undefined) throw new WorkflowError(ERRORS.gas);
  validateEndpoint(config.reportUrl, config.allowLocalHttp ?? false);
  const normalized: Config = { ...config, receiver, allowLocalHttp: config.allowLocalHttp ?? false };
  if (!createCreReportRequest.safeParse(reportRequestBody(normalized)).success) throw new WorkflowError(ERRORS.configInvalid);
  return normalized;
}

function validateEndpoint(raw: string, allowLocalHttp: boolean): void {
  const match = raw.length <= 2048 ? endpointPattern.exec(raw) : null;
  if (!match) throw new WorkflowError(ERRORS.endpoint);
  const [, scheme, host, port] = match;
  try {
    new URL(raw);
  } catch {
    throw new WorkflowError(ERRORS.endpoint);
  }
  if (port !== undefined && (Number(port) < 1 || Number(port) > 65535)) throw new WorkflowError(ERRORS.port);
  if (scheme !== "https" && !(allowLocalHttp && scheme === "http" && loopbackHosts.has(host!))) {
    throw new WorkflowError(ERRORS.https);
  }
}

export function reportRequestBody(config: Config) {
  return { publicKey: config.publicKey, chainId: config.chainId, receiver: config.receiver.toLowerCase(), ttlSeconds: config.ttlSeconds };
}

/**
 * JSON with Go `encoding/json` escaping (`<`, `>`, `&`, U+2028, U+2029 as `\u00xx`).
 * JSON.stringify emits these characters raw, and only inside strings, so the replacement
 * cannot touch structure. This keeps idempotency keys and request bytes identical to the
 * previous Go workflow; otherwise a retry across the migration would open a new report.
 */
export function goJson(value: unknown): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export const recordIdFor = (publicKey: string): Hex => keccak256(stringToHex(`mpc-registry:project:${publicKey}`));

export type ScheduledTime = { seconds?: bigint | number | undefined; nanos?: number | undefined } | undefined;

/** Validates like protobuf Timestamp.CheckValid, then requires a positive time. */
export function scheduledTime(timestamp: ScheduledTime): { seconds: bigint; nanos: number } {
  if (timestamp === undefined || timestamp === null) throw new WorkflowError(ERRORS.cronMissing);
  const rawSeconds = timestamp.seconds ?? 0n;
  const nanos = timestamp.nanos ?? 0;
  if ((typeof rawSeconds === "number" && !Number.isSafeInteger(rawSeconds)) || !Number.isInteger(nanos)) {
    throw new WorkflowError(ERRORS.cronInvalid);
  }
  const seconds = BigInt(rawSeconds);
  if (seconds < -62135596800n || seconds > 253402300799n || nanos < 0 || nanos >= 1_000_000_000) {
    throw new WorkflowError(ERRORS.cronInvalid);
  }
  if (seconds <= 0n) throw new WorkflowError(ERRORS.scheduledTime);
  return { seconds, nanos };
}

/** One key per scheduled execution, shared by every DON node. Never reads a clock. */
export function executionKey(config: Config, seconds: bigint, nanos: number): string {
  if (seconds <= 0n || !Number.isInteger(nanos) || nanos < 0 || nanos >= 1_000_000_000) {
    throw new WorkflowError(ERRORS.scheduledTime);
  }
  const identity = goJson([config.reportUrl, config.publicKey, config.chainId, config.receiver.toLowerCase(),
    config.ttlSeconds, seconds.toString(), nanos]);
  return `cre-${keccak256(stringToHex(identity)).slice(2)}-report`;
}

function reportSchema(config: Config) {
  const recordId = recordIdFor(config.publicKey);
  const ttl = BigInt(config.ttlSeconds);
  return creReport.superRefine((report, ctx) => {
    if (report.chainId !== config.chainId || report.receiver !== config.receiver.toLowerCase() || report.recordId !== recordId) {
      ctx.addIssue({ code: "custom", message: ERRORS.identity });
      return;
    }
    if (report.contentHash === zeroHash) {
      ctx.addIssue({ code: "custom", message: ERRORS.content });
      return;
    }
    // Zod also runs refinements after field issues; never convert an unvalidated integer.
    if (!positiveDecimal.test(report.observedAt) || !positiveDecimal.test(report.validUntil)) return;
    const observed = BigInt(report.observedAt);
    const until = BigInt(report.validUntil);
    if (until <= observed || until - observed > ttl) ctx.addIssue({ code: "custom", message: ERRORS.lifetime });
  });
}

/**
 * Strict validation of the Registry response. The API contract schema already requires
 * exactly nine fields, lowercase hex and positive uint64 strings; this adds the
 * destination/record binding, a nonzero content hash and the TTL window.
 */
export function validateReport(body: string, config: Config): RegistryReport {
  if (byteLength(body) > MAX_REPORT_BYTES) throw new WorkflowError(ERRORS.responseSize);
  let result;
  try {
    result = reportSchema(config).safeParse(JSON.parse(body));
  } catch {
    throw new WorkflowError(ERRORS.reportInvalid);
  }
  if (!result.success) {
    // Report a binding failure only for an otherwise well-formed report.
    const [first] = result.error.issues;
    const fixed = result.error.issues.every((issue) => issue.code === "custom") && first && FIXED_MESSAGES.has(first.message);
    throw new WorkflowError((fixed ? first.message : ERRORS.reportInvalid) as (typeof ERRORS)[keyof typeof ERRORS]);
  }
  return result.data;
}

/** Fixed field order, so every node produces identical consensus bytes. */
export function canonicalReport(report: RegistryReport): string {
  return JSON.stringify({
    chainId: report.chainId, receiver: report.receiver, recordId: report.recordId, registryVersion: report.registryVersion,
    contentHash: report.contentHash, observedAt: report.observedAt, validUntil: report.validUntil,
    sequence: report.sequence, status: report.status,
  });
}

const reportAbi = parseAbiParameters("uint256, address, bytes32, uint64, bytes32, uint64, uint64, uint64, uint8");

export function encodeReport(report: RegistryReport): Hex {
  const encoded = encodeAbiParameters(reportAbi, [BigInt(report.chainId), report.receiver as Hex, report.recordId as Hex,
    BigInt(report.registryVersion), report.contentHash as Hex, BigInt(report.observedAt), BigInt(report.validUntil),
    BigInt(report.sequence), report.status]);
  if ((encoded.length - 2) / 2 !== REPORT_ABI_BYTES) throw new WorkflowError(ERRORS.encoding);
  return encoded;
}

export { reportAbi };
