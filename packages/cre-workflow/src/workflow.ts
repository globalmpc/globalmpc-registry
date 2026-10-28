import {
  bytesToBase64, bytesToHex, consensusIdenticalAggregation, cre, hexToBase64, ok, text, TxStatus,
  type CronPayload, type NodeRuntime, type Runtime,
} from "@chainlink/cre-sdk";
import {
  ANVIL_SELECTOR, ERRORS, HTTP_TIMEOUT, MAX_REPORT_BYTES, WorkflowError, canonicalReport, encodeReport, executionKey,
  goJson, redact, reportRequestBody, scheduledTime, validateConfig, validateReport, type Config,
} from "./protocol.js";

const tokenPattern = /^[A-Za-z0-9._~-]+$/;
// EVM_PB.ReceiverContractExecutionStatus.SUCCESS; the SDK root only re-exports TxStatus.
const RECEIVER_EXECUTION_SUCCESS = 0;

/**
 * Node-mode observation. Every failure becomes a fixed message: the SDK forwards a thrown
 * message to consensus, and capability errors can carry transport detail or credentials.
 */
export function requestRegistryReport(nodeRuntime: NodeRuntime<Config>, token: string, key: string): string {
  try {
    const config = nodeRuntime.config;
    const body = new TextEncoder().encode(goJson(reportRequestBody(config)));
    let response;
    try {
      response = new cre.capabilities.HTTPClient().sendRequest(nodeRuntime, {
        url: config.reportUrl,
        method: "POST",
        body: bytesToBase64(body),
        multiHeaders: {
          Authorization: { values: [`Bearer ${token}`] },
          "Content-Type": { values: ["application/json"] },
          "Idempotency-Key": { values: [key] },
        },
        timeout: HTTP_TIMEOUT,
        cacheSettings: { store: false },
      }).result();
    } catch {
      throw new WorkflowError(ERRORS.request);
    }
    // Neither the status text nor the body of a failed response is reflected anywhere.
    if (!ok(response)) throw new WorkflowError(ERRORS.request);
    if (response.body.length > MAX_REPORT_BYTES) throw new WorkflowError(ERRORS.responseSize);
    return canonicalReport(validateReport(text(response), config));
  } catch (error) {
    throw redact(error, ERRORS.request);
  }
}

export function onCron(runtime: Runtime<Config>, payload: CronPayload | undefined): string {
  const config = validateConfig(runtime.config);
  const { seconds, nanos } = scheduledTime(payload?.scheduledExecutionTime);
  const key = executionKey(config, seconds, nanos);
  // The credential is fetched in DON mode before any request, so a missing secret makes no call.
  let token: string;
  try {
    token = runtime.getSecret({ id: "REGISTRY_BEARER_TOKEN" }).result().value;
  } catch {
    throw new WorkflowError(ERRORS.credential);
  }
  if (!tokenPattern.test(token)) throw new WorkflowError(ERRORS.credential);

  // Exact agreement on canonical validated JSON precedes any signing.
  let canonical: string;
  try {
    canonical = runtime.runInNodeMode(requestRegistryReport, consensusIdenticalAggregation<string>())(token, key).result();
  } catch (error) {
    throw redact(error, ERRORS.consensus);
  }
  const report = validateReport(canonical, config);
  const encoded = encodeReport(report);

  let signed;
  try {
    signed = runtime.report({ encodedPayload: hexToBase64(encoded), encoderName: "evm", signingAlgo: "ecdsa", hashingAlgo: "keccak256" }).result();
  } catch {
    throw new WorkflowError(ERRORS.generation);
  }
  let result;
  try {
    result = new cre.capabilities.EVMClient(ANVIL_SELECTOR).writeReport(runtime, {
      receiver: config.receiver, report: signed, gasConfig: { gasLimit: config.gasLimit },
    }).result();
  } catch {
    throw new WorkflowError(ERRORS.delivery);
  }
  // Forwarder success alone is insufficient: the receiver must also have executed.
  if (result.txStatus !== TxStatus.SUCCESS || result.receiverContractExecutionStatus !== RECEIVER_EXECUTION_SUCCESS
    || result.txHash?.length !== 32) {
    throw new WorkflowError(ERRORS.delivery);
  }
  runtime.log("Registry status report delivered");
  return bytesToHex(result.txHash);
}

export function initWorkflow(input: Config) {
  const config = validateConfig(input);
  return [cre.handler(new cre.capabilities.CronCapability().trigger({ schedule: config.schedule }), onCron)];
}
