import { z } from "zod";
import { SOURCE_RESULTS } from "@mpc/domain";

/**
 * Common API conventions — spec 07 §7.1·§7.3.
 *
 * Everything defined here is attached to every response. In particular,
 * `limitations`, `legalEffect`, and `disclaimerCodes` are not optional — the UI
 * renders its warnings from them, so copy is never hardcoded (§7.3).
 */

export const hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "Must be 32-byte lowercase hex");

export const walletAddress = z
  .string()
  .regex(/^0x[0-9a-f]{40}$/, "Must be a 20-byte lowercase hex address");

export const ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Must be a ULID");

export const isoDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "Must be ISO 8601 UTC");

/**
 * Error envelope.
 *
 * Why `retryable` exists: 07 §7.11 forbids returning `source_returned_no_record`
 * and a timeout under the same error code. A client that guesses whether to
 * retry mistakes "no record" for an outage.
 */
export const errorEnvelope = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  retryable: z.boolean(),
  correlationId: z.string(),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelope>;

/** Metadata attached to every response (§7.1). */
export const responseMeta = z.object({
  requestId: z.string(),
  resourceVersion: z.number().int().nonnegative().optional(),
  asOf: isoDateTime,
});

/**
 * Safety fields — §7.3.
 *
 * `legalEffect` has only `none` and `counsel_required` by design. The MPC API
 * does not determine whether legal effect exists.
 */
export const safetyFields = z.object({
  authority: z.string().describe("Party that produced or decided this value"),
  basisVersion: z.string(),
  ruleVersion: z.string().nullable(),
  limitations: z.array(z.string()),
  sourceAge: z.string().nullable().describe("Elapsed days, as an integer decimal string"),
  staleStatus: z.enum(["fresh", "aging", "stale", "unknown"]),
  verificationScope: z.array(z.string()),
  legalEffect: z.enum(["none", "counsel_required"]),
  externalRegulatedServiceStatus: z
    .object({
      status: z.enum([
        "not_linked",
        "requested",
        "ersp_confirmed",
        "ersp_rejected",
        "expired",
      ]),
      erspOrganizationId: z.string().nullable(),
      authorizationEvidenceId: z.string().nullable(),
      asOf: isoDateTime.nullable(),
      limitations: z.array(z.string()),
    })
    .nullable(),
  disclaimerCodes: z.array(z.string()),
});

export const sourceResultEnum = z.enum(SOURCE_RESULTS);

/** UI and retry hints for the 12 results (§7.11, §11.11). */
export const sourceStatusView = z.object({
  result: sourceResultEnum,
  retryable: z.boolean(),
  nextAction: z.string(),
  lastSuccessAt: isoDateTime.nullable(),
  asOf: isoDateTime,
  authorityReference: z.string(),
  authorityScope: z.array(z.string()),
  collectionMethod: z.enum([
    "authenticated_api",
    "official_bulk_export",
    "verifiable_signed_document",
    "manual_official_registry_confirmation",
  ]),
  adapterVersion: z.string(),
  sourceSchemaVersion: z.string(),
  limitations: z.array(z.string()),
});

/** Common mutation headers (§7.1). */
export const mutationHeaders = z.object({
  "idempotency-key": z.string().min(16).describe("Prevents duplicate execution when a mutation is retried"),
  "if-match": z.string().optional().describe('Required for versioned resource mutations. Format: `"<version>"`'),
});

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
