/**
 * Evidence Adapter Framework — spec 05 §5.12, OD-42.
 *
 * Wraps government registries, professional bodies, ERSPs, and manual checks in **one Source
 * Receipt envelope**. If each adapter used its own result format, the 12 source results would
 * fork once per adapter and the UI would have to merge them again.
 *
 * This file names no specific institution. **Core does not hard-code institutions, laws, or
 * schemas** (OD-43) — the Mongolia profile arrives as configuration; only confirmed integrations are active.
 *
 * What an adapter must uphold:
 *
 * 1. **Never turn a failure into a success.** A failed lookup is `source_unavailable`, not
 *    `source_returned_no_record`. Mixing the two makes users keep retrying for a record that
 *    does not exist.
 * 2. **Keep the raw-response hash.** Replaying the same lookup later must reveal whether the
 *    response changed.
 * 3. **State what was not checked.** The authority's `does_not_prove` goes straight into the
 *    receipt's `limitations`.
 */

import type { SourceResult } from "./source-result.js";

/**
 * Adapter operating state — OD-43.
 *
 * Only `active` is actually called. The rest exist **to expose that an integration is not
 * ready** — drop them from the list and "why is this institution missing" has no answer.
 */
export const ADAPTER_STATES = [
  /** Access is confirmed; the adapter is called. */
  "active",
  /** A person looks up the source and enters the result. No API, or access is under negotiation. */
  "manual",
  /** The institution is identified but access is not granted. Not called. */
  "pending_access",
  /** Unusable for legal or contractual reasons. */
  "blocked",
] as const;

export type AdapterState = (typeof ADAPTER_STATES)[number];

export interface AdapterDescriptor {
  readonly connectionKey: string;
  readonly authorityName: string;
  readonly jurisdiction: string;
  readonly state: AdapterState;
  /** What this source confirms. Same as the authority's `proves`. */
  readonly proves: readonly string[];
  /** What it does not confirm. Never empty (05 §5.11). */
  readonly doesNotProve: readonly string[];
  /** Why it is in this state. Required in particular for `pending_access` and `blocked`. */
  readonly stateReason: string;
}

export type AdapterAvailability =
  | { readonly callable: true }
  | { readonly callable: false; readonly reason: string; readonly nextAction: string };

/**
 * Can this adapter be called now?
 *
 * `manual` is not a call target but is **not blocked either** — a person does the lookup.
 * Erasing that distinction makes manual checks look like outages.
 */
export function checkAdapterAvailable(descriptor: AdapterDescriptor): AdapterAvailability {
  switch (descriptor.state) {
    case "active":
      return { callable: true };
    case "manual":
      return {
        callable: false,
        reason: "MANUAL_COLLECTION_ONLY",
        nextAction: "Look up the official channel, then record the result manually",
      };
    case "pending_access":
      return {
        callable: false,
        reason: "ACCESS_NOT_GRANTED",
        nextAction: "Negotiate access with the institution. Do not call it until access is confirmed",
      };
    case "blocked":
      return {
        callable: false,
        reason: "LEGALLY_BLOCKED",
        nextAction: "Check the outcome of the legal review",
      };
  }
}

/**
 * Adapter call result.
 *
 * Normalized to one of the 12 source results. If an adapter used its own format, decision
 * branches would multiply by that many formats.
 */
export interface AdapterOutcome {
  readonly result: SourceResult;
  /** Hash of the raw bytes. The basis for reproducibility. */
  readonly rawHash: string;
  /** The conditions of the lookup. The same conditions must be replayable. */
  readonly queryBasis: Readonly<Record<string, string>>;
  /** What this lookup did not check. Receives the authority's `doesNotProve`. */
  readonly limitations: readonly string[];
  /** Reference date stated by the source. Differs from the lookup time. */
  readonly effectiveAt: string | null;
}

export type AdapterInvocation =
  | { readonly kind: "outcome"; readonly outcome: AdapterOutcome }
  /** The adapter could not decide. **Never recorded as a success.** */
  | { readonly kind: "failed"; readonly result: SourceResult; readonly detail: string };

/**
 * Converts an adapter result into Source Receipt input.
 *
 * **Limitations are merged here.** Even if the adapter omits them, the authority's declared
 * `doesNotProve` always goes in — a receipt without limitations would be misread as a full
 * check.
 */
