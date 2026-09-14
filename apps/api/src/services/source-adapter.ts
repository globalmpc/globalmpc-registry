import { createHash } from "node:crypto";
import {
  assertEndpointReachable,
  dnsResolver,
  type HostResolver,
} from "./source-endpoint.js";
import {
  pinnedFetch,
  SourceResponseTooLargeError,
  type SourceFetch,
} from "./source-fetch.js";
import {
  checkAdapterAvailable,
  toReceiptInput,
  type AdapterDescriptor,
  type AdapterInvocation,
  type SourceResult,
} from "@mpc/domain";

/**
 * Source Adapter implementation — spec 05 §5.12, OD-42.
 *
 * The framework (`@mpc/domain/adapter`) sets the rules; the actual calls happen here.
 * **No authority names appear in this file** — which authority to call and how comes from
 * config (OD-43).
 *
 * Only two collection methods are implemented.
 *
 * - `http` — authenticated API. Response status and body decide one of 12 outcomes.
 * - `manual` — accepts a result a person looked up. Does not call the adapter.
 *
 * The rest (bulk export, signed documents) get built once real targets are confirmed. Building
 * them now would turn unused code into a maintenance burden.
 */

export interface HttpAdapterConfig {
  readonly endpoint: string;
  /** Auth header. The value comes from the secret manager — not stored here. */
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** JSON path for extracting the as-of date from the response. Null if absent. */
  readonly effectiveAtField: string | null;
  /** What this source's response looks like. Without a declaration nothing is confirmed. */
  readonly responseProfile: ResponseProfile;
}

/**
 * Source response profile — 2026-09-10 audit A7.
 *
 * Previously **a response that parsed as JSON was taken as matching the schema.** So HTTP 200
 * with `{"error":"unavailable"}` or `{}` became `confirmed_from_source` — a path that records a
 * source saying "cannot answer" as confirmation.
 *
 * The declaration belongs to the connection (`core.source_connections`). **No authority is in code** (OD-43).
 */
export interface ResponseProfile {
  /**
   * Top-level fields a normal response always has.
   *
   * **Empty means nothing is confirmed.** An unknown format is not read as a match —
   * the same rule as `schema_fingerprint` for `official_bulk_export`.
   */
  readonly requiredFields: readonly string[];
  /** Field carrying "no record for that condition". `found` in `{"found": false}`. */
  readonly recordAbsentField: string | null;
  /** When that field equals this value, there is no record. `"false"` for `found`. */
  readonly recordAbsentValue: string | null;
  /** Field carrying a business error in a 200. Any value means not a success. */
  readonly businessErrorField: string | null;
}

/**
 * Body verdict.
 *
 * Kept separate from the status code — the fact of a 200 and the fact that the body is an
 * answer we recognize are different, and merging them lets the former mask the latter.
 */
export type BodyVerdict =
  | "match"
  | "no_record"
  | "business_error"
  | "drift"
  | "unprofiled"
  | "unparsable"
  | "empty";

export interface BodyEvaluation {
  readonly verdict: BodyVerdict;
  readonly detail: string | null;
  readonly parsed: unknown;
}

/** Reads a top-level field. Nested paths get built when profiles grow. */
function fieldOf(parsed: unknown, field: string): unknown {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  return (parsed as Record<string, unknown>)[field];
}

/**
 * Judges the response body against the profile.
 *
 * The order is the rule. Business errors and no-record are checked **before field matching** —
 * those responses lack the normal response's fields, so reversing the order turns them all
 * into `schema_changed` and loses "what the source actually answered".
 */
export function evaluateResponseBody(body: string, profile: ResponseProfile): BodyEvaluation {
  if (body.trim().length === 0) return { verdict: "empty", detail: null, parsed: null };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Not JSON. Do not guess values.
    return { verdict: "unparsable", detail: null, parsed: null };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { verdict: "drift", detail: "Top level is not an object", parsed };
  }

  if (profile.businessErrorField) {
    const value = fieldOf(parsed, profile.businessErrorField);
    if (value !== undefined && value !== null && value !== "" && value !== false) {
      return { verdict: "business_error", detail: String(value).slice(0, 200), parsed };
    }
  }

  if (profile.recordAbsentField && profile.recordAbsentValue !== null) {
    const value = fieldOf(parsed, profile.recordAbsentField);
    if (value !== undefined && String(value) === profile.recordAbsentValue) {
      return { verdict: "no_record", detail: null, parsed };
    }
  }

  // Without a declaration a match cannot be claimed. A 200 and valid JSON are only form.
  if (profile.requiredFields.length === 0) {
    return { verdict: "unprofiled", detail: null, parsed };
  }

  const missing = profile.requiredFields.filter(
    (field) => fieldOf(parsed, field) === undefined,
  );
  if (missing.length > 0) {
    return { verdict: "drift", detail: `Missing fields: ${missing.join(", ")}`, parsed };
  }

  return { verdict: "match", detail: null, parsed };
}

