/**
 * Canonical source result enum — spec 04 §4.9 / 07 §7.11 / 13 §13.13.
 *
 * Exactly 12. API, events, UI, and test fixtures may not merge them or invent aliases.
 * In particular `source_returned_no_record` (no record), `not_applicable` (not in scope),
 * and `source_unavailable` (source could not be checked) are distinct facts and are never
 * returned under the same error code (invariant 16, AC-18).
 */
export const SOURCE_RESULTS = [
  "confirmed_from_source",
  "source_returned_no_record",
  "not_applicable",
  "access_not_authorized",
  "source_unavailable",
  "authentication_failed",
  "signature_invalid",
  "schema_changed",
  "stale",
  "conflicting",
  "manual_review_required",
  "legal_interpretation_required",
] as const;

export type SourceResult = (typeof SOURCE_RESULTS)[number];

/**
 * The next action a user can take — spec 11 §11.11.
 *
 * The UI picks its CTA from this value and does not hard-code copy alone (07 §7.3).
 */
export type NextAction =
  | "view_limitations"
  | "verify_query_or_manual_review"
  | "view_applicability_basis"
  | "check_authorization_process"
  | "view_retry_and_last_success"
  | "connection_admin_action"
  | "quarantine_security_review"
  | "await_reconciliation"
  | "request_refresh"
  | "compare_and_expert_review"
  | "submit_official_document"
  | "escalate_to_legal";

export interface SourceResultBehaviour {
  /** Could a retry under the same conditions yield a different result? */
  readonly retryable: boolean;
  /** Can canonical claim acceptance rest on this result alone? (invariant 15) */
  readonly permitsCanonicalAcceptance: boolean;
  /** Is this grounds to treat the adapter connection as degraded? */
  readonly degradesConnection: boolean;
  readonly nextAction: NextAction;
}

export const SOURCE_RESULT_BEHAVIOUR: Readonly<Record<SourceResult, SourceResultBehaviour>> = {
  // The source answered for the lookup conditions. Acceptance is decided separately after authority scope review.
  confirmed_from_source: {
    retryable: false,
    permitsCanonicalAcceptance: true,
    degradesConnection: false,
    nextAction: "view_limitations",
  },
  // The source answered normally and "no such record" is the fact. Not an outage.
  source_returned_no_record: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "verify_query_or_manual_review",
  },
  // Given jurisdiction/project conditions this requirement does not apply. Not an absence.
  not_applicable: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "view_applicability_basis",
  },
  access_not_authorized: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "check_authorization_process",
  },
  // The source could not answer. Not an absence of record.
  source_unavailable: {
    retryable: true,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "view_retry_and_last_success",
  },
  authentication_failed: {
    retryable: true,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "connection_admin_action",
  },
  signature_invalid: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "quarantine_security_review",
  },
  // No silent coercion — stop ingestion and open a reconciliation (AC-19).
  schema_changed: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: true,
    nextAction: "await_reconciliation",
  },
  stale: {
    retryable: true,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "request_refresh",
  },
  conflicting: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "compare_and_expert_review",
  },
  manual_review_required: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "submit_official_document",
  },
  legal_interpretation_required: {
    retryable: false,
    permitsCanonicalAcceptance: false,
    degradesConnection: false,
    nextAction: "escalate_to_legal",
  },
};

export function isSourceResult(value: string): value is SourceResult {
  return (SOURCE_RESULTS as readonly string[]).includes(value);
}

/**
 * Collection method — API success is not the only path (OD-42, AC-29).
 *
 * `manual` is a collection method, neither a connection lifecycle state nor a source result
 * (§4.9).
 */
export const COLLECTION_METHODS = [
  "authenticated_api",
  "official_bulk_export",
  "verifiable_signed_document",
  "manual_official_registry_confirmation",
] as const;

export type CollectionMethod = (typeof COLLECTION_METHODS)[number];
