import { recoverTypedDataAddress, type Hex as ViemHex } from "viem";
import { canonicalBytes, keccak256, type Hex } from "@mpc/canonical";
import { GATE_DECISION_EIP712_TYPES } from "@mpc/api-contract";
import type { AppConfig } from "../config.js";
import { uuidToBytes32 } from "./attestation-signing.js";

/**
 * EIP-712 gate decision signing — spec 11 §11.3, 07 §7.2.
 *
 * Same shape as attestation signing: the server builds the signing target and verifies the
 * signature the approver made with their own key. It holds no key and signs for no one.
 *
 * A separate domain from attestations, so a signature over one can never be replayed as the
 * other — the two answer different questions (a review result vs. a decision to proceed).
 */

export interface GateDecisionContent {
  readonly gateId: string;
  readonly decision: string;
  readonly inputAssessmentId: string;
  readonly rationale: string;
  readonly assumptions: readonly string[];
  readonly conditions: readonly string[];
}

export interface GateDecisionMessage {
  readonly projectId: ViemHex;
  readonly gateId: string;
  readonly decision: string;
  readonly inputAssessmentId: ViemHex;
  readonly evidenceSnapshotHash: ViemHex;
  readonly payloadHash: ViemHex;
  readonly issuedAt: bigint;
  readonly expiresAt: bigint;
  readonly nonce: ViemHex;
}

export function gateDecisionDomain(config: AppConfig) {
  return {
    name: "MPC Gate Decision",
    version: "1",
    chainId: config.chainId,
    salt: keccak256(new TextEncoder().encode("mpc-gate-decision-v1")) as ViemHex,
  } as const;
}

/**
 * Commitment to the whole decision.
 *
 * Order of assumptions and conditions is kept — the approver wrote them in that order, and
 * reordering is a different statement. Whitespace is trimmed so a trailing space is not a
 * different decision from the one on screen.
 */
export function hashGateDecisionPayload(content: GateDecisionContent): Hex {
  return keccak256(
    canonicalBytes({
      gateId: content.gateId,
      decision: content.decision,
      inputAssessmentId: content.inputAssessmentId,
      rationale: content.rationale.trim(),
      assumptions: content.assumptions.map((item) => item.trim()),
      conditions: content.conditions.map((item) => item.trim()),
    }),
  );
}

export function buildGateDecisionTypedData(config: AppConfig, message: GateDecisionMessage) {
  return {
    domain: gateDecisionDomain(config),
    types: GATE_DECISION_EIP712_TYPES,
    primaryType: "GateDecision" as const,
    message,
  };
}

/**
 * Recovers the signer. Whether that address belongs to the deciding subject is the caller's
 * check — signature validity and authority are separate facts (invariant 13).
 */
export async function recoverGateDecisionSigner(
  config: AppConfig,
  message: GateDecisionMessage,
  signature: ViemHex,
): Promise<string> {
  const address = await recoverTypedDataAddress({
    ...buildGateDecisionTypedData(config, message),
    signature,
  });
  return address.toLowerCase();
}

export function gateDecisionMessage(input: {
  readonly projectId: string;
  readonly gateId: string;
  readonly decision: string;
  readonly inputAssessmentId: string;
  readonly evidenceSnapshotHash: string;
  readonly payloadHash: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
  readonly nonce: string;
}): GateDecisionMessage {
  return {
    projectId: uuidToBytes32(input.projectId),
    gateId: input.gateId,
    decision: input.decision,
    inputAssessmentId: uuidToBytes32(input.inputAssessmentId),
    evidenceSnapshotHash: input.evidenceSnapshotHash as ViemHex,
    payloadHash: input.payloadHash as ViemHex,
    issuedAt: BigInt(Math.floor(input.issuedAt.getTime() / 1000)),
    expiresAt: BigInt(Math.floor(input.expiresAt.getTime() / 1000)),
    nonce: input.nonce as ViemHex,
  };
}

/** What the approver reads before the wallet opens. States what the signature does not mean. */
export function humanReadableGateDecision(input: {
  readonly projectKey: string;
  readonly content: GateDecisionContent;
  readonly assessmentStatus: string;
  readonly evidenceSnapshotHash: string;
}): string {
  const list = (items: readonly string[]) =>
    items.length === 0 ? ["  (none)"] : items.map((item) => `  - ${item.trim()}`);
  return [
    `Project: ${input.projectKey}`,
    `Gate: ${input.content.gateId}`,
    `Decision: ${input.content.decision}`,
    `Readiness at decision: ${input.assessmentStatus}`,
    `Evidence snapshot: ${input.evidenceSnapshotHash}`,
    "",
    "Rationale:",
    `  ${input.content.rationale.trim()}`,
    "Assumptions:",
    ...list(input.content.assumptions),
    "Conditions:",
    ...list(input.content.conditions),
    "",
    "This signature records a human decision. It is not a legal approval to issue and does not state that the evidence is accurate.",
  ].join("\n");
}