/**
 * Normalizes an HTTP response into one of 12 outcomes.
 *
 * **This is the core of the module.** Splitting status codes straight into success/failure
 * makes "no record" (404) and "source outage" (503) the same failure, and users keep
 * retrying records that do not exist.
 */
export function classifyHttpResponse(input: {
  readonly status: number;
  readonly signatureValid: boolean | null;
  /** Body verdict. Produced by `evaluateResponseBody`. */
  readonly body: BodyVerdict;
}): SourceResult {
  // Auth failure and no permission differ: the former is our config problem, the latter an agreement problem.
  if (input.status === 401) return "authentication_failed";
  if (input.status === 403) return "access_not_authorized";

  // 404 is a fact, not an outage — there is no record for that condition.
  if (input.status === 404) return "source_returned_no_record";

  if (input.status === 429 || input.status >= 500) return "source_unavailable";

  // 3xx. Redirects are not followed — the source is sending us elsewhere, and the target may be
  // on the internal network. Following automatically turns registry lookups into a channel for
  // reading internal addresses. A person verifies the new address and fixes the config.
  if (input.status >= 300 && input.status < 400) return "manual_review_required";

  if (input.status >= 200 && input.status < 300) {
    // A signed response failed verification. Even if the content is right it cannot be trusted.
    if (input.signatureValid === false) return "signature_invalid";

    switch (input.body) {
      // The schema changed. It parses, but not in a format we know — guessing values
      // would record false facts.
      case "unparsable":
      case "drift":
        return "schema_changed";

      // The source answered "no record for that condition". A fact, not an outage.
      case "no_record":
        return "source_returned_no_record";

      /**
       * A 200 whose body carries a business error.
       *
       * Not left as `source_unavailable` — that is a retry target and marks the connection
       * degraded. We cannot assert that without knowing what the source said.
       * A person reads the detail.
       */
      case "business_error":
        return "manual_review_required";

      // A 200 with an empty body. Indistinguishable from no-record, so a person looks.
      case "empty":
        return "manual_review_required";

      /**
       * This source's normal response shape is not declared.
       *
       * **This is the core of A7.** Confirming on parse success alone makes both `{}` and
       * `{"error":"..."}` confirmations. Without a declaration nothing is confirmed.
       */
      case "unprofiled":
        return "manual_review_required";

      case "match":
        return "confirmed_from_source";
    }
  }

  // Unknown status. Not passed as success.
  return "manual_review_required";
}

/** Hash of the original. The basis for reproducibility; takes storage out of the trust base. */
export function hashRawResponse(body: string): string {
  return `0x${createHash("sha256").update(body).digest("hex")}`;
}

export interface InvokeInput {
  readonly descriptor: AdapterDescriptor;
  readonly config: HttpAdapterConfig;
  readonly queryBasis: Readonly<Record<string, string>>;
}

/**
 * HTTP adapter call.
 *
 * **Callability is judged first.** Calling a `pending_access` source promises an unverified
 * integration and records a 401 as "auth failure" — when in fact no agreement has been
 * reached.
 */
