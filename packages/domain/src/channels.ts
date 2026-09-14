import type { CollectionMethod, SourceResult } from "./source-result.js";

export type { CollectionMethod };

/**
 * Evidence channel parity — spec 05 §5.12, AC-29, OD-42.
 *
 * All four channels use the same Source Receipt and the same result enum. That is what parity
 * means — readers need not interpret differently depending on "which path it came by".
 *
 * **But each channel must block different things.** An API signals failure with status codes;
 * a file-based channel has none. Instead it must check that the file is in a known format and
 * that its signature is valid.
 *
 * Decides the three cases AC-29 names:
 *
 *   1. invalid signature on a signed document
 *   2. schema drift in a bulk export
 *   3. missing second review on a manual confirmation
 */

// --- bulk export -----------------------------------------------------------

export interface SchemaDrift {
  readonly drifted: boolean;
  /** Fields absent from the declaration. A new column appeared. */
  readonly added: readonly string[];
  /** Fields that were declared but disappeared. This side is the dangerous one. */
  readonly removed: readonly string[];
}

/**
 * Schema drift check.
 *
 * **Missing fields are more dangerous.** A new column can simply be ignored, but a vanished
 * column means a value we used to read is gone. Yet a parser can receive `undefined` and
 * silently pass it on as empty.
 *
 * An empty declaration is not compared — to avoid reading the unknown as a match it returns
 * `drifted: false`, and the caller learns that fact through `compared`.
 */
export function detectSchemaDrift(
  declared: readonly string[],
  observed: readonly string[],
): SchemaDrift & { readonly compared: boolean } {
  if (declared.length === 0) {
    return { drifted: false, added: [], removed: [], compared: false };
  }

  const declaredSet = new Set(declared);
  const observedSet = new Set(observed);

  const added = observed.filter((field) => !declaredSet.has(field));
  const removed = declared.filter((field) => !observedSet.has(field));

  return { drifted: removed.length > 0 || added.length > 0, added, removed, compared: true };
}

/**
 * Bulk export result decision.
 *
 * Drift means `schema_changed`. **Values are never guessed** — a value read from a file whose
 * columns changed may point at something else.
 */
export function classifyBulkExport(input: {
  readonly declaredFields: readonly string[];
  readonly observedFields: readonly string[];
  readonly recordFound: boolean;
}): { readonly result: SourceResult; readonly drift: SchemaDrift } {
  const drift = detectSchemaDrift(input.declaredFields, input.observedFields);

  if (drift.drifted) {
    return { result: "schema_changed", drift };
  }

  // Not compared, so it cannot be confirmed. A person must register the schema.
  if (!drift.compared) {
    return { result: "manual_review_required", drift };
  }

  // The file is fine but has no record for that condition. A fact, not an outage.
  if (!input.recordFound) {
    return { result: "source_returned_no_record", drift };
  }

  return { result: "confirmed_from_source", drift };
}

// --- signed document -------------------------------------------------------

/**
 * Signed document result decision.
 *
 * Distinguishes a signature that was **not verified** from one that **failed verification**.
 * The former has no means of checking (public key not registered); the latter means the
 * document was tampered with or belongs to another signer. Merging them would let anyone skip
 * verification by not registering a public key.
 */
export function classifySignedDocument(input: {
  /** null means verification could not be attempted. */
  readonly signatureValid: boolean | null;
  /** Is the signer a registered signer for this authority? */
  readonly signerRecognized: boolean;
  readonly recordFound: boolean;
}): SourceResult {
  if (input.signatureValid === false) return "signature_invalid";

  // No key to verify with. The mere presence of a signature is not trusted.
  if (input.signatureValid === null) return "manual_review_required";

  // The signature is valid but the signer is not one we know. A valid signature does not say
  // who the signer is.
  if (!input.signerRecognized) return "signature_invalid";

  if (!input.recordFound) return "source_returned_no_record";

  return "confirmed_from_source";
}

// --- manual confirmation ---------------------------------------------------

/** Does this channel require a second review? */
export function requiresSecondReview(method: CollectionMethod): boolean {
  // A manual check has neither an API response nor a signature. One person's statement is the only evidence.
  return method === "manual_official_registry_confirmation";
}

export type SecondReviewCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly nextAction: string };

/**
 * Second-review decision — AC-29.
 *
 * **The same person cannot check twice.** A second review exists for a different pair of eyes;
 * allowing the same person leaves only the procedure.
 */
export function checkSecondReview(input: {
  readonly firstConfirmedBy: string | null;
  readonly secondConfirmedBy: string | null;
}): SecondReviewCheck {
  if (!input.secondConfirmedBy) {
    return {
      ok: false,
      reason: "A manual check cannot be confirmed without a second review",
      nextAction: "Another person looks up the same registry and confirms",
    };
  }

  if (input.secondConfirmedBy === input.firstConfirmedBy) {
    return {
      ok: false,
      reason: "The first checker cannot perform the second review",
      nextAction: "Another person confirms",
    };
  }

  return { ok: true };
}

/**
 * Is the channel qualified to produce a confirmed result?
 *
 * Called before creating a receipt. A DB CHECK blocks the same thing, but tripping it returns a
 * 500 and the user cannot tell **what else to do**.
 */
export function checkChannelReady(input: {
  readonly method: CollectionMethod;
  readonly result: SourceResult;
  readonly signatureValid?: boolean | null;
  readonly observedFields?: readonly string[] | null;
  readonly secondConfirmedBy?: string | null;
  readonly firstConfirmedBy?: string | null;
}): SecondReviewCheck {
  // Not a confirmation, so channel requirements are not asked. Failures must be recorded as failures.
  if (input.result !== "confirmed_from_source") return { ok: true };

  if (input.method === "manual_official_registry_confirmation") {
    return checkSecondReview({
      firstConfirmedBy: input.firstConfirmedBy ?? null,
      secondConfirmedBy: input.secondConfirmedBy ?? null,
    });
  }

  if (input.method === "verifiable_signed_document" && input.signatureValid !== true) {
    return {
      ok: false,
      reason: "A document whose signature is not verified cannot be confirmed",
      nextAction: "Register the signer's public key and verify again",
    };
  }

  if (input.method === "official_bulk_export" && !input.observedFields) {
    return {
      ok: false,
      reason: "A bulk export cannot be confirmed without an observed schema",
      nextAction: "Send the list of fields read from the file along with it",
    };
  }

  return { ok: true };
}