export function toReceiptInput(
  descriptor: AdapterDescriptor,
  invocation: AdapterInvocation,
): {
  readonly result: SourceResult;
  readonly limitations: readonly string[];
  readonly rawHash: string | null;
  readonly queryBasis: Readonly<Record<string, string>>;
  readonly effectiveAt: string | null;
} {
  if (invocation.kind === "failed") {
    return {
      result: invocation.result,
      // Limitations stay attached on failure too. Recording a failed lookup only as "not
      // checked" would lose what it tried to check.
      limitations: [...descriptor.doesNotProve, `Lookup failed: ${invocation.detail}`],
      rawHash: null,
      queryBasis: {},
      effectiveAt: null,
    };
  }

  const merged = new Set([...descriptor.doesNotProve, ...invocation.outcome.limitations]);

  return {
    result: invocation.outcome.result,
    limitations: [...merged],
    rawHash: invocation.outcome.rawHash,
    queryBasis: invocation.outcome.queryBasis,
    effectiveAt: invocation.outcome.effectiveAt,
  };
}

/**
 * Jurisdiction Profile — OD-43.
 *
 * The adapter set for one jurisdiction. Core knows only this structure; the contents come from
 * configuration. The goal is deep Mongolia support first without hard-coding Mongolia.
 */
export interface JurisdictionProfile {
  readonly jurisdiction: string;
  readonly adapters: readonly AdapterDescriptor[];
}

/**
 * Profile validation.
 *
 * **A profile with no active adapter is still valid** — e.g. a jurisdiction whose access is
 * under negotiation. The fact is exposed in the list instead.
 */
export type ProfileIssue = { readonly connectionKey: string; readonly problem: string };

export function validateProfile(profile: JurisdictionProfile): ProfileIssue[] {
  const issues: ProfileIssue[] = [];
  const seen = new Set<string>();

  for (const adapter of profile.adapters) {
    if (seen.has(adapter.connectionKey)) {
      issues.push({ connectionKey: adapter.connectionKey, problem: "duplicate connectionKey" });
    }
    seen.add(adapter.connectionKey);

    // 05 §5.11: an authority that declares no limitations cannot be registered.
    if (adapter.doesNotProve.length === 0) {
      issues.push({
        connectionKey: adapter.connectionKey,
        problem: "doesNotProve is empty — what is not checked must always be stated",
      });
    }

    if (adapter.proves.length === 0) {
      issues.push({ connectionKey: adapter.connectionKey, problem: "proves is empty" });
    }

    // An inactive state needs a reason. If "why doesn't this institution work" has no answer,
    // that alone looks like an unverified integration.
    if (adapter.state !== "active" && adapter.stateReason.trim().length === 0) {
      issues.push({
        connectionKey: adapter.connectionKey,
        problem: `${adapter.state} state requires a reason`,
      });
    }

    if (adapter.jurisdiction !== profile.jurisdiction) {
      issues.push({
        connectionKey: adapter.connectionKey,
        problem: "profile jurisdiction and adapter jurisdiction differ",
      });
    }
  }

  return issues;
}

/**
 * Reads a connection state as an adapter state — 05 §5.11.
 *
 * `source_connections.state` is the source of truth; the adapter state is its interpretation.
 * A separate column would drift from it. There are several readers, so the rule lives here in
 * one place — if the UI and the ingestion path read it differently, the UI says callable while
 * ingestion rejects.
 */
export function connectionStateToAdapterState(
  connectionState: string | null,
): AdapterState | "none" {
  switch (connectionState) {
    case "active":
      return "active";
    // Access is confirmed but there is no automatic call path yet. A person does the lookup.
    case "access_confirmed":
    case "tested":
      return "manual";
    // Feasibility review or planning stage. Calling it would promise an unverified integration.
    case "planned":
    case "feasibility_checked":
      return "pending_access";
    case "degraded":
    case "disabled":
      return "blocked";
    case null:
    case undefined:
      // No integration at all. The institution is known but no access path was built.
      return "none";
    default:
      // An unknown state is never read as callable.
      return "pending_access";
  }
}

/** Why it is in this state. Anything other than `active` needs a reason. */
export function adapterStateReason(
  adapterState: AdapterState | "none",
  connectionState: string | null,
): string {
  switch (adapterState) {
    case "active":
      return "";
    case "manual":
      return "No official API, or access is under negotiation. A person looks it up and records the result";
    case "pending_access":
      return `Access is not confirmed (connection state: ${connectionState ?? "none"})`;
    case "blocked":
      return `Integration is suspended or degraded (connection state: ${connectionState})`;
    case "none":
      return "No integration has been built for this institution";
  }
}