export async function invokeHttpAdapter(
  input: InvokeInput,
  fetchImpl: SourceFetch = pinnedFetch,
  resolveHost: HostResolver = dnsResolver,
): Promise<AdapterInvocation> {
  const availability = checkAdapterAvailable(input.descriptor);
  if (!availability.callable) {
    return {
      kind: "failed",
      // Do not record unapproved access as an auth failure.
      result:
        availability.reason === "MANUAL_COLLECTION_ONLY"
          ? "manual_review_required"
          : "access_not_authorized",
      detail: availability.nextAction,
    };
  }

  /**
   * Re-checks the target right before calling — SSRF.
   *
   * It is also checked at save time, but that alone does not stop a bypass that changes DNS so
   * the name points to a private address. If it trips here, no request was sent, so it is our
   * config problem, not a source outage — the result records it that way.
   *
   * **The address used for the verdict is taken and connected to as is.** Resolving again could
   * change the answer in between (rebinding), making the checked and connected addresses differ.
   */
  let pinnedAddresses: readonly string[];
  try {
    pinnedAddresses = await assertEndpointReachable(input.config.endpoint, resolveHost);
  } catch (error) {
    return {
      kind: "failed",
      result: "manual_review_required",
      detail: error instanceof Error ? error.message : "Endpoint is not usable",
    };
  }

  const url = new URL(input.config.endpoint);
  for (const [key, value] of Object.entries(input.queryBasis)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.config.timeoutMs);

  let response: Response;
  let body: string;
  try {
    response = await fetchImpl(url, {
      headers: input.config.headers,
      signal: controller.signal,
      // Do not follow redirects. The classification above routes 3xx to a manual check.
      redirect: "manual",
      pinnedAddresses,
    });
    body = await response.text();
  } catch (error) {
    // A response over the cap is not a source outage. We could not read it, and
    // a person checks what arrived.
    if (error instanceof SourceResponseTooLargeError) {
      return { kind: "failed", result: "manual_review_required", detail: error.message };
    }
    // Timeouts and connection failures are source outages, not no-record.
    return {
      kind: "failed",
      result: "source_unavailable",
      detail: String(error).slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }

  const evaluation = evaluateResponseBody(body, input.config.responseProfile);

  const result = classifyHttpResponse({
    status: response.status,
    // Signature verification differs per source, so it is added in the R5 profile.
    signatureValid: null,
    body: evaluation.verdict,
  });

  if (result !== "confirmed_from_source") {
    return {
      kind: "failed",
      result,
      detail: evaluation.detail
        ? `HTTP ${response.status} — ${evaluation.detail}`
        : `HTTP ${response.status} (${evaluation.verdict})`,
    };
  }

  return {
    kind: "outcome",
    outcome: {
      result,
      rawHash: hashRawResponse(body),
      queryBasis: input.queryBasis,
      // Limitations the adapter would add are not inserted here. Those the authority declared are
      // always merged in `toReceiptInput`.
      limitations: [],
      effectiveAt: extractEffectiveAt(evaluation.parsed, input.config.effectiveAtField),
    },
  };
}

/**
 * As-of date stated by the source.
 *
 * Differs from lookup time — if the registry was updated yesterday, the as-of date is yesterday
 * even when queried today. Treating them as equal makes data look fresher than it is.
 */
function extractEffectiveAt(parsed: unknown, field: string | null): string | null {
  if (!field || parsed === null || typeof parsed !== "object") return null;

  const value = (parsed as Record<string, unknown>)[field];
  if (typeof value !== "string") return null;

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Turns an adapter result into a Source Receipt body.
 *
 * `toReceiptInput` always merges the authority's limitations — even if the adapter omits
 * them, no receipt is created without limitations.
 */
export function buildReceiptBody(
  descriptor: AdapterDescriptor,
  invocation: AdapterInvocation,
  extra: {
    readonly connectionId: string;
    readonly authorityId: string;
    readonly collectionMethod: string;
    readonly authenticationMethod: string;
    readonly endpointOrDocumentRef: string;
    readonly sourceSchemaVersion: string;
    readonly adapterVersion: string;
    readonly termsLicense: string;
    readonly commercialReuse: string;
    readonly disclosurePermission: string;
  },
): Record<string, unknown> {
  const normalized = toReceiptInput(descriptor, invocation);

  return {
    connectionId: extra.connectionId,
    authorityId: extra.authorityId,
    result: normalized.result,
    collectionMethod: extra.collectionMethod,
    queryBasis: normalized.queryBasis,
    endpointOrDocumentRef: extra.endpointOrDocumentRef,
    authenticationMethod: extra.authenticationMethod,
    // A failed lookup has no original. Do not fabricate a hash.
    rawHash: normalized.rawHash ?? `0x${"0".repeat(64)}`,
    sourceSchemaVersion: extra.sourceSchemaVersion,
    adapterVersion: extra.adapterVersion,
    termsLicense: extra.termsLicense,
    commercialReuse: extra.commercialReuse,
    disclosurePermission: extra.disclosurePermission,
    asOf: new Date().toISOString(),
    effectiveAt: normalized.effectiveAt,
    freshnessStatus: normalized.effectiveAt ? "fresh" : "unknown",
    limitations: normalized.limitations,
  };
}
